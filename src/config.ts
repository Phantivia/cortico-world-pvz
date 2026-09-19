import type { ConfigGroup } from 'cortico/core/types.ts';

export interface PvzConfigSection {
  enabled: boolean;
  executable: string;
  launch: boolean;
  closeOnStop: boolean;
  attachPid: number | null;
  /** Where the injector and implant are built; empty means `<runtimes root>/pvz/`. */
  nativeBuildDir: string;
  pollHz: number;
  cursorDurationMs: [number, number];
  actionTimeoutMs: number;
  emitBoardDeltas: boolean;
}

export const PVZ_DEFAULTS: PvzConfigSection = {
  enabled: false,
  executable: '',
  launch: true,
  closeOnStop: true,
  attachPid: null,
  nativeBuildDir: '',
  pollHz: 15,
  cursorDurationMs: [80, 280],
  actionTimeoutMs: 5000,
  emitBoardDeltas: true,
};

export function normalizePvzExecutablePath(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

export const PVZ_CONFIG_GROUP: ConfigGroup = {
  id: 'world:pvz',
  owner: 'world:pvz',
  schema: {
    type: 'object',
    title: '植物大战僵尸 · 游戏桥',
    description: '游戏进程、植入件构建目录、刷新率与内部光标轨迹。未知版本默认拒绝接入。',
    properties: {
      'worlds.pvz.executable': {
        type: 'string',
        title: '游戏程序（PlantsVsZombies.exe）',
        description: '选择 PlantsVsZombies.exe 文件；同目录必须包含版本匹配的 main.pak。可粘贴带首尾双引号的完整路径。游戏本体由操作员自备，本 World 不分发。',
        'x-hot': false,
        'x-path': {
          kind: 'file',
          extensions: ['.exe'],
        },
      },
      'worlds.pvz.nativeBuildDir': {
        type: 'string',
        title: '植入件构建目录',
        description: '注入器与植入件从 src/native 用本机的 x86 MSVC 编译到这里，按源码哈希分目录。留空用部署根的 runtimes/pvz/。',
        'x-hot': false,
        'x-path': { kind: 'directory' },
      },
      'worlds.pvz.closeOnStop': {
        type: 'boolean',
        title: 'World 停机时关闭游戏',
        'x-hot': false,
        description: '关闭由 World 启动并持有所有权令牌的游戏。',
      },
      'worlds.pvz.pollHz': {
        type: 'integer',
        title: '状态监视频率',
        minimum: 10,
        maximum: 20,
        'x-suffix': 'Hz',
        'x-hot': false,
      },
      'worlds.pvz.cursorDurationMs': {
        type: 'array',
        title: '内部光标轨迹时长',
        items: { type: 'integer', minimum: 40, maximum: 800 },
        minItems: 2,
        maxItems: 2,
        'x-suffix': 'ms',
        'x-hot': false,
      },
      'worlds.pvz.actionTimeoutMs': {
        type: 'integer',
        title: '操作验真死线',
        description: '原生终止结果使用独立执行包络；此值用于终止结果后的因果状态验真。',
        minimum: 500,
        maximum: 30000,
        'x-scale': 1000,
        'x-suffix': '秒',
        'x-hot': true,
      },
      'worlds.pvz.emitBoardDeltas': {
        type: 'boolean',
        title: '投递棋盘变化事件',
        'x-hot': true,
      },
    },
  },
};
