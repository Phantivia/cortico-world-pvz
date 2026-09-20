import { describe, expect, it } from 'vitest';
import {
  parseNativeMessage,
  PVZ_NATIVE_PROTOCOL,
  snapshotKey,
  windowPresentable,
  windowPresentationFault,
} from '../src/protocol.ts';
import { boardState, shovelTutorialBoard, snapshot } from './helpers.ts';

describe('PvZ 原生协议边界', () => {
  it.each(['ready', 'triggered', 'squished'] as const)('preserves visible mower state %s', state => {
    const value = snapshot({ screen: 'board', board: boardState({
      mowers: [{ row: 1, kind: 'roof_cleaner', state }],
    }) });
    expect(parseNativeMessage(JSON.stringify({ type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value })))
      .toMatchObject({ snapshot: { board: { mowers: [{ row: 1, state }] } } });
  });

  it('接受可见僵王与球，拒绝越界、隐藏或其他关卡中的球', () => {
    const state = snapshot({ screen: 'board', mode: 35, board: boardState({ boss: {
      phase: 'boss_spitting', immobilized: false,
      projectile: { kind: 'fireball', row: 5, columnPosition: 6.6 },
    } }) });
    const parse = () => parseNativeMessage(JSON.stringify({ type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: state }));
    expect(parse()).toMatchObject({ snapshot: { board: { boss: state.board!.boss } } });
    state.board!.boss!.projectile!.row = 6;
    expect(parse).toThrow('boss.projectile');
    state.board!.boss!.projectile!.row = 5;
    state.mode = 34;
    expect(parse).toThrow('boss');
    state.mode = 35;
    state.board!.disclosure = { entitiesVisible: false, phase: 'dark' };
    expect(parse).toThrow('boss');
  });
  it('右边界仅允许传送门，种植范围仍为九列', () => {
    const state = snapshot({ screen: 'board', mode: 26, modeName: 'portal_combat', board: boardState({
      gridItems: [{ id: 1, kind: 'square_portal', row: 2, column: 10 }],
    }) });
    const parse = () => parseNativeMessage(JSON.stringify({ type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: state }));
    expect(parse()).toMatchObject({ snapshot: { board: { columns: 9, gridItems: [{ column: 10 }] } } });
    state.board!.gridItems[0]!.kind = 'gravestone';
    expect(parse).toThrow('gridItem');
    state.board!.gridItems[0]!.kind = 'round_portal';
    state.board!.gridItems[0]!.column = 11;
    expect(parse).toThrow('gridItem');
  });
  it('语义快照键覆盖完整可见状态并忽略采样时钟', () => {
    const before = snapshot({
      screen: 'board',
      board: boardState({
        fog: { active: true, visibilityRule: 'rendered_fog' },
        allowedSpecialActions: ['whack'],
      }),
    });
    const clockOnly = structuredClone(before);
    clockOnly.revision += 1;
    clockOnly.monotonicMs += 50;
    clockOnly.inputControl = { epoch: 9, menuContext: 0, queueDepth: 1, activeActionId: 'capture' };
    expect(snapshotKey(clockOnly)).toBe(snapshotKey(before));

    const newMenuContext = structuredClone(clockOnly);
    newMenuContext.inputControl.menuContext += 1;
    expect(snapshotKey(newMenuContext)).not.toBe(snapshotKey(before));

    const changed = structuredClone(clockOnly);
    changed.board!.allowedSpecialActions = [];
    expect(snapshotKey(changed)).not.toBe(snapshotKey(before));
  });

  it('接受完整握手、快照、回执、画面与日志消息', () => {
    const messages = [
      {
        type: 'hello', protocol: PVZ_NATIVE_PROTOCOL, pid: 42, architecture: 'x86',
        profile: 'goty-1073', executableSha256: 'a'.repeat(64),
        executableVersion: '1.2.0.1073', ownerToken: '0'.repeat(32), supported: true,
      },
      { type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: snapshot() },
      { type: 'ack', protocol: PVZ_NATIVE_PROTOCOL, id: 'action-1', accepted: true },
      {
        type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'action-1', revision: 1,
        outcome: 'executed', effect: 'target_changed',
      },
      {
        type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'action-2', revision: 2,
        outcome: 'executed', effect: 'card_consumed',
      },
      {
        type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'action-3', revision: 3,
        outcome: 'executed', effect: 'usable_seed_consumed',
      },
      {
        type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'action-4', revision: 4,
        outcome: 'executed', effect: 'beghouled_purchase',
      },
      {
        type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'action-5', revision: 5,
        outcome: 'executed', effect: 'zen_care_applied',
      },
      {
        type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'action-6', revision: 6,
        outcome: 'executed', effect: 'garden_changed',
      },
      {
        type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'action-7', revision: 7,
        outcome: 'executed', effect: 'tree_fed',
      },
      {
        type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'action-8', revision: 8,
        outcome: 'executed', effect: 'profile_created',
      },
      {
        type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'action-9', revision: 9,
        outcome: 'executed', effect: 'shovel_applied',
      },
      {
        type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'action-10', revision: 10,
        outcome: 'executed', effect: 'bowling_launched',
      },
      {
        type: 'frame', protocol: PVZ_NATIVE_PROTOCOL, id: 'frame-1', mime: 'image/png',
        base64: 'iVBORw0KGgo=', width: 800, height: 600,
      },
      { type: 'log', protocol: PVZ_NATIVE_PROTOCOL, level: 'info', message: 'ready' },
    ];
    expect(messages.map((message) => parseNativeMessage(JSON.stringify(message)).type))
      .toEqual([
        'hello', 'snapshot', 'ack', 'result', 'result', 'result', 'result', 'result',
        'result', 'result', 'result', 'result', 'result', 'frame', 'log',
      ]);
  });

  it('保留卡片冷却与僵尸位置速度的公开精度', () => {
    const state = snapshot({
      screen: 'board',
      board: boardState({
        cards: [{
          slot: 0, type: 4, name: 'potato_mine', imitates: null, cost: 25,
          ready: false, affordable: true, cooldown: 'medium',
          cooldownRemainingPercent: 47, cooldownRemainingSeconds: 3.8, x: 80, y: 40,
        }],
        zombies: [{
          id: 9, type: 4, name: 'buckethead', row: 2, column: 6,
          columnPosition: 5.7, xBand: 'mid', speedCellsPerSecond: 0.07,
          speed: 'slow', phase: 'walking', eating: false, condition: 'intact', armor: 'intact',
          shield: 'none', hypnotized: false, slowed: true, immobilized: false,
        }],
      }),
    });
    const parsed = parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: state,
    }));
    expect(parsed).toMatchObject({
      type: 'snapshot',
      snapshot: {
        board: {
          cards: [{ cooldownRemainingPercent: 47, cooldownRemainingSeconds: 3.8 }],
          zombies: [{ columnPosition: 5.7, speedCellsPerSecond: 0.07, eating: false }],
        },
      },
    });
  });

  it.each([
    ['冷却秒数超过一位小数', { field: 'card', value: 3.81 }],
    ['僵尸列位置超过一位小数', { field: 'position', value: 5.72 }],
    ['僵尸速度超过两位小数', { field: 'speed', value: 0.345 }],
  ])('拒绝%s', (_label, sample) => {
    const state = snapshot({
      screen: 'board',
      board: boardState({
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: false, affordable: true, cooldown: 'short',
          cooldownRemainingPercent: 20,
          cooldownRemainingSeconds: sample.field === 'card' ? sample.value : 1.2,
          x: 80, y: 40,
        }],
        zombies: [{
          id: 1, type: 0, name: 'zombie', row: 1, column: 6,
          columnPosition: sample.field === 'position' ? sample.value : 5.7,
          xBand: 'mid', speedCellsPerSecond: sample.field === 'speed' ? sample.value : 0.3,
          speed: 'normal', phase: 'walking', condition: 'intact', armor: 'none',
          shield: 'none', hypnotized: false, slowed: false, immobilized: false,
        }],
      }),
    });
    expect(() => parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: state,
    }))).toThrow();
  });

  it.each(['executed', 'rejected', 'cancelled'] as const)(
    '接受 %s 结果携带严格的批次计数',
    (outcome) => {
      const batch = {
        requested: 4,
        attempted: 3,
        released: 3,
        verified: 2,
        stale: 1,
        scopeStopped: true,
      };
      expect(parseNativeMessage(JSON.stringify({
        type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'batch-1', revision: 3,
        outcome, batch,
      }))).toMatchObject({ type: 'result', outcome, batch });
    },
  );

  it('1-5 铲子教程只接受受限植物目标与 shovel 动作', () => {
    const value = snapshot({
      screen: 'board', scene: 2, mode: 0, menu: [],
      board: shovelTutorialBoard('pickup', [
        { row: 1, column: 3 },
        { row: 3, column: 3 },
        { row: 5, column: 3 },
      ]),
    });
    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value,
    })).type).toBe('snapshot');

    const leaked = structuredClone(value);
    leaked.board!.zombies.push({
      id: 99, type: 0, name: 'zombie', row: 1, column: 9, columnPosition: 9, xBand: 'far', speedCellsPerSecond: 0.0,
      condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
      slowed: false, immobilized: false,
    });
    expect(() => parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: leaked,
    }))).toThrow('泄露了铲子教程之外的棋盘状态');

    const menuLeak = structuredClone(value);
    menuLeak.menu.push({
      id: 'pause', label: 'Pause', enabled: true, x: 750, y: 20,
      state: null, record: null,
    });
    expect(() => parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: menuLeak,
    }))).toThrow('只允许出现在无菜单的关卡引导画面');

    const unrelatedScene = structuredClone(value);
    unrelatedScene.scene = 3;
    expect(() => parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: unrelatedScene,
    }))).toThrow('只允许出现在无菜单的关卡引导画面');
  });

  it.each([
    [799, 600],
    [800, 599],
    [801, 600],
    [800, 601],
  ])('画面尺寸 %d×%d 偏离托管客户区时拒绝', (width, height) => {
    expect(() => parseNativeMessage(JSON.stringify({
      type: 'frame', protocol: PVZ_NATIVE_PROTOCOL, id: 'frame-drift', mime: 'image/png',
      base64: 'iVBORw0KGgo=', width, height,
    }))).toThrow('frame 字段无效');
  });

  it('选卡转场降为 loading 时保持画面与载荷一致', () => {
    const transition = snapshot({ screen: 'loading', seedPicker: null });
    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: transition,
    })).type).toBe('snapshot');

    const contradictory = structuredClone(transition);
    contradictory.screen = 'seed_picker';
    expect(() => parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: contradictory,
    }))).toThrow('snapshot.seedPicker 与画面不一致');
  });

  it('选卡协议保留戴夫固定卡语义', () => {
    const value = snapshot({
      screen: 'seed_picker',
      seedPicker: {
        capacity: 1,
        selected: [0],
        choices: [{
          id: 0, name: 'peashooter', state: 'selected', bankSlot: 0, imitates: null,
          recommended: true, fixed: true, x: 100, y: 20,
        }],
        previewZombies: [],
        ready: true,
      },
    });
    const parsed = parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value,
    }));
    expect(parsed.type).toBe('snapshot');
    if (parsed.type === 'snapshot') {
      expect(parsed.snapshot.seedPicker?.choices[0].fixed).toBe(true);
    }
  });

  it('接受主菜单中可点击但尚未解锁的模式入口', () => {
    const value = snapshot({
      menu: [
        { id: 'adventure', label: 'Adventure', enabled: true, x: 400, y: 340, state: null, record: null },
        { id: 'minigame', label: 'Mini-games', enabled: false, x: 500, y: 300, state: 'locked', record: null },
        { id: 'puzzle', label: 'Puzzle', enabled: false, x: 500, y: 360, state: 'locked', record: null },
        { id: 'survival', label: 'Survival', enabled: false, x: 500, y: 420, state: 'locked', record: null },
      ],
    });

    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value,
    })).type).toBe('snapshot');
  });

  it('接受 Zen 可见植物目标与换花园的无坐标全局目标', () => {
    const value = snapshot({
      screen: 'board', mode: 43, modeName: 'zen_garden', modeKind: 'zen_garden',
      board: boardState({
        plants: [{
          id: 80, type: 0, name: 'peashooter', row: 2, column: 3,
          condition: 'intact', sleeping: false, squished: false, layers: [],
        }],
        allowedSpecialActions: ['zen_water', 'zen_next_garden'],
        special: {
          phase: 'care', settled: true,
          targets: [
            {
              action: 'zen_water', kind: 'plant', id: 80, slot: null,
              row: 2, column: 3,
            },
            {
              action: 'zen_next_garden', kind: 'cell', id: null, slot: null,
              row: null, column: null,
            },
          ],
        },
      }),
    });

    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value,
    })).type).toBe('snapshot');
  });

  it('只在智慧树模式接受 tree_feed 全局目标', () => {
    const value = snapshot({
      screen: 'board', mode: 50, modeName: 'tree_of_wisdom', modeKind: 'tree_of_wisdom',
      board: boardState({
        allowedSpecialActions: ['tree_feed'],
        special: {
          phase: 'tree', settled: true,
          targets: [{
            action: 'tree_feed', kind: 'cell', id: null, slot: null,
            row: null, column: null,
          }],
        },
      }),
    });

    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value,
    })).type).toBe('snapshot');
  });

  it('智慧树模式允许用无坐标全局目标切换到下一座花园', () => {
    const value = snapshot({
      screen: 'board', mode: 50, modeName: 'tree_of_wisdom', modeKind: 'tree_of_wisdom',
      board: boardState({
        allowedSpecialActions: ['zen_next_garden'],
        special: {
          phase: 'tree', settled: true,
          targets: [{
            action: 'zen_next_garden', kind: 'cell', id: null, slot: null,
            row: null, column: null,
          }],
        },
      }),
    });

    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value,
    })).type).toBe('snapshot');
  });

  it('拒绝 Zen 全局动作夹带普通地格或出现在错误模式', () => {
    const mixed = snapshot({
      screen: 'board', mode: 43, modeName: 'zen_garden', modeKind: 'zen_garden',
      board: boardState({
        allowedSpecialActions: ['zen_next_garden'],
        special: {
          phase: 'care', settled: true,
          targets: [
            {
              action: 'zen_next_garden', kind: 'cell', id: null, slot: null,
              row: null, column: null,
            },
            {
              action: 'zen_next_garden', kind: 'cell', id: null, slot: null,
              row: 1, column: 1,
            },
          ],
        },
      }),
    });
    expect(() => parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: mixed,
    }))).toThrow('zen_next_garden 全局目标无效');

    const wrongMode = structuredClone(mixed);
    wrongMode.mode = 0;
    wrongMode.modeName = 'adventure';
    wrongMode.modeKind = 'adventure';
    wrongMode.board!.special!.targets = [wrongMode.board!.special!.targets[0]!];
    expect(() => parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: wrongMode,
    }))).toThrow('Zen 动作与游戏模式不一致');
  });

  it('主模式未 settled 时仍允许独立就绪的精确特殊目标', () => {
    const value = snapshot({
      screen: 'board',
      board: boardState({
        plants: [{
          id: 51, type: 47, name: 'cob_cannon', row: 2, column: 3,
          condition: 'intact', sleeping: false, squished: false, layers: [],
        }],
        allowedSpecialActions: ['cob_fire'],
        special: {
          phase: 'onslaught',
          settled: false,
          targets: [{
            action: 'cob_fire', kind: 'plant', id: 51, slot: null, row: 2, column: 3,
          }],
        },
      }),
    });
    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value,
    })).type).toBe('snapshot');
  });

  it('接受与 I, Zombie 卡槽原子配对的格子目标', () => {
    const value = snapshot({
      screen: 'board',
      mode: 61,
      modeName: 'i_zombie_1',
      modeKind: 'i_zombie',
      board: boardState({
        cards: [{
          slot: 0, type: 0, name: 'zombie', imitates: null, cost: 50, ready: true,
          affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        allowedSpecialActions: ['place_zombie'],
        special: {
          phase: 'playing',
          settled: true,
          targets: [
            { action: 'place_zombie', kind: 'card', id: null, slot: 0, row: null, column: null },
            { action: 'place_zombie', kind: 'cell', id: null, slot: 0, row: 2, column: 8 },
          ],
        },
      }),
    });
    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value,
    })).type).toBe('snapshot');
  });

  it('普通迷雾允许用 null 表达动态占用未知的可尝试地格', () => {
    const board = boardState({ fog: { active: true, visibilityRule: 'rendered_fog' } });
    board.cells[7] = {
      ...board.cells[7], playable: null, blocker: 'fog_hidden', base: 'unknown',
    };
    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({ screen: 'board', board }),
    })).type).toBe('snapshot');
  });

  it('黑暗阶段只接受不可操作且内容未知的静态地格', () => {
    const board = boardState({ disclosure: { entitiesVisible: false, phase: 'dark' } });
    board.plants = [];
    board.zombies = [];
    board.gridItems = [];
    board.collectibles = [];
    board.mowers = [];
    board.cells = board.cells.map((cell) => ({
      ...cell, playable: false, blocker: 'dark_hidden', base: 'unknown',
    }));
    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({ screen: 'board', board }),
    })).type).toBe('snapshot');
  });

  it('关卡完成进度不复述已失效的计数器', () => {
    const value = snapshot({
      screen: 'board',
      board: boardState({
        progress: {
          kind: 'complete', current: null, target: null, stage: null, label: 'Complete',
        },
      }),
    });
    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value,
    })).type).toBe('snapshot');
  });

  it('接受持久终局结果并严格校验其进程内身份', () => {
    const value = snapshot({
      screen: 'award', mode: 22, modeName: 'seeing_stars', modeKind: 'minigame',
      lastRun: { resultId: 3, runId: 7, mode: 22, level: 0, outcome: 'won' },
    });
    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value,
    })).type).toBe('snapshot');

    for (const lastRun of [
      { resultId: 0, runId: 7, mode: 22, level: 0, outcome: 'won' },
      { resultId: 3, runId: 0, mode: 22, level: 0, outcome: 'won' },
      { resultId: 3, runId: 7, mode: 71, level: 0, outcome: 'won' },
      { resultId: 3, runId: 7, mode: 0, level: 0, outcome: 'won' },
      { resultId: 3, runId: 7, mode: 0, level: 51, outcome: 'won' },
      { resultId: 3, runId: 7, mode: 22, level: 1, outcome: 'won' },
      { resultId: 3, runId: 7, mode: 22, level: 0, outcome: 'quit' },
      { resultId: 3, runId: 7, mode: 22, level: 0, outcome: 'won', rawResult: 1 },
    ]) {
      expect(() => parseNativeMessage(JSON.stringify({
        type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
        snapshot: { ...value, lastRun },
      }))).toThrow();
    }
  });

  it('Seeing Stars 目标格是常规种植目标而不是特殊动作', () => {
    const cells = [
      [1, 4], [2, 4], [2, 5],
      [3, 2], [3, 3], [3, 4], [3, 5], [3, 6], [3, 7],
      [4, 4], [4, 5], [4, 6], [5, 4], [5, 7],
    ] as const;
    const board = boardState({
      plants: [
        {
          id: 4, type: 0, name: 'peashooter', row: 2, column: 4,
          condition: 'intact', sleeping: false, squished: false, layers: [],
        },
        {
          id: 5, type: 29, name: 'starfruit', row: 1, column: 1,
          condition: 'intact', sleeping: false, squished: false, layers: [],
        },
      ],
      allowedSpecialActions: [],
      special: {
        phase: 'playing', settled: true,
        targets: cells.map(([row, column]) => ({
          action: 'objective_starfruit', kind: 'cell', id: null, slot: null,
          row, column,
        })),
      },
    });
    const value = snapshot({
      screen: 'board', mode: 22, modeName: 'seeing_stars', modeKind: 'minigame', board,
    });
    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value,
    })).type).toBe('snapshot');

    const completed = structuredClone(value);
    completed.board!.special!.targets = [];
    completed.board!.plants = cells.map(([row, column], id) => ({
      id: id + 10, type: 29, name: 'starfruit', row, column,
      condition: 'intact', sleeping: false, squished: false, layers: [],
    }));
    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: completed,
    })).type).toBe('snapshot');

    const unsettled = structuredClone(value);
    unsettled.board!.special = { phase: 'transition', settled: false, targets: [] };
    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: unsettled,
    })).type).toBe('snapshot');

    const occupiedWrong = structuredClone(value);
    occupiedWrong.board!.special!.targets = occupiedWrong.board!.special!.targets
      .filter((target) => target.row !== 2 || target.column !== 4);
    expect(() => parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: occupiedWrong,
    }))).toThrow('与可见星星图案不一致');

    const nonPattern = structuredClone(value);
    nonPattern.board!.special!.targets[0]!.row = 1;
    nonPattern.board!.special!.targets[0]!.column = 1;
    expect(() => parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: nonPattern,
    }))).toThrow('图案坐标无效');

    const wrongMode = structuredClone(value);
    wrongMode.mode = 23;
    expect(() => parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: wrongMode,
    }))).toThrow('objective_starfruit 观测目标无效');

    const actionable = structuredClone(value);
    actionable.board!.allowedSpecialActions = ['objective_starfruit'];
    expect(() => parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: actionable,
    }))).toThrow('target 与允许动作不一致');

    const duplicate = structuredClone(value);
    duplicate.board!.special!.targets.push({ ...duplicate.board!.special!.targets[0]! });
    expect(() => parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: duplicate,
    }))).toThrow('target 重复');

    const unknown = structuredClone(value);
    unknown.board!.special!.targets[0]!.action = 'objective_hidden_score';
    expect(() => parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: unknown,
    }))).toThrow('objective target 未知');
  });

  it('模式选择页只传递肉眼可见的锁定、完成与无尽纪录', () => {
    const value = snapshot({
      screen: 'mode_selector',
      menu: [
        { id: 'mode_1', label: 'survival_day', enabled: true, x: 100, y: 100, state: 'completed', record: null },
        { id: 'mode_11', label: 'survival_endless_day', enabled: true, x: 200, y: 100, state: 'available', record: 12 },
        { id: 'mode_20', label: 'locked', enabled: false, x: 300, y: 100, state: 'locked', record: null },
      ],
    });
    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value,
    })).type).toBe('snapshot');
  });

  it('主菜单入口的锁定标记与可点状态对不上时照常收下这一份快照', () => {
    // 快照由植入件提供，locked 与 enabled 是独立状态；解析器不以两字段组合推断快照无效。
    const value = snapshot({
      menu: [{
        id: 'minigame', label: 'Mini-games', enabled: true, x: 500, y: 300,
        state: 'locked', record: null,
      }],
    });
    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value,
    })).type).toBe('snapshot');
  });

  it('商店菜单项表达可购、金币不足与售罄', () => {
    const value = snapshot({
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
        {
          id: 'store_buy_phonograph', label: 'Phonograph', enabled: false,
          x: 400, y: 220, state: 'sold_out', record: 15000,
        },
      ],
    });
    expect(parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value,
    })).type).toBe('snapshot');
  });

  it.each([
    ['JSON null', 'null'],
    ['非 JSON', '{'],
    ['协议代际错误', JSON.stringify({ type: 'log', protocol: 999, level: 'info', message: 'x' })],
    ['未知消息类型', JSON.stringify({ type: 'execute', protocol: PVZ_NATIVE_PROTOCOL })],
    ['非 x86 植入件', JSON.stringify({
      type: 'hello', protocol: PVZ_NATIVE_PROTOCOL, pid: 1, architecture: 'x64', profile: 'x',
      executableSha256: 'a'.repeat(64), executableVersion: '1', ownerToken: '0'.repeat(32), supported: true,
    })],
    ['过长 action id', JSON.stringify({
      type: 'ack', protocol: PVZ_NATIVE_PROTOCOL, id: 'a'.repeat(129), accepted: true,
    })],
    ['非法执行结果', JSON.stringify({
      type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'a', revision: 1, outcome: 'maybe',
    })],
    ['缺少执行结果 revision', JSON.stringify({
      type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'a', outcome: 'executed',
    })],
    ['拒绝结果携带成功 effect', JSON.stringify({
      type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'a', revision: 1,
      outcome: 'rejected', effect: 'collectibles_collected',
    })],
    ['未知 Zen effect', JSON.stringify({
      type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'a', revision: 1,
      outcome: 'executed', effect: 'tree_height_changed',
    })],
    ['批次计数含未知字段', JSON.stringify({
      type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'a', revision: 1,
      outcome: 'executed',
      batch: {
        requested: 1, attempted: 1, released: 1, verified: 1, stale: 0, scopeStopped: false,
        remaining: 0,
      },
    })],
    ['批次请求数为零', JSON.stringify({
      type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'a', revision: 1,
      outcome: 'executed',
      batch: { requested: 0, attempted: 0, released: 0, verified: 0, stale: 0, scopeStopped: false },
    })],
    ['批次验证数超过尝试数', JSON.stringify({
      type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'a', revision: 1,
      outcome: 'executed',
      batch: { requested: 2, attempted: 1, released: 1, verified: 2, stale: 0, scopeStopped: false },
    })],
    ['批次尝试与过期数超过请求数', JSON.stringify({
      type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'a', revision: 1,
      outcome: 'cancelled',
      batch: { requested: 2, attempted: 2, released: 2, verified: 1, stale: 1, scopeStopped: true },
    })],
    ['批次停止标志不是布尔值', JSON.stringify({
      type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: 'a', revision: 1,
      outcome: 'rejected',
      batch: { requested: 1, attempted: 0, released: 0, verified: 0, stale: 1, scopeStopped: 1 },
    })],
    ['过大画面', JSON.stringify({
      type: 'frame', protocol: PVZ_NATIVE_PROTOCOL, id: 'f', mime: 'image/png', base64: '',
      width: 8193, height: 600,
    })],
    ['空画面尺寸', JSON.stringify({
      type: 'frame', protocol: PVZ_NATIVE_PROTOCOL, id: 'f', mime: 'image/png',
      base64: 'iVBORw0KGgo=', width: 0, height: 600,
    })],
    ['伪造 PNG 数据', JSON.stringify({
      type: 'frame', protocol: PVZ_NATIVE_PROTOCOL, id: 'f', mime: 'image/png',
      base64: 'dGV4dA==', width: 800, height: 600,
    })],
    ['非数组棋盘字段', JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({ screen: 'board', board: boardState({ zombies: [] }) }),
    }).replace('"zombies":[]', '"zombies":{}')],
    ['超量棋盘对象', JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({ screen: 'board', board: boardState({
        gridItems: Array.from({ length: 4097 }, (_, id) => ({ id, kind: 'vase', row: 1, column: 1 })),
      }) }),
    })],
    ['非法日志正文', JSON.stringify({
      type: 'log', protocol: PVZ_NATIVE_PROTOCOL, level: 'info', message: 3,
    })],
  ])('拒绝%s', (_label, line) => {
    expect(() => parseNativeMessage(line)).toThrow();
  });

  it.each([
    ['非正 PID', {
      type: 'hello', protocol: PVZ_NATIVE_PROTOCOL, pid: 0, architecture: 'x86', profile: 'x',
      executableSha256: 'a'.repeat(64), executableVersion: '1', ownerToken: '0'.repeat(32), supported: true,
    }],
    ['负 revision', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: snapshot({ revision: -1 }),
    }],
    ['未知 screen', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: { ...snapshot(), screen: 'native_private_screen' },
    }],
    ['缺少版本事实', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: { ...snapshot(), executable: undefined },
    }],
    ['缺少可见档案名', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: {
        ...snapshot(),
        profile: { ...snapshot().profile!, name: undefined },
      },
    }],
    ['畸形可见实体', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'board',
        board: { ...boardState(), zombies: [{ id: 'raw-pointer', row: -7 }] } as never,
      }),
    }],
    ['缺少棋盘运行标识', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'board',
        board: { ...boardState(), runId: undefined } as never,
      }),
    }],
    ['畸形卡片', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'board',
        board: { ...boardState(), cards: [{ slot: 12, ready: 'yes' }] } as never,
      }),
    }],
    ['卡片 ready 与冷却桶不一致', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'board',
        board: boardState({
          cards: [{
            slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
            ready: true, affordable: true, cooldown: 'short', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
          }],
        }),
      }),
    }],
    ['同一行重复割草机', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'board',
        board: boardState({
          mowers: [
            { row: 1, kind: 'lawn_mower', state: 'ready' },
            { row: 1, kind: 'super_mower', state: 'triggered' },
          ],
        }),
      }),
    }],
    ['割草机泄露内部类型名', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'board',
        board: boardState({ mowers: [{ row: 1, kind: 'mower_type_3', state: 'ready' }] }),
      }),
    }],
    ['畸形可见进度', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'board',
        board: { ...boardState(), progress: { kind: 'raw_internal_counter', current: -1 } } as never,
      }),
    }],
    ['畸形迷雾边界', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'board',
        board: { ...boardState(), fog: { active: true, visibilityRule: 'memory_read' } } as never,
      }),
    }],
    ['非迷雾地格伪装动态未知', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'board',
        board: boardState({
          cells: boardState().cells.map((cell, index) => index === 0
            ? { ...cell, playable: null, blocker: 'fog_hidden', base: 'unknown' }
            : cell),
        }),
      }),
    }],
    ['不一致的迷雾状态', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'board',
        board: { ...boardState(), fog: { active: false, visibilityRule: 'rendered_fog' } } as never,
      }),
    }],
    ['黑暗阶段泄露实体', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'board',
        board: {
          ...boardState(),
          disclosure: { entitiesVisible: false, phase: 'dark' },
          plants: [{
            id: 1, type: 0, name: 'peashooter', row: 1, column: 1,
            condition: 'intact', sleeping: false, squished: false, layers: [],
          }],
        } as never,
      }),
    }],
    ['黑暗阶段泄露割草机状态', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'board',
        board: {
          ...boardState(),
          disclosure: { entitiesVisible: false, phase: 'dark' },
          mowers: [{ row: 1, kind: 'lawn_mower', state: 'ready' }],
        } as never,
      }),
    }],
    ['隐形食脑者阶段泄露僵尸', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'board',
        board: {
          ...boardState(),
          fog: { active: true, visibilityRule: 'invisighoul' },
          zombies: [{
            id: 1, type: 0, name: 'zombie', row: 1, column: 8, columnPosition: 8, xBand: 'far', speedCellsPerSecond: 0.0,
            condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
            slowed: false, immobilized: false,
          }],
        } as never,
      }),
    }],
    ['畸形花瓶显露内容', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'board',
        board: {
          ...boardState(),
          gridItems: [{
            id: 1, kind: 'vase', row: 1, column: 1,
            revealedContent: { kind: 'pointer', type: -1, name: '' },
          }],
        } as never,
      }),
    }],
    ['嵌套可见状态含未知字段', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'board',
        board: {
          ...boardState(),
          progress: {
            kind: 'waves', current: 0, target: 10, stage: null, label: '0/10 波',
            hiddenWaveCounter: 37,
          },
        } as never,
      }),
    }],
    ['选卡容量超过种子槽上限', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'seed_picker',
        seedPicker: {
          capacity: 11, selected: [], choices: [], previewZombies: [], ready: false,
        },
      }),
    }],
    ['选卡画面缺少选卡状态', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({ screen: 'seed_picker', seedPicker: null }),
    }],
    ['非选卡画面携带选卡状态', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        seedPicker: {
          capacity: 1, selected: [], choices: [], previewZombies: [], ready: false,
        },
      }),
    }],
    ['选卡容量为零', {
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL,
      snapshot: snapshot({
        screen: 'seed_picker',
        seedPicker: {
          capacity: 0, selected: [], choices: [], previewZombies: [], ready: false,
        },
      }),
    }],
  ])('拒绝来自进程边界的%s', (_label, message) => {
    expect(() => parseNativeMessage(JSON.stringify(message))).toThrow();
  });

  it('接受窗口不可操作的实况并据此给出一句事实', () => {
    const value = snapshot({
      presentation: { managed: false, onScreen: false, minimized: false, clientWidth: 1200, clientHeight: 900 },
    });
    const parsed = parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value,
    }));
    expect(parsed).toMatchObject({
      snapshot: { presentation: { managed: false, onScreen: false, minimized: false, clientWidth: 1200 } },
    });
    expect(windowPresentable(value.presentation)).toBe(false);
    const fault = windowPresentationFault(value.presentation);
    expect(fault).toContain('1200×900');
    expect(fault).toContain('没有整个落在同一块显示器');
    expect(windowPresentationFault({
      managed: true, onScreen: true, minimized: false, clientWidth: 800, clientHeight: 600,
    })).toBeNull();
    expect(windowPresentationFault({
      managed: false, onScreen: false, minimized: true, clientWidth: 0, clientHeight: 0,
    })).toContain('窗口已最小化');
  });

  it.each([
    ['缺少窗口实况', undefined],
    ['窗口实况多带字段', {
      managed: true, onScreen: true, minimized: false, clientWidth: 800, clientHeight: 600, monitor: 1,
    }],
    ['managed 与量到的尺寸自相矛盾', {
      managed: true, onScreen: true, minimized: false, clientWidth: 1200, clientHeight: 900,
    }],
    ['窗口尺寸为负', {
      managed: false, onScreen: false, minimized: false, clientWidth: -1, clientHeight: 600,
    }],
    ['最小化却自称整个在屏幕里', {
      managed: false, onScreen: true, minimized: true, clientWidth: 0, clientHeight: 0,
    }],
  ])('拒绝%s', (_label, presentation) => {
    const value = snapshot() as unknown as Record<string, unknown>;
    if (presentation === undefined) delete value.presentation;
    else value.presentation = presentation;
    expect(() => parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: value,
    }))).toThrow();
  });
});
