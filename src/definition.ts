import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { PVZ_DEFAULTS, normalizePvzExecutablePath, type PvzConfigSection } from './config.ts';
import { PvzWorldProxy } from './proxy.ts';
import { PVZ_TOOL_DECLS } from './tools.ts';

export const PVZ: WorldDefinition<PvzConfigSection> = {
  id: 'pvz',
  label: '植物大战僵尸',
  defaults: () => structuredClone(PVZ_DEFAULTS),
  preflight: (ctx) => {
    // 植入件是 x86 DLL,桥走命名管道,探进程走 PowerShell:这个 World 只有 Windows 版。
    // 判定放在这里而不是启动路径上,是为了让 WebUI 的激活当场被拒,而不是挂载成功后
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
  describe: {
    tools: describeTools(PVZ_TOOL_DECLS, {
      pvz_observe: {
        zh: '读取当前界面、棋盘、卡片、阳光、关卡进度和任务队列。',
        en: 'Reads the current screen, board, cards, sun, level progress and task queue.',
      },
      pvz_do: {
        zh: '提交一串按顺序执行的动作(选卡、种植、点菜单等),任务结束时回执结果。',
        en: 'Submits an ordered queue of actions such as picking seeds, planting or pressing menu items, with a receipt when the task ends.',
      },
      pvz_queue: {
        zh: '查看正在执行和排队的任务、预留的卡片和最近的结果。',
        en: 'Shows the running and waiting tasks, reserved cards and recent results.',
      },
      pvz_arm: {
        zh: '设一个棋盘条件触发器,条件成立时自动提交一串动作。',
        en: 'Arms a trigger that submits a queue of actions when a board condition becomes true.',
      },
      pvz_stop: {
        zh: '撤掉一个任务或触发器,或清空全部任务与触发器。',
        en: 'Cancels one task or trigger, or clears every task and trigger.',
      },
      pvz_glance: {
        zh: '截取游戏窗口画面;模型能看图时才提供。',
        en: 'Takes a screenshot of the game window; offered only when the model accepts images.',
      },
    }),
    events: [
      {
        type: 'pvz.lifecycle',
        description: {
          zh: '操作员启动或停止游戏、游戏进程退出、引擎子进程崩溃,以及自动恢复的结果。',
          en: 'The operator started or stopped the game, the game process exited, or the engine child process crashed, and whether recovery worked.',
        },
        trigger: 'flush',
      },
      {
        type: 'pvz.connected',
        description: { zh: '连上游戏,附当前画面摘要。', en: 'Connected to the game, with a summary of the current screen.' },
      },
      {
        type: 'pvz.window.changed',
        description: {
          zh: '游戏窗口变得不能截图或点击(尺寸不对、跨出屏幕),或已恢复。',
          en: 'The game window stopped accepting screenshots and clicks (wrong size, off screen), or recovered.',
        },
      },
      {
        type: 'pvz.screen.changed',
        description: {
          zh: '游戏画面切换,如菜单到图鉴,或对话框关闭回到关卡。',
          en: 'The game switched screens, such as from a menu to the almanac, or a dialog over the level closed.',
        },
      },
      {
        type: 'pvz.seed_picker.opened',
        description: { zh: '进入选卡画面,附可选卡片。', en: 'The seed picker opened, with the available cards.' },
      },
      {
        type: 'pvz.level.started',
        description: { zh: '进入一个关卡,附棋盘摘要。', en: 'A level started, with a board summary.' },
      },
      {
        type: 'pvz.level.restarted',
        description: { zh: '同一画面上开始了新的一局。', en: 'A new run of the level began on the same screen.' },
      },
      {
        type: 'pvz.level.stage_resumed',
        description: {
          zh: '生存模式阶段间换卡完成,回到同一关继续。',
          en: 'Survival mode finished picking seeds between stages and resumed the same level.',
        },
      },
      {
        type: 'pvz.level.stage_completed',
        description: {
          zh: '分阶段的关卡(生存、砸罐子、我是僵尸、Last Stand)进入下一阶段。',
          en: 'A staged level (Survival, Vasebreaker, I, Zombie, Last Stand) moved on to its next stage.',
        },
      },
      {
        type: 'pvz.level.progress',
        description: { zh: '关卡进度变化,如波次或完成数。', en: 'Level progress changed, such as the wave or the completed count.' },
      },
      {
        type: 'pvz.level.won',
        description: { zh: '关卡胜利。', en: 'The level was won.' },
      },
      {
        type: 'pvz.level.lost',
        description: { zh: '关卡失败。', en: 'The level was lost.' },
      },
      {
        type: 'pvz.menu.ready',
        description: { zh: '当前画面出现新的可点操作。', en: 'New actions became available on the current screen.' },
      },
      {
        type: 'pvz.mode.progress',
        description: { zh: '模式选择画面上某个模式完成或刷新了纪录。', en: 'A mode on the mode selector was completed or got a new record.' },
      },
      {
        type: 'pvz.progress.committed',
        description: {
          zh: '存档进度已写入:冒险关数与各模式解锁情况。',
          en: 'Profile progress was saved: the Adventure level and which modes are unlocked.',
        },
      },
      {
        type: 'pvz.visibility.changed',
        description: {
          zh: '棋盘进入或离开看不见僵尸和植物的黑暗阶段。',
          en: 'The board entered or left a dark phase in which zombies and plants are hidden.',
        },
      },
      {
        type: 'pvz.zombie.visible',
        description: { zh: '有新的僵尸出现在画面上。', en: 'New zombies came into view.' },
      },
      {
        type: 'pvz.threat.approaching',
        description: { zh: '可见的僵尸进入更靠近房子的区段。', en: 'Visible zombies moved into a band closer to the house.' },
      },
      {
        type: 'pvz.threat.close',
        description: {
          zh: '僵尸走到草坪最左段,附这一排割草机是否还在。',
          en: 'Zombies reached the leftmost part of the lawn, with whether that row still has a lawn mower.',
        },
      },
      {
        type: 'pvz.zombie.relocated',
        description: { zh: '传送门关卡里僵尸被传到别的排。', en: 'A zombie was moved to another row through a portal.' },
      },
      {
        type: 'pvz.zombie.hunger',
        description: { zh: '僵尸水族馆里潜水僵尸饿了或恢复正常。', en: 'A Snorkel Zombie in Zombiquarium became hungry or recovered.' },
      },
      {
        type: 'pvz.boss.phase',
        description: { zh: '僵王博士换了动作阶段。', en: 'Dr. Zomboss entered a new attack phase.' },
      },
      {
        type: 'pvz.boss.immobilized',
        description: { zh: '僵王博士被定住或解除定身。', en: 'Dr. Zomboss was frozen in place or freed.' },
      },
      {
        type: 'pvz.boss.projectile',
        description: { zh: '僵王博士放出火球或冰球,或球已消失。', en: 'Dr. Zomboss launched a fireball or iceball, or the ball is gone.' },
      },
      {
        type: 'pvz.terrain.ice',
        description: { zh: '某一排的冰道变化或被清除,冰道上不能种植。', en: "A row's ice trail changed or was cleared; nothing can be planted on it." },
      },
      {
        type: 'pvz.portals.changed',
        description: { zh: '传送门关卡里传送门的位置变化。', en: 'Portals moved in Portal Combat.' },
      },
      {
        type: 'pvz.vase.changed',
        description: { zh: '砸罐子关卡里罐子露出的内容变化。', en: 'What a vase reveals about its contents changed in Vasebreaker.' },
      },
      {
        type: 'pvz.collectible.appeared',
        description: {
          zh: '出现可拾取的东西,如金币、钻石、种子包或奖杯;阳光由 World 自动收,不报。',
          en: 'Something to pick up appeared, such as coins, diamonds, seed packets or the trophy; sun is collected by the World and not reported.',
        },
      },
      {
        type: 'pvz.sun.stuck',
        description: { zh: '自动收阳光连续几次没收到。', en: 'Automatic sun collection missed several times in a row.' },
        trigger: 'debounce',
      },
      {
        type: 'pvz.card.ready',
        description: {
          zh: '卡片冷却完毕且阳光够用,或传送带送来新卡。',
          en: 'A card finished cooling down and is affordable, or the conveyor belt delivered a new card.',
        },
      },
      {
        type: 'pvz.cursor.changed',
        description: { zh: '手上拿起或放下了种子包。', en: 'A seed packet was picked up onto or dropped from the cursor.' },
      },
      {
        type: 'pvz.actions.changed',
        description: { zh: '特殊关卡的阶段、可用动作或目标数变化。', en: "A special level's phase, allowed actions or target count changed." },
      },
      {
        type: 'pvz.target.ready',
        description: { zh: '锤僵尸关卡里出现新的可锤目标。', en: 'New targets appeared in Whack a Zombie.' },
      },
      {
        type: 'pvz.mower.used',
        description: { zh: '某一排的割草机或同类防线被触发。', en: "A row's lawn mower or its pool or roof counterpart went off." },
      },
      {
        type: 'pvz.mower.lost',
        description: { zh: '某一排的割草机被压毁或不见了。', en: "A row's lawn mower was crushed or disappeared." },
      },
      {
        type: 'pvz.plant.damaged',
        description: { zh: '植物受损程度加重。', en: 'Plants took more damage.' },
      },
      {
        type: 'pvz.plant.lost',
        description: { zh: '可见的植物离场。', en: 'Visible plants left the board.' },
      },
      {
        type: 'pvz.plant.layers_changed',
        description: {
          zh: '一格上叠着的植物(花盆、南瓜头等)变化。',
          en: 'The plants stacked on a tile, such as a flower pot or pumpkin, changed.',
        },
      },
      {
        type: 'pvz.task',
        description: {
          zh: 'pvz_do 任务结束的回执:完成、部分完成、受阻、未验真或被撤销。',
          en: 'The receipt of a pvz_do task: done, partly done, blocked, unverified or cancelled.',
        },
      },
      {
        type: 'pvz.trigger',
        description: {
          zh: 'pvz_arm 设的触发器打响、过期、因换关失效或被撤销。',
          en: 'A pvz_arm trigger fired, expired, lapsed with the level, or was cancelled.',
        },
      },
      {
        type: 'pvz.task.prefetch',
        description: {
          zh: '锤僵尸关卡里当前锤击队列快执行完,提示接着排下一份。',
          en: 'In Whack a Zombie, the current whack queue is about to run out; a prompt to queue the next one.',
        },
        trigger: 'flush',
      },
      {
        type: 'pvz.board.snapshot',
        description: {
          zh: '棋盘摘要,随下一批事件送达;对局中棋盘有变化时,最多每 30 秒以它唤醒一次。',
          en: 'A board summary sent with the next batch; during a level it wakes the bot at most every 30 seconds while the board changes.',
        },
        tags: ['snapshot'],
      },
    ],
  },
};
