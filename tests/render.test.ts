import { describe, expect, it } from 'vitest';
import {
  compactSnapshot,
  renderSnapshot,
  renderTacticalSnapshot,
  zombiePhaseLabel,
} from '../src/render.ts';
import { boardState, shovelTutorialBoard, snapshot } from './helpers.ts';
import { PLANT_NAMES } from '../src/names.ts';
import type { PvzCard, PvzSeedChoice } from '../src/protocol.ts';

it('visible seed packets carry their localized names, direction, and activation mechanics', () => {
  const names = ['leftpeater', 'hypno_shroom', 'potato_mine', 'torchwood', 'magnet_shroom', 'tall_nut'] as const;
  const state = snapshot({ screen: 'board', mode: 53, board: boardState({
    collectibles: names.map((name, index) => ({
      id: index + 1, kind: 'usable_seed', containedType: PLANT_NAMES.indexOf(name),
      containedName: name, x: 400, y: 100, row: 1, column: 5,
    })),
  }) });
  for (const rendered of [renderSnapshot(state), renderTacticalSnapshot(state), JSON.stringify(compactSnapshot(state))]) {
    expect(rendered).toContain('左向豌豆射手；只攻击本排列号更小的敌人，应位于敌人右侧');
    expect(rendered).toContain('魅惑菇；白天入睡，需咖啡豆唤醒；被吃后魅惑咬它的僵尸');
    expect(rendered).toContain('土豆雷；种下后准备较久；一次性');
    expect(rendered).toContain('火炬树桩；点燃穿过本格的豌豆，自身不攻击');
    expect(rendered).toContain('磁力菇；白天入睡，需咖啡豆唤醒；吸走附近金属装备，自身不攻击');
    expect(rendered).toContain('高坚果；阻挡并拦截撑杆跳跃');
  }
});

it('distinguishes an available pole, an active vault, and a spent pole', () => {
  expect(zombiePhaseLabel('pole_vault_ready')).toBe('持杆，可跳跃');
  expect(zombiePhaseLabel('pole_vaulting')).toBe('正在撑杆跳跃');
  expect(zombiePhaseLabel('pole_vault_spent')).toBe('已丢杆，不能再跳');
});

it('renders vase markings and only disclosed contents across observation surfaces', () => {
  const state = snapshot({ screen: 'board', mode: 51, modeKind: 'vasebreaker', board: boardState({
    gridItems: [
      { id: 1, kind: 'vase', row: 1, column: 5, visibleHint: 'plant' },
      { id: 2, kind: 'vase', row: 1, column: 6, visibleHint: 'unknown' },
      { id: 3, kind: 'vase', row: 1, column: 7, visibleHint: 'zombie' },
      { id: 4, kind: 'vase', row: 2, column: 5, visibleHint: 'unknown',
        revealedContent: { kind: 'plant', type: 0, name: 'peashooter' } },
      { id: 5, kind: 'vase', row: 2, column: 6, visibleHint: 'unknown',
        revealedContent: { kind: 'zombie', type: 23, name: 'gargantuar' } },
      { id: 6, kind: 'vase', row: 2, column: 7, visibleHint: 'unknown',
        revealedContent: { kind: 'sun', count: 3 } },
    ],
  }) });
  const render = () => [renderSnapshot(state), renderTacticalSnapshot(state), JSON.stringify(compactSnapshot(state))];
  for (const text of render()) {
    expect(text).toContain('花瓶（绿色植物罐）');
    expect(text).toContain('花瓶（内容未知）');
    expect(text).toContain('花瓶（僵尸标记）');
    expect(text).toContain('花瓶（透视：豌豆射手）');
    expect(text).toContain('花瓶（透视：巨人僵尸）');
    expect(text).toContain('花瓶（透视：阳光×3）');
  }
  state.board!.cells.filter(cell => cell.row === 2).forEach(cell => {
    cell.playable = null; cell.blocker = 'fog_hidden';
  });
  for (const text of render()) expect(text).not.toContain('透视');
  state.board!.disclosure.entitiesVisible = false;
  for (const text of render()) expect(text).not.toContain('绿色植物罐');
});

it('renders a squished mower as destroyed across every observation surface', () => {
  const state = snapshot({ screen: 'board', board: boardState({
    mowers: [{ row: 1, kind: 'roof_cleaner', state: 'squished' }],
  }) });
  for (const text of [renderSnapshot(state), renderTacticalSnapshot(state), JSON.stringify(compactSnapshot(state))]) {
    expect(text).toContain('第1排屋顶清洁车被压毁');
    expect(text).not.toContain('已触发');
  }
});

it('确认框只发布实际菜单动作，不将 restart 伪装成 confirm', () => {
  const state = snapshot({ screen: 'dialog', menu: [
    { id: 'restart', label: 'restart', enabled: true, x: 350, y: 400, state: null, record: null },
    { id: 'cancel', label: 'cancel', enabled: true, x: 450, y: 400, state: null, record: null },
  ], dialog: { id: 1, hasPrimary: true, hasSecondary: true, primaryLabel: 'restart', secondaryLabel: 'cancel' } });
  for (const text of [renderSnapshot(state), renderTacticalSnapshot(state), JSON.stringify(compactSnapshot(state))]) {
    expect(text).toContain('restart');
    expect(text).toContain('cancel');
    expect(text).not.toContain('confirm');
  }
});

it('僵王与球单独描述，夜间屋顶卡片不要求咖啡豆', () => {
  const state = snapshot({ screen: 'board', mode: 35, board: boardState({ background: 5,
    cards: [mechanicsCard(14)], boss: { phase: 'boss_aiming', immobilized: false,
      projectile: { kind: 'fireball', row: 5, columnPosition: 6.6 } },
  }) });
  for (const text of [renderSnapshot(state), renderTacticalSnapshot(state), JSON.stringify(compactSnapshot(state))]) {
    expect(text).toContain('夜间屋顶');
    expect(text).toContain('僵王在棋盘右侧：头部瞄准');
    expect(text).toContain('火球在第5排第6.6列');
    expect(text).not.toContain('咖啡豆');
    expect(text).not.toContain('←僵王');
  }
});

it('隐形食脑者说明僵尸不可见，不将夜间泳池描述为雾区', () => {
  const state = snapshot({ screen: 'board', mode: 21, modeName: 'invisighoul', modeKind: 'minigame',
    board: boardState({ background: 3, fog: { active: true, visibilityRule: 'invisighoul' } }),
  });
  for (const rendered of [renderSnapshot(state), renderTacticalSnapshot(state), JSON.stringify(compactSnapshot(state))]) {
    expect(rendered).toContain('夜间泳池');
    expect(rendered).toContain('僵尸隐形，数量与位置未知');
    expect(rendered).not.toContain('雾');
  }
});

it('公开手持种子名称与合法落点，放置后不保留旧的手持信息', () => {
  const state = snapshot({ screen: 'board', mode: 19, modeName: 'its_raining_seeds', modeKind: 'minigame', board: boardState({
    cursor: { kind: 'usable_seed', heldType: 16, logicalX: 320, logicalY: 130 },
    allowedSpecialActions: ['launch'],
    special: { phase: 'playing', settled: true, targets: [
      { action: 'launch', kind: 'cell', id: null, slot: null, row: 3, column: 2 },
    ] },
  }) });
  for (const rendered of [renderSnapshot(state), renderTacticalSnapshot(state), JSON.stringify(compactSnapshot(state))]) {
    expect(rendered).toContain('种子雨');
    expect(rendered).toContain('可用种子包（荷叶）');
    expect(rendered).toContain('第3排第2列');
  }
  state.board!.cursor = { kind: 'normal', heldType: 16, logicalX: 160, logicalY: 300 };
  expect(renderSnapshot(state)).toContain('手持 无');
  expect(renderSnapshot(state)).not.toContain('可用种子包（荷叶）');
  expect(compactSnapshot(state)).toMatchObject({ 棋盘状态: { 手持: '无' } });
});

function mechanicsCard(type: number, overrides: Partial<PvzCard> = {}): PvzCard {
  return {
    slot: type, type, name: PLANT_NAMES[type] ?? 'unknown', imitates: null, cost: 100,
    ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0,
    cooldownRemainingSeconds: 0, x: 80, y: 40, ...overrides,
  };
}

function mechanicsChoice(id: number, state: PvzSeedChoice['state'] = 'chooser'): PvzSeedChoice {
  return {
    id, name: PLANT_NAMES[id] ?? 'unknown', state, bankSlot: state === 'selected' ? 0 : null,
    imitates: null, recommended: false, fixed: false, x: 80, y: 140,
  };
}

it('groups interchangeable conveyor packets and lists only disclosed empty pots for the boss', () => {
  const board = boardState({ background: 5,
    boss: { phase: 'boss_aiming', immobilized: false, projectile: null },
    cards: [mechanicsCard(14, { slot: 0, cost: null }), mechanicsCard(14, { slot: 1, cost: null, ready: false }),
      mechanicsCard(20, { slot: 2, cost: null })],
    plants: [1, 2, 3, 4].map(column => ({ id: column, type: 33, name: 'flower_pot', row: 1, column,
      phase: 'active', condition: 'intact', sleeping: false, squished: false, layers: ['base'] })),
  });
  board.plants.push({ ...board.plants[0]!, id: 9, type: 32, name: 'cabbage_pult', column: 2, layers: ['main'] });
  board.plants[2]!.squished = true;
  board.cells.find(cell => cell.row === 1 && cell.column === 4)!.playable = null;
  const state = snapshot({ screen: 'board', mode: 35, board });
  for (const text of [renderSnapshot(state), renderTacticalSnapshot(state), JSON.stringify(compactSnapshot(state))]) {
    expect(text).toContain('寒冰菇×2张[就绪1张]');
    expect(text).toContain('冻结全场后减速');
    expect(text).toContain('火爆辣椒×1张[就绪1张]');
    expect(text).toContain('空花盆落点：第1排第1列');
    expect(text).not.toMatch(/空花盆落点：[^\n"\]]*第[234]列/);
    expect(text).toContain('头部可受伤');
  }
  board.disclosure.entitiesVisible = false;
  expect(renderSnapshot(state)).not.toContain('空花盆落点');
});

describe('PvZ 卡片生效条件的公开提示', () => {
  it('日间泳池选卡在未携带咖啡豆时仍说明大喷菇的睡眠和短程条件', () => {
    const state = snapshot({
      screen: 'seed_picker',
      profile: { ...snapshot().profile!, adventureLevel: 22 },
      board: boardState({ background: 2, level: 22 }),
      seedPicker: {
        capacity: 7, selected: [10], ready: false, previewZombies: [],
        choices: [mechanicsChoice(10, 'selected'), mechanicsChoice(4), mechanicsChoice(2), mechanicsChoice(0)],
      },
    });
    const rendered = renderSnapshot(state);
    expect(rendered).toContain('选卡 1/7: 大喷菇');
    expect(rendered).toContain('大喷菇（白天入睡，需咖啡豆唤醒；短程）');
    expect(rendered).toContain('土豆雷（种下后准备较久；一次性）');
    expect(rendered).toContain('樱桃炸弹（短暂延时；一次性）');
    expect(rendered.match(/大喷菇（/g)).toHaveLength(1);
    expect(compactSnapshot(state)).toMatchObject({ 选卡: { 卡片机制: [
      '大喷菇（白天入睡，需咖啡豆唤醒；短程）',
      '土豆雷（种下后准备较久；一次性）',
      '樱桃炸弹（短暂延时；一次性）',
    ] } });
    expect(rendered).not.toMatch(/sustained_damage|automatic_when_awake|forward_lane/);
  });

  it('卡槽可用性与生效条件并列，冷却和已种植物的实际状态保持独立', () => {
    const state = snapshot({
      screen: 'board', menu: [],
      board: boardState({
        background: 2,
        cards: [mechanicsCard(10), mechanicsCard(4, {
          ready: false, cooldown: 'short', cooldownRemainingSeconds: 1.2,
        }), mechanicsCard(35)],
        plants: [{
          id: 1, type: 10, name: 'fume_shroom', row: 2, column: 3, phase: 'active',
          condition: 'intact', sleeping: false, squished: false, layers: ['main'],
        }],
      }),
    });
    for (const rendered of [renderSnapshot(state), renderTacticalSnapshot(state), JSON.stringify(compactSnapshot(state))]) {
      expect(rendered).toContain('大喷菇[100阳光/可用]（白天入睡，需咖啡豆唤醒；短程）');
      expect(rendered).toContain('土豆雷[100阳光/冷却剩1.2秒]（种下后准备较久；一次性）');
      expect(rendered).toContain('咖啡豆[100阳光/可用]（唤醒睡眠蘑菇；短暂延时；一次性）');
      expect(rendered).not.toContain('大喷菇（睡眠）');
    }
    state.board!.plants[0]!.sleeping = true;
    expect(renderSnapshot(state)).toContain('大喷菇（睡眠）');
  });

  it('模仿者同时公开变身延时和被模仿植物的生效条件', () => {
    const state = snapshot({ screen: 'board', board: boardState({ cards: [
      mechanicsCard(48, { slot: 0, imitates: 4 }), mechanicsCard(48, { slot: 1, imitates: 10 }),
    ] }) });
    const rendered = renderSnapshot(state);
    expect(rendered).toContain('模仿者(土豆雷)[100阳光/可用]（变身需时；种下后准备较久；一次性）');
    expect(rendered).toContain('模仿者(大喷菇)[100阳光/可用]（变身需时；白天入睡，需咖啡豆唤醒；短程）');
  });

  it('夜间不提示咖啡豆，吞食与装填延时不冒充卡片冷却', () => {
    const state = snapshot({ screen: 'board', board: boardState({ background: 1, cards: [
      mechanicsCard(13), mechanicsCard(6), mechanicsCard(47),
    ] }) });
    const rendered = renderSnapshot(state);
    expect(rendered).toContain('胆小菇[100阳光/可用]');
    expect(rendered).not.toContain('咖啡豆');
    expect(rendered).toContain('大嘴花[100阳光/可用]（短程；吞食后消化较久）');
    expect(rendered).toContain('玉米加农炮[100阳光/可用]（装填较久）');
    expect(rendered).not.toContain('冷却剩');
  });

  it('机制提示遵守隐藏与解锁过滤，不披露不可选植物的机制', () => {
    const state = snapshot({
      screen: 'seed_picker', profile: { ...snapshot().profile!, adventureLevel: 22 },
      seedPicker: {
        capacity: 7, selected: [], ready: false, previewZombies: [],
        choices: [mechanicsChoice(0), mechanicsChoice(2, 'hidden'), mechanicsChoice(42)],
      },
    });
    expect(renderSnapshot(state)).not.toMatch(/卡片机制|樱桃炸弹|忧郁菇|一次性/);
    expect(compactSnapshot(state)).not.toHaveProperty('选卡.卡片机制');
  });

  it('棋盘只描述当前卡槽，换卡后移除旧机制，不展开普通卡片百科或僵尸卡', () => {
    const state = snapshot({ screen: 'board', board: boardState({ cards: [mechanicsCard(10)] }) });
    expect(renderSnapshot(state)).toContain('白天入睡');
    state.board!.cards = [mechanicsCard(0), mechanicsCard(100, { name: 'zombie' })];
    const rendered = renderSnapshot(state);
    expect(rendered).toContain('豌豆射手[100阳光/可用]');
    expect(rendered).not.toMatch(/白天入睡|咖啡豆|一次性|短程|卡片机制|projectile_damage/);
    const compact = JSON.stringify(compactSnapshot(state));
    expect(compact).not.toMatch(/白天入睡|咖啡豆|一次性|短程/);
  });
});

describe('PvZ 公开语义快照', () => {
  it('1-5 铲子教程只渲染预置植物、阶段与 shovel 动作', () => {
    const state = snapshot({
      screen: 'board', scene: 2, mode: 0, menu: [],
      board: shovelTutorialBoard('keep_digging', [
        { row: 1, column: 3 },
        { row: 5, column: 3 },
      ]),
    });

    const rendered = renderSnapshot(state, 'full');
    expect(rendered).toContain('关卡 5 · 铲子教程');
    expect(rendered).toContain('阶段 继续铲除 · 剩余 2');
    expect(rendered).toContain('棋盘 5排×9列（第1列靠房子；格前数字是列号）');
    expect(rendered).toContain('第1排 1教程锁定 2教程锁定 3豌豆射手（动作中） 4教程锁定 5教程锁定 6教程锁定 7教程锁定 8教程锁定 9教程锁定');
    expect(rendered.match(/豌豆射手/g)).toHaveLength(2);
    expect(rendered).not.toMatch(/阳光|卡片|僵尸|割草机|地格/);

    const compact = compactSnapshot(state);
    expect(compact).toMatchObject({
      棋盘状态: {
        关卡: 5,
        模式: '铲子教程',
        阶段: '继续铲除',
        剩余目标: 2,
      },
    });
    expect(JSON.stringify(compact)).not.toMatch(/cards|zombies|mowers|collectibles|cells|runId|"id"/);
  });

  it('只在关卡外显示档案、解锁与脱敏后的最近结算', () => {
    const state = snapshot({
      profile: { ...snapshot().profile!, name: 'Alice' },
      lastRun: { resultId: 410041, runId: 910091, mode: 22, level: 0, outcome: 'won' },
    });

    const rendered = renderSnapshot(state);
    expect(rendered).toContain('档案 Alice: 冒险 1');
    expect(rendered).toContain('模式解锁 小游戏=否 · 解谜=否 · 生存=否');
    expect(rendered).toContain('最近结算 胜利 · seeing_stars · 关卡 0');
    expect(rendered).not.toContain('410041');
    expect(rendered).not.toContain('910091');
    expect(rendered).not.toContain('模式 22');

    const compact = compactSnapshot(state);
    expect(compact).toMatchObject({
      档案: { 名称: 'Alice' },
      最近结算: { 结果: '胜利', 模式: 'seeing_stars', 关卡: 0 },
    });
    expect(JSON.stringify(compact)).not.toMatch(/resultId|runId|410041|910091|"mode":22/);
  });

  it.each(['mode_selector', 'seed_picker'] as const)(
    '%s 显示菜单决策所需的档案进度',
    (screen) => {
      const state = snapshot({
        screen,
        profile: { ...snapshot().profile!, name: 'MenuOwner', coins: 2500 },
        lastRun: { resultId: 1001, runId: 1002, mode: 17, level: 3, outcome: 'won' },
      });

      expect(renderSnapshot(state)).toContain('档案 MenuOwner: 冒险 1, 通关 0, 金币 2500');
      expect(compactSnapshot(state)).toMatchObject({
        档案: { 名称: 'MenuOwner', 金币: 2500 },
        最近结算: { 结果: '胜利', 模式: 'wall_nut_bowling', 关卡: 3 },
      });
    },
  );

  it.each(['award', 'defeat', 'dialog', 'credits', 'loading', 'unknown'] as const)(
    '%s 隐藏档案、金币、解锁和最近结算',
    (screen) => {
      const state = snapshot({
        screen,
        profile: {
          ...snapshot().profile!,
          name: 'HiddenOwner',
          coins: 9876,
          minigamesUnlocked: true,
        },
        lastRun: { resultId: 2001, runId: 2002, mode: 17, level: 4, outcome: 'lost' },
      });

      const rendered = renderSnapshot(state);
      expect(rendered).not.toContain('HiddenOwner');
      expect(rendered).not.toContain('9876');
      expect(rendered).not.toContain('模式解锁');
      expect(rendered).not.toContain('最近结算');
      expect(compactSnapshot(state)).not.toHaveProperty('档案');
      expect(compactSnapshot(state)).not.toHaveProperty('最近结算');
    },
  );

  it('summary 默认给出完整语义空间图，并隐藏棋盘外元数据与内部编号', () => {
    const board = boardState({
      background: 3,
      cards: [
        {
          slot: 71, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        },
        {
          slot: 84, type: 48, name: 'imitater', imitates: 0, cost: 100,
          ready: false, affordable: true, cooldown: 'medium', cooldownRemainingPercent: 42, cooldownRemainingSeconds: 3.6, x: 120, y: 40,
        },
      ],
      plants: [
        {
          id: 771001, type: 4, name: 'potato_mine', row: 2, column: 3,
          phase: 'arming', condition: 'intact', sleeping: false, squished: false, layers: [],
        },
        {
          id: 771002, type: 8, name: 'puff_shroom', row: 1, column: 1,
          phase: 'sleeping', condition: 'worn', sleeping: true, squished: false,
          layers: ['pumpkin'],
        },
      ],
      zombies: [{
        id: 881002, type: 5, name: 'newspaper_zombie', row: 2, column: 8, columnPosition: 7.6,
        xBand: 'far', speedCellsPerSecond: 0.3, speed: 'slow', phase: 'reading', condition: 'damaged',
        armor: 'worn', shield: 'lost', hypnotized: false, slowed: true,
        immobilized: false,
      }],
      gridItems: [{ id: 661006, kind: 'gravestone', row: 4, column: 6 }],
      collectibles: [
        { id: 991003, kind: 'sun', x: 10, y: 10, row: 1, column: 1 },
        { id: 991004, kind: 'sun', x: 20, y: 20, row: 2, column: 2 },
        { id: 991005, kind: 'silver_coin', x: 30, y: 30, row: 3, column: 3 },
      ],
    });
    const state = snapshot({
      screen: 'board', board,
      profile: { ...snapshot().profile!, name: 'BoardOwner' },
      lastRun: { resultId: 555001, runId: 555002, mode: 22, level: 0, outcome: 'won' },
    });

    const summary = renderSnapshot(state);
    expect(summary).toContain('关卡 1 · 冒险 · 夜间泳池 · 进行中');
    // 坐标朝向由 ENV_PROMPT 说一次,不按快照份数重复
    expect(summary).not.toContain('僵尸朝列号更小的方向走');
    expect(summary).toContain('豌豆射手[100阳光/可用]');
    expect(summary).toContain('模仿者(豌豆射手)[100阳光/冷却剩3.6秒]');
    expect(summary).toContain('第1排 1小喷菇（轻损，睡眠） 2空 3空');
    expect(summary).toContain('第2排 1空 2空 3土豆雷（动作中） 4空');
    expect(summary).toContain('第4排 1空 2空 3空 4空 5空 6墓碑 7空 8空 9空');
    expect(summary).toContain('第5排 1空 2空 3空 4空 5空 6空 7空 8空 9空');
    // 僵尸写在它脚下那格后面,不再单列一行
    expect(summary).toContain('7空 8空←读报僵尸7.6列（0.30格/秒·向房子');
    expect(summary).not.toMatch(/^僵尸 /m);
    expect(summary).toContain('收集物 银币×1, 阳光×2');
    expect(summary).not.toContain('植物布局');
    expect(summary).not.toContain('地格详情');
    expect(summary).not.toContain('档案 BoardOwner');
    expect(summary).not.toContain('模式解锁');
    expect(summary).not.toContain('最近结算');
    for (const internal of ['71:', '84:', '771001', '771002', '881002', '661006', '991003', '991004', '991005']) {
      expect(summary).not.toContain(internal);
    }

    const compact = compactSnapshot(state);
    expect(compact).not.toHaveProperty('档案');
    expect(compact).not.toHaveProperty('最近结算');
    expect(compact).toMatchObject({
      棋盘状态: {
        场景: '夜间泳池',
        方向: '第1列靠着房子，第9列出怪，僵尸朝列号更小的方向走',
        卡片: [
          '豌豆射手[100阳光/可用]',
          '模仿者(豌豆射手)[100阳光/冷却剩3.6秒]（变身需时）',
        ],
        僵尸: [expect.stringContaining('读报僵尸在第2排第7.6列（0.30格/秒')],
        收集物: '银币×1, 阳光×2',
      },
    });
    const compactJson = JSON.stringify(compact);
    expect(compactJson).not.toMatch(/"(?:id|slot|type|inputControl|cursor|runId)"/);
    expect(compactJson).not.toMatch(/771001|771002|881002|661006|991003|991004|991005/);
  });

  it('战术快照保留当前作战事实并删除静态规则与默认植物字段', () => {
    const board = boardState({
      level: 17,
      background: 3,
      paused: true,
      sun: 75,
      fog: { active: true, visibilityRule: 'rendered_fog' },
      cards: [{
        slot: 71, type: 10, name: 'fume_shroom', imitates: null, cost: 75,
        ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
      }],
      plants: [
        {
          id: 710001, type: 0, name: 'peashooter', row: 1, column: 1,
          phase: 'active', condition: 'intact', sleeping: false, squished: false,
          layers: ['main'],
        },
        {
          id: 710002, type: 4, name: 'potato_mine', row: 2, column: 3,
          phase: 'potato_mine_arming', condition: 'worn', sleeping: false,
          squished: false, layers: [],
        },
        {
          id: 710003, type: 8, name: 'puff_shroom', row: 3, column: 4,
          phase: 'sleeping', condition: 'damaged', sleeping: true, squished: true,
          layers: ['main', 'pumpkin'],
        },
      ],
      zombies: [{
        id: 720001, type: 5, name: 'newspaper_zombie', row: 2, column: 7, columnPosition: 6.7,
        xBand: 'mid', speedCellsPerSecond: 0.2, speed: 'slow', phase: 'reading', condition: 'damaged',
        armor: 'worn', shield: 'lost', hypnotized: false, slowed: true,
        immobilized: true,
      }],
      collectibles: [
        { id: 730001, kind: 'sun', x: 10, y: 10, row: 1, column: 2 },
        { id: 730002, kind: 'sun', x: 20, y: 20, row: 2, column: 2 },
      ],
      allowedSpecialActions: ['zen_sell'],
      special: {
        phase: 'care', settled: true,
        targets: [{
          action: 'zen_sell', kind: 'plant', id: 710001, slot: null, row: 1, column: 1,
        }],
      },
    });
    board.cells[0] = { ...board.cells[0]!, blocker: 'occupied' };
    board.cells[10] = { ...board.cells[10]!, blocker: 'gravestone' };
    board.cells[16] = {
      ...board.cells[16]!, playable: null, blocker: 'fog_hidden', base: 'unknown',
    };
    const state = snapshot({
      revision: 812,
      screen: 'board', modeName: 'adventure', board,
      menu: [{
        id: 'pause', label: 'Pause', enabled: true, x: 0, y: 0,
        state: null, record: null,
      }],
    });

    const tactical = renderTacticalSnapshot(state);
    expect(tactical).toContain('[PvZ 状态 r812] 画面=棋盘 模式=冒险');
    expect(tactical).toContain('关卡 17 · 冒险 · 夜间泳池 · 暂停');
    expect(tactical).toContain('阳光 75 · 0/1 面旗');
    expect(tactical).toContain('卡片 大喷菇[75阳光/可用]');
    expect(tactical).toContain('第1排 1豌豆射手 2空');
    expect(tactical).toContain('3土豆雷（轻损，准备中）');
    expect(tactical).toContain('小喷菇（受损，被压扁）');
    expect(tactical).toContain('7空←读报僵尸6.7列（0.20格/秒·向房子');
    expect(tactical).toContain('收集物 阳光×2');
    expect(tactical).toContain('割草机 第1排割草机待命');
    expect(tactical).toContain('2墓碑占用');
    expect(tactical).toContain('8雾中未知');
    expect(tactical).toContain('特殊动作 出售植物');
    expect(tactical).toContain('特殊阶段 稳定');
    expect(tactical).toContain('特殊目标 出售植物·豌豆射手在第1排第1列');
    expect(tactical).not.toMatch(/坐标方向|僵尸朝列号更小的方向走|卡片机制|occupied|植物布局|地格详情/);
    expect(tactical).not.toMatch(/phase=active|sleep=no|squished=no|layers=main(?:,|$)/);
    expect(tactical).not.toMatch(/710001|710002|710003|720001|730001|730002|71:/);
    expect(tactical).toBe(renderSnapshot(state));
  });

  it('战术快照在黑暗阶段不读取隐藏实体或地格内容', () => {
    const board = boardState({
      fog: { active: true, visibilityRule: 'rendered_fog' },
      disclosure: { entitiesVisible: false, phase: 'dark' },
      plants: [{
        id: 810001, type: 0, name: 'hidden_plant', row: 1, column: 1,
        phase: 'active', condition: 'critical', sleeping: false, squished: false,
        layers: ['main'],
      }],
      zombies: [{
        id: 820001, type: 0, name: 'hidden_zombie', row: 1, column: 2, columnPosition: 2,
        xBand: 'near', speedCellsPerSecond: 0.0, speed: 'fast', phase: 'walking', condition: 'intact',
        armor: 'none', shield: 'none', hypnotized: false, slowed: false,
        immobilized: false,
      }],
      collectibles: [{ id: 830001, kind: 'diamond', x: 1, y: 1, row: 1, column: 3 }],
      allowedSpecialActions: ['zen_sell'],
      special: {
        phase: 'hidden_care', settled: true,
        targets: [{
          action: 'zen_sell', kind: 'plant', id: 810001, slot: null, row: 1, column: 1,
        }],
      },
    });
    board.cells[0] = { ...board.cells[0]!, blocker: 'secret_blocker' };
    board.cells[1] = {
      ...board.cells[1]!, playable: false, blocker: 'dark_hidden', base: 'unknown',
    };

    const tactical = renderTacticalSnapshot(snapshot({ screen: 'board', board }));
    expect(tactical).toContain('棋盘 5排×9列 黑暗中不可见');
    expect(tactical).not.toContain('第1排');
    expect(tactical).toContain('僵尸 黑暗中不可见');
    expect(tactical).toContain('收集物 黑暗中不可见');
    expect(tactical).toContain('割草机 黑暗中不可见');
    expect(tactical).toContain('黑暗阶段只允许盲放卡片');
    expect(tactical).toContain('特殊目标 黑暗中不可见');
    expect(tactical).not.toMatch(/hidden_plant|hidden_zombie|diamond|secret_blocker|810001|820001|830001/);
  });

  it('非棋盘战术快照沿用现有 summary', () => {
    const state = snapshot({ screen: 'seed_picker' });
    expect(renderTacticalSnapshot(state)).toBe(renderSnapshot(state, 'summary'));
  });

  it('普通与 Whack 棋盘使用同一份精简卡片状态', () => {
    const board = boardState({
      cards: [
        {
          slot: 4, type: 2, name: 'cherry_bomb', imitates: null, cost: 150,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        },
        {
          slot: 7, type: 48, name: 'imitater', imitates: 2, cost: 150,
          ready: false, affordable: true, cooldown: 'medium', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 130, y: 40,
        },
      ],
    });
    const ordinary = snapshot({ screen: 'board', mode: 0, modeName: 'adventure', board });
    const whack = structuredClone(ordinary);
    whack.mode = 30;
    whack.modeName = 'whack_a_zombie';

    const ordinaryLine = renderSnapshot(ordinary).split('\n')
      .find((line) => line.startsWith('卡片 '));
    const whackLine = renderSnapshot(whack).split('\n')
      .find((line) => line.startsWith('卡片 '));
    expect(ordinaryLine).toBe(whackLine);
    expect(ordinaryLine).toContain('樱桃炸弹[150阳光/可用]');
    expect(ordinaryLine).toContain('模仿者(樱桃炸弹)[150阳光/冷却剩0.0秒]');
    expect(renderSnapshot(ordinary)).not.toContain('卡片机制');

    const compact = compactSnapshot(ordinary);
    expect(compact).toMatchObject({
      棋盘状态: {
        卡片: [
          '樱桃炸弹[150阳光/可用]（短暂延时；一次性）',
          '模仿者(樱桃炸弹)[150阳光/冷却剩0.0秒]（变身需时；短暂延时；一次性）',
        ],
      },
    });
    expect(JSON.stringify(compact)).not.toContain('sunflower');
  });

  it('full 只输出语义模式、背景、实体、对话与特殊目标', () => {
    const state = snapshot({
      screen: 'board', mode: 22, modeName: 'seeing_stars', modeKind: 'minigame',
      menu: [{
        id: 'mode_17', label: 'wall_nut_bowling', enabled: true, x: 10, y: 10,
        state: 'completed', record: null,
      }],
      dialog: {
        id: 246802, hasPrimary: true, hasSecondary: true,
        primaryLabel: 'Resume', secondaryLabel: 'Main Menu',
      },
      lastRun: { resultId: 135701, runId: 135702, mode: 22, level: 0, outcome: 'won' },
      board: boardState({
        background: 3,
        cards: [{
          slot: 7, type: 161803, name: 'starfruit', imitates: null, cost: 125,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        plants: [{
          id: 987654, type: 314159, name: 'starfruit', row: 2, column: 3,
          phase: 'firing', condition: 'intact', sleeping: false, squished: false, layers: [],
        }],
        zombies: [{
          id: 876543, type: 271828, name: 'zombie', row: 2, column: 8, columnPosition: 8, xBand: 'far', speedCellsPerSecond: 0.0,
          speed: 'normal', phase: 'walking', condition: 'intact', armor: 'none',
          shield: 'none', hypnotized: false, slowed: false, immobilized: false,
        }],
        gridItems: [{ id: 765432, kind: 'gravestone', row: 4, column: 6 }],
        allowedSpecialActions: ['zen_sell'],
        special: {
          phase: 'care', settled: true,
          targets: [{
            action: 'zen_sell', kind: 'plant', id: 987654, slot: null, row: 2, column: 3,
          }],
        },
      }),
    });

    const full = renderSnapshot(state, 'full');
    expect(full).toContain('模式=种星星');
    expect(full).toContain('关卡 1 · 种星星 · 夜间泳池');
    expect(full).toContain('wall_nut_bowling(已完成)');
    expect(full).not.toContain('confirm[Resume]');
    expect(full).toContain('特殊目标 出售植物·杨桃在第2排第3列');
    expect(full.match(/特殊目标 /g)).toHaveLength(1);
    expect(full).toContain('3杨桃（攻击中）');
    expect(full).toContain('8空←普通僵尸8.0列（0.00格/秒');
    expect(full).not.toContain('mode_17');
    expect(full).not.toContain('fog(3)');
    expect(full).not.toContain('slot=');
    for (const internal of [
      '246802', '135701', '135702', '161803', '987654', '314159',
      '876543', '271828', '765432',
    ]) {
      expect(full).not.toContain(internal);
    }
  });

  it('选卡页只公开植物名并明确区分 Imitater', () => {
    const selecting = snapshot({
      screen: 'seed_picker',
      board: boardState({
        plants: [{
          id: 908090, type: 0, name: 'stale_board_plant', row: 1, column: 1,
          condition: 'intact', sleeping: false, squished: false, layers: [],
        }],
      }),
      seedPicker: {
        capacity: 2,
        selected: [483920],
        choices: [
          {
            id: 483920, name: 'imitater', state: 'selected', bankSlot: 0, imitates: 0,
            recommended: false, fixed: true, x: 100, y: 100,
          },
          {
            id: 120012, name: 'sunflower', state: 'chooser', bankSlot: null, imitates: null,
            recommended: true, fixed: false, x: 120, y: 100,
          },
        ],
        previewZombies: [{ type: 700007, name: 'conehead_zombie' }],
        ready: false,
      },
    });

    const rendered = renderSnapshot(selecting);
    expect(rendered).toContain('选卡 1/2: 模仿者(豌豆射手)[固定]');
    expect(rendered).toContain('可选植物: 模仿者(豌豆射手)*[固定], 向日葵');
    expect(rendered).toContain('本关预告敌人: 路障僵尸');
    expect(rendered).not.toMatch(/483920|120012|700007|908090|stale_board_plant|peashooter:0/);
    const compact = compactSnapshot(selecting);
    expect(compact).not.toHaveProperty('棋盘状态');
    expect(compact).toMatchObject({
      选卡: {
        已选: ['模仿者(豌豆射手)[固定]'],
        可选: ['模仿者(豌豆射手)[固定]', '向日葵'],
        敌人预告: ['路障僵尸'],
      },
    });
    expect(JSON.stringify(compact)).not.toMatch(/483920|120012|700007|908090|"id"|"type"/);
  });

  it('Seeing Stars 用纯语义目标说明普通种植位置', () => {
    const state = snapshot({
      screen: 'board', mode: 22, modeName: 'seeing_stars', modeKind: 'minigame',
      board: boardState({
        special: {
          phase: 'playing', settled: true,
          targets: [
            { action: 'objective_starfruit', kind: 'cell', id: null, slot: null, row: 2, column: 3 },
            { action: 'objective_starfruit', kind: 'cell', id: null, slot: null, row: 4, column: 5 },
          ],
        },
      }),
    });

    const rendered = renderSnapshot(state);
    expect(rendered).toContain('种星星剩余目标 杨桃目标在第2排第3列, 杨桃目标在第4排第5列');
    expect(rendered).not.toContain('starfruit(29)');
    expect(rendered).not.toContain('特殊目标 objective_starfruit');
  });

  it('大量 I-Zombie 目标使用语义卡名并保持有界', () => {
    const cards = ['zombie', 'conehead_zombie', 'buckethead_zombie', 'football_zombie', 'digger_zombie']
      .map((name, index) => ({
        slot: 40 + index, type: 100 + index, name, imitates: null, cost: 50,
        ready: true, affordable: true, cooldown: 'ready' as const, cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80 + index * 40, y: 40,
      }));
    const targets = cards.flatMap((card) =>
      Array.from({ length: 5 }, (_, row) =>
        Array.from({ length: 9 }, (_, column) => ({
          action: 'place_zombie', kind: 'cell' as const, id: null, slot: card.slot,
          row: row + 1, column: column + 1,
        }))).flat());
    const state = snapshot({
      screen: 'board', modeName: 'i_zombie', modeKind: 'i_zombie',
      board: boardState({
        cards,
        allowedSpecialActions: ['place_zombie'],
        special: { phase: 'ready', settled: true, targets },
      }),
    });

    const summary = renderSnapshot(state);
    expect(summary).toContain('放置僵尸·普通僵尸在第1-5排第1-9列');
    expect(summary).toContain('放置僵尸·矿工僵尸在第1-5排第1-9列');
    expect(summary).not.toContain('slot=40');
    expect(summary.length).toBeLessThan(6000);

    const compact = compactSnapshot(state);
    expect(compact).toMatchObject({
      棋盘状态: {
        特殊: {
          阶段: '稳定', 动作: ['放置僵尸'],
        },
      },
    });
    const compactSpecial = (compact.棋盘状态 as { 特殊: { 目标: string[] } }).特殊;
    expect(compactSpecial.目标[0])
      .toBe('放置僵尸·普通僵尸在第1-5排第1-9列');
    expect(compactSpecial.目标).toHaveLength(5);
    expect(JSON.stringify(compact)).not.toMatch(/"slot"|"targetId"|"type"/);
  });

  it('黑暗快照明确不可观测，且不把空数组解释为零对象', () => {
    const dark = snapshot({
      screen: 'board',
      board: boardState({
        disclosure: { entitiesVisible: false, phase: 'dark' },
        plants: [], zombies: [], gridItems: [], collectibles: [],
      }),
    });

    expect(compactSnapshot(dark)).toMatchObject({
      棋盘状态: {
        棋盘: Array.from({ length: 5 }, () => Array(9).fill('黑暗未知')),
        僵尸: '黑暗中不可见', 收集物: '黑暗中不可见', 割草机: '黑暗中不可见',
      },
    });
    const summary = renderSnapshot(dark);
    expect(summary).toContain('僵尸 黑暗中不可见');
    expect(summary).not.toContain('僵尸 无');

    const full = renderSnapshot(dark, 'full');
    expect(full).toContain('棋盘 5排×9列 黑暗中不可见');
    expect(full).not.toMatch(/第1排|植物布局|地格详情|gridItems|plants/);
  });

  it('普通迷雾保留可尝试地格与语义格子状态', () => {
    const board = boardState({ fog: { active: true, visibilityRule: 'rendered_fog' } });
    board.cells[7] = {
      ...board.cells[7]!, playable: null, blocker: 'fog_hidden', base: 'unknown',
    };
    const rendered = renderSnapshot(snapshot({ screen: 'board', board }), 'full');

    expect(rendered).toContain('雾中未知');
    expect(rendered).toContain('雾中未知格允许盲放，动态占用未知');
    expect(rendered).not.toContain('fog_hidden');
  });

  it('模式选择用语义名称而非 mode 数字目标', () => {
    const state = snapshot({
      screen: 'mode_selector',
      menu: [
        { id: 'mode_17', label: 'wall_nut_bowling', enabled: true, x: 100, y: 100, state: 'completed', record: null },
        { id: 'mode_60', label: 'vasebreaker_endless', enabled: true, x: 200, y: 100, state: 'available', record: 8 },
        { id: 'mode_23', label: 'locked', enabled: false, x: 300, y: 100, state: 'locked', record: null },
      ],
    });

    const rendered = renderSnapshot(state);
    expect(rendered).toContain('wall_nut_bowling(已完成)');
    expect(rendered).toContain('vasebreaker_endless(纪录 8)');
    expect(rendered).toContain('locked(锁定)');
    expect(rendered).not.toMatch(/mode_(17|60|23)/);
    expect(compactSnapshot(state)).toMatchObject({
      菜单: ['wall_nut_bowling(已完成)', 'vasebreaker_endless(纪录 8)', 'locked(锁定)'],
    });
  });

  it('玩家列表只公开语义创建与取消，不伪造无参确认动作', () => {
    const state = snapshot({
      screen: 'dialog',
      menu: [
        {
          id: 'profile_create', label: 'Create profile', enabled: true,
          x: 394, y: 225, state: null, record: null,
        },
        {
          id: 'cancel', label: 'Cancel', enabled: true,
          x: 580, y: 515, state: null, record: null,
        },
      ],
      dialog: {
        id: 918273, hasPrimary: false, hasSecondary: true,
        primaryLabel: null, secondaryLabel: 'Cancel',
      },
    });

    const rendered = renderSnapshot(state);
    expect(rendered).toContain('profile_create[Create profile]');
    expect(rendered).toContain('cancel[Cancel]');
    expect(rendered.match(/cancel\[Cancel\]/g)).toHaveLength(1);
    expect(rendered).not.toContain('confirm[');
    expect(JSON.stringify(compactSnapshot(state))).not.toContain('918273');
  });

  it('商店动作保留语义目标、价格与购买状态', () => {
    const rendered = renderSnapshot(snapshot({
      screen: 'dialog',
      menu: [
        {
          id: 'store_buy_fertilizer', label: 'Fertilizer (5 uses)', enabled: true,
          x: 200, y: 220, state: 'available', record: 750,
        },
        {
          id: 'store_buy_bug_spray', label: 'Bug Spray', enabled: false,
          x: 300, y: 220, state: 'unaffordable', record: 1000,
        },
      ],
    }));
    expect(rendered).toContain('store_buy_fertilizer[Fertilizer (5 uses)](价格 750)');
    expect(rendered).toContain('store_buy_bug_spray[Bug Spray](价格 1000/金币不足)');
    expect(rendered).not.toContain('纪录 750');
  });

  it('Zen 全局特殊目标保持纯语义描述', () => {
    const zen = snapshot({
      screen: 'board', mode: 43, modeName: 'zen_garden', modeKind: 'zen_garden',
      board: boardState({
        background: 7,
        allowedSpecialActions: ['zen_next_garden', 'tree_feed'],
        special: {
          phase: 'care', settled: true,
          targets: [
            {
              action: 'zen_next_garden', kind: 'cell', id: null, slot: null,
              row: null, column: null,
            },
            {
              action: 'tree_feed', kind: 'cell', id: null, slot: null,
              row: null, column: null,
            },
          ],
        },
      }),
    });

    const rendered = renderSnapshot(zen, 'full');
    const compact = JSON.stringify(compactSnapshot(zen));
    expect(rendered).toContain('关卡 1 · 禅境花园 · 温室');
    expect(rendered).toContain('特殊目标 切换花园, 给智慧树施肥');
    expect(rendered).not.toMatch(/height|树高|background_7/i);
    expect(compact).not.toMatch(/height|树高|background_7/i);
  });
});

describe('PvZ 棋盘逐格渲染', () => {
  it('空荷叶、荷叶上的植物、水和站在格里的僵尸各有自己的写法，僵尸不再单列一行', () => {
    const board = boardState({ rows: 6, background: 2 });
    for (const row of [3, 4]) {
      for (let column = 1; column <= 9; column++) {
        const index = board.cells.findIndex((cell) => cell.row === row && cell.column === column);
        board.cells[index] = { ...board.cells[index]!, terrain: 'water', blocker: 'requires_lily_pad' };
      }
    }
    const plant = (id: number, type: number, name: string, row: number, column: number) => ({
      id, type, name, row, column, phase: 'active', condition: 'intact' as const,
      sleeping: false, squished: false, layers: [],
    });
    board.plants = [
      plant(1, 16, 'lily_pad', 3, 1), plant(2, 16, 'lily_pad', 3, 2), plant(3, 7, 'repeater', 3, 2),
      plant(4, 1, 'sunflower', 2, 1),
    ];
    const zombie = (id: number, row: number, column: number, columnPosition: number) => ({
      id, type: 0, name: 'zombie', row, column, columnPosition, xBand: 'mid' as const,
      speedCellsPerSecond: 0.17, speed: 'slow' as const, phase: 'walking', condition: 'intact' as const,
      armor: 'none' as const, shield: 'none' as const, hypnotized: false, slowed: false, immobilized: false,
    });
    board.zombies = [zombie(21, 3, 2, 2.4), zombie(22, 1, 0, 0.2), zombie(23, 2, 10, 9.6), zombie(24, 2, 10, 9.8)];

    const rendered = renderSnapshot(snapshot({ screen: 'board', board }));
    expect(rendered).toContain('棋盘 6排×9列（第1列靠房子；格前数字是列号）');
    expect(rendered).toContain('第3排（水面） 1空荷叶 2双发射手（荷叶上）←普通僵尸2.4列（0.17格/秒·向房子，行进） 3水 4水 5水 6水 7水 8水 9水');
    expect(rendered).toContain('第4排（水面） 1水 2水');
    // 走进房子的和还没走上棋盘的都夹在边上那格,小数列照写
    expect(rendered).toContain('第1排 1空←普通僵尸0.2列（');
    expect(rendered).toContain('第2排 1向日葵 2空 3空 4空 5空 6空 7空 8空 9空←普通僵尸9.6列（0.17格/秒·向房子，行进）、普通僵尸9.8列（');
    expect(rendered).not.toMatch(/^僵尸 /m);
    expect(rendered).not.toContain('需要荷叶');
  });
});
