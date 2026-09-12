import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensurePvzNativeArtifacts,
  loadPvzNativeArtifacts,
  runPvzNativeBuildScript,
} from '../src/native-build.ts';
import { pvzWhackExecutionBudgetMs } from '../src/timing.ts';

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function artifactFixture(): { outputDir: string; injector: string; implant: string } {
  const root = mkdtempSync(join(tmpdir(), 'worlds-pvz-native-test-'));
  temporary.push(root);
  const identity = 'a'.repeat(64);
  const outputDir = join(root, identity);
  mkdirSync(outputDir);
  const injector = join(outputDir, 'pvz-injector.exe');
  const implant = join(outputDir, 'pvz-implant.dll');
  const injectorBytes = Buffer.from('injector fixture');
  const implantBytes = Buffer.from('implant fixture');
  writeFileSync(injector, injectorBytes);
  writeFileSync(implant, implantBytes);
  writeFileSync(join(outputDir, 'artifacts.json'), JSON.stringify({
    schema: 1,
    identity,
    injector: { sha256: sha256(injectorBytes), size: injectorBytes.length },
    implant: { sha256: sha256(implantBytes), size: implantBytes.length },
  }));
  return { outputDir, injector, implant };
}

describe('PvZ 原生构建身份', () => {
  it('锤击执行预算按目标数和节奏扩展，并保留最小预算', () => {
    expect(pvzWhackExecutionBudgetMs(10, 220, 5000)).toBe(24_800);
    expect(pvzWhackExecutionBudgetMs(2, 220, 5000)).toBe(5000);
    expect(pvzWhackExecutionBudgetMs(2, 800, 5000)).toBe(7360);
  });

  it('内部光标不调用全局输入或前台焦点 API', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/native/implant.cpp', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/PostGameMessage\(window,\s*WM_(?:MOUSEMOVE|LBUTTON|RBUTTON)/);
    expect(source).not.toMatch(/\b(?:SetCursorPos|SetPhysicalCursorPos|SendInput|mouse_event|ClipCursor)\s*\(/i);
    expect(source).not.toMatch(/\b(?:SetCapture|ReleaseCapture|SetCursor)\s*\(/i);
    expect(source).not.toMatch(/\b(?:SetForegroundWindow|SetActiveWindow|BringWindowToTop|AttachThreadInput)\s*\(/i);
  });

  it('恢复只接受清单和二进制哈希一致的内容寻址目录', () => {
    const fixture = artifactFixture();
    expect(loadPvzNativeArtifacts(fixture.outputDir)).toMatchObject(fixture);

    writeFileSync(fixture.implant, 'tampered');
    expect(() => loadPvzNativeArtifacts(fixture.outputDir)).toThrow('完整性校验失败');
  });

  // 非 Windows 上 ensurePvzNativeArtifacts 先撞平台闸,路径校验够不着。
  it.runIf(process.platform === 'win32')('拒绝会被 cmd.exe 解释的可配置构建路径', async () => {
    await expect(ensurePvzNativeArtifacts('scratch/worlds-pvz&unexpected'))
      .rejects.toThrow('不安全字符');
  });

  it.skipIf(process.platform === 'win32')('非 Windows 上原生植入件直接拒绝构建', async () => {
    await expect(ensurePvzNativeArtifacts('scratch/worlds-pvz-native'))
      .rejects.toThrow('只支持 Windows');
  });

  it.runIf(process.platform === 'win32')('脚本与输出目录同时含空格时保留单一输出参数', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worlds pvz native build '));
    temporary.push(root);
    const scriptDir = join(root, 'script fixture');
    const outputDir = join(root, 'output fixture');
    mkdirSync(scriptDir);
    const script = join(scriptDir, 'fixture build.cmd');
    writeFileSync(script, [
      '@echo off',
      'if not "%~2"=="" exit /b 7',
      'if not exist "%~1" mkdir "%~1"',
      '> "%~1\\received-path.txt" echo(%~f1',
    ].join('\r\n'));

    await runPvzNativeBuildScript(script, outputDir);

    expect(readFileSync(join(outputDir, 'received-path.txt'), 'utf8').trim())
      .toBe(outputDir);
  });
});
