import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NATIVE_DIR = fileURLToPath(new URL('./native/', import.meta.url));
const MANIFEST = 'artifacts.json';

export interface PvzNativeArtifacts {
  injector: string;
  implant: string;
  outputDir: string;
  identity: string;
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else files.push(path);
  }
  return files.sort();
}

function nativeIdentity(): string {
  const hash = createHash('sha256');
  for (const path of sourceFiles(NATIVE_DIR)) {
    hash.update(relative(NATIVE_DIR, path).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function runPvzNativeBuildScript(script: string, outputDir: string): Promise<void> {
  assertCmdPath(script);
  assertCmdPath(outputDir);
  return new Promise((resolveBuild, reject) => {
    const command = `""${script}" "${outputDir}""`;
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
      cwd: dirname(script),
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolveBuild();
        return;
      }
      reject(new Error(`原生桥编译失败(${String(code)}): ${(stderr || stdout).trim()}`));
    });
  });
}

function assertCmdPath(path: string): void {
  if (/[&|<>^()%!"\r\n]/.test(path)) {
    throw new Error(`PvZ 原生构建路径含 cmd.exe 不安全字符: ${path}`);
  }
}

function fileIdentity(path: string): { sha256: string; size: number } {
  const bytes = readFileSync(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

function writeManifest(outputDir: string, identity: string): void {
  const injector = fileIdentity(join(outputDir, 'pvz-injector.exe'));
  const implant = fileIdentity(join(outputDir, 'pvz-implant.dll'));
  writeFileSync(join(outputDir, MANIFEST), `${JSON.stringify({
    schema: 1,
    identity,
    injector,
    implant,
  })}\n`, { encoding: 'utf8', flag: 'wx' });
}

export async function ensurePvzNativeArtifacts(buildDir: string): Promise<PvzNativeArtifacts> {
  if (process.platform !== 'win32') throw new Error('worlds-pvz 原生植入件只支持 Windows');
  const root = isAbsolute(buildDir) ? buildDir : resolve(process.cwd(), buildDir);
  assertCmdPath(root);
  const identity = nativeIdentity();
  const outputDir = join(root, identity);
  const script = join(NATIVE_DIR, 'build.cmd');
  if (!existsSync(script)) throw new Error(`缺少原生构建脚本: ${script}`);
  mkdirSync(root, { recursive: true });

  if (existsSync(outputDir)) {
    try {
      return loadPvzNativeArtifacts(outputDir);
    } catch {
      renameSync(outputDir, `${outputDir}.invalid-${randomUUID()}`);
    }
  }

  const staging = mkdtempSync(join(root, `.tmp-${identity}-`));
  try {
    await runPvzNativeBuildScript(script, staging);
    const injector = join(staging, 'pvz-injector.exe');
    const implant = join(staging, 'pvz-implant.dll');
    if (!existsSync(injector) || !existsSync(implant)) {
      throw new Error(`原生构建未产出 pvz-injector.exe 与 pvz-implant.dll: ${staging}`);
    }
    writeManifest(staging, identity);
    try {
      renameSync(staging, outputDir);
    } catch (error) {
      if (!existsSync(outputDir)) throw error;
      loadPvzNativeArtifacts(outputDir);
    }
    return loadPvzNativeArtifacts(outputDir);
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

export function loadPvzNativeArtifacts(outputDir: string): PvzNativeArtifacts {
  const resolved = resolve(outputDir);
  const identity = resolved.split(/[\\/]/).at(-1) ?? '';
  if (!/^[0-9a-f]{64}$/.test(identity)) throw new Error('PvZ 原生构建目录身份无效');
  const injector = join(resolved, 'pvz-injector.exe');
  const implant = join(resolved, 'pvz-implant.dll');
  const manifestPath = join(resolved, MANIFEST);
  if (!existsSync(injector) || !existsSync(implant) || !existsSync(manifestPath)) {
    throw new Error(`PvZ 恢复所需的原生构建已丢失: ${resolved}`);
  }
  if (statSync(manifestPath).size > 4096) {
    throw new Error(`PvZ 原生构建完整性校验失败: ${resolved}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const expectedInjector = manifest.injector as Record<string, unknown> | null;
  const expectedImplant = manifest.implant as Record<string, unknown> | null;
  const validEntry = (entry: Record<string, unknown> | null, path: string): boolean => {
    if (!entry || !/^[0-9a-f]{64}$/.test(String(entry.sha256))
      || !Number.isSafeInteger(entry.size) || Number(entry.size) <= 0) return false;
    const actual = fileIdentity(path);
    return actual.sha256 === entry.sha256 && actual.size === entry.size;
  };
  if (manifest.schema !== 1 || manifest.identity !== identity
    || !validEntry(expectedInjector, injector) || !validEntry(expectedImplant, implant)) {
    throw new Error(`PvZ 原生构建完整性校验失败: ${resolved}`);
  }
  return { injector, implant, outputDir: resolved, identity };
}
