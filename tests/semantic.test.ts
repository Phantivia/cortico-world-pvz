import { describe, expect, it } from 'vitest';
import {
  PVZ_SEMANTIC_SPECIAL_ACTIONS,
  PvzSemanticError,
  canonicalCardDisplay,
  canonicalCardKey,
  describeSemanticTarget,
  resolveCardSlot,
  resolveSemanticMenuAction,
  resolveSemanticSpecialAction,
  selectCollectibleIds,
  selectSunIds,
  semanticCards,
  semanticMenuTarget,
  emptyFlowerPotCells,
  type PvzSemanticSpecialRequest,
} from '../src/semantic.ts';
import type {
  PvzBoardState,
  PvzNativeAction,
  PvzSpecialTarget,
} from '../src/protocol.ts';
import { boardState, snapshot } from './helpers.ts';

it('selects only disclosed, empty, unsquished flower pots on usable cells in house order', () => {
  const pot = (column: number) => ({ id: column, type: 33, name: 'flower_pot', row: 1, column,
    condition: 'intact' as const, sleeping: false, squished: false, layers: [] });
  const board = boardState({ background: 5, plants: [pot(6), pot(5), pot(4), pot(3), pot(2), pot(1),
    { ...pot(1), id: 20, type: 39, name: 'melon_pult' },
  ] });
  board.plants.find(plant => plant.column === 3)!.squished = true;
  board.cells.find(cell => cell.row === 1 && cell.column === 4)!.blocker = 'ice_trail';
  board.cells.find(cell => cell.row === 1 && cell.column === 5)!.playable = null;
  expect(emptyFlowerPotCells(board)).toEqual([{ row: 1, column: 2 }, { row: 1, column: 6 }]);
  board.disclosure.entitiesVisible = false;
  expect(emptyFlowerPotCells(board)).toEqual([]);
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

describe('PvZ semantic menus', () => {
  it('maps hidden mode ids to the visible mode name in both directions', () => {
    const state = snapshot({
      screen: 'mode_selector',
      menu: [{
        id: 'mode_17', label: 'wall_nut_bowling', enabled: true,
        x: 100, y: 100, state: 'available', record: null,
      }],
    });
    expect(semanticMenuTarget(state.menu[0]!)).toBe('wall_nut_bowling');
    expect(resolveSemanticMenuAction(state, 'wall-nut bowling').id).toBe('mode_17');
    expect(() => resolveSemanticMenuAction(state, 'mode_17')).toThrow('当前界面没有菜单操作');
  });
});

describe('PvZ semantic cards', () => {
  it('uses canonical keys to distinguish ordinary, duplicate, and imitater cards', () => {
    const board = boardState({
      cards: [
        {
          slot: 4, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 100, y: 40,
        },
        {
          slot: 1, type: 48, name: 'imitater', imitates: 0, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 150, y: 40,
        },
        {
          slot: 2, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 200, y: 40,
        },
      ],
    });

    expect(semanticCards(board)).toEqual([
      { key: 'card:imitater:peashooter#1', display: 'imitater(peashooter)', internalSlot: 1 },
      { key: 'card:peashooter#1', display: 'peashooter #1', internalSlot: 2 },
      { key: 'card:peashooter#2', display: 'peashooter #2', internalSlot: 4 },
    ]);
    expect(canonicalCardKey(board, 1)).toBe('card:imitater:peashooter#1');
    expect(canonicalCardDisplay(board, 1)).toBe('imitater(peashooter)');
    expect(resolveCardSlot(board, { plant: 'imitater', imitates: 'peashooter' })).toBe(1);
    expect(resolveCardSlot(board, 'card:peashooter#2')).toBe(4);
    expect(resolveCardSlot(board, canonicalCardDisplay(board, 1))).toBe(1);
    expect(resolveCardSlot(board, canonicalCardDisplay(board, 2))).toBe(2);
    expect(resolveCardSlot(board, canonicalCardDisplay(board, 4))).toBe(4);
    expect(resolveCardSlot(board, '豌豆射手 #2')).toBe(4);
    expect(resolveCardSlot(board, { plant: '模仿者', imitates: '豌豆射手' })).toBe(1);
    expect(() => resolveCardSlot(board, 'peashooter')).toThrowError(PvzSemanticError);
    expect(() => resolveCardSlot(board, 'peashooter'))
      .toThrow('card:"peashooter #1" 或 card:"peashooter #2"');
  });

  it('does not silently treat an imitater as its base plant', () => {
    const board = boardState({
      cards: [{
        slot: 0, type: 48, name: 'imitater', imitates: 0, cost: 100,
        ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
      }],
    });

    expect(() => resolveCardSlot(board, 'peashooter')).toThrow('当前没有可见卡片');
    expect(() => resolveCardSlot(board, { plant: 'imitater' })).toThrow('必须指定 imitates');
    expect(() => resolveCardSlot(board, { plant: 'peashooter', imitates: 'sunflower' }))
      .toThrow('只有 imitater');
  });
});

describe('PvZ semantic collectibles', () => {
  it('selects visible semantic groups and places terminal awards last', () => {
    const board = boardState({
      collectibles: [
        { id: 10, kind: 'trophy', x: 1, y: 1, row: null, column: null },
        { id: 11, kind: 'small_sun', x: 2, y: 2, row: null, column: null },
        { id: 12, kind: 'silver_coin', x: 3, y: 3, row: null, column: null },
        { id: 13, kind: 'usable_seed', containedType: 0, containedName: 'peashooter', x: 4, y: 4, row: null, column: null },
        { id: 14, kind: 'large_sun', x: 5, y: 5, row: null, column: null },
        { id: 15, kind: 'diamond', x: 6, y: 6, row: null, column: null },
        { id: 16, kind: 'present', x: 7, y: 7, row: null, column: null },
      ],
    });

    expect(selectCollectibleIds(board, 'coins')).toEqual([12, 15]);
    expect(selectCollectibleIds(board, 'award')).toEqual([10, 16]);
    expect(selectCollectibleIds(board, 'usable_seed')).toEqual([13]);
  });

  it('keeps sun out of every model-facing group and inside the module selector', () => {
    const board = boardState({
      collectibles: [
        { id: 11, kind: 'small_sun', x: 2, y: 2, row: null, column: null },
        { id: 12, kind: 'silver_coin', x: 3, y: 3, row: null, column: null },
        { id: 14, kind: 'large_sun', x: 5, y: 5, row: null, column: null },
        { id: 16, kind: 'present', x: 7, y: 7, row: null, column: null },
      ],
    });

    expect(selectCollectibleIds(board, 'resources')).toEqual([12, 16]);
    expect(selectSunIds(board)).toEqual([11, 14]);
  });

  it('uses only the disclosed entity list', () => {
    const dark = boardState({
      disclosure: { entitiesVisible: false, phase: 'dark' },
      collectibles: [],
    });
    expect(selectCollectibleIds(dark, 'resources')).toEqual([]);
  });
});

interface SpecialCase {
  request: PvzSemanticSpecialRequest;
  expected: PvzNativeAction;
}

function specialBoard(): PvzBoardState {
  const globals = [
    'spin', 'start_onslaught', 'buy_snorkel', 'buy_trophy', 'zen_next_garden', 'tree_feed',
  ];
  const zen = [
    'zen_water', 'zen_fertilize', 'zen_bug_spray', 'zen_phonograph', 'zen_chocolate',
  ];
  const specialTargets: PvzSpecialTarget[] = [
    target('break_vase', 'grid_item', { id: 30, row: 4, column: 5 }),
    target('whack', 'zombie', { id: 20, row: 3, column: 4 }),
    target('cob_fire', 'plant', { id: 10, row: 1, column: 1 }),
    target('swap', 'cell', { row: 2, column: 2 }),
    target('swap', 'cell', { row: 2, column: 3 }),
    target('twist', 'cell', { row: 2, column: 2 }),
    target('launch', 'cell', { row: 1, column: 4 }),
    target('drop_brain', 'cell', { row: 2, column: 9 }),
    target('bowling', 'card', { slot: 0 }),
    target('bowling', 'cell', { row: 3, column: 3 }),
    target('place_zombie', 'card', { slot: 1 }),
    target('place_zombie', 'cell', { slot: 1, row: 3, column: 8 }),
    target('beghouled_buy', 'card', { slot: 2 }),
    ...globals.map((action) => target(action, 'cell')),
    ...zen.map((action) => target(action, 'plant', { id: 11, row: 2, column: 2 })),
  ];
  return boardState({
    cards: [
      {
        slot: 0, type: 3, name: 'wall_nut', imitates: null, cost: null,
        ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
      },
      {
        slot: 1, type: 60, name: 'zombie', imitates: null, cost: 50,
        ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 130, y: 40,
      },
      {
        slot: 2, type: 7, name: 'repeater', imitates: null, cost: 100,
        ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 180, y: 40,
      },
    ],
    plants: [
      {
        id: 10, type: 47, name: 'cob_cannon', row: 1, column: 1,
        condition: 'intact', sleeping: false, squished: false, layers: ['main'],
      },
      {
        id: 11, type: 0, name: 'peashooter', row: 2, column: 2,
        condition: 'intact', sleeping: false, squished: false, layers: ['main'],
      },
    ],
    zombies: [{
      id: 20, type: 0, name: 'zombie', row: 3, column: 4, columnPosition: 4, xBand: 'near', speedCellsPerSecond: 0.0,
      condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
      slowed: false, immobilized: false,
    }],
    gridItems: [{ id: 30, kind: 'vase', row: 4, column: 5 }],
    allowedSpecialActions: [...PVZ_SEMANTIC_SPECIAL_ACTIONS],
    special: { phase: 'ready', settled: true, targets: specialTargets },
  });
}

const SPECIAL_CASES: SpecialCase[] = [
  {
    request: { action: 'break_vase', target: { kind: 'grid_item', name: 'vase', at: { row: 4, column: 5 } } },
    expected: { kind: 'special', action: 'break_vase', targetId: 30, row: 4, column: 5 },
  },
  {
    request: { action: 'whack', target: { kind: 'zombie', name: 'zombie', at: { row: 3, column: 4 } } },
    expected: { kind: 'special', action: 'whack', targetId: 20, row: 3, column: 4 },
  },
  {
    request: {
      action: 'cob_fire', target: { kind: 'plant', name: 'cob_cannon', at: { row: 1, column: 1 } },
      to: { row: 3, column: 7 },
    },
    expected: {
      kind: 'special', action: 'cob_fire', targetId: 10, row: 1, column: 1,
      toRow: 3, toColumn: 7,
    },
  },
  {
    request: { action: 'swap', at: { row: 2, column: 2 }, to: { row: 2, column: 3 } },
    expected: { kind: 'special', action: 'swap', row: 2, column: 2, toRow: 2, toColumn: 3 },
  },
  {
    request: { action: 'twist', at: { row: 2, column: 2 } },
    expected: { kind: 'special', action: 'twist', row: 2, column: 2 },
  },
  {
    request: { action: 'launch', at: { row: 1, column: 4 } },
    expected: { kind: 'special', action: 'launch', row: 1, column: 4 },
  },
  {
    request: { action: 'drop_brain', at: { row: 2, column: 9 } },
    expected: { kind: 'special', action: 'drop_brain', row: 2, column: 9 },
  },
  {
    request: { action: 'bowling', card: 'wall_nut', at: { row: 3, column: 3 } },
    expected: { kind: 'special', action: 'bowling', slot: 0, row: 3, column: 3 },
  },
  {
    request: { action: 'place_zombie', card: 'zombie', at: { row: 3, column: 8 } },
    expected: { kind: 'special', action: 'place_zombie', slot: 1, row: 3, column: 8 },
  },
  {
    request: { action: 'beghouled_buy', card: 'repeater' },
    expected: { kind: 'special', action: 'beghouled_buy', slot: 2 },
  },
  ...(['spin', 'start_onslaught', 'buy_snorkel', 'buy_trophy', 'zen_next_garden', 'tree_feed'] as const)
    .map((action): SpecialCase => ({
      request: { action }, expected: { kind: 'special', action },
    })),
  ...(['zen_water', 'zen_fertilize', 'zen_bug_spray', 'zen_phonograph', 'zen_chocolate'] as const)
    .map((action): SpecialCase => ({
      request: { action, target: { kind: 'plant', name: 'peashooter', at: { row: 2, column: 2 } } },
      expected: { kind: 'special', action, targetId: 11, row: 2, column: 2 },
    })),
];

describe('PvZ semantic special actions', () => {
  it.each(SPECIAL_CASES)('resolves $request.action without caller ids or slots', ({ request, expected }) => {
    expect(resolveSemanticSpecialAction(specialBoard(), request)).toEqual(expected);
  });

  it('keeps the semantic contract table in lockstep with every supported action', () => {
    expect(SPECIAL_CASES.map(({ request }) => request.action).sort())
      .toEqual([...PVZ_SEMANTIC_SPECIAL_ACTIONS].sort());
  });

  it('treats duplicate bowling packets of the same plant as interchangeable', () => {
    const board = specialBoard();
    board.cards.push({
      slot: 3, type: 3, name: 'wall_nut', imitates: null, cost: null,
      ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 230, y: 40,
    });
    board.special!.targets.push(target('bowling', 'card', { slot: 3 }));

    expect(resolveSemanticSpecialAction(board, {
      action: 'bowling', card: 'wall_nut', at: { row: 3, column: 3 },
    })).toEqual({ kind: 'special', action: 'bowling', slot: 0, row: 3, column: 3 });
    expect(resolveSemanticSpecialAction(board, {
      action: 'bowling', card: 'wall_nut #3', at: { row: 3, column: 3 },
    })).toEqual({ kind: 'special', action: 'bowling', slot: 0, row: 3, column: 3 });
    expect(() => resolveCardSlot(board, 'wall_nut')).toThrow('有歧义');
  });

  it('rejects raw ids, wrong target kinds, illegal cells, and ambiguous entities', () => {
    const board = specialBoard();
    expect(() => resolveSemanticSpecialAction(board, {
      action: 'whack', targetId: 20,
    } as never)).toThrow('不接受字段 targetId');
    expect(() => resolveSemanticSpecialAction(board, {
      action: 'whack', target: { kind: 'plant', name: 'zombie' },
    })).toThrow('target.kind 必须是 zombie');
    expect(() => resolveSemanticSpecialAction(board, {
      action: 'swap', at: { row: 2, column: 2 }, to: { row: 4, column: 4 },
    })).toThrow('不是当前可用的 swap 目标');

    board.plants.push({
      id: 12, type: 0, name: 'peashooter', row: 2, column: 3,
      condition: 'intact', sleeping: false, squished: false, layers: ['main'],
    });
    board.special!.targets.push(target('zen_water', 'plant', { id: 12, row: 2, column: 3 }));
    expect(() => resolveSemanticSpecialAction(board, {
      action: 'zen_water', target: { kind: 'plant', name: 'peashooter' },
    })).toThrowError(PvzSemanticError);
    expect(() => resolveSemanticSpecialAction(board, {
      action: 'zen_water', target: { kind: 'plant', name: 'peashooter' },
    })).toThrow('目标有歧义');
  });

  it('binds all_visible to the current whackable cohort in stable nearest-house order', () => {
    const board = specialBoard();
    board.zombies.push(
      {
        id: 21, type: 0, name: 'zombie', row: 4, column: 2, columnPosition: 2, xBand: 'near', speedCellsPerSecond: 0.0,
        condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
        slowed: false, immobilized: false,
      },
      {
        id: 22, type: 0, name: 'zombie', row: 1, column: 2, columnPosition: 2, xBand: 'near', speedCellsPerSecond: 0.0,
        condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
        slowed: false, immobilized: false,
      },
      {
        id: 24, type: 0, name: 'zombie', row: 1, column: 2, columnPosition: 2, xBand: 'near', speedCellsPerSecond: 0.0,
        condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
        slowed: false, immobilized: false,
      },
      {
        id: 23, type: 0, name: 'zombie', row: 2, column: 5, columnPosition: 5, xBand: 'near', speedCellsPerSecond: 0.0,
        condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
        slowed: false, immobilized: false,
      },
      {
        id: 99, type: 0, name: 'zombie', row: 2, column: 1, columnPosition: 1, xBand: 'near', speedCellsPerSecond: 0.0,
        condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
        slowed: false, immobilized: false,
      },
    );
    board.special!.targets.push(
      target('whack', 'zombie', { id: 21, row: 4, column: 2 }),
      target('whack', 'zombie', { id: 22, row: 1, column: 2 }),
      target('whack', 'zombie', { id: 24, row: 1, column: 2 }),
      target('whack', 'zombie', { id: 23, row: 2, column: 5 }),
    );

    const bound = resolveSemanticSpecialAction(board, {
      action: 'whack', targets: [{ kind: 'zombie', scope: 'all_visible' }],
    });
    expect(bound).toEqual({
      kind: 'special', action: 'whack', targetIds: [22, 24, 21, 20, 23],
    });
  });

  it('caps all_visible at the nearest 32 admission targets', () => {
    const board = specialBoard();
    board.zombies = [];
    board.special!.targets = board.special!.targets.filter((candidate) =>
      candidate.action !== 'whack');
    for (let index = 0; index < 33; index++) {
      const id = 100 + index;
      const row = index % 6 + 1;
      const column = index === 32 ? 9 : Math.floor(index / 6) + 1;
      board.zombies.push({
        id, type: 0, name: 'zombie', row, column, columnPosition: column,
        xBand: 'near', speedCellsPerSecond: 0,
        condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
        slowed: false, immobilized: false,
      });
      board.special!.targets.push(target('whack', 'zombie', { id, row, column }));
    }

    const capped = resolveSemanticSpecialAction(board, {
      action: 'whack', targets: [{ kind: 'zombie', scope: 'all_visible' }],
    });
    expect(capped.kind === 'special' ? capped.targetIds : null).toHaveLength(32);
    expect(capped.kind === 'special' ? capped.targetIds : []).not.toContain(132);
  });

  it('never infers an entity hidden outside the supplied lists', () => {
    const board = specialBoard();
    board.disclosure = { entitiesVisible: false, phase: 'dark' };
    board.zombies = [];
    expect(() => resolveSemanticSpecialAction(board, {
      action: 'whack', target: { kind: 'zombie', at: { row: 3, column: 4 } },
    })).toThrow('不在当前可见实体列表');
  });

  it('describes targets without internal ids or slots', () => {
    const board = specialBoard();
    const whack = board.special!.targets.find((candidate) => candidate.action === 'whack')!;
    const card = board.special!.targets.find((candidate) =>
      candidate.action === 'place_zombie' && candidate.kind === 'card')!;
    const cell = board.special!.targets.find((candidate) =>
      candidate.action === 'place_zombie' && candidate.kind === 'cell')!;

    expect(describeSemanticTarget(snapshot({ screen: 'board', board }), whack))
      .toBe('锤击·普通僵尸在第3排第4列');
    expect(describeSemanticTarget(board, card)).toBe('放置僵尸·普通僵尸');
    expect(describeSemanticTarget(board, cell)).toBe('放置僵尸·普通僵尸在第3排第8列');
    expect(resolveSemanticSpecialAction(board, {
      action: 'whack', target: { kind: 'zombie', name: '普通僵尸', at: { row: 3, column: 4 } },
    })).toMatchObject({ kind: 'special', targetId: 20 });
    const rendered = [whack, card, cell].map((value) => describeSemanticTarget(board, value)).join(' ');
    expect(rendered).not.toMatch(/targetId|slot|\b20\b/);
  });
});
