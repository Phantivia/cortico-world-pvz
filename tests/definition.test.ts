import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { WorldContext } from 'cortico/world.ts';
import { PVZ } from '../src/definition.ts';
import { PVZ_DEFAULTS, type PvzConfigSection } from '../src/config.ts';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** preflight 只读 `cfg`;其余字段给到形状齐全即可。 */
function context(executable: string): WorldContext<PvzConfigSection> {
  const cfg: PvzConfigSection = { ...structuredClone(PVZ_DEFAULTS), executable };
  return { id: 'pvz', cfg } as WorldContext<PvzConfigSection>;
}

function existingExecutable(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pvz-preflight-'));
  directories.push(dir);
  const executable = join(dir, 'PlantsVsZombies.exe');
  writeFileSync(executable, 'test executable');
  return executable;
}

it.skipIf(process.platform === 'win32')('非 Windows 上激活当场被拒,不等引擎子进程起来才报', () => {
  expect(() => PVZ.preflight?.(context(existingExecutable()))).toThrow('只支持 Windows');
});

it.runIf(process.platform === 'win32')('装好的游戏程序通过前置检查', () => {
  expect(() => PVZ.preflight?.(context(existingExecutable()))).not.toThrow();
});

it.runIf(process.platform === 'win32')('游戏程序填成目录时说清是目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pvz-preflight-dir-'));
  directories.push(dir);
  expect(() => PVZ.preflight?.(context(dir))).toThrow('当前路径是目录');
});

it.runIf(process.platform === 'win32')('没填游戏程序时指路控制台的选择器', () => {
  expect(() => PVZ.preflight?.(context(''))).toThrow('请先选择');
});
