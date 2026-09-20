import { describe, expect, it } from 'vitest';
import {
  createPvzEventMemory,
  isWhackSnapshot,
  renderWhackPrefetchCue,
  renderWhackTaskState,
  renderWhackTargetReady,
  trackSnapshot,
} from '../src/events.ts';
import { renderWhackSkillQueueCall } from '../src/tools.ts';
import { boardState, snapshot } from './helpers.ts';
import { renderSnapshot, renderTacticalSnapshot, compactSnapshot } from '../src/render.ts';

it('僵王动作变化分别描述头部伸入、瞄准、吐球与收回', () => {
  let before = snapshot({ screen: 'board', mode: 35, board: boardState({ boss: {
    phase: 'boss_idle', immobilized: false, projectile: null,
  } }) });
  for (const [phase, label] of [
    ['boss_head_entering', '头部伸入棋盘'], ['boss_aiming', '头部瞄准'],
    ['boss_spitting', '吐出冰火球'], ['boss_head_leaving', '头部收回'],
  ]) {
    const after = structuredClone(before);
    after.board!.boss!.phase = phase!;
    expect(renderSnapshot(after)).toContain(label!);
    expect(trackSnapshot(after, before)).toContainEqual(expect.objectContaining({
      type: 'pvz.boss.phase', text: `[PvZ] ${label}`, urgent: true,
    }));
    expect(trackSnapshot(after, after).some(event => event.type === 'pvz.boss.phase')).toBe(false);
    before = after;
  }
});

it('reports boss freeze and thaw once without inferring thaw from a hidden board', () => {
  const before = snapshot({ screen: 'board', mode: 35, board: boardState({ boss: {
    phase: 'boss_aiming', immobilized: false, projectile: null,
  } }) });
  const frozen = structuredClone(before);
  frozen.board!.boss!.immobilized = true;
  expect(trackSnapshot(frozen, before)).toContainEqual(expect.objectContaining({
    type: 'pvz.boss.immobilized', text: '[PvZ] 僵王已定身', urgent: true,
  }));
  expect(trackSnapshot(before, frozen)).toContainEqual(expect.objectContaining({
    type: 'pvz.boss.immobilized', text: '[PvZ] 僵王定身已解除', urgent: true,
  }));
  expect(trackSnapshot(frozen, frozen).some(event => event.type === 'pvz.boss.immobilized')).toBe(false);
  before.board!.disclosure.entitiesVisible = false;
  expect(trackSnapshot(before, frozen).some(event => event.type === 'pvz.boss.immobilized')).toBe(false);
});

it('冰火球出现和消失产生事件，滚动不重复出现，遮挡不冒充消失', () => {
  const before = snapshot({ screen: 'board', mode: 35, board: boardState({ boss: {
    phase: 'boss_spitting', immobilized: false, projectile: null,
  } }) });
  const after = structuredClone(before);
  after.board!.boss!.projectile = { kind: 'iceball', row: 4, columnPosition: 6.5 };
  expect(trackSnapshot(after, before)).toContainEqual(expect.objectContaining({
    type: 'pvz.boss.projectile', text: '[PvZ] 冰球在第4排第6.5列，向房子滚动', urgent: true,
  }));
  const moved = structuredClone(after);
  moved.board!.boss!.projectile!.columnPosition = 5;
  expect(trackSnapshot(moved, after).filter(event => event.type === 'pvz.boss.projectile')).toEqual([]);
  expect(trackSnapshot(before, after)).toContainEqual(expect.objectContaining({
    type: 'pvz.boss.projectile', text: '[PvZ] 第4排冰球已不在画面中',
  }));
  const hidden = structuredClone(before);
  hidden.board!.boss = null;
  hidden.board!.disclosure = { entitiesVisible: false, phase: 'dark' };
  expect(trackSnapshot(hidden, after).filter(event => event.type === 'pvz.boss.projectile')).toEqual([]);
});

it('可见冰道生长与清除改变地格和事件，遮挡不冒充清冰', () => {
  const before = snapshot({ screen: 'board', mode: 28, modeName: 'bobsled_bonanza', board: boardState() });
  const icy = structuredClone(before);
  for (const cell of icy.board!.cells.filter(cell => cell.row === 1 && cell.column >= 5)) {
    cell.blocker = 'ice_trail';
    cell.playable = false;
  }
  for (const text of [renderSnapshot(icy), renderTacticalSnapshot(icy), JSON.stringify(compactSnapshot(icy))]) {
    expect(text).toContain('冰道');
  }
  expect(trackSnapshot(icy, before)).toContainEqual(expect.objectContaining({
    type: 'pvz.terrain.ice', text: '[PvZ] 第1排冰道覆盖第5、6、7、8、9列，不能种植', urgent: true,
  }));
  expect(trackSnapshot(before, icy)).toContainEqual(expect.objectContaining({
    type: 'pvz.terrain.ice', text: '[PvZ] 第1排冰道已清除', urgent: true,
  }));
  expect(trackSnapshot(icy, icy).some(event => event.type === 'pvz.terrain.ice')).toBe(false);
  const hidden = structuredClone(icy);
  hidden.board!.cells.filter(cell => cell.row === 1).forEach(cell => { cell.blocker = 'fog_hidden'; cell.playable = null; });
  expect(trackSnapshot(hidden, icy).some(event => event.type === 'pvz.terrain.ice')).toBe(false);
});

it('传送门配对包含右边界，换位和可见僵尸跨排移动产生事件', () => {
  const before = snapshot({ screen: 'board', mode: 26, modeName: 'portal_combat', board: boardState({
    gridItems: [
      { id: 1, kind: 'square_portal', row: 1, column: 3 },
      { id: 2, kind: 'square_portal', row: 2, column: 10 },
      { id: 3, kind: 'round_portal', row: 4, column: 10 },
      { id: 4, kind: 'round_portal', row: 5, column: 3 },
    ],
    zombies: [{ id: 1, type: 0, name: 'zombie', row: 2, column: 9, columnPosition: 9,
      xBand: 'far', speedCellsPerSecond: 0.1, condition: 'intact', armor: 'none', shield: 'none',
      hypnotized: false, slowed: false, immobilized: false }],
  }) });
  for (const text of [renderSnapshot(before), renderTacticalSnapshot(before), JSON.stringify(compactSnapshot(before))]) {
    expect(text).toContain('方形传送门：第1排第3列 ↔ 第2排右边界');
    expect(text).toContain('圆形传送门：第4排右边界 ↔ 第5排第3列');
  }
  const after = structuredClone(before);
  after.board!.gridItems[0]!.row = 3;
  Object.assign(after.board!.zombies[0]!, { row: 1, column: 2, columnPosition: 2 });
  expect(trackSnapshot(after, before)).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'pvz.portals.changed', text: expect.stringContaining('第3排第3列'), urgent: true }),
    expect.objectContaining({ type: 'pvz.zombie.relocated', text: expect.stringContaining('从第2排第9列移到第1排第2列'), urgent: true }),
  ]));
  expect(trackSnapshot(after, after).some(event => ['pvz.portals.changed', 'pvz.zombie.relocated'].includes(event.type))).toBe(false);
  after.board!.gridItems.push({ id: 5, kind: 'round_portal', row: 1, column: 5 });
  expect(renderSnapshot(after)).toContain('圆形传送门可见位置：第1排第5列、第4排右边界、第5排第3列');
  after.board!.disclosure = { entitiesVisible: false, phase: 'dark' };
  expect(renderSnapshot(after)).not.toContain('右边界');
  expect(trackSnapshot(after, before).some(event => event.type === 'pvz.portals.changed')).toBe(false);
});

it('水族僵尸变绿报告饥饿，进食恢复体色；游近左侧不产生近屋威胁', () => {
  const before = snapshot({ screen: 'board', mode: 23, modeName: 'zombiquarium', board: boardState({
    zombies: [{ id: 1, type: 11, name: 'snorkel_zombie', row: 2, column: 7,
      columnPosition: 7, xBand: 'far', phase: 'zombiquarium_drifting', speedCellsPerSecond: 0.1,
      condition: 'intact', armor: 'none', shield: 'none', hypnotized: false, slowed: false, immobilized: false }],
  }) });
  const hungry = structuredClone(before);
  Object.assign(hungry.board!.zombies[0]!, { condition: 'worn', xBand: 'lawn', column: 1, columnPosition: 1 });
  const events = trackSnapshot(hungry, before);
  expect(events).toContainEqual(expect.objectContaining({ type: 'pvz.zombie.hunger', urgent: true }));
  expect(events.some(event => event.type.startsWith('pvz.threat.'))).toBe(false);
  for (const text of [renderSnapshot(hungry), renderTacticalSnapshot(hungry), JSON.stringify(compactSnapshot(hungry))]) {
    expect(text).toContain('饥饿（身体变绿）');
    expect(text).toContain('游动');
    expect(text).not.toMatch(/向房子|本体轻损/);
  }
  expect(trackSnapshot(hungry, hungry).some(event => event.type === 'pvz.zombie.hunger')).toBe(false);
  const fed = structuredClone(hungry);
  Object.assign(fed.board!.zombies[0]!, { condition: 'intact', phase: 'zombiquarium_biting' });
  expect(trackSnapshot(fed, hungry)).toContainEqual(expect.objectContaining({
    type: 'pvz.zombie.hunger', text: expect.stringContaining('恢复正常体色'), urgent: false,
  }));
  expect(renderSnapshot(fed)).toContain('进食');
});

it('种子拾取与释放报告手持变化，光标移动不重复通知', () => {
  const before = snapshot({ screen: 'board', board: boardState() });
  const held = structuredClone(before);
  held.board!.cursor = { kind: 'usable_seed', heldType: 16, logicalX: 320, logicalY: 130 };
  expect(trackSnapshot(held, before)).toContainEqual(expect.objectContaining({
    type: 'pvz.cursor.changed', text: '[PvZ] 手持 可用种子包（荷叶）', urgent: true,
  }));
  const moved = structuredClone(held);
  moved.board!.cursor.logicalX += 100;
  expect(trackSnapshot(moved, held).some(event => event.type === 'pvz.cursor.changed')).toBe(false);
  const released = structuredClone(moved);
  released.board!.cursor.kind = 'normal';
  expect(trackSnapshot(released, moved)).toContainEqual(expect.objectContaining({
    type: 'pvz.cursor.changed', text: '[PvZ] 手持 无',
  }));
});

describe('PvZ 事件驱动唤醒', () => {
  it('对新掉落物、新可见僵尸与逼近分别产生聚合事件', () => {
    const before = snapshot({ screen: 'board', board: boardState({
      zombies: [{
        id: 1, type: 0, name: 'zombie', row: 1, column: 8, columnPosition: 8, xBand: 'far', speedCellsPerSecond: 0.0,
        condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
        slowed: false, immobilized: false,
      }],
    }) });
    const after = structuredClone(before);
    after.revision += 1;
    after.board!.collectibles.push({ id: 9, kind: 'silver_coin', x: 300, y: 200, row: 2, column: 3 });
    after.board!.zombies[0].xBand = 'near';
    after.board!.zombies.push({
      id: 2, type: 2, name: 'conehead', row: 3, column: 9, columnPosition: 9, xBand: 'far', speedCellsPerSecond: 0.0,
      condition: 'intact', armor: 'intact', shield: 'none', hypnotized: false,
      slowed: false, immobilized: false,
    });

    const events = trackSnapshot(after, before);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'pvz.collectible.appeared', 'pvz.zombie.visible', 'pvz.threat.approaching',
    ]));
    expect(events.find((event) => event.type === 'pvz.threat.approaching')?.urgent).toBe(true);
    expect(events.find((event) => event.type === 'pvz.collectible.appeared')?.urgent).toBe(false);
    expect(events.find((event) => event.type === 'pvz.collectible.appeared')?.routineKey)
      .toBe('collectible:silver_coin');
    expect(events.find((event) => event.type === 'pvz.zombie.visible')?.routineKey)
      .toBe('zombie:conehead:R3:far');
    expect(events.find((event) => event.type === 'pvz.threat.approaching')?.routineKey)
      .toBeUndefined();
  });

  it('阳光不再作为可收集机会出现在事件里，同批的其他掉落物照报', () => {
    const before = snapshot({ screen: 'board', board: boardState() });
    const onlySun = structuredClone(before);
    onlySun.revision += 1;
    onlySun.board!.collectibles = [
      { id: 1, kind: 'sun', x: 320, y: 180, row: 2, column: 3 },
      { id: 2, kind: 'small_sun', x: 340, y: 180, row: 2, column: 4 },
      { id: 3, kind: 'large_sun', x: 360, y: 180, row: 2, column: 5 },
    ];
    expect(trackSnapshot(onlySun, before)).toEqual([]);

    const mixed = structuredClone(onlySun);
    mixed.revision += 1;
    mixed.board!.collectibles.push({
      id: 4, kind: 'gold_coin', x: 380, y: 180, row: 2, column: 6,
    });
    const events = trackSnapshot(mixed, onlySun);
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toContain('出现可收集对象：金币');
    expect(events[0]?.text).not.toContain('阳光');
  });

  it('近屋威胁直接说明对应路线是否仍有割草机', () => {
    const before = snapshot({ screen: 'board', board: boardState({
      zombies: [{
        id: 1, type: 2, name: 'conehead', row: 4, column: 2, columnPosition: 2, xBand: 'near', speedCellsPerSecond: 0.0,
        condition: 'intact', armor: 'intact', shield: 'none', hypnotized: false,
        slowed: false, immobilized: false,
      }],
    }) });
    before.board!.mowers = before.board!.mowers.filter((mower) => mower.row !== 4);
    const after = structuredClone(before);
    after.revision += 1;
    after.board!.zombies[0]!.xBand = 'lawn';

    const event = trackSnapshot(after, before)
      .find((candidate) => candidate.type === 'pvz.threat.close');
    expect(event).toMatchObject({ urgent: true });
    expect(event?.text).toContain('路障僵尸在第4排第2列（这排没有可用割草机）');

    const readyBefore = snapshot({ screen: 'board', board: boardState({
      zombies: [{
        id: 2, type: 0, name: 'zombie', row: 3, column: 2, columnPosition: 2, xBand: 'near', speedCellsPerSecond: 0.0,
        condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
        slowed: false, immobilized: false,
      }],
    }) });
    const readyAfter = structuredClone(readyBefore);
    readyAfter.revision += 1;
    readyAfter.board!.zombies[0]!.xBand = 'lawn';
    const ready = trackSnapshot(readyAfter, readyBefore)
      .find((candidate) => candidate.type === 'pvz.threat.close');
    expect(ready).toMatchObject({ urgent: false });
    expect(ready?.text).toContain('普通僵尸在第3排第2列（这排割草机还在）');
  });

  it('短命卡包和推进奖励立即唤醒，普通资源仍合并', () => {
    const before = snapshot({ screen: 'board', board: boardState() });
    const after = structuredClone(before);
    after.revision += 1;
    after.board!.collectibles = [
      {
        id: 8, kind: 'usable_seed', containedType: 0, containedName: 'peashooter',
        x: 300, y: 200, row: null, column: null,
      },
      { id: 9, kind: 'sun', x: 360, y: 200, row: null, column: null },
    ];

    const events = trackSnapshot(after, before);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'pvz.collectible.appeared', urgent: true }),
    ]));
    expect(events.find((event) => event.type === 'pvz.collectible.appeared')?.routineKey)
      .toBeUndefined();
  });

  it('只给重复可能性高的卡片可用变化加短窗语义键', () => {
    const before = snapshot({
      screen: 'board',
      board: boardState({
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: false, affordable: false, cooldown: 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
      }),
    });
    const ready = structuredClone(before);
    ready.revision += 1;
    ready.board!.sun = 100;
    ready.board!.cards[0].ready = true;
    ready.board!.cards[0].affordable = true;
    ready.board!.cards[0].cooldown = 'ready';

    expect(trackSnapshot(ready, before)).toEqual([
      expect.objectContaining({
        type: 'pvz.card.ready', urgent: false, routineKey: 'card:peashooter',
      }),
    ]);

    const conveyor = structuredClone(ready);
    conveyor.revision += 1;
    conveyor.board!.cards[0] = {
      ...conveyor.board!.cards[0], type: 1, name: 'sunflower',
    };
    const conveyorEvents = trackSnapshot(conveyor, ready);
    expect(conveyorEvents).toEqual([
      expect.objectContaining({ type: 'pvz.card.ready', urgent: true }),
    ]);
    expect(conveyorEvents[0]?.routineKey).toBeUndefined();
  });

  it('Whack 的阳光与卡片机会共享同批棋盘而不各自复制快照', () => {
    const before = snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie',
      board: boardState({
        sun: 0,
        cards: [
          {
            slot: 0, type: 4, name: 'potato_mine', imitates: null, cost: 25,
            ready: false, affordable: false, cooldown: 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
          },
          {
            slot: 1, type: 2, name: 'cherry_bomb', imitates: null, cost: 150,
            ready: false, affordable: false, cooldown: 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 130, y: 40,
          },
        ],
        allowedSpecialActions: ['whack'],
        special: { phase: 'ready', settled: true, targets: [] },
      }),
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.board!.sun = 150;
    after.board!.collectibles = [
      { id: 9, kind: 'silver_coin', x: 360, y: 200, row: 2, column: 3 },
    ];
    for (const card of after.board!.cards) {
      Object.assign(card, { ready: true, affordable: true, cooldown: 'ready' });
    }

    const events = trackSnapshot(after, before);
    const collectible = events.find((event) => event.type === 'pvz.collectible.appeared');
    const card = events.find((event) => event.type === 'pvz.card.ready');
    for (const event of [collectible, card]) {
      expect(event).toMatchObject({ urgent: true });
      expect(event?.text).not.toMatch(/\[当前战术快照\]|\[PvZ 状态 r/);
      expect(event?.text).toContain('queue:"append"');
    }
    expect(collectible?.text).toContain('出现可收集对象：银币');
    expect(card?.text).toContain('土豆雷, 樱桃炸弹');
  });

  it('初次连接 Whack 时目标提示复用同一份当前状态', () => {
    const board = boardState({
      allowedSpecialActions: ['whack'],
      special: {
        phase: 'ready', settled: true,
        targets: [{
          action: 'whack', kind: 'zombie', id: 41, slot: null, row: 2, column: 6,
        }],
      },
      zombies: [{
        id: 41, type: 2, name: 'conehead', row: 2, column: 6, columnPosition: 6, xBand: 'mid', speedCellsPerSecond: 0.0,
        speed: 'normal', phase: 'rising', condition: 'intact', armor: 'intact',
        shield: 'none', hypnotized: false, slowed: false, immobilized: false,
      }],
    });
    const state = snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      board,
    });

    const connected = trackSnapshot(state, null)[0]!;
    expect(connected.text.match(/\[PvZ 状态 r\d+\]/g)).toHaveLength(1);
    expect(connected.text).toContain('当前 1 个可锤目标');
  });

  it('特殊动作可用集合和可见植物伤势变化会唤醒', () => {
    const before = snapshot({ screen: 'board', board: boardState({
      plants: [{
        id: 3, type: 3, name: 'wall_nut', row: 2, column: 3,
        condition: 'worn', sleeping: false, squished: false, layers: ['main'],
      }],
    }) });
    const after = structuredClone(before);
    after.revision += 1;
    after.board!.allowedSpecialActions = ['start_onslaught'];
    after.board!.special = {
      phase: 'setup_ready', settled: true,
      targets: [{
        action: 'start_onslaught', kind: 'cell', id: null, slot: null, row: null, column: null,
      }],
    };
    after.board!.plants[0].condition = 'critical';

    const events = trackSnapshot(after, before);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'pvz.actions.changed', 'pvz.plant.damaged',
    ]));
    expect(events.find((event) => event.type === 'pvz.plant.damaged')?.urgent).toBe(true);
  });

  it('只把仍可见空格中的持久植物消失报告为紧急防线损失', () => {
    const before = snapshot({ screen: 'board', board: boardState({
      plants: [{
        id: 3, type: 3, name: 'wall_nut', row: 1, column: 8,
        condition: 'intact', sleeping: false, squished: false, layers: [],
      }],
    }) });
    const gone = structuredClone(before);
    gone.revision += 1;
    gone.board!.plants = [];
    expect(trackSnapshot(gone, before)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'pvz.plant.lost', urgent: true }),
    ]));

    const fogged = structuredClone(gone);
    fogged.board!.fog = { active: true, visibilityRule: 'rendered_fog' };
    const cell = fogged.board!.cells.find((item) => item.row === 1 && item.column === 8)!;
    cell.playable = null;
    cell.blocker = 'fog_hidden';
    cell.base = 'unknown';
    expect(trackSnapshot(fogged, before).map((event) => event.type)).not.toContain('pvz.plant.lost');

    const replaced = structuredClone(gone);
    replaced.board!.plants = [{
      id: 4, type: 1, name: 'sunflower', row: 1, column: 8,
      condition: 'intact', sleeping: false, squished: false, layers: [],
    }];
    expect(trackSnapshot(replaced, before).map((event) => event.type)).not.toContain('pvz.plant.lost');

    const bowling = structuredClone(gone);
    bowling.mode = 33;
    const bowlingBefore = structuredClone(before);
    bowlingBefore.mode = 33;
    expect(trackSnapshot(bowling, bowlingBefore).map((event) => event.type)).not.toContain('pvz.plant.lost');
  });

  it('同格主植物不会掩盖南瓜和基座层的离场', () => {
    const before = snapshot({ screen: 'board', board: boardState({
      plants: [
        {
          id: 1, type: 0, name: 'peashooter', row: 2, column: 3,
          condition: 'intact', sleeping: false, squished: false, layers: ['main'],
        },
        {
          id: 2, type: 30, name: 'pumpkin', row: 2, column: 3,
          condition: 'intact', sleeping: false, squished: false, layers: ['pumpkin'],
        },
        {
          id: 3, type: 16, name: 'lily_pad', row: 2, column: 3,
          condition: 'intact', sleeping: false, squished: false, layers: ['lily_pad'],
        },
      ],
    }) });
    const after = structuredClone(before);
    after.revision += 1;
    after.board!.plants = [after.board!.plants[0]];

    const lost = trackSnapshot(after, before).find((event) => event.type === 'pvz.plant.lost');
    expect(lost).toMatchObject({ urgent: true });
    expect(lost?.text).toContain('南瓜头在第2排第3列');
    expect(lost?.text).toContain('荷叶在第2排第3列');

    const replaced = structuredClone(before);
    replaced.revision += 1;
    replaced.board!.plants = [
      replaced.board!.plants[0],
      { ...replaced.board!.plants[1], id: 4 },
      { ...replaced.board!.plants[2], id: 5, type: 33, name: 'flower_pot' },
    ];
    expect(trackSnapshot(replaced, before).map((event) => event.type))
      .not.toContain('pvz.plant.lost');
  });

  it('跨关卡边界不会把整张新棋盘误报为逐实体变化', () => {
    const menu = snapshot();
    const board = snapshot({
      screen: 'board',
      board: boardState({
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        zombies: [{
          id: 1, type: 0, name: 'zombie', row: 1, column: 9, columnPosition: 9, xBand: 'far', speedCellsPerSecond: 0.0,
          condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
          slowed: false, immobilized: false,
        }],
      }),
    });
    const entered = trackSnapshot(board, menu);
    expect(entered.map((event) => event.type)).toEqual(['pvz.level.started']);
    expect(entered[0]?.text).toContain('[直播]');
    expect(entered[0]?.text).toContain('一句不超过 30 个汉字的中文短句');
    expect(entered[0]?.text).toContain('不念坐标或内部状态');
    expect(entered[0]?.text).not.toMatch(/vtuber_act|mc_do|minecraft|bilibili/i);

    const award = snapshot({
      screen: 'award', menu: [], board: null,
      lastRun: { resultId: 1, runId: 1, mode: 0, level: 1, outcome: 'won' },
    });
    const exited = trackSnapshot(award, board);
    expect(exited.map((event) => event.type)).toEqual(['pvz.level.won']);
    expect(exited[0]?.text).toContain('adventure，第 1 关');
    expect(exited[0]?.text).toContain('[直播]');
    expect(exited[0]?.text).toContain('按当前状态处理奖励或失败菜单');
    expect(exited[0]?.text).not.toContain('结果 #');

    const awardDialog = snapshot({
      screen: 'dialog', menu: [], board: null, lastRun: award.lastRun,
    });
    const returnedToAward = trackSnapshot(award, awardDialog);
    expect(returnedToAward.map((event) => event.type)).toEqual(['pvz.screen.changed']);
    expect(returnedToAward.map((event) => event.type)).not.toContain('pvz.level.won');

    const restarted = structuredClone(board);
    restarted.revision += 1;
    restarted.board!.runId += 1;
    restarted.board!.mowers = [];
    const restartEvents = trackSnapshot(restarted, board);
    expect(restartEvents.map((event) => event.type)).toEqual(['pvz.level.restarted']);
    expect(restartEvents[0]?.text).toContain('[直播]');
  });

  it('选卡事件直接要求推进且不伪装成直播口播轮', () => {
    const before = snapshot({ screen: 'main_menu', board: null, seedPicker: null });
    const after = snapshot({
      screen: 'seed_picker',
      board: null,
      seedPicker: {
        capacity: 6,
        selected: [],
        choices: [],
        previewZombies: [],
        ready: false,
      },
    });

    const [event] = trackSnapshot(after, before);
    expect(event?.type).toBe('pvz.seed_picker.opened');
    expect(event?.text).toContain('进入选卡，请完成选卡并确认');
    expect(event?.text).not.toContain('[直播]');
  });

  it('只给关卡起止和重开附加直播口播提示', () => {
    const before = snapshot({ screen: 'board', board: boardState() });
    const changed = structuredClone(before);
    changed.revision += 1;
    changed.board!.collectibles = [
      { id: 1, kind: 'silver_coin', x: 320, y: 180, row: 2, column: 3 },
    ];

    const ordinary = trackSnapshot(changed, before);
    expect(ordinary).toHaveLength(1);
    expect(ordinary[0]?.type).toBe('pvz.collectible.appeared');
    expect(ordinary[0]?.text).not.toContain('[直播]');

    const lost = snapshot({
      screen: 'defeat', board: null, menu: [],
      lastRun: { resultId: 1, runId: 1, mode: 0, level: 1, outcome: 'lost' },
    });
    const terminal = trackSnapshot(lost, before);
    expect(terminal.find((event) => event.type === 'pvz.level.lost')?.text)
      .toContain('[直播]');
  });

  it('只有新的持久终局结果宣告胜负，单独终局画面、同号结果和回退均不宣告', () => {
    const board = snapshot({ screen: 'board', board: boardState({ runId: 8, level: 4 }) });
    const screenOnly = snapshot({ screen: 'defeat', board: null, menu: [] });
    expect(trackSnapshot(screenOnly, board).map((event) => event.type))
      .toEqual(['pvz.screen.changed']);

    const lost = structuredClone(screenOnly);
    lost.revision += 1;
    lost.lastRun = { resultId: 5, runId: 8, mode: 0, level: 4, outcome: 'lost' };
    expect(trackSnapshot(lost, screenOnly)).toEqual([
      expect.objectContaining({ type: 'pvz.level.lost', urgent: true }),
    ]);

    const sameResultAward = structuredClone(lost);
    sameResultAward.revision += 1;
    sameResultAward.screen = 'award';
    sameResultAward.lastRun = { ...lost.lastRun!, outcome: 'won' };
    const sameIdEvents = trackSnapshot(sameResultAward, lost);
    expect(sameIdEvents.map((event) => event.type)).toEqual(['pvz.screen.changed']);
    expect(sameIdEvents.map((event) => event.type)).not.toEqual(expect.arrayContaining([
      'pvz.level.won', 'pvz.level.lost',
    ]));

    const rolledBack = structuredClone(sameResultAward);
    rolledBack.revision += 1;
    rolledBack.lastRun = { resultId: 2, runId: 2, mode: 0, level: 1, outcome: 'won' };
    expect(trackSnapshot(rolledBack, sameResultAward)).toEqual([]);

    expect(trackSnapshot(sameResultAward, null).map((event) => event.type))
      .toEqual(['pvz.connected']);
  });

  it('非冒险 level 0 的持久终局结果只宣告一次', () => {
    const board = snapshot({
      screen: 'board',
      mode: 22,
      modeName: 'seeing_stars',
      modeKind: 'minigame',
      menu: [],
      board: boardState({ runId: 9, level: 0 }),
    });
    const completed = structuredClone(board);
    completed.revision += 1;
    completed.screen = 'mode_selector';
    completed.board = null;
    completed.lastRun = { resultId: 4, runId: 9, mode: 22, level: 0, outcome: 'won' };

    expect(trackSnapshot(completed, board).map((event) => event.type))
      .toEqual(['pvz.screen.changed', 'pvz.level.won']);

    const repeated = structuredClone(completed);
    repeated.revision += 1;
    expect(trackSnapshot(repeated, completed).map((event) => event.type))
      .not.toContain('pvz.level.won');
  });

  it('Boss 细碎伤害不淹没事件流，只在 10% 里程碑报告', () => {
    const before = snapshot({
      screen: 'board', mode: 35,
      board: boardState({
        progress: { kind: 'boss', current: 1, target: 100, stage: null, label: 'Boss damage 1/100' },
      }),
    });
    const chipped = structuredClone(before);
    chipped.revision += 1;
    chipped.board!.progress = {
      kind: 'boss', current: 9, target: 100, stage: null, label: 'Boss damage 9/100',
    };
    expect(trackSnapshot(chipped, before).map((event) => event.type))
      .not.toContain('pvz.level.progress');

    const milestone = structuredClone(chipped);
    milestone.revision += 1;
    milestone.board!.progress = {
      kind: 'boss', current: 10, target: 100, stage: null, label: 'Boss damage 10/100',
    };
    expect(trackSnapshot(milestone, chipped)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'pvz.level.progress', text: expect.stringContaining('僵王进度 10%') }),
    ]));
  });

  it('黑暗披露边界只报告可见性变化，不把隐藏列表误报成实体变化', () => {
    const before = snapshot({ screen: 'board', board: boardState({
      plants: [{
        id: 3, type: 3, name: 'wall_nut', row: 2, column: 3,
        condition: 'worn', sleeping: false, squished: false, layers: [],
      }],
      zombies: [{
        id: 1, type: 0, name: 'zombie', row: 1, column: 8, columnPosition: 8, xBand: 'far', speedCellsPerSecond: 0.0,
        condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
        slowed: false, immobilized: false,
      }],
      collectibles: [{ id: 9, kind: 'sun', x: 300, y: 200, row: 2, column: 3 }],
    }) });
    const after = structuredClone(before);
    after.revision += 1;
    after.board!.disclosure = { entitiesVisible: false, phase: 'dark' };
    after.board!.plants = [];
    after.board!.zombies = [];
    after.board!.collectibles = [];
    after.board!.mowers = [];

    const enteredDark = trackSnapshot(after, before);
    expect(enteredDark).toEqual([expect.objectContaining({
      type: 'pvz.visibility.changed', urgent: false,
    })]);
    expect(enteredDark.map((event) => event.type)).not.toEqual(expect.arrayContaining([
      'pvz.zombie.visible', 'pvz.collectible.appeared', 'pvz.mower.used',
    ]));

    const visibleAgain = structuredClone(after);
    visibleAgain.revision += 1;
    visibleAgain.board!.disclosure = { entitiesVisible: true, phase: 'visible' };
    visibleAgain.board!.zombies = before.board!.zombies;
    const restored = trackSnapshot(visibleAgain, after);
    expect(restored).toEqual([expect.objectContaining({
      type: 'pvz.visibility.changed', urgent: true,
    })]);
    expect(restored[0].text).toContain('隐藏期内的实体变化不会补报');
  });

  it('关闭同一关卡的暂停对话不会误报新关卡开始', () => {
    const before = snapshot({
      screen: 'dialog',
      menu: [{ id: 'resume', label: 'Resume', enabled: true, x: 400, y: 300, state: null, record: null }],
      board: boardState({ runId: 9, paused: true }),
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.screen = 'board';
    after.menu = [];
    after.board!.paused = false;

    expect(trackSnapshot(after, before)).toEqual([expect.objectContaining({
      type: 'pvz.screen.changed', urgent: false,
    })]);
  });

  it('关闭同一运行中的 Dave 教程对话不会误报新关卡开始', () => {
    const before = snapshot({
      screen: 'dialog',
      menu: [{ id: 'advance', label: 'Continue', enabled: true, x: 400, y: 300, state: null, record: null }],
      board: boardState({ runId: 11, paused: true }),
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.screen = 'board';
    after.menu = [];
    after.board!.paused = false;

    const events = trackSnapshot(after, before);
    expect(events).toEqual([expect.objectContaining({
      type: 'pvz.screen.changed', urgent: false,
    })]);
    expect(events.map((event) => event.type)).not.toContain('pvz.level.started');
  });

  it('忽略同一关卡中短暂出现的 loading 快照', () => {
    const memory = createPvzEventMemory();
    const board = snapshot({
      screen: 'board',
      mode: 0,
      board: boardState({ runId: 11, level: 2 }),
    });
    trackSnapshot(board, null, memory);
    const loading = structuredClone(board);
    loading.revision += 1;
    loading.screen = 'loading';
    loading.board = null;
    const returned = structuredClone(board);
    returned.revision += 2;

    expect(trackSnapshot(loading, board, memory)).toEqual([]);
    expect(trackSnapshot(returned, loading, memory)).toEqual([]);
  });

  it('loading 后进入不同运行仍报告真实的新关卡', () => {
    const memory = createPvzEventMemory();
    const board = snapshot({
      screen: 'board',
      mode: 0,
      board: boardState({ runId: 11, level: 2 }),
    });
    trackSnapshot(board, null, memory);
    const loading = structuredClone(board);
    loading.revision += 1;
    loading.screen = 'loading';
    loading.board = null;
    const nextRun = structuredClone(board);
    nextRun.revision += 2;
    nextRun.board!.runId = 12;
    nextRun.board!.level = 3;

    expect(trackSnapshot(loading, board, memory)).toEqual([]);
    expect(trackSnapshot(nextRun, loading, memory)).toEqual([
      expect.objectContaining({ type: 'pvz.level.started', urgent: true }),
    ]);
  });

  it('生存模式阶段换卡返回同一运行时发阶段续局事件', () => {
    const before = snapshot({
      screen: 'seed_picker',
      mode: 6,
      modeName: 'survival_hard_day',
      modeKind: 'survival',
      seedPicker: {
        capacity: 6, selected: [], choices: [], previewZombies: [], ready: false,
      },
      board: boardState({
        runId: 12,
        progress: { kind: 'flags', current: 1, target: 10, stage: 1, label: '1/10 旗' },
      }),
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.screen = 'board';
    after.seedPicker = null;

    const events = trackSnapshot(after, before);
    expect(events).toEqual([expect.objectContaining({
      type: 'pvz.level.stage_resumed', urgent: true,
    })]);
    expect(events.map((event) => event.type)).not.toContain('pvz.level.started');
  });

  it('生存模式初次选卡返回棋盘仍报告新关卡开始', () => {
    const before = snapshot({
      screen: 'seed_picker',
      mode: 1,
      modeName: 'survival_day',
      modeKind: 'survival',
      seedPicker: {
        capacity: 6, selected: [], choices: [], previewZombies: [], ready: false,
      },
      board: boardState({
        runId: 13,
        progress: { kind: 'flags', current: 0, target: 5, stage: 1, label: '0/5 旗' },
      }),
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.screen = 'board';
    after.seedPicker = null;

    expect(trackSnapshot(after, before)).toEqual([expect.objectContaining({
      type: 'pvz.level.started', urgent: true,
    })]);
  });

  it('Last Stand 在同一棋盘运行内从布阵进入猛攻并完成阶段，不伪造胜利或换卡', () => {
    const setup = snapshot({
      screen: 'board',
      mode: 31,
      modeName: 'last_stand',
      modeKind: 'minigame',
      board: boardState({
        runId: 14,
        progress: { kind: 'setup', current: null, target: 5, stage: 1, label: 'Last Stand setup' },
        allowedSpecialActions: ['start_onslaught'],
        special: {
          phase: 'setup_ready', settled: true,
          targets: [{
            action: 'start_onslaught', kind: 'cell', id: null, slot: null,
            row: null, column: null,
          }],
        },
      }),
    });
    const onslaught = structuredClone(setup);
    onslaught.revision += 1;
    onslaught.board!.progress = {
      kind: 'flags', current: 0, target: 5, stage: 1, label: 'Last Stand onslaught 0/5',
    };
    onslaught.board!.allowedSpecialActions = [];
    onslaught.board!.special = { phase: 'onslaught', settled: false, targets: [] };
    const entered = trackSnapshot(onslaught, setup);
    expect(entered.map((event) => event.type)).toContain('pvz.level.progress');
    expect(entered.map((event) => event.type)).not.toEqual(expect.arrayContaining([
      'pvz.level.stage_completed', 'pvz.level.won', 'pvz.seed_picker.opened',
    ]));

    const nextSetup = structuredClone(onslaught);
    nextSetup.revision += 1;
    nextSetup.board!.progress = {
      kind: 'setup', current: null, target: 5, stage: 2, label: 'Last Stand setup',
    };
    nextSetup.board!.allowedSpecialActions = ['start_onslaught'];
    nextSetup.board!.special = {
      phase: 'setup_ready', settled: true,
      targets: [{
        action: 'start_onslaught', kind: 'cell', id: null, slot: null,
        row: null, column: null,
      }],
    };
    const completed = trackSnapshot(nextSetup, onslaught);
    expect(completed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'pvz.level.stage_completed', text: expect.stringContaining('Last Stand阶段 1'),
        urgent: true,
      }),
    ]));
    expect(completed.map((event) => event.type)).not.toContain('pvz.level.won');
  });

  it.each([
    [6, 'survival_hard_day', 'survival', 'flags', 10, 0, 10],
    [51, 'vasebreaker_1', 'vasebreaker', 'vases', 0, 15, null],
    [70, 'i_zombie_endless', 'i_zombie', 'brains', 5, 0, 5],
  ] as const)('模式 %s 的同运行分段只报告阶段完成', (
    mode, modeName, modeKind, kind, beforeCurrent, afterCurrent, target,
  ) => {
    const before = snapshot({
      screen: 'board', mode, modeName, modeKind,
      board: boardState({
        runId: 21,
        progress: { kind, current: beforeCurrent, target, stage: 1, label: 'stage 1' },
      }),
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.board!.progress = { kind, current: afterCurrent, target, stage: 2, label: 'stage 2' };

    const events = trackSnapshot(after, before);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'pvz.level.stage_completed', urgent: true }),
    ]));
    expect(events.map((event) => event.type)).not.toContain('pvz.level.won');
  });

  it('传送带同一槽位换成新的可用卡片时重新唤醒', () => {
    const before = snapshot({
      screen: 'board',
      mode: 17,
      modeName: 'wall_nut_bowling',
      modeKind: 'minigame',
      board: boardState({
        cards: [{
          slot: 0, type: 3, name: 'wall_nut', imitates: null, cost: null,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
      }),
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.board!.cards[0] = {
      slot: 0, type: 50, name: 'giant_wall_nut', imitates: null, cost: null,
      ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
    };

    expect(trackSnapshot(after, before)).toEqual([expect.objectContaining({
      type: 'pvz.card.ready',
      text: expect.stringContaining('巨大坚果'),
      urgent: true,
    })]);
  });

  it('割草机触发当帧即报告防线已用，不等对象滚出棋盘', () => {
    const before = snapshot({ screen: 'board', board: boardState() });
    const after = structuredClone(before);
    after.revision += 1;
    after.board!.mowers[0].state = 'triggered';

    expect(trackSnapshot(after, before)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'pvz.mower.used', text: '[PvZ] 防线触发：第1排割草机' }),
    ]));
  });

  it('publishes a trophy arriving after victory once while suppressing ordinary teardown drops', () => {
    const won = snapshot({ screen: 'board', menu: [], board: boardState({ runId: 71, level: 50,
      collectibles: [] }),
      lastRun: { resultId: 5, runId: 71, mode: 0, level: 50, outcome: 'won' },
    });
    const dropped = structuredClone(won);
    dropped.revision += 1;
    dropped.board!.collectibles = [
      { id: 1, kind: 'silver_sunflower', x: 600, y: 300, row: null, column: null },
      { id: 2, kind: 'gold_coin', x: 200, y: 200, row: 2, column: 3 },
    ];
    expect(trackSnapshot(dropped, won)).toEqual([
      expect.objectContaining({ type: 'pvz.collectible.appeared', urgent: true,
        text: '[PvZ] 出现可收集对象：银向日葵奖杯' }),
    ]);
    expect(trackSnapshot(structuredClone(dropped), dropped)).toEqual([]);
    const hidden = structuredClone(dropped);
    hidden.board!.disclosure.entitiesVisible = false;
    expect(trackSnapshot(hidden, won).some(event => event.type === 'pvz.collectible.appeared')).toBe(false);
  });

  it('关卡结算后棋盘拆场期间的割草机、卡片、植物变化不再当作战况报出', () => {
    const before = snapshot({ screen: 'board', board: boardState() });
    const won = structuredClone(before);
    won.revision += 1;
    won.lastRun = { resultId: 7, runId: won.board!.runId, mode: 0, level: 1, outcome: 'won' };
    won.board!.mowers[0]!.state = 'triggered';
    for (const card of won.board!.cards) Object.assign(card, { ready: true, affordable: true, cooldown: 'ready' });

    const settled = trackSnapshot(won, before);
    expect(settled.map((event) => event.type)).toContain('pvz.level.won');
    expect(settled.map((event) => event.type)).not.toEqual(expect.arrayContaining([
      'pvz.mower.used', 'pvz.card.ready',
    ]));

    // 结算之后的每一帧同样:割草机一台台被收走,不是防线在触发
    const teardown = structuredClone(won);
    teardown.revision += 1;
    teardown.board!.mowers = [];
    teardown.board!.plants = [];
    const types = trackSnapshot(teardown, won).map((event) => event.type);
    expect(types).not.toEqual(expect.arrayContaining(['pvz.mower.used', 'pvz.plant.lost']));
  });

  it('割草机触发当帧的近屋威胁说明正在清路，不误报该路无防线', () => {
    const before = snapshot({ screen: 'board', board: boardState({
      zombies: [{
        id: 1, type: 2, name: 'conehead', row: 1, column: 2, columnPosition: 2, xBand: 'near', speedCellsPerSecond: 0.0,
        condition: 'intact', armor: 'intact', shield: 'none', hypnotized: false,
        slowed: false, immobilized: false,
      }],
    }) });
    const after = structuredClone(before);
    after.revision += 1;
    after.board!.mowers[0].state = 'triggered';
    after.board!.zombies[0]!.xBand = 'lawn';

    const close = trackSnapshot(after, before)
      .find((event) => event.type === 'pvz.threat.close');
    expect(close).toMatchObject({ urgent: false });
    expect(close?.text).toContain('路障僵尸在第1排第2列（这排割草机正在清路）');
    expect(close?.text).not.toContain('这排没有可用割草机');
  });

  it('Whack-a-Zombie 同数量目标轮换也立即唤醒', () => {
    const before = snapshot({
      screen: 'board', mode: 30,
      board: boardState({
        zombies: [{
          id: 1, type: 0, name: 'zombie', row: 2, column: 7, columnPosition: 7, xBand: 'mid', speedCellsPerSecond: 0.0,
          condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
          slowed: false, immobilized: false,
        }],
        special: { phase: 'ready', settled: true, targets: [
          { action: 'whack', kind: 'zombie', id: 1, slot: null, row: 2, column: 7 },
        ] },
        allowedSpecialActions: ['whack'],
      }),
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.board!.special!.targets = [
      { action: 'whack', kind: 'zombie', id: 2, slot: null, row: 3, column: 8 },
      { action: 'whack', kind: 'zombie', id: 3, slot: null, row: 1, column: 2 },
    ];
    after.board!.zombies = [{
      id: 2, type: 4, name: 'buckethead', row: 3, column: 8, columnPosition: 8, xBand: 'far', speedCellsPerSecond: 0.0,
      condition: 'intact', armor: 'worn', shield: 'none', hypnotized: false,
      slowed: false, immobilized: false,
    }, {
      id: 3, type: 2, name: 'conehead', row: 1, column: 2, columnPosition: 2, xBand: 'near', speedCellsPerSecond: 0.0,
      condition: 'worn', armor: 'critical', shield: 'none', hypnotized: false,
      slowed: false, immobilized: false,
    }];

    const ready = trackSnapshot(after, before)
      .find((event) => event.type === 'pvz.target.ready');
    expect(ready).toMatchObject({ type: 'pvz.target.ready', urgent: true });
    const text = ready?.text ?? '';
    expect(text).toContain(renderWhackSkillQueueCall());
    expect(text).toContain('当前 2 个可锤目标');
    expect(text).toContain('路障僵尸在第1排第2列');
    expect(text).toContain('铁桶僵尸在第3排第8列');
    expect(text).not.toContain('until:');
    expect(text).toContain('[当前战术快照]');
    expect(text).toContain('阳光 150');
    expect(text).toContain('普通 queue:"replace" 队列');
    expect(text).not.toMatch(/工作区|记忆|fork|vtuber_act|mc_do|minecraft|bilibili/i);
  });

  it('Whack 快照判定覆盖小游戏、冒险 1-5 与原生特殊动作', () => {
    const minigame = snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie',
      board: boardState({ level: 0 }),
    });
    const adventure = snapshot({
      screen: 'board', mode: 0, modeName: 'adventure',
      board: boardState({ level: 15 }),
    });
    const special = snapshot({
      screen: 'board', mode: 0, modeName: 'adventure',
      board: boardState({ allowedSpecialActions: ['whack'] }),
    });
    const ordinary = snapshot({ screen: 'board', board: boardState({ level: 14 }) });

    expect(isWhackSnapshot(minigame)).toBe(true);
    expect(isWhackSnapshot(adventure)).toBe(true);
    expect(isWhackSnapshot(special)).toBe(true);
    expect(isWhackSnapshot(ordinary)).toBe(false);
  });

  it('Whack 任务终态只在新快照仍有目标时给出完整有限队列调用', () => {
    const active = snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie',
      board: boardState({
        allowedSpecialActions: ['whack'],
        zombies: [{
          id: 1, type: 0, name: 'zombie', row: 2, column: 4, columnPosition: 4, xBand: 'lawn', speedCellsPerSecond: 0.0,
          condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
          slowed: false, immobilized: false,
        }],
        special: {
          phase: 'ready', settled: true,
          targets: [{
            action: 'whack', kind: 'zombie', id: 1, slot: null, row: 2, column: 4,
          }],
        },
      }),
    });
    expect(renderWhackTargetReady(active)).toContain(renderWhackSkillQueueCall());

    const empty = structuredClone(active);
    empty.board!.special!.targets = [];
    expect(renderWhackTargetReady(empty)).toBeNull();
    expect(renderWhackTaskState(empty)).toContain('当前没有可锤目标');
    expect(renderWhackTaskState(empty)).toContain('0/1 面旗');
    expect(renderWhackTaskState(empty)).toContain('[当前战术快照]');
    expect(renderWhackTaskState(empty)).toContain('处理可见支援机会或等待新目标');
  });

  it('中途连接到已有目标的 Whack 棋盘时立即给出当前批次队列', () => {
    const active = snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie',
      board: boardState({
        allowedSpecialActions: ['whack'],
        zombies: [{
          id: 7, type: 0, name: 'zombie', row: 3, column: 5, columnPosition: 5, xBand: 'lawn', speedCellsPerSecond: 0.0,
          condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
          slowed: false, immobilized: false,
        }],
        special: {
          phase: 'ready', settled: true,
          targets: [{
            action: 'whack', kind: 'zombie', id: 7, slot: null, row: 3, column: 5,
          }],
        },
      }),
    });

    const connected = trackSnapshot(active, null).find((event) => event.type === 'pvz.connected');
    expect(connected?.text).toContain('当前 1 个可锤目标');
    expect(connected?.text).toContain(renderWhackSkillQueueCall());
  });

  it('Whack-a-Zombie 进关先提交当前有限批次再口播', () => {
    const before = snapshot({
      screen: 'loading', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      board: null, menu: [],
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.screen = 'board';
    after.scene = 3;
    after.board = boardState({
      level: 0,
      zombies: [{
        id: 1, type: 0, name: 'zombie', row: 2, column: 7, columnPosition: 7, xBand: 'far', speedCellsPerSecond: 0.0,
        condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
        slowed: false, immobilized: false,
      }],
      allowedSpecialActions: ['whack'],
      special: {
        phase: 'ready', settled: true,
        targets: [{ action: 'whack', kind: 'zombie', id: 1, slot: null, row: 2, column: 7 }],
      },
    });

    const started = trackSnapshot(after, before)
      .find((event) => event.type === 'pvz.level.started');
    expect(started?.text).toContain('[PvZ·锤击开局]');
    expect(started?.text).toContain(renderWhackSkillQueueCall());
    expect(started?.text).toContain('当前有 1 个可锤目标');
    expect(started?.text).not.toContain('until:');
    expect(started?.text).toContain('[直播]');
  });

  it('Whack-a-Zombie 进关无目标时不要求提交空批次', () => {
    const before = snapshot({
      screen: 'loading', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      board: null, menu: [],
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.screen = 'board';
    after.scene = 3;
    after.board = boardState({
      level: 0,
      allowedSpecialActions: [],
      special: { phase: 'ready', settled: true, targets: [] },
    });

    const started = trackSnapshot(after, before)
      .find((event) => event.type === 'pvz.level.started');
    expect(started?.text).toContain('[PvZ·锤击开局]');
    expect(started?.text).toContain('当前没有可锤目标');
    expect(started?.text).not.toContain('targets:[');
  });

  it('Whack 预取提示标明任务代次并保留空后继位给锤击', () => {
    const active = snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie',
      board: boardState({ allowedSpecialActions: ['whack'] }),
    });

    const cue = renderWhackPrefetchCue(active, 42);
    expect(cue).toContain(renderWhackSkillQueueCall('append'));
    expect(cue).toContain('当前锤击任务#42仍在执行');
    expect(cue).toContain('后继缓冲位为空');
    expect(cue).toContain('[当前战术快照]');
    expect(cue).not.toMatch(/vtuber_act|工作区|记忆|fork|mc_do/i);
    expect(renderWhackPrefetchCue(snapshot(), 42)).toBeNull();
  });

  it('同一奖励或对话画面中的按钮变为可用时唤醒', () => {
    const before = snapshot({
      screen: 'award',
      menu: [{ id: 'advance', label: 'Continue', enabled: false, x: 400, y: 500, state: null, record: null }],
      board: null,
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.menu[0].enabled = true;

    expect(trackSnapshot(after, before)).toEqual([expect.objectContaining({
      type: 'pvz.menu.ready',
      text: expect.stringContaining('advance'),
      urgent: true,
      routineKey: 'menu:advance',
    })]);
  });

  it('内部输入结束后 Pause 恢复可用不会制造棋盘唤醒', () => {
    const before = snapshot({
      screen: 'board',
      menu: [{ id: 'pause', label: 'Menu', enabled: false, x: 780, y: 20, state: null, record: null }],
      board: boardState(),
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.menu[0]!.enabled = true;

    expect(trackSnapshot(after, before)).toEqual([]);
  });

  it('同一画面动画后新建的可用按钮也会立即唤醒', () => {
    const before = snapshot({ screen: 'award', menu: [], board: null });
    const after = structuredClone(before);
    after.revision += 1;
    after.menu = [{
      id: 'advance', label: 'Continue', enabled: true, x: 400, y: 500,
      state: null, record: null,
    }];

    expect(trackSnapshot(after, before)).toEqual([expect.objectContaining({
      type: 'pvz.menu.ready',
      text: expect.stringContaining('advance'),
      urgent: true,
    })]);
  });

  it('模式奖杯或无尽纪录在同页更新时产生长期进度事件', () => {
    const before = snapshot({
      screen: 'mode_selector',
      menu: [
        { id: 'mode_17', label: 'wall_nut_bowling', enabled: true, x: 100, y: 100, state: 'available', record: null },
        { id: 'mode_60', label: 'vasebreaker_endless', enabled: true, x: 200, y: 100, state: 'available', record: 4 },
      ],
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.menu[0].state = 'completed';
    after.menu[1].record = 5;

    const events = trackSnapshot(after, before);
    expect(events).toEqual([expect.objectContaining({
      type: 'pvz.mode.progress',
      text: expect.stringMatching(/wall_nut_bowling.*vasebreaker_endless/),
      urgent: true,
    })]);
  });

  it('模式分页首次加载历史成绩时不误报进度或新可用操作', () => {
    const before = snapshot({
      screen: 'mode_selector',
      menu: [
        { id: 'page_puzzle', label: 'Puzzle', enabled: true, x: 100, y: 500, state: null, record: null },
        { id: 'mode_17', label: 'wall_nut_bowling', enabled: true, x: 100, y: 100, state: 'available', record: null },
      ],
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.menu = [
      { id: 'page_minigame', label: 'Mini-game', enabled: true, x: 100, y: 500, state: null, record: null },
      { id: 'mode_51', label: 'vasebreaker_1', enabled: true, x: 100, y: 100, state: 'completed', record: null },
      { id: 'mode_60', label: 'vasebreaker_endless', enabled: true, x: 200, y: 100, state: 'available', record: 12 },
    ];

    expect(trackSnapshot(after, before)).toEqual([]);
  });

  it('离开模式页游玩后重新出现的奖杯和纪录会与已见基线比较', () => {
    const memory = createPvzEventMemory();
    const selector = snapshot({
      screen: 'mode_selector',
      menu: [
        { id: 'mode_17', label: 'wall_nut_bowling', enabled: true, x: 100, y: 100, state: 'available', record: null },
        { id: 'mode_60', label: 'vasebreaker_endless', enabled: true, x: 200, y: 100, state: 'available', record: 4 },
      ],
    });
    trackSnapshot(selector, null, memory);
    const award = snapshot({ revision: 2, screen: 'award', menu: [], board: null });
    trackSnapshot(award, selector, memory);
    const returned = snapshot({
      revision: 3,
      screen: 'mode_selector',
      menu: [
        { id: 'mode_17', label: 'wall_nut_bowling', enabled: true, x: 100, y: 100, state: 'completed', record: null },
        { id: 'mode_60', label: 'vasebreaker_endless', enabled: true, x: 200, y: 100, state: 'available', record: 5 },
      ],
    });

    expect(trackSnapshot(returned, award, memory)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'pvz.mode.progress',
        text: expect.stringMatching(/wall_nut_bowling.*vasebreaker_endless/),
      }),
    ]));
  });

  it('切换档案会重建模式成绩基线，随后只报告新档案自己的推进', () => {
    const memory = createPvzEventMemory();
    const aliceSelector = snapshot({
      screen: 'mode_selector',
      profile: { ...snapshot().profile!, name: 'Alice', adventureLevel: 2 },
      menu: [
        { id: 'mode_17', label: 'wall_nut_bowling', enabled: true, x: 100, y: 100, state: 'available', record: null },
        { id: 'mode_60', label: 'vasebreaker_endless', enabled: true, x: 200, y: 100, state: 'available', record: 4 },
      ],
    });
    trackSnapshot(aliceSelector, null, memory);

    const bobMenu = snapshot({
      revision: 2,
      profile: {
        ...snapshot().profile!, name: 'Bob', adventureLevel: 50,
        adventureCompletions: 3, minigamesUnlocked: true,
        puzzleUnlocked: true, survivalUnlocked: true,
      },
    });
    const switchEvents = trackSnapshot(bobMenu, aliceSelector, memory);
    expect(switchEvents.map((event) => event.type)).not.toContain('pvz.progress.committed');
    expect(switchEvents.map((event) => event.type)).not.toContain('pvz.mode.progress');
    expect(memory.profileName).toBe('Bob');
    expect(memory.modeProgress.size).toBe(0);

    const bobSelector = snapshot({
      revision: 3,
      screen: 'mode_selector',
      profile: structuredClone(bobMenu.profile),
      menu: [
        { id: 'mode_17', label: 'wall_nut_bowling', enabled: true, x: 100, y: 100, state: 'completed', record: null },
        { id: 'mode_60', label: 'vasebreaker_endless', enabled: true, x: 200, y: 100, state: 'available', record: 12 },
      ],
    });
    expect(trackSnapshot(bobSelector, bobMenu, memory).map((event) => event.type))
      .not.toContain('pvz.mode.progress');
    expect(memory.modeProgress.get('mode_60')?.record).toBe(12);

    const improved = structuredClone(bobSelector);
    improved.revision += 1;
    improved.menu[1].record = 13;
    expect(trackSnapshot(improved, bobSelector, memory)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'pvz.mode.progress', text: expect.stringContaining('纪录 13') }),
    ]));

    const reconnected = snapshot({ profile: structuredClone(bobMenu.profile) });
    trackSnapshot(reconnected, null, memory);
    expect(memory.modeProgress.size).toBe(0);
    const historyAfterReconnect = snapshot({
      revision: 2,
      screen: 'mode_selector',
      profile: structuredClone(bobMenu.profile),
      menu: [{
        id: 'mode_60', label: 'vasebreaker_endless', enabled: true,
        x: 200, y: 100, state: 'available', record: 20,
      }],
    });
    expect(trackSnapshot(historyAfterReconnect, reconnected, memory).map((event) => event.type))
      .not.toContain('pvz.mode.progress');
  });

  it('关卡内只缓存档案与解锁进度，进入菜单后再合并投递', () => {
    const memory = createPvzEventMemory();
    const board = snapshot({ screen: 'board', board: boardState() });
    trackSnapshot(board, null, memory);

    const progressed = structuredClone(board);
    progressed.revision += 1;
    progressed.profile!.adventureLevel += 1;
    progressed.profile!.minigamesUnlocked = true;
    expect(trackSnapshot(progressed, board, memory).map((event) => event.type))
      .not.toContain('pvz.progress.committed');
    expect(memory.pendingProfileProgress?.adventureLevel)
      .toBe(progressed.profile!.adventureLevel);

    const award = structuredClone(progressed);
    award.revision += 1;
    award.screen = 'award';
    award.board = null;
    expect(trackSnapshot(award, progressed, memory).map((event) => event.type))
      .not.toContain('pvz.progress.committed');

    const menu = structuredClone(award);
    menu.revision += 1;
    menu.screen = 'main_menu';
    const events = trackSnapshot(menu, award, memory);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'pvz.progress.committed',
        text: expect.stringContaining('小游戏已解锁'),
      }),
    ]));
    expect(memory.pendingProfileProgress).toBeNull();
  });

  it('特殊目标身份轮换但阶段和目标数量不变时不重复唤醒', () => {
    const before = snapshot({
      screen: 'board',
      board: boardState({
        allowedSpecialActions: ['launch'],
        special: {
          phase: 'ready', settled: true,
          targets: [{
            action: 'launch', kind: 'cell', id: null, slot: null, row: 1, column: 1,
          }],
        },
      }),
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.board!.special!.targets[0].column = 2;

    expect(trackSnapshot(after, before)).toEqual([]);
  });

  it('窗口变得不可操作与恢复各唤醒一次，中间不重复', () => {
    const before = snapshot();
    const clipped = structuredClone(before);
    clipped.revision += 1;
    clipped.presentation = {
      managed: false, onScreen: false, minimized: false, clientWidth: 1200, clientHeight: 900,
    };

    const raised = trackSnapshot(clipped, before);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ type: 'pvz.window.changed', urgent: true });
    expect(raised[0].text).toContain('1200×900');

    const stillClipped = structuredClone(clipped);
    stillClipped.revision += 1;
    expect(trackSnapshot(stillClipped, clipped)).toEqual([]);

    const restored = structuredClone(before);
    restored.revision = stillClipped.revision + 1;
    const recovered = trackSnapshot(restored, stillClipped);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].text).toContain('已恢复可操作');
  });
});
