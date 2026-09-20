import { describe, expect, it, vi } from 'vitest';
import type { PvzNativeAction, PvzSnapshot, PvzSpecialTarget } from '../src/protocol.ts';
import {
  renderWhackSkillQueueCall,
  WHACK_SKILL_QUEUE_LENGTH,
} from '../src/tools.ts';
import {
  afterTimers,
  boardState,
  callTool,
  FakePvzTransport,
  snapshot,
  startWorld,
} from './helpers.ts';

function installAdventureStateMachine(transport: FakePvzTransport): void {
  transport.actionHandler = (action, fake) => {
    if (action.kind === 'menu' && action.target === 'adventure') {
      fake.publish((draft) => {
        draft.profile!.adventureLevel = 2;
        draft.screen = 'seed_picker';
        draft.scene = 2;
        draft.menu = [];
        draft.seedPicker = {
          capacity: 2,
          selected: [],
          choices: [
            {
              id: 0, name: 'peashooter', state: 'chooser', bankSlot: null, imitates: null,
              recommended: true, fixed: false, x: 100, y: 150,
            },
            {
              id: 1, name: 'sunflower', state: 'chooser', bankSlot: null, imitates: null,
              recommended: true, fixed: false, x: 160, y: 150,
            },
          ],
          previewZombies: [{ type: 0, name: 'zombie' }],
          ready: false,
        };
      });
      return;
    }
    if (action.kind === 'choose_seed') {
      fake.publish((draft) => {
        const picker = draft.seedPicker!;
        const index = picker.selected.indexOf(action.seed);
        if (index >= 0) picker.selected.splice(index, 1);
        else picker.selected.push(action.seed);
        picker.choices.forEach((choice) => {
          const bankSlot = picker.selected.indexOf(choice.id);
          choice.state = bankSlot >= 0 ? 'selected' : 'chooser';
          choice.bankSlot = bankSlot >= 0 ? bankSlot : null;
        });
        picker.ready = picker.selected.length === picker.capacity;
      });
      return;
    }
    if (action.kind === 'ready') {
      fake.publish((draft) => {
        const selected = [...draft.seedPicker!.selected];
        draft.screen = 'board';
        draft.scene = 3;
        draft.seedPicker = null;
        draft.board = boardState({
          cards: selected.map((type, slot) => ({
            slot,
            type,
            name: type === 0 ? 'peashooter' : 'sunflower',
            imitates: null,
            cost: type === 0 ? 100 : 50,
            ready: true,
            affordable: true,
            cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0,
            x: 80 + slot * 55,
            y: 40,
          })),
          collectibles: [
            { id: 90, kind: 'sun', x: 360, y: 190, row: 2, column: 4 },
            { id: 91, kind: 'coin', x: 420, y: 250, row: 3, column: 5 },
          ],
        });
      });
      return;
    }
    if (action.kind === 'plant' && 'column' in action) {
      fake.publish((draft) => {
        const board = draft.board!;
        const card = board.cards.find((candidate) => candidate.slot === action.slot)!;
        board.plants.push({
          id: 100,
          type: card.type,
          name: card.name,
          row: action.row,
          column: action.column,
          condition: 'intact',
          sleeping: false,
          squished: false,
          layers: [],
        });
        board.sun -= card.type === 1 ? 50 : 100;
        card.ready = false;
        card.cooldown = 'long';
      });
      return;
    }
    if (action.kind === 'shovel') {
      fake.publish((draft) => {
        draft.board!.plants = draft.board!.plants.filter(
          (plant) => plant.row !== action.row || plant.column !== action.column,
        );
      });
      return;
    }
    if (action.kind === 'collect') {
      fake.nativeResult = { outcome: 'executed', effect: 'collectibles_collected' };
      fake.publish((draft) => {
        const ids = new Set(action.ids);
        const collected = draft.board!.collectibles.filter((item) => ids.has(item.id));
        draft.board!.collectibles = draft.board!.collectibles.filter((item) => !ids.has(item.id));
        if (collected.some((item) => item.kind === 'sun')) draft.board!.sun += 25;
        if (collected.some((item) => item.kind === 'coin')) draft.profile!.coins += 1;
      });
      return;
    }
    if (action.kind === 'menu' && action.target === 'advance') {
      fake.publish((draft) => {
        draft.screen = 'main_menu';
        draft.scene = 1;
        draft.menu = [
          { id: 'adventure', label: 'Adventure', enabled: true, x: 400, y: 340, state: null, record: null },
          { id: 'minigames', label: 'Mini-games', enabled: true, x: 450, y: 410, state: null, record: null },
        ];
        draft.profile!.adventureLevel = 2;
        draft.profile!.minigamesUnlocked = true;
      });
      return;
    }
    return { accepted: false, reason: `模拟器当前不接受 ${action.kind}` };
  };
}

describe('PvzWorld 工具流程', () => {
  it('主菜单没有棋盘时 pvz_stop 仍以输入代次验真释放', async () => {
    const transport = new FakePvzTransport();
    const { world } = await startWorld(transport);
    try {
      const result = await callTool(world, 'pvz_stop');

      expect(result).toContain('原生输入已释放');
      expect(result).not.toContain('失败');
      expect(transport.commands).toEqual([{ kind: 'cancel' }]);
    } finally {
      await world.stop();
    }
  });

  it('默认只暴露语义队列工具并从 引擎子进程 代际基数分配任务号', async () => {
    const transport = new FakePvzTransport();
    const { world } = await startWorld(transport, {}, {
      taskIdBase: 2_000_000,
    });
    try {
      expect(world.tools().map((tool) => tool.name)).toEqual([
        'pvz_observe', 'pvz_do', 'pvz_queue', 'pvz_arm', 'pvz_stop', 'pvz_glance',
      ]);
      expect(await callTool(world, 'pvz_do', {
        steps: [{ skill: 'menu', action: 'adventure' }],
      })).toMatch(/^任务#2000001 已受理[\s\S]*\[PvZ队列\]/);
    } finally {
      await world.stop();
    }
  });

  it('受理回执只有受理行与队列状态，不再附一份世界快照', async () => {
    const state = snapshot({
      screen: 'board',
      scene: 3,
      menu: [],
      board: boardState({
        plants: [{
          id: 10, type: 1, name: 'sunflower', row: 1, column: 1,
          condition: 'intact', sleeping: false, squished: false, layers: [],
        }],
        zombies: [{
          id: 20, type: 4, name: 'buckethead', row: 2, column: 5, columnPosition: 5,
          xBand: 'mid', speedCellsPerSecond: 0.0, speed: 'normal', phase: 'walking', condition: 'intact',
          armor: 'intact', shield: 'none', hypnotized: false, slowed: false,
          immobilized: false,
        }],
      }),
    });
    const transport = new FakePvzTransport(state);
    const { world } = await startWorld(transport);
    try {
      const receipt = await callTool(world, 'pvz_do', {
        steps: [{ skill: 'collect', what: 'coins', until: 'once' }],
      });

      expect(receipt).toMatch(/^任务#1 已受理:收集金币一次。\n\[PvZ队列\] 正在做任务#1/);
      expect(receipt).not.toContain('[PvZ 状态');
      expect(receipt).not.toContain('铁桶僵尸');
    } finally {
      await world.stop();
    }
  });

  it('生产工具把玩家列表到新档案确认封装成一个语义任务', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'dialog',
      profile: {
        name: 'Player',
        adventureLevel: 8, adventureCompletions: 0, coins: 1250,
        minigamesUnlocked: true, puzzleUnlocked: false, survivalUnlocked: false,
      },
      menu: [
        { id: 'profile_create', label: 'Create profile', enabled: true, x: 394, y: 225, state: null, record: null },
        { id: 'cancel', label: 'Cancel', enabled: true, x: 580, y: 515, state: null, record: null },
      ],
      dialog: {
        id: 290001, hasPrimary: false, hasSecondary: true,
        primaryLabel: null, secondaryLabel: 'Cancel',
      },
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'profile_create') return { accepted: false, reason: 'unexpected action' };
      fake.nativeResult = { outcome: 'executed', effect: 'profile_created' };
      fake.publish((draft) => {
        draft.screen = 'main_menu';
        draft.profile = {
          name: action.name,
          adventureLevel: 1, adventureCompletions: 0, coins: 0,
          minigamesUnlocked: false, puzzleUnlocked: false, survivalUnlocked: false,
        };
        draft.menu = [{
          id: 'adventure', label: 'Adventure', enabled: true,
          x: 400, y: 340, state: null, record: null,
        }];
        draft.dialog = null;
        draft.inputControl.menuContext += 1;
      });
    };
    const { world, host } = await startWorld(transport);
    try {
      expect(world.tools().map((tool) => tool.name)).toEqual([
        'pvz_observe', 'pvz_do', 'pvz_queue', 'pvz_arm', 'pvz_stop', 'pvz_glance',
      ]);
      expect(await callTool(world, 'pvz_do', {
        steps: [{ skill: 'profile_create', name: '  PVZE2E0831  ' }],
      })).toContain('任务#1 已受理');
      await afterTimers(20);

      expect(transport.commands).toEqual([{ kind: 'profile_create', name: 'PVZE2E0831' }]);
      expect(await callTool(world, 'pvz_queue')).toContain('任务#1完成');
      const reports = host.events.filter(({ event }) => event.type === 'pvz.task');
      expect(reports).toHaveLength(1);
      expect(reports[0]!.event.text).toContain('档案「PVZE2E0831」已创建');
    } finally {
      await world.stop();
    }
  });

  it('参数化档案创建目标不能被 menu 或 interact 半调用', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'dialog',
      menu: [{
        id: 'profile_create', label: 'Create profile', enabled: true,
        x: 394, y: 225, state: null, record: null,
      }],
      dialog: {
        id: 290002, hasPrimary: false, hasSecondary: false,
        primaryLabel: null, secondaryLabel: null,
      },
    }));
    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', {
        steps: [{ skill: 'menu', action: 'profile_create' }],
      })).toContain('任务#1 已受理');
      await afterTimers(20);
      expect(await callTool(world, 'pvz_do', {
        steps: [{ skill: 'interact', target: 'profile_create' }],
      })).toContain('任务#2 已受理');
      await afterTimers(20);

      expect(transport.commands).toEqual([]);
      expect(host.events.filter(({ event }) => event.type === 'pvz.task')
        .map(({ event }) => event.text)).toEqual([
        expect.stringContaining('创建档案必须使用带 name 的 profile_create 步骤'),
        expect.stringContaining('创建档案必须使用带 name 的 profile_create 步骤'),
      ]);
    } finally {
      await world.stop();
    }
  });

  it('任务最终回执保留植入件失败证据并隐藏内部标识', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'dialog',
      menu: [{
        id: 'profile_create', label: 'Create profile', enabled: true,
        x: 394, y: 225, state: null, record: null,
      }],
      dialog: {
        id: 290002, hasPrimary: false, hasSecondary: false,
        primaryLabel: null, secondaryLabel: null,
      },
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'profile_create') return { accepted: false, reason: 'unexpected action' };
      fake.nativeResult = {
        outcome: 'rejected',
        reason: 'new active profile and roster growth were not both verified; targetId=42 slot 7 at 0x1234',
      };
    };
    const { world, host } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', {
        steps: [{ skill: 'profile_create', name: 'PVZE2E0831' }],
      });
      await afterTimers(20);

      const report = host.events.find(({ event }) => event.type === 'pvz.task')?.event.text ?? '';
      expect(report).toContain('new active profile and roster growth were not both verified');
      expect(report).toContain('内部目标');
      expect(report).toContain('语义卡位');
      expect(report).toContain('内部地址');
      expect(report).not.toMatch(/targetId|slot 7|0x1234/);
    } finally {
      await world.stop();
    }
  });

  it('pvz_do 用异步任务回执走完菜单、选卡和多步棋盘操作', async () => {
    const transport = new FakePvzTransport();
    installAdventureStateMachine(transport);
    const { world, host } = await startWorld(transport);
    try {
      const open = await callTool(world, 'pvz_do', {
        steps: [{ skill: 'menu', action: 'adventure' }],
      });
      expect(open).toContain('任务#1 已受理');
      await afterTimers(20);
      expect(await callTool(world, 'pvz_queue')).toContain('任务#1完成');
      expect(await callTool(world, 'pvz_observe')).toContain('选卡 0/2');

      expect(await callTool(world, 'pvz_do', {
        steps: [{
          skill: 'choose_seeds', seeds: ['peashooter', 'sunflower'],
          mode: 'replace', confirm: true,
        }],
      })).toContain('任务#2 已受理');
      await afterTimers(100);
      expect(await callTool(world, 'pvz_observe')).toContain('画面=棋盘');

      expect(await callTool(world, 'pvz_do', {
        steps: [
          { skill: 'plant', plant: 'peashooter', row: 2, column: 3 },
          { skill: 'collect', what: 'resources', until: 'visible_clear' },
          { skill: 'shovel', row: 2, column: 3 },
        ],
      // 棋盘一出来场上就有一颗阳光,World 自己先收掉它,占掉 3 号:她这份队列是 4 号。
      })).toContain('任务#4 已受理');
      await afterTimers(100);

      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('当前没有执行中的任务');
      expect(queue).toContain('任务#4完成');
      expect(transport.commands.map((action) => action.kind)).toEqual([
        'menu', 'choose_seed', 'choose_seed', 'ready', 'collect', 'plant', 'collect', 'shovel',
      ]);
      const taskEvents = host.events.filter(({ event }) => event.type === 'pvz.task');
      expect(taskEvents.map(({ event }) => event.text)).toEqual(expect.arrayContaining([
        expect.stringContaining('任务#1完成'),
        expect.stringContaining('任务#2完成'),
        expect.stringContaining('任务#4完成'),
      ]));
      expect(taskEvents.find(({ event }) => event.text.includes('任务#1完成'))?.event.text)
        .toMatch(/画面=选卡[\s\S]*选卡 0\/2/);
      expect(taskEvents.every(({ event }) => !/actionId|targetId|slot|"id"/.test(event.text)))
        .toBe(true);
    } finally {
      await world.stop();
    }
  });

  it('同一模型轮次只受理一个 pvz_do 技能队列', async () => {
    const transport = new FakePvzTransport();
    installAdventureStateMachine(transport);
    const { world } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', {
        steps: [{ skill: 'menu', action: 'adventure' }],
      }, 17)).toContain('任务#1 已受理');
      await afterTimers(30);
      expect(await callTool(world, 'pvz_queue')).toContain('任务#1完成');

      const duplicate = await callTool(world, 'pvz_do', {
        steps: [{ skill: 'choose_seeds', seeds: ['peashooter', 'sunflower'], confirm: true }],
      }, 17);
      expect(duplicate).toContain('[pvz_do 失败]');
      expect(duplicate).toContain('本轮已经提交过一个技能队列');

      expect(await callTool(world, 'pvz_do', {
        steps: [{ skill: 'choose_seeds', seeds: ['peashooter', 'sunflower'], confirm: true }],
      }, 18)).toContain('任务#2 已受理');
    } finally {
      await world.stop();
    }
  });

  it('水族馆连续投喂和购买逐步结算阳光，资源不足时停止剩余动作', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', mode: 23, modeName: 'zombiquarium',
      board: boardState({ sun: 115, cards: [], allowedSpecialActions: ['drop_brain', 'buy_snorkel'],
        special: { phase: 'feeding', settled: true, targets: [
          { action: 'buy_snorkel', kind: 'cell', id: null, slot: null, row: null, column: null },
          ...[3, 5, 7].map(column => ({ action: 'drop_brain', kind: 'cell' as const, id: null, slot: null, row: 2, column })),
        ] },
      }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'special') return;
      fake.publish(draft => {
        const board = draft.board!;
        if (action.action === 'drop_brain') {
          board.sun -= 5;
          board.gridItems.push({ id: board.gridItems.length + 1, kind: 'i_zombie_brain', row: action.row!, column: action.column! });
        } else if (action.action === 'buy_snorkel') {
          board.sun -= 100;
          board.zombies.push({ id: 1, type: 11, name: 'snorkel_zombie', row: 2, column: 5, columnPosition: 5,
            xBand: 'mid', phase: 'zombiquarium_drifting', speedCellsPerSecond: 0.2,
            condition: 'intact', armor: 'none', shield: 'none', hypnotized: false, slowed: false, immobilized: false });
        }
        if (board.sun < 100) {
          board.allowedSpecialActions = board.allowedSpecialActions.filter(action => action !== 'buy_snorkel');
          board.special!.targets = board.special!.targets.filter(target => target.action !== 'buy_snorkel');
        }
      });
    };
    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: [
        { skill: 'special', action: 'drop_brain', at: { row: 2, column: 3 } },
        { skill: 'special', action: 'drop_brain', at: { row: 2, column: 5 } },
        { skill: 'special', action: 'buy_snorkel' },
        { skill: 'special', action: 'buy_snorkel' },
        { skill: 'special', action: 'drop_brain', at: { row: 2, column: 7 } },
      ] })).toContain('已受理');
      await waitUntil(() => host.events.some(({ event }) => event.type === 'pvz.task' && event.text.includes('第 4/5 步')), 3000);
      expect(transport.state.board!.sun).toBe(5);
      expect(transport.state.board!.gridItems.map(item => item.column)).toEqual([3, 5]);
      expect(transport.state.board!.zombies).toHaveLength(1);
      expect(await callTool(world, 'pvz_queue')).toContain('第 4/5 步');
    } finally { await world.stop(); }
  });

  it('特殊阶段和界面动作在回执前形成技能队列决策屏障', async () => {
    const transport = new FakePvzTransport();
    const { world } = await startWorld(transport);
    try {
      const queues = [
        [
          { skill: 'special', action: 'spin' },
          { skill: 'special', action: 'spin' },
        ],
        [
          { skill: 'special', action: 'break_vase', target: { kind: 'grid_item', at: { row: 2, column: 3 } } },
          { skill: 'collect', what: 'resources', until: 'visible_clear' },
        ],
        [
          { skill: 'choose_seeds', seeds: ['peashooter'], confirm: true },
          { skill: 'menu', action: 'advance' },
        ],
        [
          { skill: 'collect', what: 'award', until: 'once' },
          { skill: 'menu', action: 'advance' },
        ],
        [
          { skill: 'interact', target: 'store_buy_1' },
          { skill: 'menu', action: 'advance' },
        ],
        [
          { skill: 'visual_click', x: 400, y: 300 },
          { skill: 'menu', action: 'advance' },
        ],
      ];
      for (const steps of queues) {
        const result = await callTool(world, 'pvz_do', { steps });
        expect(result).toContain('[pvz_do 失败]');
        expect(result).toContain('必须作为本次技能队列的最后一步');
      }
      expect(transport.commands).toEqual([]);

      const futurePacket = await callTool(world, 'pvz_do', {
        steps: [
          { skill: 'collect', what: 'usable_seed', until: 'once' },
          { skill: 'collect', what: 'coins', until: 'once' },
          { skill: 'special', action: 'launch', at: { row: 2, column: 3 } },
        ],
      });
      expect(futurePacket).toContain('[pvz_do 失败]');
      expect(futurePacket).toContain('只能紧跟一个作为队尾的 launch');

      expect(await callTool(world, 'pvz_do', {
        steps: [
          { skill: 'collect', what: 'usable_seed', until: 'once' },
          { skill: 'special', action: 'launch', at: { row: 2, column: 3 } },
        ],
      })).toContain('任务#1 已受理');
    } finally {
      await world.stop();
    }
  });

  it('条件种植停放并在卡片就绪且阳光足够后自动执行', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      menu: [],
      board: boardState({
        sun: 25,
        cards: [{
          slot: 7, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: false, affordable: false, cooldown: 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
      }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'plant' || !('column' in action)) return { accepted: false, reason: 'unexpected' };
      fake.publish((draft) => {
        draft.board!.plants.push({
          id: 901, type: 0, name: 'peashooter', row: action.row, column: action.column,
          phase: 'idle', condition: 'intact', sleeping: false, squished: false, layers: [],
        });
        draft.board!.cards[0]!.ready = false;
        draft.board!.cards[0]!.affordable = false;
      });
    };
    const { world } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', {
        steps: [{
          skill: 'plant', plant: 'peashooter', row: 3, column: 2,
          when: 'ready_and_affordable',
        }],
      })).toContain('任务#1 已受理');
      await afterTimers(10);
      expect(transport.commands).toHaveLength(0);
      const waiting = await callTool(world, 'pvz_observe');
      expect(waiting)
        .toContain('等待中 任务#1 把 豌豆射手 种在第3排第2列，等冷却并阳光足够；占用卡 豌豆射手');

      transport.publish((draft) => {
        draft.board!.sun = 125;
        draft.board!.cards[0]!.ready = true;
        draft.board!.cards[0]!.affordable = true;
        draft.board!.cards[0]!.cooldown = 'ready';
      });
      await afterTimers(30);
      expect(transport.commands).toEqual([{ kind: 'plant', slot: 7, row: 3, column: 2 }]);
      expect(await callTool(world, 'pvz_queue')).toContain('任务#1完成');
    } finally {
      await world.stop();
    }
  });

  it('条件 plant 可以在队列中间：走到那一步停放，后面的步骤等它种下再做', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      menu: [],
      board: boardState({
        sun: 25,
        cards: [{
          slot: 0, type: 9, name: 'sun_shroom', imitates: null, cost: 25,
          ready: false, affordable: true, cooldown: 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        collectibles: [{ id: 10, kind: 'gold_coin', x: 100, y: 100, row: 1, column: 2 }],
      }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind === 'collect') {
        fake.nativeResult = { outcome: 'executed', effect: 'collectibles_collected' };
        fake.publish((draft) => {
          draft.board!.collectibles = [];
          draft.board!.sun += 25;
        });
        return;
      }
      if (action.kind !== 'plant' || !('column' in action)) return { accepted: false, reason: 'unexpected' };
      fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
      fake.publish((draft) => {
        draft.board!.plants.push({
          id: 901, type: 9, name: 'sun_shroom', row: action.row, column: action.column,
          phase: 'idle', condition: 'intact', sleeping: false, squished: false, layers: [],
        });
        draft.board!.sun -= 25;
        draft.board!.cards[0]!.ready = false;
        draft.board!.cards[0]!.affordable = false;
      });
    };
    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', {
        steps: [
          {
            skill: 'plant', plant: 'sun_shroom', row: 2, column: 2,
            when: 'ready_and_affordable',
          },
          { skill: 'collect', what: 'coins', until: 'visible_clear' },
        ],
      })).toContain('任务#1 已受理');
      await afterTimers(30);
      // 停放在第 1 步:排在后面的收集不会越过它先跑
      expect(transport.commands).toEqual([]);
      expect(await callTool(world, 'pvz_observe'))
        .toContain('等待中 任务#1 把 阳光菇 种在第2排第2列，等冷却并阳光足够；占用卡 阳光菇');

      transport.publish((draft) => {
        draft.board!.cards[0]!.ready = true;
        draft.board!.cards[0]!.cooldown = 'ready';
      });
      await waitUntil(() => host.events.some(({ event }) =>
        event.type === 'pvz.task' && event.text.includes('任务#1完成')), 3000);
      expect(transport.commands).toEqual([
        { kind: 'plant', slot: 0, row: 2, column: 2 },
        { kind: 'collect', ids: [10] },
      ]);
    } finally {
      await world.stop();
    }
  });

  it('条件 plant 必须在提交时绑定当前关卡，不能吸附到未来棋盘', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'main_menu', board: null,
    }));
    const { world } = await startWorld(transport);
    try {
      const result = await callTool(world, 'pvz_do', {
        steps: [{
          skill: 'plant', plant: 'peashooter', row: 2, column: 2,
          when: 'ready_and_affordable',
        }],
      });
      expect(result).toContain('[pvz_do 失败]');
      expect(result).toContain('只能在当前棋盘内提交，不能停放到未来关卡');
      expect(await callTool(world, 'pvz_queue')).toContain('当前没有执行中的任务');
    } finally {
      await world.stop();
    }
  });

  it('无割草机的近屋威胁会阻止来不及武装的土豆雷', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      menu: [],
      board: boardState({
        mowers: [1, 2, 3, 4].map((row) => ({
          row, kind: 'lawn_mower', state: 'ready' as const,
        })),
        cards: [{
          slot: 4, type: 4, name: 'potato_mine', imitates: null, cost: 25,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        zombies: [{
          id: 71, type: 2, name: 'pole_vaulting_zombie', row: 5, column: 1, columnPosition: 1,
          xBand: 'lawn', speedCellsPerSecond: 0.0, speed: 'fast', phase: 'walking', condition: 'intact',
          armor: 'none', shield: 'none', hypnotized: false, slowed: false,
          immobilized: false,
        }],
      }),
    }));
    const { world } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', {
        queue: 'now',
        steps: [{ skill: 'plant', plant: 'potato_mine', row: 5, column: 5 }],
      })).toContain('任务#1 已受理');
      await afterTimers(20);

      expect(transport.commands).toEqual([]);
      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('任务#1');
      expect(queue).toContain('土豆雷来不及武装');
      // 受阻回执只报读数与结论,换什么手段归她判断
      expect(queue).not.toContain('改用');
    } finally {
      await world.stop();
    }
  });

  it('visible_clear 每次验真后重新扫描新出现的掉落物', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      menu: [],
      board: boardState({
        collectibles: [{ id: 10, kind: 'gold_coin', x: 100, y: 100, row: 1, column: 2 }],
      }),
    }));
    let round = 0;
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'collect') return { accepted: false, reason: 'unexpected' };
      round += 1;
      fake.nativeResult = { outcome: 'executed', effect: 'collectibles_collected' };
      fake.publish((draft) => {
        draft.board!.collectibles = round === 1
          ? [{ id: 11, kind: 'gold_coin', x: 200, y: 120, row: 1, column: 3 }]
          : [];
      });
    };
    const { world } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', {
        steps: [{ skill: 'collect', what: 'coins', until: 'visible_clear' }],
      });
      await afterTimers(30);
      expect(transport.commands).toEqual([
        { kind: 'collect', ids: [10] },
        { kind: 'collect', ids: [11] },
      ]);
      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('已收集 2 个金币');
      expect(queue).not.toMatch(/\b(?:10|11)\b/);
    } finally {
      await world.stop();
    }
  });

  it('visible_clear 在途目标消失后重扫且不把失败批次计入收集量', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      menu: [],
      board: boardState({
        cards: [{
          slot: 7, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        collectibles: [{ id: 10, kind: 'gold_coin', x: 100, y: 100, row: 1, column: 2 }],
      }),
    }));
    let round = 0;
    transport.actionHandler = (action, fake) => {
      if (action.kind === 'plant' && 'column' in action) {
        fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
        fake.publish((draft) => {
          draft.board!.plants.push({
            id: 901, type: 0, name: 'peashooter', row: action.row, column: action.column,
            phase: 'idle', condition: 'intact', sleeping: false, squished: false, layers: [],
          });
          draft.board!.cards[0]!.ready = false;
          draft.board!.cards[0]!.affordable = false;
          draft.board!.sun -= 100;
        });
        return;
      }
      if (action.kind !== 'collect') return { accepted: false, reason: 'unexpected' };
      round += 1;
      if (round === 1) {
        fake.nativeResult = {
          outcome: 'rejected',
          reason: 'a requested collectible disappeared before it could be clicked',
        };
        fake.publish((draft) => {
          draft.board!.collectibles = [
            { id: 11, kind: 'gold_coin', x: 180, y: 120, row: 1, column: 3 },
          ];
        });
        return;
      }
      fake.nativeResult = { outcome: 'executed', effect: 'collectibles_collected' };
      fake.publish((draft) => {
        draft.board!.collectibles = [];
      });
    };
    const { world } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', {
        steps: [
          { skill: 'collect', what: 'coins', until: 'visible_clear' },
          { skill: 'plant', plant: 'peashooter', row: 2, column: 2 },
        ],
      });
      await afterTimers(100);

      expect(transport.commands).toEqual([
        { kind: 'collect', ids: [10] },
        { kind: 'collect', ids: [11] },
        { kind: 'plant', slot: 7, row: 2, column: 2 },
      ]);
      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('任务#1完成');
      expect(queue).toContain('已收集 1 个金币');
      expect(queue).not.toContain('已收集 2 个金币');
    } finally {
      await world.stop();
    }
  });

  it('多目标收集部分验真后保留计数并继续后续步骤', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      menu: [],
      board: boardState({
        sun: 100,
        cards: [{
          slot: 7, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        collectibles: [
          { id: 10, kind: 'gold_coin', x: 100, y: 100, row: 1, column: 2 },
          { id: 11, kind: 'gold_coin', x: 180, y: 120, row: 1, column: 3 },
        ],
      }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind === 'collect') {
        fake.nativeResult = {
          outcome: 'executed', effect: 'collectibles_collected',
          batch: {
            requested: 2, attempted: 1, released: 1,
            verified: 1, stale: 1, scopeStopped: false,
          },
        };
        fake.publish((draft) => {
          draft.board!.collectibles = [];
          draft.board!.sun += 25;
        });
        return;
      }
      if (action.kind === 'plant' && 'column' in action) {
        fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
        fake.publish((draft) => {
          draft.board!.plants.push({
            id: 901, type: 0, name: 'peashooter', row: action.row, column: action.column,
            phase: 'idle', condition: 'intact', sleeping: false, squished: false, layers: [],
          });
          draft.board!.cards[0]!.ready = false;
          draft.board!.cards[0]!.affordable = false;
          draft.board!.sun -= 100;
        });
        return;
      }
      return { accepted: false, reason: 'unexpected' };
    };
    const { world } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', {
        steps: [
          { skill: 'collect', what: 'coins', until: 'once' },
          { skill: 'plant', plant: 'peashooter', row: 2, column: 2 },
        ],
      });
      await afterTimers(60);

      expect(transport.commands).toEqual([
        { kind: 'collect', ids: [10, 11] },
        { kind: 'plant', slot: 7, row: 2, column: 2 },
      ]);
      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('任务#1部分完成');
      expect(queue).toContain('已确认收集 1 个金币');
      expect(queue).toContain('本批确认 1/2 个');
      expect(queue).toContain('1 个在点击前已消失');
      expect(queue).toContain('豌豆射手 已种在第2排第2列');
      expect(queue).not.toContain('未验真');
    } finally {
      await world.stop();
    }
  });

  it('visible_clear 对 current-target 投递失败只按精确原因有界重扫', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      menu: [],
      board: boardState({
        collectibles: [{ id: 10, kind: 'gold_coin', x: 100, y: 100, row: 1, column: 2 }],
      }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'collect') return { accepted: false, reason: 'unexpected' };
      fake.nativeResult = {
        outcome: 'rejected',
        reason: 'failed to post collectible input from a current target',
      };
      fake.publish((draft) => {
        draft.board!.collectibles[0]!.x += 1;
      });
    };
    const { world } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', {
        steps: [{ skill: 'collect', what: 'coins', until: 'visible_clear' }],
      });
      await afterTimers(30);

      expect(transport.commands).toEqual(Array.from({ length: 3 }, () => ({
        kind: 'collect', ids: [10],
      })));
      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('步受阻');
      expect(queue).not.toMatch(/已收集 [1-9]/);
    } finally {
      await world.stop();
    }
  });

  it('visible_clear 在收集状态超时后有界重试同一可见目标', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      menu: [],
      board: boardState({
        collectibles: [{ id: 10, kind: 'gold_coin', x: 100, y: 100, row: 1, column: 2 }],
      }),
    }));
    let attempts = 0;
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'collect') return { accepted: false, reason: 'unexpected' };
      attempts += 1;
      if (attempts === 1) {
        fake.nativeResult = {
          outcome: 'rejected',
          reason: 'collectible did not enter the collection state before timeout',
        };
        fake.publish((draft) => {
          draft.board!.collectibles[0]!.x += 1;
        });
        return;
      }
      fake.nativeResult = { outcome: 'executed', effect: 'collectibles_collected' };
      fake.publish((draft) => {
        draft.board!.collectibles = [];
      });
    };
    const { world } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', {
        steps: [{ skill: 'collect', what: 'coins', until: 'visible_clear' }],
      });
      await afterTimers(50);

      expect(transport.commands).toEqual([
        { kind: 'collect', ids: [10] },
        { kind: 'collect', ids: [10] },
      ]);
      expect(await callTool(world, 'pvz_queue')).toContain('已收集 1 个金币');
    } finally {
      await world.stop();
    }
  });

  it('visible_clear 连续收集状态超时后标记部分完成并继续条件种植', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      menu: [],
      board: boardState({
        sun: 100,
        cards: [{
          slot: 7, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        collectibles: [{ id: 10, kind: 'gold_coin', x: 100, y: 100, row: 1, column: 2 }],
      }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind === 'collect') {
        fake.nativeResult = {
          outcome: 'rejected',
          reason: 'collectible did not enter the collection state before timeout',
        };
        fake.publish((draft) => {
          draft.board!.collectibles[0]!.x += 1;
        });
        return;
      }
      if (action.kind === 'plant' && 'column' in action) {
        fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
        fake.publish((draft) => {
          draft.board!.plants.push({
            id: 901, type: 0, name: 'peashooter', row: action.row, column: action.column,
            phase: 'idle', condition: 'intact', sleeping: false, squished: false, layers: [],
          });
          draft.board!.cards[0]!.ready = false;
          draft.board!.cards[0]!.affordable = false;
          draft.board!.sun -= 100;
        });
        return;
      }
      return { accepted: false, reason: 'unexpected' };
    };
    const { world } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', {
        steps: [
          { skill: 'collect', what: 'coins', until: 'visible_clear' },
          {
            skill: 'plant', plant: 'peashooter', row: 2, column: 2,
            when: 'ready_and_affordable',
          },
        ],
      });
      await afterTimers(80);

      expect(transport.commands).toEqual([
        { kind: 'collect', ids: [10] },
        { kind: 'collect', ids: [10] },
        { kind: 'plant', slot: 7, row: 2, column: 2 },
      ]);
      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('任务#1部分完成');
      expect(queue).toContain('收集状态连续超时');
      expect(queue).toContain('豌豆射手 已种在第2排第2列');
    } finally {
      await world.stop();
    }
  });

  it('visible_clear 收集状态超时后关卡运行变化时不继续后续种植', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      menu: [],
      board: boardState({
        sun: 100,
        cards: [{
          slot: 7, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        collectibles: [{ id: 10, kind: 'gold_coin', x: 100, y: 100, row: 1, column: 2 }],
      }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'collect') return { accepted: false, reason: 'unexpected' };
      fake.nativeResult = {
        outcome: 'rejected',
        reason: 'collectible did not enter the collection state before timeout',
      };
      fake.publish((draft) => {
        draft.board!.runId += 1;
      });
    };
    const { world } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', {
        steps: [
          { skill: 'collect', what: 'coins', until: 'visible_clear' },
          {
            skill: 'plant', plant: 'peashooter', row: 2, column: 2,
            when: 'ready_and_affordable',
          },
        ],
      });
      await afterTimers(50);

      expect(transport.commands).toEqual([{ kind: 'collect', ids: [10] }]);
      expect(await callTool(world, 'pvz_queue')).toContain('第 1/2 步受阻');
    } finally {
      await world.stop();
    }
  });

  it('visible_clear 等待新快照时立即服从任务取消', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      menu: [],
      board: boardState({
        collectibles: [{ id: 10, kind: 'gold_coin', x: 100, y: 100, row: 1, column: 2 }],
      }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind === 'cancel') {
        fake.nativeResult = { outcome: 'executed' };
        return;
      }
      if (action.kind !== 'collect') return { accepted: false, reason: 'unexpected' };
      fake.nativeResult = {
        outcome: 'rejected',
        reason: 'a requested collectible disappeared before it could be clicked',
      };
      fake.publish((draft) => {
        draft.board!.collectibles[0]!.x += 1;
      }, 100);
    };
    const { world } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', {
        steps: [{ skill: 'collect', what: 'coins', until: 'visible_clear' }],
      });
      await afterTimers(5);
      expect(transport.commands).toEqual([{ kind: 'collect', ids: [10] }]);

      expect(await callTool(world, 'pvz_stop')).toContain('已停止任务#1');
      await afterTimers(120);
      expect(transport.commands).toEqual([
        { kind: 'collect', ids: [10] },
        { kind: 'cancel' },
      ]);
      expect(await callTool(world, 'pvz_queue')).toContain('任务#1 未完成');
    } finally {
      await world.stop();
    }
  });

  it.each([
    {
      label: 'once',
      collectible: { id: 10, kind: 'gold_coin', x: 100, y: 100, row: 1, column: 2 },
      step: { skill: 'collect', what: 'coins', until: 'once' },
      reason: 'a requested collectible disappeared before it could be clicked',
      change: 'same-run',
    },
    {
      label: 'award',
      collectible: { id: 12, kind: 'trophy', x: 400, y: 300, row: null, column: null },
      step: { skill: 'collect', what: 'award', until: 'visible_clear' },
      reason: 'a requested collectible disappeared before it could be clicked',
      change: 'same-run',
    },
    {
      label: 'usable_seed',
      collectible: { id: 13, kind: 'usable_seed', x: 250, y: 180, row: 2, column: 3 },
      step: { skill: 'collect', what: 'usable_seed', until: 'once' },
      reason: 'failed to post collectible input from a current target',
      change: 'same-run',
    },
    {
      label: 'board change',
      collectible: { id: 10, kind: 'gold_coin', x: 100, y: 100, row: 1, column: 2 },
      step: { skill: 'collect', what: 'coins', until: 'visible_clear' },
      reason: 'a requested collectible disappeared before it could be clicked',
      change: 'new-run',
    },
    {
      label: 'near-match unknown failure',
      collectible: { id: 10, kind: 'gold_coin', x: 100, y: 100, row: 1, column: 2 },
      step: { skill: 'collect', what: 'coins', until: 'visible_clear' },
      reason: 'failed to post collectible input from a current target after an unknown failure',
      change: 'same-run',
    },
  ])('$label 不触发瞬态重扫', async ({ collectible, step, reason, change }) => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      menu: [],
      board: boardState({ collectibles: [collectible] }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'collect') return { accepted: false, reason: 'unexpected' };
      fake.nativeResult = { outcome: 'rejected', reason };
      fake.publish((draft) => {
        if (change === 'new-run') draft.board!.runId += 1;
        else draft.board!.collectibles[0]!.x += 1;
      });
    };
    const { world } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', { steps: [step] });
      await afterTimers(30);

      expect(transport.commands).toHaveLength(1);
      expect(await callTool(world, 'pvz_queue')).toContain('步受阻');
    } finally {
      await world.stop();
    }
  });

  it('冒险 1-5 以植物名和格位执行坚果保龄球并消费专属原生回执', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', scene: 3, mode: 0, menu: [],
      board: boardState({
        level: 5,
        sun: 0,
        cards: [{
          slot: 0, type: 3, name: 'wall_nut', imitates: null, cost: null,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        allowedSpecialActions: ['bowling'],
        special: {
          phase: 'ready', settled: true,
          targets: [
            target('bowling', 'card', { slot: 0 }),
            target('bowling', 'cell', { row: 3, column: 2 }),
          ],
        },
      }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'special' || action.action !== 'bowling') {
        return { accepted: false, reason: '仅接受坚果保龄球' };
      }
      fake.nativeResult = { outcome: 'executed', effect: 'bowling_launched' };
      fake.publish((draft) => {
        draft.board!.cards[0] = {
          slot: 0, type: 4, name: 'potato_mine', imitates: null, cost: null,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        };
      });
    };
    const { world } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', {
        steps: [{
          skill: 'special', action: 'bowling', card: 'wall_nut',
          at: { row: 3, column: 2 },
        }],
      })).toContain('任务#1 已受理');
      await afterTimers(30);

      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('任务#1完成');
      expect(queue).toContain('特殊操作 bowling 已完成');
      expect(transport.commands).toEqual([{
        kind: 'special', action: 'bowling', slot: 0, row: 3, column: 2,
      }]);
      expect(transport.commandContexts[0]).toMatchObject({
        expectedCardType: 3, expectedCardImitates: null,
      });
    } finally {
      await world.stop();
    }
  });

  it('传送带卡位短暂变化时按植物语义重选并有界重试', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', scene: 3, mode: 0, menu: [],
      board: boardState({
        runId: 110, level: 10, sun: 0,
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: null,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
      }),
    }));
    let attempts = 0;
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'plant' || !('column' in action)) return { accepted: false, reason: 'unexpected' };
      attempts += 1;
      if (attempts === 1) {
        fake.nativeResult = {
          outcome: 'rejected', reason: 'planting slot does not hold the plant the action asked for',
        };
        setTimeout(() => fake.publish((draft) => {
          draft.board!.cards[0]!.slot = 1;
          draft.board!.cards[0]!.x = 133;
        }), 5);
        return;
      }
      fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
      fake.publish((draft) => {
        draft.board!.plants.push({
          id: 1101, type: 0, name: 'peashooter', row: action.row, column: action.column,
          phase: 'idle', condition: 'intact', sleeping: false, squished: false, layers: [],
        });
        draft.board!.cards = [];
      });
    };
    const { world } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', {
        steps: [{ skill: 'plant', plant: 'peashooter', row: 2, column: 2 }],
      })).toContain('任务#1 已受理');
      await afterTimers(60);

      expect(transport.commands).toEqual([
        { kind: 'plant', slot: 0, row: 2, column: 2 },
        { kind: 'plant', slot: 1, row: 2, column: 2 },
      ]);
      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('任务#1完成');
      expect(queue).toContain('传送带卡位稳定后自动重选 1 次');
    } finally {
      await world.stop();
    }
  });

  it('传送带按同类卡在带子上的张数算预算：四颗坚果就能一次排三次投掷', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', scene: 3, mode: 0, menu: [],
      board: boardState({
        runId: 113, level: 10, sun: 0,
        cards: [          {
            slot: 0, type: 3, name: 'wall_nut', imitates: null, cost: null,
            ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
          },
          {
            slot: 1, type: 3, name: 'wall_nut', imitates: null, cost: null,
            ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 133, y: 40,
          },
          {
            slot: 2, type: 3, name: 'wall_nut', imitates: null, cost: null,
            ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 186, y: 40,
          },
          {
            slot: 3, type: 3, name: 'wall_nut', imitates: null, cost: null,
            ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 239, y: 40,
          },],
        allowedSpecialActions: ['bowling'],
        special: {
          phase: 'ready', settled: true,
          targets: [
            target('bowling', 'card', { slot: 0 }),
            target('bowling', 'card', { slot: 1 }),
            target('bowling', 'card', { slot: 2 }),
            target('bowling', 'card', { slot: 3 }),
            target('bowling', 'cell', { row: 3, column: 2 }),
            target('bowling', 'cell', { row: 4, column: 2 }),
            target('bowling', 'cell', { row: 5, column: 2 }),
          ],
        },
      }),
    }));
    transport.nativeResultDelayMs = 400;
    const { world } = await startWorld(transport);
    try {
      const throwAt = (row: number) => ({
        skill: 'special', action: 'bowling', card: '坚果', at: { row, column: 2 },
      });
      expect(await callTool(world, 'pvz_do', {
        steps: [throwAt(3), throwAt(4), throwAt(5)],
      })).toContain('任务#1 已受理');

      // 带子上只有四颗,一次要五颗就超了。
      expect(await callTool(world, 'pvz_do', {
        steps: [throwAt(3), throwAt(4), throwAt(5), throwAt(3), throwAt(4)],
      })).toContain('传送带上「坚果」此刻有 4 张，这次要 5 张；等前面那些落定并收到新快照再排');
    } finally {
      await world.stop();
    }
  });

  it('传送带上不同类的卡各自算账，一次一张互不相碍', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', scene: 3, mode: 0, menu: [],
      board: boardState({
        runId: 114, level: 10, sun: 0,
        cards: [
          {
            slot: 0, type: 0, name: 'peashooter', imitates: null, cost: null,
            ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
          },
          {
            slot: 1, type: 3, name: 'wall_nut', imitates: null, cost: null,
            ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 133, y: 40,
          },
        ],
        allowedSpecialActions: ['bowling'],
        special: {
          phase: 'ready', settled: true,
          targets: [
            target('bowling', 'card', { slot: 1 }),
            target('bowling', 'cell', { row: 3, column: 2 }),
          ],
        },
      }),
    }));
    transport.nativeResultDelayMs = 400;
    const { world } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', {
        steps: [
          { skill: 'plant', plant: 'peashooter', row: 2, column: 2 },
          { skill: 'special', action: 'bowling', card: '坚果', at: { row: 3, column: 2 } },
        ],
      })).toContain('任务#1 已受理');

      // 豌豆射手带子上只有一张,已经排掉了。
      expect(await callTool(world, 'pvz_do', {
        steps: [{ skill: 'plant', plant: 'peashooter', row: 4, column: 2, when: 'ready' }], queue: 'append',
      })).toContain('传送带上「豌豆射手」此刻有 1 张，这次要 1 张，在途的队列与触发器已经占了 1 张');
    } finally {
      await world.stop();
    }
  });

  it('传送带上已武装的触发器占掉同类卡的份额，不能再绑定等待任务', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', scene: 3, mode: 0, menu: [],
      board: boardState({
        runId: 115, level: 10, sun: 0,
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: null,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0,
          cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
      }),
    }));
    const { world } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_arm', {
        when: { zombie: { row: 2, maxColumn: 5 } },
        steps: [{ skill: 'plant', plant: 'peashooter', row: 2, column: 2 }],
      })).toContain('触发器#1 已武装');

      expect(await callTool(world, 'pvz_do', {
        steps: [{ skill: 'plant', plant: 'peashooter', row: 3, column: 2, when: 'ready' }],
      })).toContain('在途的队列与触发器已经占了 1 张');

      // 收取与铲除不碰卡片,照样受理。
      expect(await callTool(world, 'pvz_do', {
        steps: [{ skill: 'collect', what: 'coins', until: 'once' }], queue: 'append',
      })).toContain('已受理');
    } finally {
      await world.stop();
    }
  });

  it('棋盘快照:首份 flush 叫醒;近期投过快照的变化只搭车;隔久了再变才再叫醒', async () => {
    const now = vi.spyOn(Date, 'now');
    const base = 1_700_000_000_000;
    now.mockReturnValue(base);
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    const { world, host } = await startWorld(transport);
    try {
      const triggers = () => host.deliveryCalls
        .filter((call) => call.kind === 'deferred' && call.type === 'pvz.board.snapshot')
        .map((call) => call.trigger);
      expect(triggers()).toEqual(['flush']);

      now.mockReturnValue(base + 2_000);
      transport.publish((draft) => { draft.board!.sun += 25; });
      await afterTimers(20);
      for (const event of host.deferred.splice(0)) await event.render();
      expect(triggers()).toEqual(['flush', 'piggyback']);

      // 上一份在 base+2s 发车刻渲染过;要再隔满间隔才 flush
      now.mockReturnValue(base + 20_000);
      transport.publish((draft) => { draft.board!.sun += 25; });
      await afterTimers(20);
      for (const event of host.deferred.splice(0)) await event.render();
      expect(triggers()).toEqual(['flush', 'piggyback', 'piggyback']);

      now.mockReturnValue(base + 60_000);
      transport.publish((draft) => { draft.board!.sun += 25; });
      await afterTimers(20);
      for (const event of host.deferred.splice(0)) await event.render();
      expect(triggers()).toEqual(['flush', 'piggyback', 'piggyback', 'flush']);
    } finally {
      now.mockRestore();
      await world.stop();
    }
  });

  it('transport 断开后清空快照并把故障交给生命周期宿主', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    const failures: Error[] = [];
    const { world } = await startWorld(transport, {}, {
      onTransportFailure: (error) => failures.push(error),
    });
    try {
      expect(await callTool(world, 'pvz_observe')).toContain('画面=棋盘');

      const failure = new Error('named pipe closed');
      transport.emit('disconnect', failure);

      expect(failures).toEqual([failure]);
      expect(await callTool(world, 'pvz_observe')).toContain('尚未取得 PvZ 状态');
      expect(world.console().badges?.find((badge) => badge.label === '画面')?.value)
        .toBe('未连接');
    } finally {
      await world.stop();
    }
  });

  it('关卡内只即时投递关卡进度，档案进度留到菜单', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      board: boardState(),
    }));
    const { world, host } = await startWorld(transport);
    try {
      const baseline = host.events.length;
      transport.publish((draft) => {
        draft.profile!.adventureLevel += 1;
        draft.board!.progress = {
          kind: 'complete', current: null, target: null, stage: null, label: '关卡完成',
        };
      });
      await afterTimers();
      const emitted = host.events.slice(baseline).filter(({ event }) => [
        'pvz.progress.committed', 'pvz.level.progress',
      ].includes(event.type));
      expect(emitted.map(({ event }) => event.type)).toEqual(['pvz.level.progress']);
      expect(emitted.filter(({ options }) => options?.trigger === 'flush')).toHaveLength(1);
    } finally {
      await world.stop();
    }
  });

  it('五秒短窗内的同类普通掉落只唤醒一次，但最新快照仍会搭下一班车', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      board: boardState(),
    }));
    const { world, host } = await startWorld(transport);
    try {
      host.events.length = 0;
      host.deferred.length = 0;

      transport.publish((draft) => {
        draft.board!.collectibles.push({
          id: 100, kind: 'gold_coin', x: 300, y: 180, row: 2, column: 3,
        });
      });
      await afterTimers();
      transport.publish((draft) => {
        draft.board!.collectibles.push({
          id: 101, kind: 'gold_coin', x: 340, y: 180, row: 2, column: 4,
        });
      });
      await afterTimers();

      const firstWindow = host.events.filter(({ event }) =>
        event.type === 'pvz.collectible.appeared');
      expect(firstWindow).toHaveLength(2);
      expect(firstWindow.map(({ options }) => options?.deliver)).toEqual([undefined, false]);
      expect(host.deferred).toHaveLength(1);
      const rendered = await host.deferred[0]!.render();
      expect(rendered).toContain('收集物 金币×2');

      transport.publish((draft) => {
        draft.monotonicMs += 5000;
        draft.board!.collectibles.push({
          id: 102, kind: 'gold_coin', x: 380, y: 180, row: 2, column: 5,
        });
      });
      await afterTimers();

      const all = host.events.filter(({ event }) => event.type === 'pvz.collectible.appeared');
      expect(all.map(({ options }) => options?.deliver)).toEqual([undefined, false, undefined]);
      expect(host.deferred).toHaveLength(2);
    } finally {
      await world.stop();
    }
  });

  it('紧急威胁发车前已经挂好发车刻棋盘快照', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      menu: [],
      board: boardState({
        zombies: [{
          id: 1, type: 2, name: 'conehead', row: 2, column: 8, columnPosition: 8, xBand: 'far', speedCellsPerSecond: 0.0,
          speed: 'normal', phase: 'walking', condition: 'intact', armor: 'intact',
          shield: 'none', hypnotized: false, slowed: false, immobilized: false,
        }],
      }),
    }));
    const { world, host } = await startWorld(transport);
    try {
      host.events.length = 0;
      host.deferred.length = 0;
      host.deliveryCalls.length = 0;

      transport.publish((draft) => {
        draft.board!.zombies[0]!.column = 3;
        draft.board!.zombies[0]!.xBand = 'near';
      });
      await afterTimers();

      const deferredIndex = host.deliveryCalls.findIndex((call) =>
        call.kind === 'deferred' && call.type === 'pvz.board.snapshot');
      const threatIndex = host.deliveryCalls.findIndex((call) =>
        call.kind === 'event' && call.type === 'pvz.threat.approaching');
      expect(deferredIndex).toBeGreaterThanOrEqual(0);
      expect(threatIndex).toBeGreaterThan(deferredIndex);
      expect(host.events.find(({ event }) => event.type === 'pvz.threat.approaching')?.options)
        .toMatchObject({ trigger: 'flush' });
    } finally {
      await world.stop();
    }
  });

  it('没有独立事件的语义棋盘变化也会合并成一份最新快照', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      menu: [],
      board: boardState({
        zombies: [{
          id: 1, type: 0, name: 'zombie', row: 1, column: 9, columnPosition: 9, xBand: 'far', speedCellsPerSecond: 0.0,
          speed: 'normal', phase: 'walking', condition: 'intact', armor: 'none',
          shield: 'none', hypnotized: false, slowed: false, immobilized: false,
        }],
      }),
    }));
    const { world, host } = await startWorld(transport);
    try {
      host.events.length = 0;
      host.deferred.length = 0;
      host.deliveryCalls.length = 0;

      transport.publish((draft) => {
        draft.board!.zombies[0]!.column = 8;
        draft.board!.zombies[0]!.columnPosition = 8;
      });
      await afterTimers();
      transport.publish((draft) => {
        draft.board!.zombies[0]!.column = 7;
        draft.board!.zombies[0]!.columnPosition = 7;
      });
      await afterTimers();

      expect(host.events).toHaveLength(0);
      expect(host.deferred.filter((event) => event.type === 'pvz.board.snapshot')).toHaveLength(1);
      const rendered = await host.deferred[0]!.render();
      expect(rendered).toMatch(/第1排 .*←普通僵尸7\.0列/);
    } finally {
      await world.stop();
    }
  });

  it('任务终态先挂最新棋盘再投递不含重复世界的回执', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      menu: [],
      board: boardState({
        plants: [{
          id: 10, type: 0, name: 'peashooter', row: 2, column: 3,
          condition: 'intact', sleeping: false, squished: false, layers: [],
        }],
      }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'shovel') return { accepted: false, reason: 'unexpected action' };
      fake.publish((draft) => {
        draft.board!.plants = [];
      });
    };
    const { world, host } = await startWorld(transport);
    try {
      host.events.length = 0;
      host.deferred.length = 0;
      host.deliveryCalls.length = 0;

      const accepted = await callTool(world, 'pvz_do', {
        steps: [{ skill: 'shovel', row: 2, column: 3 }],
      });
      expect(accepted).toContain('[PvZ队列]');
      expect(accepted).not.toContain('[PvZ 状态');
      await afterTimers(30);

      const report = host.events.find(({ event }) => event.type === 'pvz.task');
      expect(report).toBeDefined();
      expect(report!.event.text).toContain('任务#1完成');
      expect(report!.event.text).not.toContain('[PvZ 状态');
      expect(report!.event.text).not.toContain('[当前战术快照]');
      expect(report!.event.text.match(/任务#1完成/g)).toHaveLength(1);
      const deferred = host.deferred.filter((event) => event.type === 'pvz.board.snapshot');
      expect(deferred).toHaveLength(1);
      expect(await deferred[0]!.render()).toContain('棋盘 5排×9列（第1列靠房子');

      const deferredIndex = host.deliveryCalls.findIndex((call) =>
        call.kind === 'deferred' && call.type === 'pvz.board.snapshot');
      const reportIndex = host.deliveryCalls.findIndex((call) =>
        call.kind === 'event' && call.type === 'pvz.task');
      expect(deferredIndex).toBeGreaterThanOrEqual(0);
      expect(reportIndex).toBeGreaterThan(deferredIndex);
    } finally {
      await world.stop();
    }
  });

  it('同一菜单按钮在短动画中反复可用时不重复唤醒', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'award',
      board: null,
      menu: [{
        id: 'advance', label: 'Continue', enabled: false,
        x: 400, y: 500, state: null, record: null,
      }],
    }));
    const { world, host } = await startWorld(transport);
    try {
      host.events.length = 0;
      transport.publish((draft) => {
        draft.menu[0].enabled = true;
      });
      await afterTimers();
      transport.publish((draft) => {
        draft.menu[0].enabled = false;
      });
      await afterTimers();
      transport.publish((draft) => {
        draft.menu[0].enabled = true;
      });
      await afterTimers();

      const ready = host.events.filter(({ event }) => event.type === 'pvz.menu.ready');
      expect(ready).toHaveLength(2);
      expect(ready[0]?.options).toMatchObject({ trigger: 'flush' });
      expect(ready[1]?.options).toMatchObject({ deliver: false });
    } finally {
      await world.stop();
    }
  });

  it('同一快照按事实顺序入批，近屋威胁在整帧入队后立即发车', async () => {
    const board = boardState({
      zombies: [{
        id: 1, type: 2, name: 'conehead', row: 4, column: 2, columnPosition: 2, xBand: 'near', speedCellsPerSecond: 0.0,
        condition: 'intact', armor: 'intact', shield: 'none', hypnotized: false,
        slowed: false, immobilized: false,
      }],
    });
    board.mowers = board.mowers.filter((mower) => mower.row !== 4);
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board }));
    const { world, host } = await startWorld(transport);
    try {
      host.events.length = 0;
      transport.publish((draft) => {
        draft.board!.zombies[0].xBand = 'lawn';
        draft.board!.collectibles.push({
          id: 200, kind: 'gold_coin', x: 320, y: 180, row: 3, column: 3,
        });
      });
      await afterTimers();

      const emitted = host.events.filter(({ event }) => [
        'pvz.collectible.appeared', 'pvz.threat.close',
      ].includes(event.type));
      expect(emitted.map(({ event }) => event.type)).toEqual([
        'pvz.threat.close', 'pvz.collectible.appeared',
      ]);
      expect(emitted.map(({ options }) => options?.trigger)).toEqual(['piggyback', 'flush']);
      expect(emitted[0]?.event.text).toContain('这排没有可用割草机');
    } finally {
      await world.stop();
    }
  });
});

function target(
  action: string,
  kind: PvzSpecialTarget['kind'],
  values: Partial<Omit<PvzSpecialTarget, 'action' | 'kind'>> = {},
): PvzSpecialTarget {
  return {
    action,
    kind,
    id: null,
    slot: null,
    row: null,
    column: null,
    ...values,
  };
}

interface WhackTestTarget {
  id: number;
  row: number;
  column: number;
}

function whackQueueSteps(count = WHACK_SKILL_QUEUE_LENGTH): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () => ({
    skill: 'special',
    action: 'whack',
    targets: [{ kind: 'zombie', scope: 'all_visible' }],
  }));
}

function whackBoard(
  targets: readonly WhackTestTarget[],
  wave = 0,
): ReturnType<typeof boardState> {
  return boardState({
    level: 0,
    progress: { kind: 'flags', current: wave, target: 10, stage: null, label: `${wave}/10 波` },
    zombies: targets.map(({ id, row, column }) => ({
      id, type: 0, name: 'zombie', row, column, columnPosition: column,
      xBand: 'lawn' as const, speedCellsPerSecond: 0,
      condition: 'intact' as const, armor: 'none' as const, shield: 'none' as const,
      hypnotized: false, slowed: false, immobilized: false,
    })),
    allowedSpecialActions: ['whack'],
    special: {
      phase: 'ready',
      settled: true,
      targets: targets.map(({ id, row, column }) =>
        target('whack', 'zombie', { id, row, column })),
    },
  });
}

function setWhackBatch(
  draft: PvzSnapshot,
  targets: readonly WhackTestTarget[],
  wave = draft.board?.progress.current ?? 0,
): void {
  const board = whackBoard(targets, wave);
  draft.board!.progress = board.progress;
  draft.board!.zombies = board.zombies;
  draft.board!.allowedSpecialActions = board.allowedSpecialActions;
  draft.board!.special = board.special;
}

function installRollingWhackStateMachine(
  transport: FakePvzTransport,
  firstTargetId: number,
): void {
  transport.actionHandler = (action, fake) => {
    if (action.kind === 'cancel') {
      fake.nativeResult = { outcome: 'executed' };
      return;
    }
    if (action.kind !== 'special' || action.action !== 'whack') {
      return { accepted: false, reason: 'unexpected action' };
    }
    const requested = action.targetIds?.length ?? 0;
    fake.nativeResult = {
      outcome: 'executed',
      effect: 'target_changed',
          batch: {
            requested, attempted: requested, released: requested,
            verified: requested, stale: 0, scopeStopped: false,
          },
    };
    const id = firstTargetId + fake.commands.length;
    fake.publish((draft) => setWhackBatch(draft, [{ id, row: 3, column: 5 }]));
  };
}

async function flushImmediateWhackPrefetchFallback(): Promise<void> {
  await afterTimers(10);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition timed out');
    await afterTimers(1);
  }
}

describe('PvzWorld 窗口可操作性', () => {
  it('窗口被裁掉时入队与截图都拒绝，并说清量到了什么', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    const { world, host } = await startWorld(transport);

    transport.publish((draft) => {
      draft.presentation = {
        managed: false, onScreen: false, minimized: false, clientWidth: 1200, clientHeight: 900,
      };
    });
    await afterTimers();

    const queued = await callTool(world, 'pvz_do', {
      steps: [{ skill: 'collect', what: 'coins' }],
    });
    expect(queued).toContain('[pvz_do 失败]');
    expect(queued).toContain('1200×900');
    expect(transport.commands).toEqual([]);
    await expect(world.photoFrame()).rejects.toThrow('游戏窗口当前不可操作');

    expect(host.events.map(({ event }) => event.text))
      .toContainEqual(expect.stringContaining('游戏窗口当前不可操作'));
    const lamp = world.console().lamps?.find(({ label }) => label === '窗口');
    expect(lamp).toMatchObject({ state: 'error' });
    expect(world.console().badges).toContainEqual(
      expect.objectContaining({ label: '窗口', value: '1200×900 出屏', tone: 'off' }),
    );

    await world.stop();
  });

  it('窗口摆回来之后照常入队', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    const { world } = await startWorld(transport);

    transport.publish((draft) => {
      draft.presentation = {
        managed: false, onScreen: true, minimized: false, clientWidth: 800, clientHeight: 601,
      };
    });
    await afterTimers();
    expect(await callTool(world, 'pvz_do', { steps: [{ skill: 'collect', what: 'coins' }] }))
      .toContain('800×601');

    transport.publish((draft) => {
      draft.presentation = {
        managed: true, onScreen: true, minimized: false, clientWidth: 800, clientHeight: 600,
      };
    });
    await afterTimers();
    expect(await callTool(world, 'pvz_do', { steps: [{ skill: 'collect', what: 'coins' }] }))
      .toContain('已受理');

    await world.stop();
  });
});

describe('PvzWorld 特殊关卡', () => {
  it.each([
    { outcome: 'won' as const, screen: 'award' as const, type: 'pvz.level.won' },
    { outcome: 'lost' as const, screen: 'defeat' as const, type: 'pvz.level.lost' },
  ])('Whack 开局与 $outcome 终态保持即时投递', async ({ outcome, screen, type }) => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'loading', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      board: null, menu: [],
    }));
    const { world, host } = await startWorld(transport);
    try {
      host.events.length = 0;
      host.deferred.length = 0;
      transport.publish((draft) => {
        draft.screen = 'board';
        draft.scene = 3;
        draft.board = boardState({
          level: 0,
          allowedSpecialActions: ['whack'],
          special: { phase: 'ready', settled: true, targets: [] },
        });
      });
      await afterTimers();

      const started = host.events.find(({ event }) => event.type === 'pvz.level.started');
      expect(started).toBeDefined();
      expect(started?.options?.deliver).not.toBe(false);
      expect(started?.event.text.match(/\[PvZ 状态 r\d+\]/g)).toHaveLength(1);
      expect(host.deferred.filter((event) => event.type === 'pvz.board.snapshot')).toHaveLength(1);

      host.events.length = 0;
      transport.publish((draft) => {
        draft.screen = screen;
        draft.board = null;
        draft.lastRun = { resultId: 1, runId: 1, mode: 30, level: 0, outcome };
      });
      await afterTimers();

      const terminal = host.events.find(({ event }) => event.type === type);
      expect(terminal).toBeDefined();
      expect(terminal?.options?.deliver).not.toBe(false);
    } finally {
      await world.stop();
    }
  });

  it('Whack 棋盘的掉落物与卡片事件共享一份发车刻棋盘', async () => {
    const board = whackBoard([{ id: 40, row: 2, column: 6 }]);
    board.sun = 0;
    board.cards = [{
      slot: 0, type: 4, name: 'potato_mine', imitates: null, cost: 25,
      ready: false, affordable: false, cooldown: 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
    }];
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board,
    }));
    const { world, host } = await startWorld(transport);
    try {
      host.events.length = 0;
      host.deferred.length = 0;
      transport.publish((draft) => {
        draft.board!.sun = 25;
        draft.board!.collectibles = [
          { id: 90, kind: 'gold_coin', x: 360, y: 190, row: 2, column: 4 },
        ];
        Object.assign(draft.board!.cards[0]!, {
          ready: true, affordable: true, cooldown: 'ready',
        });
      });
      await afterTimers(20);

      for (const type of ['pvz.collectible.appeared', 'pvz.card.ready']) {
        const delivered = host.events.find(({ event }) => event.type === type);
        expect(delivered?.options?.deliver).not.toBe(false);
        expect(delivered?.event.text).not.toMatch(/\[当前战术快照\]|\[PvZ 状态 r/);
      }
      const deferred = host.deferred.filter((event) => event.type === 'pvz.board.snapshot');
      expect(deferred).toHaveLength(1);
      const tactical = await deferred[0]!.render();
      expect(tactical).toContain('土豆雷[25阳光/可用]');
      expect(tactical).toContain('收集物 金币×1');
    } finally {
      await world.stop();
    }
  });

  it('Whack 新目标与支援机会同帧时由支援事件统一发车', async () => {
    const board = whackBoard([]);
    board.cards = [{
      slot: 0, type: 4, name: 'potato_mine', imitates: null, cost: 25,
      ready: false, affordable: false, cooldown: 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
    }];
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board,
    }));
    const { world, host } = await startWorld(transport);
    try {
      host.events.length = 0;
      host.deferred.length = 0;
      host.deliveryCalls.length = 0;
      transport.publish((draft) => {
        setWhackBatch(draft, [{ id: 50, row: 3, column: 6 }]);
        draft.board!.collectibles = [
          { id: 91, kind: 'gold_coin', x: 360, y: 190, row: 2, column: 4 },
        ];
        Object.assign(draft.board!.cards[0]!, {
          ready: true, affordable: true, cooldown: 'ready',
        });
      });
      await afterTimers();

      expect(host.deferred.map((event) => event.type)).toEqual(['pvz.target.ready']);
      const targetCall = host.deliveryCalls.find((call) =>
        call.kind === 'deferred' && call.type === 'pvz.target.ready');
      expect(targetCall).toMatchObject({ trigger: 'piggyback' });
      expect(host.events.find(({ event }) => event.type === 'pvz.card.ready')?.options)
        .toMatchObject({ trigger: 'flush' });
      const out = await host.deferred[0]!.render();
      const rendered = typeof out === 'string' ? out : out?.text;
      expect(rendered?.match(/\[PvZ 状态 r\d+\]/g)).toHaveLength(1);
      expect(rendered).toMatch(/土豆雷\[25阳光\/可用\][\s\S]*收集物 金币×1/);
    } finally {
      await world.stop();
    }
  });

  it('Whack 管线中只归档的变化不残留棋盘，支援批仍恰好挂一份', async () => {
    const board = whackBoard([{ id: 60, row: 2, column: 6 }]);
    board.cards = [{
      slot: 0, type: 4, name: 'potato_mine', imitates: null, cost: 25,
      ready: false, affordable: false, cooldown: 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
    }];
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board,
    }));
    transport.nativeResultDelayMs = 250;
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'special' || action.action !== 'whack') {
        return { accepted: false, reason: 'unexpected action' };
      }
      const requested = action.targetIds?.length ?? 0;
      fake.nativeResult = {
        outcome: 'executed', effect: 'target_changed',
        batch: {
          requested, attempted: requested, released: requested,
          verified: requested, stale: 0, scopeStopped: false,
        },
      };
    };

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => transport.commands.length === 1);
      host.events.length = 0;
      host.deferred.length = 0;
      host.deliveryCalls.length = 0;

      transport.publish((draft) => {
        draft.board!.zombies.push({
          id: 61, type: 0, name: 'zombie', row: 3, column: 9, columnPosition: 9, xBand: 'far', speedCellsPerSecond: 0.0,
          condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
          slowed: false, immobilized: false,
        });
      });
      await afterTimers();
      expect(host.events.find(({ event }) => event.type === 'pvz.zombie.visible')?.options)
        .toMatchObject({ deliver: false });
      expect(host.deferred).toHaveLength(0);

      host.events.length = 0;
      host.deliveryCalls.length = 0;
      transport.publish((draft) => {
        draft.board!.zombies.push({
          id: 62, type: 2, name: 'conehead', row: 4, column: 7, columnPosition: 7, xBand: 'mid', speedCellsPerSecond: 0.0,
          condition: 'intact', armor: 'intact', shield: 'none', hypnotized: false,
          slowed: false, immobilized: false,
        });
        draft.board!.special!.targets.push(
          target('whack', 'zombie', { id: 62, row: 4, column: 7 }),
        );
        draft.board!.collectibles = [
          { id: 90, kind: 'gold_coin', x: 360, y: 190, row: 2, column: 4 },
        ];
        Object.assign(draft.board!.cards[0]!, {
          ready: true, affordable: true, cooldown: 'ready',
        });
      });
      await afterTimers();

      const deferred = host.deferred.filter((event) => event.type === 'pvz.board.snapshot');
      expect(deferred).toHaveLength(1);
      expect(await deferred[0]!.render()).toMatch(/第4排 .*←路障僵尸7\.0列[\s\S]*收集物 金币×1/);
      expect(host.events.find(({ event }) => event.type === 'pvz.target.ready')?.options)
        .toMatchObject({ deliver: false });
      expect(host.events.find(({ event }) => event.type === 'pvz.card.ready')?.options?.deliver)
        .not.toBe(false);
    } finally {
      await world.stop();
    }
  });

  it('Whack 棋盘受理独立收掉落物与种植支援队列', async () => {
    const board = whackBoard([{ id: 41, row: 3, column: 7 }]);
    board.sun = 25;
    board.cards = [{
      slot: 0, type: 4, name: 'potato_mine', imitates: null, cost: 25,
      ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
    }];
    board.collectibles = [
      { id: 91, kind: 'gold_coin', x: 360, y: 190, row: 2, column: 4 },
    ];
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board,
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind === 'collect') {
        fake.nativeResult = { outcome: 'executed', effect: 'collectibles_collected' };
        fake.publish((draft) => {
          draft.board!.collectibles = [];
          draft.board!.sun += 25;
        });
        return;
      }
      if (action.kind === 'plant' && 'column' in action) {
        fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
        fake.publish((draft) => {
          draft.board!.plants.push({
            id: 500, type: 4, name: 'potato_mine', row: action.row, column: action.column,
            phase: 'arming', condition: 'intact', sleeping: false, squished: false, layers: [],
          });
          draft.board!.sun -= 25;
          draft.board!.cards[0]!.ready = false;
          draft.board!.cards[0]!.affordable = false;
          draft.board!.cards[0]!.cooldown = 'long';
        });
        return;
      }
      return { accepted: false, reason: 'unexpected action' };
    };

    const { world, host } = await startWorld(transport);
    try {
      const receipt = await callTool(world, 'pvz_do', {
        queue: 'now',
        steps: [
          { skill: 'collect', what: 'coins', until: 'once' },
          { skill: 'plant', plant: 'potato_mine', row: 2, column: 2 },
        ],
      });
      expect(receipt).toContain('任务#1 已受理');
      expect(receipt).not.toContain('[PvZ 状态');
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));

      expect(transport.commands).toEqual([
        { kind: 'collect', ids: [91] },
        { kind: 'plant', slot: 0, row: 2, column: 2 },
      ]);
      expect(await callTool(world, 'pvz_observe')).toMatch(/第2排 .* 2土豆雷/);
      const report = host.events.find(({ event }) => event.senderKey === 'pvz.task.1');
      expect(report?.event.text).toContain('[当前战术快照]');
      expect(report?.event.text).toMatch(/第2排 .* 2土豆雷/);
    } finally {
      await world.stop();
    }
  });

  it('Whack 预取允许先安排支援，再自主追加后继锤击', async () => {
    const board = whackBoard([{ id: 42, row: 3, column: 6 }]);
    board.collectibles = [
      { id: 92, kind: 'gold_coin', x: 360, y: 190, row: 2, column: 4 },
    ];
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board,
    }));
    transport.nativeResultDelayMs = 40;
    transport.actionHandler = (action, fake) => {
      if (action.kind === 'cancel') {
        fake.nativeResultDelayMs = 0;
        fake.nativeResult = { outcome: 'executed' };
        return;
      }
      if (action.kind === 'special' && action.action === 'whack') {
        const requested = action.targetIds?.length ?? 0;
        fake.nativeResult = {
          outcome: 'executed', effect: 'target_changed',
          batch: {
            requested, attempted: requested, released: requested,
            verified: requested, stale: 0, scopeStopped: false,
          },
        };
        return;
      }
      if (action.kind === 'collect') {
        fake.nativeResult = { outcome: 'executed', effect: 'collectibles_collected' };
        fake.publish((draft) => {
          draft.board!.collectibles = [];
          draft.board!.sun += 25;
        });
        return;
      }
      return { accepted: false, reason: 'unexpected action' };
    };

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => host.events.some(({ event }) =>
        event.senderKey === 'pvz-whack-prefetch-1'));

      const earlySupport = await callTool(world, 'pvz_do', {
        queue: 'append',
        steps: [{ skill: 'collect', what: 'coins', until: 'once' }],
      });
      expect(earlySupport).toContain('任务#2 已受理');

      const prefetchedFollowup = await callTool(world, 'pvz_do', {
        queue: 'append',
        steps: whackQueueSteps(),
      });
      expect(prefetchedFollowup).toContain('任务#3 已受理');
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.3'));

      expect(transport.commands.slice(0, WHACK_SKILL_QUEUE_LENGTH).every((action) =>
        action.kind === 'special' && action.action === 'whack')).toBe(true);
      expect(transport.commands.map((action) => action.kind)).not.toContain('cancel');
      expect(transport.commands[WHACK_SKILL_QUEUE_LENGTH]?.kind).toBe('collect');
      expect(transport.commands.slice(WHACK_SKILL_QUEUE_LENGTH + 1).every((action) =>
        action.kind === 'special' && action.action === 'whack')).toBe(true);
    } finally {
      await world.stop();
    }
  });

  it('暂停可以抢占仍在执行和预取的 Whack 队列', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [{ id: 'pause', label: 'Pause', enabled: true, x: 700, y: 30, state: null, record: null }],
      board: whackBoard([{ id: 42, row: 3, column: 6 }]),
    }));
    installRollingWhackStateMachine(transport, 42);
    const whackHandler = transport.actionHandler!;
    transport.nativeResultDelayMs = 50;
    transport.actionHandler = (action, fake) => {
      if (action.kind === 'menu' && action.target === 'pause') {
        fake.nativeResult = { outcome: 'executed' };
        fake.publish(draft => { draft.board!.paused = true; });
        return;
      }
      return whackHandler(action, fake);
    };
    const { world, host } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', { steps: whackQueueSteps() });
      await waitUntil(() => host.events.some(({ event }) => event.type === 'pvz.task.prefetch'));
      expect(await callTool(world, 'pvz_do', {
        queue: 'now', steps: [{ skill: 'menu', action: 'pause' }],
      })).toContain('已受理');
      await waitUntil(() => transport.state.board!.paused);
      await waitUntil(() => host.events.some(({ event }) => event.type === 'pvz.task' && event.text.includes('pause 已完成')));
      expect(await callTool(world, 'pvz_queue')).toContain('当前没有执行中的任务');
    } finally {
      await world.stop();
    }
  });

  it('新的 Whack queue now 可以抢占正在运行的独立支援', async () => {
    const board = whackBoard([{ id: 43, row: 4, column: 3 }]);
    board.collectibles = [
      { id: 93, kind: 'gold_coin', x: 360, y: 190, row: 2, column: 4 },
    ];
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board,
    }));
    transport.nativeResultDelayMs = 200;
    transport.actionHandler = (action, fake) => {
      if (action.kind === 'cancel') {
        fake.nativeResultDelayMs = 0;
        fake.nativeResult = { outcome: 'executed' };
        return;
      }
      if (action.kind === 'collect') {
        fake.nativeResult = { outcome: 'executed', effect: 'collectibles_collected' };
        return;
      }
      if (action.kind === 'special' && action.action === 'whack') {
        const requested = action.targetIds?.length ?? 0;
        fake.nativeResult = {
          outcome: 'executed', effect: 'target_changed',
          batch: {
            requested, attempted: requested, released: requested,
            verified: requested, stale: 0, scopeStopped: false,
          },
        };
        return;
      }
      return { accepted: false, reason: 'unexpected action' };
    };

    const { world } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', {
        steps: [{ skill: 'collect', what: 'coins', until: 'once' }],
      })).toContain('任务#1 已受理');
      await waitUntil(() => transport.commands.some((action) => action.kind === 'collect'));

      const whack = await callTool(world, 'pvz_do', {
        queue: 'now',
        steps: whackQueueSteps(),
      });
      expect(whack).toContain('任务#2 已受理');
      expect(whack).toContain('叫停了任务#1');
      await waitUntil(() => transport.commands.some((action) => action.kind === 'cancel'));
      await waitUntil(() => transport.commands.some((action) =>
        action.kind === 'special' && action.action === 'whack'));
    } finally {
      await world.stop();
    }
  });

  it('一次响应受理六个 Whack skill，并在每一步开始时动态绑定当前批次', async () => {
    const batches: WhackTestTarget[][] = [
      [{ id: 45, row: 3, column: 5 }, { id: 46, row: 1, column: 3 }],
      [{ id: 47, row: 2, column: 7 }],
      [{ id: 48, row: 4, column: 8 }],
      [{ id: 49, row: 1, column: 6 }],
      [{ id: 50, row: 5, column: 4 }],
      [{ id: 51, row: 3, column: 2 }],
    ];
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard(batches[0]),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'special' || action.action !== 'whack') {
        return { accepted: false, reason: 'unexpected action' };
      }
      const index = fake.commands.length - 1;
      const requested = action.targetIds?.length ?? 0;
      fake.nativeResult = {
        outcome: 'executed',
        effect: 'target_changed',
          batch: {
            requested, attempted: requested, released: requested,
            verified: requested, stale: 0, scopeStopped: false,
          },
      };
      fake.publish((draft) => setWhackBatch(draft, batches[index + 1] ?? []));
    };

    const { world, host } = await startWorld(transport);
    try {
      const accepted = await callTool(world, 'pvz_do', { steps: whackQueueSteps() });
      expect(accepted).toContain('任务#1 已受理');
      expect(accepted).toContain('第 1/6 步');

      await waitUntil(() => transport.commands.length === WHACK_SKILL_QUEUE_LENGTH);
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));

      const commands = transport.commands as Array<
        Extract<PvzNativeAction, { kind: 'special' }>
      >;
      expect(commands.map((command) => command.targetIds)).toEqual([
        [46, 45],
        [47],
        [48],
        [49],
        [50],
        [51],
      ]);
      expect(commands[0]!.targetIds).not.toContain(47);
      expect(commands[1]!.targetIds).not.toContain(48);
      expect(commands.every((command) => command.expectedLevel === 0)).toBe(true);

      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('任务#1完成');
      expect(queue).not.toMatch(/targetIds|\b(?:45|46|47|48|49|50|51)\b/);
      const report = host.events.find(({ event }) => event.senderKey === 'pvz.task.1');
      expect(report?.event).toMatchObject({ origin: 'internal', ephemeral: true });
      expect(report?.options).toMatchObject({ deliver: false, trigger: 'piggyback' });
    } finally {
      await world.stop();
    }
  });

  it('同一目标受击但未跨可见耐久档位时继续执行完整 Whack 队列', async () => {
    const board = whackBoard([{ id: 60, row: 2, column: 4 }]);
    board.zombies[0] = {
      ...board.zombies[0]!,
      type: 4,
      name: 'buckethead',
      armor: 'intact',
    };
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board,
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'special' || action.action !== 'whack') {
        return { accepted: false, reason: 'unexpected action' };
      }
      const requested = action.targetIds?.length ?? 0;
      fake.nativeResult = {
        outcome: 'executed',
        effect: 'target_changed',
          batch: {
            requested, attempted: requested, released: requested,
            verified: requested, stale: 0, scopeStopped: false,
          },
      };
    };

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => transport.commands.length === WHACK_SKILL_QUEUE_LENGTH);
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));

      const commands = transport.commands as Array<
        Extract<PvzNativeAction, { kind: 'special' }>
      >;
      expect(commands.every((command) => JSON.stringify(command.targetIds) === '[60]')).toBe(true);
      const report = host.events.find(({ event }) => event.senderKey === 'pvz.task.1');
      expect(report?.event.text).toContain('已确认受击 1/1');
      expect(report?.event.text).toContain('铁桶僵尸在第2排第4列');
      expect(report?.event.text).not.toContain('已消灭');
    } finally {
      await world.stop();
    }
  });

  it('小推车等环境效果让整批目标在按下前消失时，刷新目标后继续后续 Whack skill', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard([{ id: 70, row: 2, column: 3 }]),
    }));
    let whackCalls = 0;
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'special' || action.action !== 'whack') {
        return { accepted: false, reason: 'unexpected action' };
      }
      const index = whackCalls++;
      const requested = action.targetIds?.length ?? 0;
      if (index === 0) {
        fake.nativeResult = {
          outcome: 'rejected',
          reason: 'no selected surfaced whack target is currently visible',
          batch: {
            requested, attempted: 0, released: 0, verified: 0,
            stale: requested, scopeStopped: false,
          },
        };
        setTimeout(() => fake.publish((draft) => {
          setWhackBatch(draft, [{ id: 71, row: 4, column: 5 }]);
        }), 10);
        return;
      }
      fake.nativeResult = {
        outcome: 'executed', effect: 'target_changed',
        batch: {
          requested, attempted: requested, released: requested,
          verified: requested, stale: 0, scopeStopped: false,
        },
      };
      fake.publish((draft) => setWhackBatch(
        draft,
        [{ id: 71 + index, row: index % 5 + 1, column: 5 }],
      ));
    };

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));

      const commands = transport.commands.filter((action) => action.kind === 'special') as Array<
        Extract<PvzNativeAction, { kind: 'special' }>
      >;
      expect(commands).toHaveLength(WHACK_SKILL_QUEUE_LENGTH);
      expect(commands[0]?.targetIds).toEqual([70]);
      expect(commands[1]?.targetIds).toEqual([71]);
      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('任务#1部分完成');
      expect(queue).toContain('1 个在执行前已离开可锤击状态');
      expect(queue).toContain('第 6/6 个锤击步骤已确认受击');
    } finally {
      await world.stop();
    }
  });

  it('原生短暂不可采样时等待同一关卡恢复并继续后续 Whack skill', async () => {
    const initialBoard = whackBoard([{ id: 75, row: 2, column: 3 }], 2);
    const runId = initialBoard.runId;
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: initialBoard,
    }));
    let whackCalls = 0;
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'special' || action.action !== 'whack') {
        return { accepted: false, reason: 'unexpected action' };
      }
      const requested = action.targetIds?.length ?? 0;
      fake.nativeResult = {
        outcome: 'executed', effect: 'target_changed',
        batch: {
          requested, attempted: requested, released: requested,
          verified: requested, stale: 0, scopeStopped: false,
        },
      };
      if (whackCalls++ !== 0) return;
      fake.publish((draft) => {
        draft.screen = 'loading';
        draft.board = null;
      });
      setTimeout(() => fake.publish((draft) => {
        const board = whackBoard([{ id: 76, row: 4, column: 5 }], 2);
        board.runId = runId;
        draft.screen = 'board';
        draft.mode = 30;
        draft.modeName = 'whack_a_zombie';
        draft.modeKind = 'minigame';
        draft.board = board;
      }), 10);
    };

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));

      const commands = transport.commands.filter((action) => action.kind === 'special') as Array<
        Extract<PvzNativeAction, { kind: 'special' }>
      >;
      expect(commands).toHaveLength(WHACK_SKILL_QUEUE_LENGTH);
      expect(commands[0]?.targetIds).toEqual([75]);
      expect(commands.slice(1).every((command) => command.targetIds?.[0] === 76)).toBe(true);
      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('任务#1完成');
      expect(queue).not.toContain('关卡运行已经结束或切换');
    } finally {
      await world.stop();
    }
  });

  it.each([
    { label: '不同 runId', terminal: 'run' as const },
    { label: '失败界面', terminal: 'defeat' as const },
  ])('$label 仍立即结束旧关卡的 Whack skill', async ({ terminal }) => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard([{ id: 77, row: 3, column: 4 }], 2),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'special' || action.action !== 'whack') {
        return { accepted: false, reason: 'unexpected action' };
      }
      const requested = action.targetIds?.length ?? 0;
      fake.nativeResult = {
        outcome: 'executed', effect: 'target_changed',
        batch: {
          requested, attempted: requested, released: requested,
          verified: requested, stale: 0, scopeStopped: false,
        },
      };
      fake.publish((draft) => {
        if (terminal === 'run') {
          draft.board!.runId += 1;
          setWhackBatch(draft, [{ id: 78, row: 4, column: 5 }], 2);
        } else {
          draft.screen = 'defeat';
          draft.board = null;
        }
      });
    };

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));

      expect(transport.commands.filter((action) => action.kind === 'special')).toHaveLength(1);
      expect(await callTool(world, 'pvz_queue'))
        .toContain('锤击技能队列绑定的关卡运行已经结束或切换');
    } finally {
      await world.stop();
    }
  });

  it('点击已确认释放但未观察到受击时只局部结束当前 Whack skill', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard([{ id: 80, row: 3, column: 4 }]),
    }));
    let whackCalls = 0;
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'special' || action.action !== 'whack') {
        return { accepted: false, reason: 'unexpected action' };
      }
      const requested = action.targetIds?.length ?? 0;
      if (whackCalls++ === 0) {
        fake.nativeResult = {
          outcome: 'cancelled',
          reason: 'selected Whack-a-Zombie targets did not show a hit effect',
          batch: {
            requested, attempted: requested, released: requested,
            verified: 0, stale: 0, scopeStopped: false,
          },
        };
        return;
      }
      fake.nativeResult = {
        outcome: 'executed', effect: 'target_changed',
        batch: {
          requested, attempted: requested, released: requested,
          verified: requested, stale: 0, scopeStopped: false,
        },
      };
    };

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));

      expect(transport.commands.filter((action) => action.kind === 'special'))
        .toHaveLength(WHACK_SKILL_QUEUE_LENGTH);
      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('任务#1部分完成');
      expect(queue).toContain('1 次点击未观察到受击变化');
      expect(queue).toContain('确认释放 1 次');
    } finally {
      await world.stop();
    }
  });

  it('波次切换会局部结束已释放的旧批次并让下一 Whack skill 绑定新波次', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard([
        { id: 85, row: 1, column: 2 },
        { id: 86, row: 3, column: 4 },
        { id: 87, row: 5, column: 6 },
      ], 1),
    }));
    let whackCalls = 0;
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'special' || action.action !== 'whack') {
        return { accepted: false, reason: 'unexpected action' };
      }
      const requested = action.targetIds?.length ?? 0;
      if (whackCalls++ === 0) {
        fake.nativeResult = {
          outcome: 'executed', effect: 'target_changed',
          batch: {
            requested, attempted: 1, released: 1,
            verified: 1, stale: 0, scopeStopped: true,
          },
        };
        fake.publish((draft) => {
          setWhackBatch(draft, [{ id: 88, row: 2, column: 5 }], 2);
        });
        return;
      }
      fake.nativeResult = {
        outcome: 'executed', effect: 'target_changed',
        batch: {
          requested, attempted: requested, released: requested,
          verified: requested, stale: 0, scopeStopped: false,
        },
      };
    };

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));

      const commands = transport.commands.filter((action) => action.kind === 'special') as Array<
        Extract<PvzNativeAction, { kind: 'special' }>
      >;
      expect(commands).toHaveLength(WHACK_SKILL_QUEUE_LENGTH);
      expect(commands[0]?.targetIds).toEqual([85, 86, 87]);
      expect(commands[1]?.targetIds).toEqual([88]);
      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('关卡已经切换，本批剩下的动作停了');
      expect(queue).toContain('第 6/6 个锤击步骤已确认受击');
    } finally {
      await world.stop();
    }
  });

  it('原生执行前发现旧波次时回报零输入边界并让下一 Whack skill 重新绑定', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard([{ id: 89, row: 3, column: 3 }], 1),
    }));
    let whackCalls = 0;
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'special' || action.action !== 'whack') {
        return { accepted: false, reason: 'unexpected action' };
      }
      const requested = action.targetIds?.length ?? 0;
      if (whackCalls++ === 0) {
        fake.nativeResult = {
          outcome: 'rejected', reason: 'whack batch level or wave scope is stale',
          batch: {
            requested, attempted: 0, released: 0,
            verified: 0, stale: 0, scopeStopped: true,
          },
        };
        fake.publish((draft) => setWhackBatch(
          draft,
          [{ id: 90, row: 4, column: 5 }],
          2,
        ));
        return;
      }
      fake.nativeResult = {
        outcome: 'executed', effect: 'target_changed',
        batch: {
          requested, attempted: requested, released: requested,
          verified: requested, stale: 0, scopeStopped: false,
        },
      };
    };

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));

      const commands = transport.commands.filter((action) => action.kind === 'special') as Array<
        Extract<PvzNativeAction, { kind: 'special' }>
      >;
      expect(commands).toHaveLength(WHACK_SKILL_QUEUE_LENGTH);
      expect(commands[0]?.targetIds).toEqual([89]);
      expect(commands[1]?.targetIds).toEqual([90]);
      expect(await callTool(world, 'pvz_queue'))
        .toContain('关卡已经切换，本批剩下的动作停了');
    } finally {
      await world.stop();
    }
  });

  it('Whack 批次含未确认释放的按下时保持未验真屏障', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard([
        { id: 90, row: 2, column: 3 },
        { id: 91, row: 4, column: 5 },
      ]),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'special' || action.action !== 'whack') {
        return { accepted: false, reason: 'unexpected action' };
      }
      fake.nativeResult = {
        outcome: 'cancelled',
        reason: 'whack batch input release was not confirmed',
        batch: {
          requested: 2, attempted: 1, released: 0,
          verified: 0, stale: 1, scopeStopped: false,
        },
      };
    };

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));

      expect(transport.commands.filter((action) => action.kind === 'special')).toHaveLength(1);
      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('任务#1 在第 1/6 步未验真');
      expect(queue).toContain('1 次输入未确认释放');
      expect(queue).not.toContain('第 2/6 个锤击步骤');
    } finally {
      await world.stop();
    }
  });

  it('Whack admission 只接受恰好六个 all_visible skill', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard([{ id: 60, row: 2, column: 4 }]),
    }));
    const { world } = await startWorld(transport);
    try {
      for (const count of [1, 5, 7]) {
        const result = await callTool(world, 'pvz_do', { steps: whackQueueSteps(count) });
        expect(result).toContain('[pvz_do 失败]');
        expect(result).toContain('恰含 6 个锤击步骤');
      }

      const mixed = whackQueueSteps();
      mixed[3] = { skill: 'collect', what: 'coins', until: 'visible_clear' };
      expect(await callTool(world, 'pvz_do', { steps: mixed }))
        .toContain('恰含 6 个锤击步骤');

      const coordinate = whackQueueSteps();
      coordinate[2] = {
        skill: 'special', action: 'whack',
        targets: [{ kind: 'zombie', at: { row: 2, column: 4 } }],
      };
      const coordinateResult = await callTool(world, 'pvz_do', { steps: coordinate });
      expect(coordinateResult).toContain('第 3 步必须使用');
      expect(coordinateResult).toContain('scope:"all_visible"');

      const offSchema = whackQueueSteps();
      offSchema[4] = {
        skill: 'special', action: 'whack',
        targets: [{ kind: 'zombie', row: 2, count: 1 }],
      };
      const offSchemaResult = await callTool(world, 'pvz_do', { steps: offSchema });
      expect(offSchemaResult).toContain('第 5 步 targets 每项必须是');
      expect(transport.commands).toEqual([]);
    } finally {
      await world.stop();
    }
  });

  it('首个 Whack skill 只投递一次主预取，队列无后继结束时立即补投一次', async () => {
    const batches = Array.from({ length: WHACK_SKILL_QUEUE_LENGTH }, (_, index) => [
      { id: 100 + index, row: index % 5 + 1, column: 7 - index },
    ]);
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard(batches[0]!),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'special' || action.action !== 'whack') {
        return { accepted: false, reason: 'unexpected action' };
      }
      const index = fake.commands.length - 1;
      const requested = action.targetIds?.length ?? 0;
      fake.nativeResult = {
        outcome: 'executed',
        effect: 'target_changed',
          batch: {
            requested, attempted: requested, released: requested,
            verified: requested, stale: 0, scopeStopped: false,
          },
      };
      fake.publish((draft) => setWhackBatch(draft, batches[index + 1] ?? []));
    };

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));
      await flushImmediateWhackPrefetchFallback();

      const primaryPrefetches = host.events.filter(({ event }) =>
        event.senderKey === 'pvz-whack-prefetch-1');
      expect(primaryPrefetches).toHaveLength(1);
      expect(primaryPrefetches[0]?.event).toMatchObject({
        origin: 'internal',
        ephemeral: true,
        senderKey: 'pvz-whack-prefetch-1',
      });
      expect(primaryPrefetches[0]?.options?.trigger).toBe('flush');
      expect(primaryPrefetches[0]?.event.text).toContain(renderWhackSkillQueueCall('append'));
      expect(primaryPrefetches[0]?.event.text.match(/skill:"special"/g))
        .toHaveLength(WHACK_SKILL_QUEUE_LENGTH);

      await afterTimers(20);
      expect(host.events.filter(({ event }) => event.senderKey === 'pvz-whack-prefetch-1'))
        .toHaveLength(1);

      const fallback = host.events.filter(({ event }) =>
        event.senderKey === 'pvz-whack-prefetch-fallback-1');
      expect(fallback).toHaveLength(1);
      expect(fallback[0]?.event).toMatchObject({
        type: 'pvz.task.prefetch',
        origin: 'internal',
        ephemeral: true,
        senderKey: 'pvz-whack-prefetch-fallback-1',
      });
      const lateDefault = await callTool(world, 'pvz_do', { steps: whackQueueSteps() });
      expect(lateDefault).toContain('任务#2 已受理');
      expect(fallback[0]?.event.text).toContain(renderWhackSkillQueueCall('append'));
      expect(fallback[0]?.event.text).toContain('锤击任务#1已经结束');
      expect(fallback[0]?.event.text).toContain('后继缓冲位仍为空');
      expect(fallback[0]?.event.text).not.toContain('当前锤击任务#1仍在执行');
    } finally {
      await world.stop();
    }
  });

  it('预取窗口只接受唯一后继锤击队列', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard([{ id: 200, row: 2, column: 4 }]),
    }));
    transport.nativeResultDelayMs = 30;
    transport.actionHandler = (action, fake) => {
      if (action.kind === 'cancel') {
        fake.nativeResultDelayMs = 0;
        fake.nativeResult = { outcome: 'executed' };
        return;
      }
      if (action.kind !== 'special' || action.action !== 'whack') {
        return { accepted: false, reason: 'unexpected action' };
      }
      const requested = action.targetIds?.length ?? 0;
      fake.nativeResult = {
        outcome: 'executed',
        effect: 'target_changed',
          batch: {
            requested, attempted: requested, released: requested,
            verified: requested, stale: 0, scopeStopped: false,
          },
      };
      const id = 200 + fake.commands.length;
      fake.publish((draft) => setWhackBatch(draft, [{ id, row: 3, column: 5 }]));
    };

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => host.events.some(({ event }) => event.type === 'pvz.task.prefetch'));

      const appended = await callTool(world, 'pvz_do', {
        queue: 'append',
        steps: whackQueueSteps(),
      });
      expect(appended).toContain('任务#2 已受理');
      expect(await callTool(world, 'pvz_queue')).toContain('排队 任务#2');

      const duplicate = await callTool(world, 'pvz_do', {
        queue: 'append',
        steps: whackQueueSteps(),
      });
      expect(duplicate).toContain('[pvz_do 失败]');
      expect(duplicate).toMatch(/仍在执行|已占用唯一预取缓冲位/);
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));
      await afterTimers(10);
      expect(host.events.some(({ event }) =>
        event.senderKey === 'pvz-whack-prefetch-fallback-1')).toBe(false);
    } finally {
      await world.stop();
    }
  });

  it('活动队列无后继结束后立即补投，迟到 append 仍接力', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard([{ id: 300, row: 2, column: 4 }]),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'special' || action.action !== 'whack') {
        return { accepted: false, reason: 'unexpected action' };
      }
      const requested = action.targetIds?.length ?? 0;
      fake.nativeResult = {
        outcome: 'executed',
        effect: 'target_changed',
          batch: {
            requested, attempted: requested, released: requested,
            verified: requested, stale: 0, scopeStopped: false,
          },
      };
      const id = 300 + fake.commands.length;
      fake.publish((draft) => setWhackBatch(draft, [{ id, row: 3, column: 5 }]));
    };

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));
      expect(transport.commands).toHaveLength(WHACK_SKILL_QUEUE_LENGTH);
      expect(await callTool(world, 'pvz_queue')).toContain('任务#1完成');
      await flushImmediateWhackPrefetchFallback();
      const fallback = host.events.find(({ event }) =>
        event.senderKey === 'pvz-whack-prefetch-fallback-1');
      expect(fallback?.event).toMatchObject({
        origin: 'internal',
        ephemeral: true,
        senderKey: 'pvz-whack-prefetch-fallback-1',
      });

      const late = await callTool(world, 'pvz_do', {
        queue: 'append',
        steps: whackQueueSteps(),
      });
      expect(late).toContain('任务#2 已受理');
      expect(late).toContain('[上一份锤击队列回执]');

      await waitUntil(() => transport.commands.length >= WHACK_SKILL_QUEUE_LENGTH + 1);
      const firstContinuation = transport.commands[WHACK_SKILL_QUEUE_LENGTH];
      expect(firstContinuation).toMatchObject({
        kind: 'special',
        action: 'whack',
        targetIds: [306],
      });
    } finally {
      await world.stop();
    }
  });

  it('预取补投没有接力时，lease 释放窗口并重新唤醒当前目标', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard([{ id: 350, row: 2, column: 4 }]),
    }));
    installRollingWhackStateMachine(transport, 350);

    const { world, host } = await startWorld(transport);
    let clock: ReturnType<typeof vi.spyOn> | null = null;
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));
      await flushImmediateWhackPrefetchFallback();
      await waitUntil(() => host.events.some(({ event }) =>
        event.senderKey === 'pvz-whack-prefetch-fallback-1'));

      const targetCount = host.deferred.filter((event) => event.type === 'pvz.target.ready').length;
      const future = Date.now() + 41_000;
      clock = vi.spyOn(Date, 'now').mockReturnValue(future);
      transport.publish((draft) => setWhackBatch(draft, [{ id: 399, row: 1, column: 7 }]));
      await afterTimers(10);
      clock.mockRestore();
      clock = null;

      const targets = host.deferred.filter((event) => event.type === 'pvz.target.ready');
      expect(targets).toHaveLength(targetCount + 1);
      expect(await targets.at(-1)!.render()).toContain('当前 1 个可锤目标');
      expect(await callTool(world, 'pvz_do', {
        queue: 'append',
        steps: whackQueueSteps(),
      })).toContain('任务#2 已受理');
    } finally {
      clock?.mockRestore();
      await world.stop();
    }
  });

  it('旧窗口的迟到 fallback promise 不会清掉新窗口或占第二个缓冲位', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard([{ id: 700, row: 2, column: 4 }]),
    }));
    transport.nativeResultDelayMs = 10;
    installRollingWhackStateMachine(transport, 700);

    const { world, host } = await startWorld(transport);
    const pushEvent = host.pushEvent.bind(host);
    let releaseOldFallback!: () => void;
    const oldFallbackGate = new Promise<void>((resolve) => {
      releaseOldFallback = resolve;
    });
    host.pushEvent = async (value, options) => {
      const event = await pushEvent(value, options);
      if (value.senderKey === 'pvz-whack-prefetch-fallback-1') await oldFallbackGate;
      return event;
    };
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));
      await flushImmediateWhackPrefetchFallback();
      await waitUntil(() => host.events.some(({ event }) =>
        event.senderKey === 'pvz-whack-prefetch-fallback-1'));
      expect(await callTool(world, 'pvz_do', {
        queue: 'append',
        steps: whackQueueSteps(),
      })).toContain('任务#2 已受理');
      await waitUntil(() => host.events.some(({ event }) =>
        event.senderKey === 'pvz-whack-prefetch-2'));
      const secondGeneration = host.events.find(({ event }) =>
        event.senderKey === 'pvz-whack-prefetch-2');
      expect(secondGeneration?.event.text).toContain('当前锤击任务#2仍在执行');
      expect(secondGeneration?.event.text).toContain('后继缓冲位为空');

      releaseOldFallback();
      await afterTimers();
      expect(await callTool(world, 'pvz_do', {
        queue: 'append',
        steps: whackQueueSteps(),
      })).toContain('任务#3 已受理');
      expect(await callTool(world, 'pvz_do', {
        queue: 'append',
        steps: whackQueueSteps(),
      })).toContain('只在 pvz.task.prefetch 到达后追加下一份队列');
    } finally {
      releaseOldFallback();
      await world.stop();
    }
  });

  it('原生短暂不可采样时保留同一关卡的 Whack 预取窗口', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard([{ id: 780, row: 2, column: 4 }]),
    }));
    installRollingWhackStateMachine(transport, 780);

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));
      await waitUntil(() => host.events.some(({ event }) =>
        event.senderKey === 'pvz-whack-prefetch-1'));
      const board = structuredClone(transport.state.board!);

      transport.publish((draft) => {
        draft.screen = 'loading';
        draft.board = null;
      });
      await afterTimers(10);
      transport.publish((draft) => {
        draft.screen = 'board';
        draft.mode = 30;
        draft.modeName = 'whack_a_zombie';
        draft.modeKind = 'minigame';
        draft.board = board;
      });
      await afterTimers(10);

      expect(await callTool(world, 'pvz_do', {
        queue: 'append',
        steps: whackQueueSteps(),
      })).toContain('任务#2 已受理');
    } finally {
      await world.stop();
    }
  });

  it('关卡 scope 改变时先释放旧预取窗口，再投递新 scope 的 target ready', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard([{ id: 800, row: 2, column: 4 }]),
    }));
    installRollingWhackStateMachine(transport, 800);

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));
      await flushImmediateWhackPrefetchFallback();
      await waitUntil(() => host.events.some(({ event }) =>
        event.senderKey === 'pvz-whack-prefetch-fallback-1'));
      const targetCount = host.deferred.filter((event) => event.type === 'pvz.target.ready').length;

      transport.publish((draft) => {
        draft.board!.runId += 1;
        setWhackBatch(draft, [{ id: 899, row: 4, column: 6 }]);
      });
      await afterTimers(10);

      const targets = host.deferred.filter((event) => event.type === 'pvz.target.ready');
      expect(targets).toHaveLength(targetCount + 1);
      expect(await targets.at(-1)!.render()).toContain('当前 1 个可锤目标');
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#2 已受理');
    } finally {
      await world.stop();
    }
  });

  it.each(['model', 'system'] as const)('%s 停止能释放只剩预取窗口的队列并恢复当前目标', async (role) => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard([{ id: 900, row: 2, column: 4 }]),
    }));
    installRollingWhackStateMachine(transport, 900);

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));
      await flushImmediateWhackPrefetchFallback();
      await waitUntil(() => host.events.some(({ event }) =>
        event.senderKey === 'pvz-whack-prefetch-fallback-1'));
      const targetCount = host.deferred.filter((event) => event.type === 'pvz.target.ready').length;

      const stop = world.tools().find((candidate) => candidate.name === 'pvz_stop')!;
      const result = await stop.handler({}, { role, log: host.log });
      expect(typeof result === 'string' ? result : result.text).toContain('当前没有排队任务');
      const targets = host.deferred.filter((event) => event.type === 'pvz.target.ready');
      expect(targets).toHaveLength(targetCount + 1);
      expect(await targets.at(-1)!.render()).toContain('当前 1 个可锤目标');
      expect(await callTool(world, 'pvz_do', {
        queue: 'append',
        steps: whackQueueSteps(),
      })).toContain('任务#2 已受理');
    } finally {
      await world.stop();
    }
  });

  it('Whack 队列只在 skill 边界切换波次，每条原生命令携带实际绑定波次', async () => {
    const batches = Array.from({ length: WHACK_SKILL_QUEUE_LENGTH }, (_, index) => [
      { id: 400 + index, row: index % 5 + 1, column: 8 - index },
    ]);
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard(batches[0]!, 3),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'special' || action.action !== 'whack') {
        return { accepted: false, reason: 'unexpected action' };
      }
      const index = fake.commands.length - 1;
      const requested = action.targetIds?.length ?? 0;
      fake.nativeResult = {
        outcome: 'executed',
        effect: 'target_changed',
          batch: {
            requested, attempted: requested, released: requested,
            verified: requested, stale: 0, scopeStopped: false,
          },
      };
      fake.publish((draft) => setWhackBatch(draft, batches[index + 1] ?? [], 4));
    };

    const { world } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => transport.commands.length === WHACK_SKILL_QUEUE_LENGTH);

      const commands = transport.commands as Array<
        Extract<PvzNativeAction, { kind: 'special' }>
      >;
      expect(commands.map((command) => command.targetIds)).toEqual([
        [400], [401], [402], [403], [404], [405],
      ]);
    } finally {
      await world.stop();
    }
  });

  it('没有新目标时每个独立 Whack skill 有限 yield 后继续且不预取', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard([{ id: 500, row: 2, column: 4 }]),
    }));
    const { world, host } = await startWorld(
      transport,
      { actionTimeoutMs: 25 },
    );
    try {
      const accepted = callTool(world, 'pvz_do', { steps: whackQueueSteps() });
      expect(await accepted).toContain('任务#1 已受理');
      transport.publish((draft) => setWhackBatch(draft, []));
      transport.emit('snapshot', structuredClone(transport.state));

      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));

      expect(transport.commands).toEqual([]);
      expect(host.events.filter(({ event }) => event.type === 'pvz.task.prefetch')).toEqual([]);
      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('任务#1部分完成');
      expect(queue.match(/没有等到新的可见批次/g)).toHaveLength(WHACK_SKILL_QUEUE_LENGTH);
      expect(queue).not.toContain('结束当前有限队列');
      const report = host.events.find(({ event }) => event.senderKey === 'pvz.task.1');
      expect(report?.event).toMatchObject({ origin: 'internal', ephemeral: true });
      expect(report?.options).toMatchObject({ deliver: false, trigger: 'piggyback' });
    } finally {
      await world.stop();
    }
  });

  it.each(['model', 'system'] as const)('实时 Whack 中 %s 可以取消整份技能队列', async (role) => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      menu: [], board: whackBoard([{ id: 600, row: 2, column: 3 }]),
    }));
    transport.nativeResultDelayMs = 80;
    transport.actionHandler = (action, fake) => {
      if (action.kind === 'cancel') {
        fake.nativeResultDelayMs = 0;
        fake.nativeResult = { outcome: 'executed' };
        return;
      }
      if (action.kind !== 'special' || action.action !== 'whack') {
        return { accepted: false, reason: 'unexpected action' };
      }
      const requested = action.targetIds?.length ?? 0;
      fake.nativeResult = {
        outcome: 'executed',
      effect: 'target_changed',
      batch: {
        requested, attempted: requested, released: requested,
        verified: requested, stale: 0, scopeStopped: false,
      },
      };
    };

    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_stop'))
        .toContain('当前没有排队任务');
      expect(await callTool(world, 'pvz_do', { steps: whackQueueSteps() }))
        .toContain('任务#1 已受理');
      await waitUntil(() => transport.commands.some((action) => action.kind === 'special'));

      const stop = world.tools().find((candidate) => candidate.name === 'pvz_stop')!;
      const stopped = await stop.handler({}, { role, log: host.log });
      const text = typeof stopped === 'string' ? stopped : stopped.text;
      expect(text).toContain('已停止任务#1');
      expect(transport.commands.filter((action) => action.kind === 'cancel').length)
        .toBeGreaterThan(0);
      await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));
      const report = host.events.find(({ event }) => event.senderKey === 'pvz.task.1');
      expect(report?.event.text).toContain('任务#1 未完成');
      expect(report?.event.text).toContain('收到 pvz_stop');
    } finally {
      await world.stop();
    }
  });
});

describe('PvzWorld 伪阻塞', () => {
  it('resolves each empty-pot step from fresh occupancy and skips rows without a pot', async () => {
    const card = { slot: 0, type: 33, name: 'flower_pot', imitates: null, cost: null,
      ready: true, affordable: true, cooldown: 'ready' as const, cooldownRemainingPercent: 0,
      cooldownRemainingSeconds: 0, x: 80, y: 40 };
    const pot = (column: number) => ({ id: column, type: 33, name: 'flower_pot', row: 2, column,
      condition: 'intact' as const, sleeping: false, squished: false, layers: [] });
    const transport = new FakePvzTransport(snapshot({ screen: 'board', menu: [], board: boardState({
      background: 5, cards: [card,
        { ...card, slot: 1, type: 39, name: 'melon_pult' },
        { ...card, slot: 2, type: 32, name: 'cabbage_pult' },
        { ...card, slot: 3, type: 32, name: 'cabbage_pult' }],
      plants: [pot(1), pot(3), { ...pot(1), id: 100, type: 34, name: 'kernel_pult' }],
    }) }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'plant' || !('column' in action)) return;
      const used = fake.state.board!.cards.find(item => item.slot === action.slot)!;
      fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
      fake.publish(draft => {
        draft.board!.plants.push({ ...pot(action.column), id: 1000 + action.column + used.type,
          type: used.type, name: used.name, row: action.row });
        draft.board!.cards = draft.board!.cards.filter(item => item.slot !== action.slot)
          .map((item, slot) => ({ ...item, slot }));
      });
    };
    const { world, host } = await startWorld(transport);
    try {
      const cabbage = { skill: 'plant', plant: 'cabbage_pult', row: 2, column: { emptyPot: 'nearest_house' } };
      await callTool(world, 'pvz_do', { steps: [
        { ...cabbage, plant: 'melon_pult', row: 3 },
        { skill: 'plant', plant: 'flower_pot', row: 2, column: 4 },
        cabbage, cabbage,
      ] });
      await waitUntil(() => host.events.some(({ event }) => event.type === 'pvz.task'));
      expect(transport.state.board!.plants.filter(plant => plant.type === 32).map(plant => plant.column))
        .toEqual([3, 4]);
      expect(transport.state.board!.cards.map(item => item.name)).toEqual(['melon_pult']);
      const report = host.events.find(({ event }) => event.type === 'pvz.task')!.event.text;
      expect(report).toContain('第3排当前没有可见空花盆');
      expect(report).toContain('卷心菜投手 已种在第2排第3列');
      expect(report).toContain('卷心菜投手 已种在第2排第4列');
    } finally { await world.stop(); }
  });

  it('种植被打回时只作废这一步，理由用植入件自己那一条', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      board: boardState({
        sun: 20,
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready',
          cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0,
          x: 80, y: 40,
        }],
        collectibles: [{ id: 9, kind: 'gold_coin', x: 300, y: 200, row: 2, column: 3 }],
      }),
    }));
    transport.nativeResult = { outcome: 'executed', effect: 'collectibles_collected' };
    transport.actionHandler = (action, fake) => {
      if (action.kind === 'collect') {
        fake.publish((draft) => { draft.board!.collectibles = []; });
        return undefined;
      }
      if (action.kind !== 'plant' || !('column' in action)) return undefined;
      // 提交之后、按下之前,阳光被别处花掉了。
      fake.publish((draft) => {
        draft.board!.cards[0]!.ready = false;
        draft.board!.cards[0]!.affordable = false;
        draft.board!.cards[0]!.cooldownRemainingSeconds = 6.5;
      });
      return { accepted: false, reason: 'planting seed packet costs more sun than is available' };
    };
    const { world, host } = await startWorld(transport);

    expect(await callTool(world, 'pvz_do', {
      steps: [
        { skill: 'plant', plant: 'peashooter', row: 2, column: 3 },
        { skill: 'collect', what: 'coins' },
      ],
    })).toContain('已受理');
    await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));

    const report = host.events.map(({ event }) => event.text)
      .find((text) => text.includes('任务#1'))!;
    expect(report).toContain('豌豆射手 没能种到第2排第3列：阳光不够买这张卡');
    // 打回之后重读到的冷却读数不进回执:它说的是现在,不是按下去那一刻。
    expect(report).not.toContain('还剩 6.5 秒');
    // 后面那一步照跑:整条队列没被这一次打回带走。
    expect(transport.commands.map((action) => action.kind)).toContain('collect');

    await world.stop();
  });

  it('植入件没给原因时，才回头读打回之后的卡和格子', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      board: boardState({
        sun: 20,
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready',
          cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0,
          x: 80, y: 40,
        }],
      }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'plant' || !('column' in action)) return undefined;
      fake.publish((draft) => {
        draft.board!.cards[0]!.ready = false;
        draft.board!.cards[0]!.affordable = false;
        draft.board!.cards[0]!.cooldownRemainingSeconds = 6.5;
      });
      return { accepted: false };
    };
    const { world, host } = await startWorld(transport);

    expect(await callTool(world, 'pvz_do', {
      steps: [{ skill: 'plant', plant: 'peashooter', row: 2, column: 3 }],
    })).toContain('已受理');
    await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));

    const report = host.events.map(({ event }) => event.text)
      .find((text) => text.includes('任务#1'))!;
    expect(report).toContain('豌豆射手 没能种到第2排第3列：这张卡又回到冷却里，还剩 6.5 秒');

    await world.stop();
  });

  it('译不出的原生原因原样报出并告警，不编一句像解释的话', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      board: boardState({
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready',
          cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0,
          x: 80, y: 40,
        }],
      }),
    }));
    // 旧 DLL 才会说这一句;新原生已经没有它了。
    transport.actionHandler = (action) => action.kind === 'plant' && 'column' in action
      ? { accepted: false, reason: 'relative planting card identity, readiness, or held cursor changed' }
      : undefined;
    const { world, host } = await startWorld(transport);
    const warn = vi.spyOn(host.log, 'warn');

    expect(await callTool(world, 'pvz_do', {
      steps: [{ skill: 'plant', plant: 'peashooter', row: 2, column: 3 }],
    })).toContain('已受理');
    await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));

    const report = host.events.map(({ event }) => event.text)
      .find((text) => text.includes('任务#1'))!;
    expect(report).toContain(
      '植入件中止了这一步（原文：relative planting card identity, readiness, or held cursor changed）',
    );
    expect(warn.mock.calls.some(([message]) => message === 'PvZ 植入件原因缺中文映射')).toBe(true);

    await world.stop();
  });

  it('菜单动作这一刻没出现时只作废这一步，并报出画面上现在能点什么', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      menu: [{ id: 'pause', label: 'Pause', enabled: true, x: 700, y: 20, state: null, record: null }],
      board: boardState({ collectibles: [{ id: 9, kind: 'gold_coin', x: 300, y: 200, row: 2, column: 3 }] }),
    }));
    transport.nativeResult = { outcome: 'executed', effect: 'collectibles_collected' };
    transport.actionHandler = (action, fake) => {
      if (action.kind === 'collect') fake.publish((draft) => { draft.board!.collectibles = []; });
      return undefined;
    };
    const { world, host } = await startWorld(transport);

    expect(await callTool(world, 'pvz_do', {
      steps: [
        { skill: 'menu', action: 'advance' },
        { skill: 'collect', what: 'coins' },
      ],
    })).toContain('已受理');
    await waitUntil(() => host.events.some(({ event }) => event.senderKey === 'pvz.task.1'));

    const report = host.events.map(({ event }) => event.text)
      .find((text) => text.includes('任务#1'))!;
    expect(report).toContain('「advance」当前画面上没有');
    expect(report).toContain('现在是棋盘');
    expect(transport.commands.map((action) => action.kind)).toContain('collect');

    await world.stop();
  });
});

describe('PvzWorld 相对落点的步内失败、例行卡片事件与受理占用比对', () => {
  const card = (slot: number, type: number, name: string, cost: number, x: number) => ({
    slot, type, name, imitates: null, cost, ready: true, affordable: true,
    cooldown: 'ready' as const, cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x, y: 40,
  });

  it('相对落点被植入件打回只跳过那一步，后面的绝对列步照做，任务收成部分完成', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', menu: [],
      board: boardState({
        sun: 300,
        cards: [card(0, 3, 'wall_nut', 50, 80), card(1, 0, 'peashooter', 100, 130)],
      }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'plant') return { accepted: false, reason: 'unexpected' };
      if ('aheadOf' in action) {
        fake.nativeResult = {
          outcome: 'rejected',
          reason: 'relative planting found no cell ahead of the target that takes this plant',
        };
        return;
      }
      fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
      fake.publish((draft) => {
        draft.board!.plants.push({
          id: 1201, type: 0, name: 'peashooter', row: action.row, column: action.column,
          phase: 'idle', condition: 'intact', sleeping: false, squished: false, layers: [],
        });
        draft.board!.cards[1]!.ready = false;
      });
    };
    const { world } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', { steps: [
        { skill: 'plant', plant: 'wall_nut', row: 2, column: { aheadOf: 'nearest_hostile', minGap: 0 } },
        { skill: 'plant', plant: 'peashooter', row: 2, column: 5 },
      ] });
      await afterTimers(60);

      expect(transport.commands.map((action) => action.kind)).toEqual(['plant', 'plant']);
      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('任务#1部分完成');
      expect(queue).toContain('坚果 没能种在第2排最近敌对僵尸脚下那格起第一个能下的格：从那只僵尸脚下往屋方向没有一格能下这株植物');
      expect(queue).toContain('豌豆射手 已种在第2排第5列');
    } finally {
      await world.stop();
    }
  });

  it('普通棋盘上例行的卡片可用事件只落库不投递', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', menu: [],
      board: boardState({ cards: [{ ...card(0, 0, 'peashooter', 100, 80), ready: false, cooldown: 'short' }] }),
    }));
    const { world, host } = await startWorld(transport);
    try {
      host.events.length = 0;
      transport.publish((draft) => {
        Object.assign(draft.board!.cards[0]!, { ready: true, affordable: true, cooldown: 'ready' });
      });
      await afterTimers(20);

      const ready = host.events.find(({ event }) => event.type === 'pvz.card.ready');
      expect(ready?.options?.deliver).toBe(false);
    } finally {
      await world.stop();
    }
  });

  it('受理回执逐步列出落点现状:已有东西的格,以及还没垫承载物的水格', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', menu: [],
      board: boardState({
        sun: 500,
        cards: [card(0, 1, 'sunflower', 50, 80), card(1, 0, 'peashooter', 100, 130), card(2, 16, 'lily_pad', 25, 180)],
        plants: [
          { id: 1, type: 1, name: 'sunflower', row: 1, column: 1, phase: 'active', condition: 'intact', sleeping: false, squished: false, layers: [] },
          { id: 2, type: 16, name: 'lily_pad', row: 2, column: 3, phase: 'active', condition: 'intact', sleeping: false, squished: false, layers: [] },
        ],
      }),
    }));
    // 第 4 排是水面:第 5 列这份队列自己先垫了荷叶,第 6 列整份都没垫。
    for (const column of [5, 6]) {
      const cells = transport.state.board!.cells;
      const index = cells.findIndex((cell) => cell.row === 4 && cell.column === column);
      cells[index] = { ...cells[index]!, terrain: 'water', blocker: 'requires_lily_pad' };
    }
    const { world } = await startWorld(transport);
    try {
      const receipt = await callTool(world, 'pvz_do', { steps: [
        { skill: 'plant', plant: 'sunflower', row: 1, column: 1 },
        { skill: 'plant', plant: 'peashooter', row: 2, column: 3 },
        { skill: 'plant', plant: 'lily_pad', row: 2, column: 3 },
        { skill: 'plant', plant: 'peashooter', row: 2, column: 4 },
        { skill: 'plant', plant: 'lily_pad', row: 4, column: 5 },
        { skill: 'plant', plant: 'peashooter', row: 4, column: 5 },
        { skill: 'plant', plant: 'peashooter', row: 4, column: 6 },
      ] });
      expect(receipt).toContain('[落点现状] 第1步 第1排第1列已有向日葵；第3步 第2排第3列已有荷叶；第7步 第4排第6列是水面,还没有荷叶');
      expect(receipt).not.toMatch(/第2步|第4步|第5步|第6步/);
    } finally {
      await world.stop();
    }
  });


  it('植入件说这一格不收时，回执接上棋盘读到的那件事', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', menu: [],
      board: boardState({ sun: 500, cards: [card(0, 0, 'peashooter', 100, 80)] }),
    }));
    const cells = transport.state.board!.cells;
    const index = cells.findIndex((cell) => cell.row === 3 && cell.column === 5);
    cells[index] = { ...cells[index]!, terrain: 'water', blocker: 'requires_lily_pad' };
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'plant') return { accepted: false, reason: 'unexpected' };
      fake.nativeResult = { outcome: 'rejected', reason: 'planting cell will not take this plant' };
    };
    const { world, host } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', {
        steps: [{ skill: 'plant', plant: 'peashooter', row: 3, column: 5 }],
      });
      await waitUntil(() => host.events.some(({ event }) => event.type === 'pvz.task'));

      expect(await callTool(world, 'pvz_queue'))
        .toContain('这一格不收这株植物；第3排第5列是水面,还没有荷叶');
    } finally {
      await world.stop();
    }
  });

  it('本场结算后棋盘还在时收得掉落物，改动植物布局的步骤受阻', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', menu: [],
      board: boardState({
        sun: 500,
        cards: [card(0, 0, 'peashooter', 100, 80)],
        collectibles: [{ id: 70, kind: 'gold_coin', x: 360, y: 190, row: 2, column: 4 }],
      }),
    }));
    const { world, host } = await startWorld(transport);
    try {
      transport.publish((draft) => {
        draft.lastRun = {
          resultId: 3, runId: draft.board!.runId, mode: draft.mode, level: 23, outcome: 'won',
        };
      });
      await afterTimers(20);

      await callTool(world, 'pvz_do', { steps: [{ skill: 'collect', what: 'coins', until: 'once' }] });
      await waitUntil(() => transport.commands.some((action) => action.kind === 'collect'));

      await callTool(world, 'pvz_do', {
        steps: [{ skill: 'plant', plant: 'peashooter', row: 1, column: 1 }],
      });
      await waitUntil(() => host.events.some(({ event }) => event.text.includes('本场已结算')));
      const queue = await callTool(world, 'pvz_queue');
      expect(queue).toContain('本场已结算,棋盘上只剩收取掉落物');
      expect(transport.commands.filter((action) => action.kind === 'plant')).toHaveLength(0);
    } finally {
      await world.stop();
    }
  });
});
