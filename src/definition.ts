import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WorldDefinition } from 'cortico/world.ts';
import { PVZ_DEFAULTS, normalizePvzExecutablePath, type PvzConfigSection } from './config.ts';
import { PvzWorldProxy } from './proxy.ts';

export const PVZ: WorldDefinition<PvzConfigSection> = {
  id: 'pvz',
  label: '植物大战僵尸',
  defaults: () => structuredClone(PVZ_DEFAULTS),
  preflight: (ctx) => {
    // 植入件是 x86 DLL,桥走命名管道,探进程走 PowerShell:这个 World 只有 Windows 版。
    // 判定放在这里而不是启动路径上,是为了让控制台的激活当场被拒,而不是挂载成功后
    // 由引擎子进程在启动游戏时才抛。
    if (process.platform !== 'win32') {
      throw new Error(`cortico-world-pvz 只支持 Windows,当前平台是 ${process.platform}`);
    }
    const executable = normalizePvzExecutablePath(ctx.cfg.executable);
    if (!executable) throw new Error('请先选择 PlantsVsZombies.exe 文件');
    if (!existsSync(executable)) throw new Error(`找不到 PlantsVsZombies.exe: ${executable}`);
    if (!statSync(executable).isFile()) {
      throw new Error(`游戏程序必须指向 PlantsVsZombies.exe 文件，当前路径是目录: ${executable}`);
    }
  },
  // 所有权记录是进程私有的恢复状态,归这份部署的数据目录。
  create: (ctx) => new PvzWorldProxy({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    botName: ctx.botName,
    ownershipDirectory: join(ctx.dataDir, 'pvz', 'ownership'),
  }),
};
