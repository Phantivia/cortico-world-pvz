import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SUPPORTED_PVZ_PROFILE, verifyPvzInstallation } from '../src/fingerprint.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worlds-pvz-fingerprint-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('PvZ 安装路径诊断', () => {
  it('游戏程序路径是目录时明确指出需要文件', async () => {
    await expect(verifyPvzInstallation(dir)).rejects.toThrow('PvZ 游戏程序必须是文件');
  });

  it('游戏程序不存在时报告具体文件路径', async () => {
    const executable = join(dir, 'PlantsVsZombies.exe');
    await expect(verifyPvzInstallation(executable)).rejects.toThrow(`找不到 PvZ 游戏程序: ${executable}`);
  });

  it('游戏程序大小或指纹不匹配时点名失败项', async () => {
    const executable = join(dir, 'PlantsVsZombies.exe');
    writeFileSync(executable, 'wrong size');
    await expect(verifyPvzInstallation(executable)).rejects.toThrow('PvZ 游戏程序大小不匹配');

    writeFileSync(executable, Buffer.alloc(SUPPORTED_PVZ_PROFILE.executable.bytes));
    await expect(verifyPvzInstallation(executable)).rejects.toThrow('PvZ 游戏程序 SHA-256 不匹配');
  });
});
