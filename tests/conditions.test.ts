import { describe, expect, it } from 'vitest';
import {
  PVZ_CONDITION_DEFS,
  PVZ_CONDITION_SCHEMA,
  describePvzCondition,
  evaluatePvzCondition,
  parsePvzCondition,
  type PvzCondition,
} from '../src/conditions.ts';
import { PLANT_NAMES } from '../src/names.ts';
import type { PvzBoardState, PvzCard, PvzPlant, PvzZombie } from '../src/protocol.ts';
import { boardState, snapshot } from './helpers.ts';

function parse(raw: unknown): PvzCondition {
  const result = parsePvzCondition(raw);
  if ('error' in result) throw new Error(result.error);
  return result.condition;
}

function card(overrides: Partial<PvzCard> = {}): PvzCard {
  return {
    slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
    ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0,
    cooldownRemainingSeconds: 0, x: 100, y: 40, ...overrides,
  };
}

function plant(overrides: Partial<PvzPlant> = {}): PvzPlant {
  return {
    id: 1, type: 0, name: 'peashooter', row: 2, column: 3, phase: 'active',
    condition: 'intact', sleeping: false, squished: false, layers: ['main'], ...overrides,
  };
}

function zombie(overrides: Partial<PvzZombie> = {}): PvzZombie {
  return {
    id: 1, type: 0, name: 'zombie', row: 2, column: 7, columnPosition: 6.7,
    xBand: 'far', speedCellsPerSecond: 0.2, phase: 'walking', condition: 'intact',
    armor: 'none', shield: 'none', hypnotized: false, slowed: false, immobilized: false,
    ...overrides,
  };
}

function fogBoard(): PvzBoardState {
  const board = boardState({ fog: { active: true, visibilityRule: 'rendered_fog' } });
  board.cells = board.cells.map((cell) => cell.column >= 6
    ? { ...cell, playable: null, blocker: 'fog_hidden', base: 'unknown' }
    : cell);
  return board;
}

function evaluate(condition: PvzCondition, board = boardState()): boolean | null {
  return evaluatePvzCondition(condition, snapshot({ screen: 'board', board }));
}

describe('PvZ condition parsing', () => {
  it('canonicalizes plant names throughout nested composition without retaining input objects', () => {
    const raw = { all: [
      { card: { plant: ' WALL-NUT ', ready: false } },
      { any: [
        { card: { plant: { plant: '模仿者', imitates: '樱桃炸弹' }, affordable: true } },
        { not: { sun: { max: 0 } } },
      ] },
    ] };
    const before = structuredClone(raw);
    const condition = parse(raw);
    expect(condition).toEqual({ all: [
      { card: { plant: 'wall_nut', ready: false } },
      { any: [
        { card: { plant: { plant: 'imitater', imitates: 'cherry_bomb' }, affordable: true } },
        { not: { sun: { max: 0 } } },
      ] },
    ] });
    expect(raw).toEqual(before);
    raw.all.length = 0;
    expect('all' in condition && condition.all.length).toBe(2);
  });

  it('copies a multi-row list instead of retaining the caller array', () => {
    const rows = [2, 3, 4];
    const condition = parse({ zombie: { row: rows, minCount: 2 } });
    rows.push(5);
    expect(condition).toEqual({ zombie: { row: [2, 3, 4], minCount: 2 } });
  });

  it('accepts every ordinary canonical plant and explicit imitater target from names.ts', () => {
    for (const name of PLANT_NAMES.filter((name) => name !== 'imitater')) {
      const ordinary = parse({ card: { plant: name, ready: true } });
      const imitated = parse({ card: { plant: { plant: 'imitater', imitates: name }, affordable: true } });
      const board = boardState({ cards: [card({ type: PLANT_NAMES.indexOf(name), name })] });
      expect(evaluate(ordinary, board)).toBe(true);
      expect(evaluate(imitated, board)).toBe(false);
    }
  });

  it.each([
    { sun: { min: 0 } }, { sun: { max: 0 } }, { sun: { min: 0.5, max: 100.25 } },
    { sun: { min: 150, max: 150 } },
    { card: { plant: 'sunflower', affordable: false } },
    { cell: { row: 6, column: 9, layer: 'pumpkin', empty: false } },
    { zombie: { row: 6 } }, { zombie: { row: 1, minColumn: -2, maxColumn: 11 } },
    { zombie: { row: 2, minColumn: 6.65, maxColumn: 6.7 } },
    { zombie: { row: [3] } }, { zombie: { row: [6, 1, 4], minCount: 1 } },
    { zombie: { row: [1, 2, 3, 4, 5, 6], minColumn: 4, maxColumn: 7, minCount: 50 } },
    { all: [{ sun: { min: 0 } }] }, { any: [{ sun: { max: 0 } }] },
  ])('accepts predicate and inclusive numeric boundaries: %j', (raw) => {
    expect(parsePvzCondition(raw)).toEqual({ condition: raw });
  });

  it.each([
    null, undefined, false, 3, 'sun >= 50', [], {},
    { sun: { min: 1 }, zombie: { row: 1 } }, { expression: 'globalThis.process.exit()' },
    { all: [] }, { any: [] }, { all: {} }, { any: 'sun' }, { not: null },
    { not: { any: [] } }, { all: [{ sun: { min: 0 } }, { unknown: {} }] },
    { sun: null }, { sun: [] }, { sun: {} }, { sun: { min: '50' } },
    { sun: { min: -1 } }, { sun: { min: NaN } }, { sun: { max: Infinity } },
    { sun: { min: 2, max: 1 } }, { sun: { min: 0, extra: true } },
    { sun: { min: undefined, max: 5 } },
    { card: {} }, { card: { plant: 'peashooter' } },
    { card: { plant: 'peashooter', ready: 1 } },
    { card: { plant: 'peashooter', ready: true, affordable: null } },
    { card: { plant: 'peashooter', ready: undefined, affordable: true } },
    { card: { plant: 'peashooter', ready: true, slot: 0 } },
    { card: { plant: 'unknown_plant', ready: true } },
    { card: { plant: 0, ready: true } }, { card: { plant: '0', ready: true } },
    { card: { plant: 'imitater', ready: true } },
    { card: { plant: { plant: 'peashooter' }, ready: true } },
    { card: { plant: { plant: 'imitater' }, ready: true } },
    { card: { plant: { plant: 'imitater', imitates: 'imitater' }, ready: true } },
    { card: { plant: { plant: 'imitater', imitates: '0' }, ready: true } },
    { card: { plant: { plant: 'imitater', imitates: 'peashooter', id: 0 }, ready: true } },
    { cell: { row: 0, column: 1, layer: 'main', empty: true } },
    { cell: { row: 7, column: 1, layer: 'main', empty: true } },
    { cell: { row: 1.5, column: 1, layer: 'main', empty: true } },
    { cell: { row: 1, column: 0, layer: 'main', empty: true } },
    { cell: { row: 1, column: 10, layer: 'main', empty: true } },
    { cell: { row: 1, column: 1.5, layer: 'main', empty: true } },
    { cell: { row: 1, column: 1, layer: 'lily_pad', empty: true } },
    { cell: { row: 1, column: 1, empty: true } },
    { cell: { row: 1, column: 1, layer: 'main' } },
    { cell: { row: 1, column: 1, layer: 'main', empty: 'true' } },
    { cell: { row: 1, column: 1, layer: 'main', empty: true, plant: 'peashooter' } },
    { zombie: {} }, { zombie: { row: 0 } }, { zombie: { row: 7 } },
    { zombie: { row: 1.5 } }, { zombie: { row: '1' } },
    { zombie: { row: 1, minColumn: -2.1 } }, { zombie: { row: 1, maxColumn: 11.1 } },
    { zombie: { row: 1, minColumn: -Infinity } }, { zombie: { row: 1, maxColumn: NaN } },
    { zombie: { row: 1, minColumn: 5, maxColumn: 4.9 } },
    { zombie: { row: 1, maxColumn: undefined } }, { zombie: { row: 1, count: 2 } },
    { zombie: { row: [] } }, { zombie: { row: [2, 2] } }, { zombie: { row: [0] } },
    { zombie: { row: [1, 7] } }, { zombie: { row: [1.5] } }, { zombie: { row: ['1'] } },
    { zombie: { row: [1, 2, 3, 4, 5, 6, 1] } }, { zombie: { row: [[1]] } },
    { zombie: { row: 1, minCount: 0 } }, { zombie: { row: 1, minCount: 1.5 } },
    { zombie: { row: 1, minCount: 51 } }, { zombie: { row: 1, minCount: '2' } },
    { zombie: { row: 1, minCount: undefined } },
  ])('rejects malformed external conditions: %j', (raw) => {
    expect(parsePvzCondition(raw)).toEqual({ error: expect.any(String) });
  });

  it('accepts eight levels and rejects the ninth, including cyclic external objects', () => {
    let condition: PvzCondition = { sun: { min: 0 } };
    for (let depth = 1; depth < 8; depth++) condition = { not: condition };
    expect(parsePvzCondition(condition)).toEqual({ condition });
    expect(parsePvzCondition({ not: condition })).toEqual({ error: expect.stringContaining('8') });
    const cycle: { not?: unknown } = {};
    cycle.not = cycle;
    expect(parsePvzCondition(cycle)).toEqual({ error: expect.stringContaining('8') });
  });

  it('counts the whole tree and each repeated occurrence toward the 64-node limit', () => {
    const leaf: PvzCondition = { sun: { min: 0 } };
    const branch = { any: Array.from({ length: 30 }, () => leaf) };
    const condition = { all: [branch, branch, leaf] };
    expect(parsePvzCondition(condition)).toEqual({ condition });
    expect(parsePvzCondition({ all: [branch, branch, leaf, leaf] }))
      .toEqual({ error: expect.stringContaining('64') });
    expect(parsePvzCondition({ any: Array.from({ length: 64 }, () => leaf) }))
      .toEqual({ error: expect.stringContaining('64') });
  });
});

describe('PvZ condition evaluation', () => {
  it('freely composes card, sun, fractional enemy position, and layer occupancy on fresh snapshots', () => {
    const condition = parse({ all: [
      { card: { plant: 'peashooter', ready: true, affordable: true } },
      { sun: { min: 100, max: 200 } },
      { any: [{ zombie: { row: 2, maxColumn: 6.7 } }, { zombie: { row: 3 } }] },
      { not: { cell: { row: 2, column: 3, layer: 'main', empty: false } } },
    ] });
    const board = boardState({ cards: [card()], zombies: [zombie()] });
    const before = structuredClone(board);
    expect(evaluate(condition, board)).toBe(true);
    expect(board).toEqual(before);
    expect(evaluate(condition, { ...board, sun: 99 })).toBe(false);
    expect(evaluate(condition, { ...board, cards: [card({ ready: false })] })).toBe(false);
    expect(evaluate(condition, { ...board, zombies: [zombie({ columnPosition: 6.8 })] })).toBe(false);
    expect(evaluate(condition, { ...board, plants: [plant()] })).toBe(false);
    expect(evaluate(condition, { ...board, plants: [plant({ type: 16, name: 'lily_pad' })] })).toBe(true);
  });

  it('uses inclusive sun limits including zero', () => {
    const exact: PvzCondition = { sun: { min: 100, max: 100 } };
    expect(evaluate(exact, boardState({ sun: 100 }))).toBe(true);
    expect(evaluate(exact, boardState({ sun: 99 }))).toBe(false);
    expect(evaluate(exact, boardState({ sun: 101 }))).toBe(false);
    expect(evaluate({ sun: { max: 0 } }, boardState({ sun: 0 }))).toBe(true);
    expect(evaluate({ sun: { min: 100.5 } }, boardState({ sun: 100 }))).toBe(false);
  });

  it('tests observed flags on the same packet and keeps imitater selection distinct', () => {
    const condition: PvzCondition = { card: { plant: 'peashooter', ready: true, affordable: true } };
    const board = boardState({ cards: [
      card({ ready: true, affordable: false }),
      card({ slot: 1, ready: false, affordable: true }),
      card({ slot: 2, type: 48, name: 'imitater', imitates: 0 }),
    ] });
    expect(evaluate(condition, board)).toBe(false);
    expect(evaluate({ card: { plant: 'peashooter', ready: false, affordable: true } }, board)).toBe(true);
    expect(evaluate({ card: { plant: { plant: 'imitater', imitates: 'peashooter' }, ready: true } }, board)).toBe(true);
    expect(evaluate({ card: { plant: { plant: 'imitater', imitates: 'sunflower' }, ready: true } }, board)).toBe(false);
    board.cards.push(card({ slot: 3, cost: null }));
    board.sun = 0;
    expect(evaluate(condition, board)).toBe(true);
    expect(evaluate({ card: { plant: 'sunflower', ready: false } }, board)).toBe(false);
  });

  it.each([
    [0, 'main'], [16, 'base'], [33, 'base'], [30, 'pumpkin'], [35, 'main'],
  ] as const)('classifies plant type %i as %s regardless of layer annotations', (type, layer) => {
    const board = boardState({ plants: [plant({ type, layers: ['main', 'pumpkin'] })] });
    for (const queried of ['main', 'base', 'pumpkin'] as const) {
      expect(evaluate({ cell: { row: 2, column: 3, layer: queried, empty: false } }, board))
        .toBe(queried === layer);
      expect(evaluate({ cell: { row: 2, column: 3, layer: queried, empty: true } }, board))
        .toBe(queried !== layer);
    }
  });

  it('ignores squished plants while sleeping plants still occupy their own layer', () => {
    const board = boardState({ plants: [
      plant({ id: 2, squished: true }),
      plant({ id: 3, row: 1 }), plant({ id: 4, column: 4 }),
    ] });
    const condition: PvzCondition = { cell: { row: 2, column: 3, layer: 'main', empty: true } };
    expect(evaluate(condition, board)).toBe(true);
    board.plants.push(plant({ id: 5, sleeping: true }));
    expect(evaluate(condition, board)).toBe(false);
  });

  it('checks plant occupancy independently of placement blockers', () => {
    const board = boardState({ gridItems: [{ id: 1, kind: 'gravestone', row: 2, column: 3 }] });
    board.cells = board.cells.map((cell) => cell.row === 2 && cell.column === 3
      ? { ...cell, playable: false, blocker: 'gravestone' } : cell);
    expect(evaluate({ cell: { row: 2, column: 3, layer: 'main', empty: true } }, board)).toBe(true);
  });

  it('compares inclusive fractional zombie positions instead of integer columns', () => {
    const board = boardState({ zombies: [zombie({ column: 7, columnPosition: 6.7 })] });
    expect(evaluate({ zombie: { row: 2, minColumn: 6.7, maxColumn: 6.7 } }, board)).toBe(true);
    expect(evaluate({ zombie: { row: 2, maxColumn: 6.65 } }, board)).toBe(false);
    expect(evaluate({ zombie: { row: 2, minColumn: 6.75 } }, board)).toBe(false);
    expect(evaluate({ zombie: { row: 1 } }, board)).toBe(false);
    expect(evaluate({ zombie: { row: 2 } }, board)).toBe(true);
  });

  it('reaches minCount only on the matches inside the interval, ignoring the excluded ones', () => {
    const board = boardState({ zombies: [
      zombie({ id: 1, columnPosition: 4.0 }), zombie({ id: 2, columnPosition: 5.0 }),
      zombie({ id: 3, columnPosition: 6.0 }), zombie({ id: 4, columnPosition: 8.5 }),
      zombie({ id: 5, columnPosition: 5.5, hypnotized: true }),
      zombie({ id: 6, columnPosition: 5.5, phase: 'dying' }),
      zombie({ id: 7, row: 3, columnPosition: 5.5 }),
    ] });
    const band = { row: 2, minColumn: 3.5, maxColumn: 6.5 };
    expect(evaluate({ zombie: { ...band, minCount: 3 } }, board)).toBe(true);
    expect(evaluate({ zombie: { ...band, minCount: 4 } }, board)).toBe(false);
    expect(evaluate({ zombie: { row: 2, minCount: 4 } }, board)).toBe(true);
    expect(evaluate({ zombie: { ...band, minCount: 1 } }, board))
      .toBe(evaluate({ zombie: band }, board));
  });

  it('sums matches across the listed rows instead of testing each row on its own', () => {
    const board = boardState({ zombies: [
      zombie({ id: 1, row: 2, columnPosition: 5 }), zombie({ id: 2, row: 2, columnPosition: 6 }),
      zombie({ id: 3, row: 3, columnPosition: 5 }), zombie({ id: 4, row: 4, columnPosition: 6 }),
      zombie({ id: 5, row: 5, columnPosition: 5 }),
    ] });
    const rows = [2, 3, 4];
    expect(evaluate({ zombie: { row: rows, minCount: 4 } }, board)).toBe(true);
    expect(evaluate({ zombie: { row: rows, minCount: 5 } }, board)).toBe(false);
    expect(evaluate({ any: rows.map((row) => ({ zombie: { row, minCount: 4 } })) }, board))
      .toBe(false);
    expect(evaluate({ zombie: { row: [2, 3], minColumn: 5.5, minCount: 2 } }, board)).toBe(false);
    expect(evaluate({ zombie: { row: [2, 5], minCount: 3 } }, board)).toBe(true);
  });

  it('keeps an unreached count unknown wherever the interval hides part of a listed row', () => {
    const board = fogBoard();
    board.zombies = [zombie({ id: 1, row: 2, columnPosition: 3 }),
      zombie({ id: 2, row: 3, columnPosition: 4 })];
    const hidden = { row: [2, 3], minColumn: 3, maxColumn: 7 };
    expect(evaluate({ zombie: { ...hidden, minCount: 2 } }, board)).toBe(true);
    expect(evaluate({ zombie: { ...hidden, minCount: 3 } }, board)).toBeNull();
    expect(evaluate({ zombie: { row: [2, 3], minColumn: 1, maxColumn: 5, minCount: 3 } }, board))
      .toBe(false);
    expect(evaluate({ zombie: { row: [2, 6], minCount: 1 } }, board)).toBeNull();
    const invisighoul = boardState({
      fog: { active: true, visibilityRule: 'invisighoul' },
      zombies: [zombie({ id: 1 }), zombie({ id: 2 })],
    });
    expect(evaluate({ zombie: { row: 2, minCount: 1 } }, invisighoul)).toBeNull();
  });

  it('excludes disclosed dying, burned, mowed, and hypnotized zombies', () => {
    const board = boardState({ zombies: [
      ...['dying', 'burned', 'mowed'].map((phase, id) => zombie({ id, phase })),
      zombie({ id: 5, hypnotized: true }),
    ] });
    expect(evaluate({ zombie: { row: 2 } }, board)).toBe(false);
    board.zombies.push(zombie({ id: 6, slowed: true, immobilized: true, condition: 'critical' }));
    expect(evaluate({ zombie: { row: 2 } }, board)).toBe(true);
  });

  it.each(['pole_vaulting', 'digger_retreating', 'snorkel_submerged', 'bungee_rising'])(
    'counts a disclosed living enemy in the emitted %s phase', (phase) => {
      expect(evaluate({ zombie: { row: 2 } }, boardState({ zombies: [zombie({ phase })] })))
        .toBe(true);
    },
  );

  it('includes disclosed positions outside the lawn and validates against actual board dimensions', () => {
    expect(evaluate({ zombie: { row: 2, maxColumn: 0 } }, boardState({
      zombies: [zombie({ column: 0, columnPosition: -1.2 })],
    }))).toBe(true);
    const board = boardState({ rows: 4, columns: 6 });
    for (const raw of [
      { cell: { row: 5, column: 1, layer: 'main', empty: true } },
      { cell: { row: 1, column: 7, layer: 'base', empty: true } },
      { zombie: { row: 5 } }, { zombie: { row: 1, maxColumn: 8.1 } },
      { zombie: { row: 1, minColumn: 8.1 } },
    ]) {
      const condition = parse(raw);
      expect(evaluate(condition, board)).toBeNull();
      expect(evaluate({ not: condition }, board)).toBeNull();
    }
    expect(evaluate({ zombie: { row: 4, maxColumn: 8 } }, board)).toBe(false);
    expect(evaluate({ cell: { row: 4, column: 6, layer: 'main', empty: true } }, board)).toBe(true);
    expect(evaluate({ cell: { row: 6, column: 9, layer: 'main', empty: true } }, boardState({ rows: 6 }))).toBe(true);
  });

  it('returns unknown without an active, unpaused board for every primitive and its negation', () => {
    const conditions: PvzCondition[] = [
      { sun: { min: 0 } }, { card: { plant: 'peashooter', ready: true } },
      { cell: { row: 1, column: 1, layer: 'main', empty: true } }, { zombie: { row: 1 } },
    ];
    for (const state of [
      null, snapshot(), snapshot({ screen: 'board' }),
      snapshot({ screen: 'dialog', board: boardState() }),
      snapshot({ screen: 'board', board: boardState({ paused: true }) }),
    ]) {
      for (const condition of conditions) {
        expect(evaluatePvzCondition(condition, state)).toBeNull();
        expect(evaluatePvzCondition({ not: condition }, state)).toBeNull();
      }
    }
  });

  it('preserves unknown occupancy in fog, darkness, missing cells, and unavailable terrain', () => {
    const condition: PvzCondition = { cell: { row: 2, column: 6, layer: 'main', empty: true } };
    const fog = fogBoard();
    const dark = boardState({ disclosure: { entitiesVisible: false, phase: 'dark' } });
    dark.cells = dark.cells.map((cell) => ({ ...cell, playable: false, blocker: 'dark_hidden', base: 'unknown' }));
    const missing = boardState();
    missing.cells = missing.cells.filter((cell) => cell.row !== 2 || cell.column !== 6);
    const unavailable = boardState();
    unavailable.cells = unavailable.cells.map((cell) => cell.row === 2 && cell.column === 6
      ? { ...cell, terrain: 'unavailable', playable: false } : cell);
    for (const board of [fog, dark, missing, unavailable]) {
      expect(evaluate(condition, board)).toBeNull();
      expect(evaluate({ not: condition }, board)).toBeNull();
      expect(evaluate({ cell: { ...condition.cell, empty: false } }, board)).toBeNull();
    }
    expect(evaluate({ sun: { min: 150 } }, dark)).toBe(true);
    expect(evaluate({ card: { plant: 'peashooter', ready: true } }, { ...dark, cards: [card()] })).toBe(true);
    expect(evaluate({ zombie: { row: 2 } }, dark)).toBeNull();
  });

  it('keeps absent enemies unknown across a partially hidden interval but accepts visible matches', () => {
    const board = fogBoard();
    const condition: PvzCondition = { zombie: { row: 2, minColumn: 3, maxColumn: 7 } };
    expect(evaluate(condition, board)).toBeNull();
    expect(evaluate({ not: condition }, board)).toBeNull();
    expect(evaluate({ zombie: { row: 2, minColumn: 2, maxColumn: 5 } }, board)).toBe(false);
    expect(evaluate({ zombie: { row: 2, minColumn: 5.6, maxColumn: 5.9 } }, board)).toBeNull();
    expect(evaluate({ zombie: { row: 2, maxColumn: 0 } }, board)).toBeNull();
    board.zombies = [zombie({ column: 4, columnPosition: 4.2 })];
    expect(evaluate(condition, board)).toBe(true);
    expect(evaluate({ not: condition }, board)).toBe(false);
    expect(evaluate({ zombie: { row: 2 } }, board)).toBe(true);
    board.zombies = [zombie({ phase: 'dying', column: 4, columnPosition: 4.2 })];
    expect(evaluate(condition, board)).toBeNull();
  });

  it('cannot establish enemy absence in Invisighoul even when cells are disclosed', () => {
    const board = boardState({ fog: { active: true, visibilityRule: 'invisighoul' } });
    const condition: PvzCondition = { zombie: { row: 1, minColumn: 2, maxColumn: 3 } };
    expect(evaluate(condition, board)).toBeNull();
    expect(evaluate({ not: condition }, board)).toBeNull();
    expect(evaluate({ cell: { row: 1, column: 2, layer: 'main', empty: true } }, board)).toBe(true);
  });

  it('implements the full three-valued truth tables in both operand orders', () => {
    const board = fogBoard();
    const operands: Array<{ condition: PvzCondition; value: boolean | null }> = [
      { condition: { sun: { min: 0 } }, value: true },
      { condition: { sun: { max: 0 } }, value: false },
      { condition: { cell: { row: 2, column: 6, layer: 'main', empty: true } }, value: null },
    ];
    for (const left of operands) {
      expect(evaluate({ not: left.condition }, board)).toBe(left.value === null ? null : !left.value);
      for (const right of operands) {
        const values = [left.value, right.value];
        const children = [left.condition, right.condition];
        expect(evaluate({ all: children }, board))
          .toBe(values.includes(false) ? false : values.includes(null) ? null : true);
        expect(evaluate({ any: children }, board))
          .toBe(values.includes(true) ? true : values.includes(null) ? null : false);
        expect(evaluate({ not: { all: children } }, board))
          .toBe(evaluate({ any: children.map((not) => ({ not })) }, board));
      }
    }
  });

  it('evaluates trusted compositions without imposing external parser limits', () => {
    let condition: PvzCondition = { sun: { min: 0 } };
    for (let index = 0; index < 10; index++) condition = { not: condition };
    expect(evaluate(condition)).toBe(true);
    expect(evaluate({ all: Array.from({ length: 65 }, () => condition) })).toBe(true);
  });
});

describe('PvZ condition descriptions and schema', () => {
  it('describes every supplied bound, card flag, layer, and nested operator', () => {
    const condition = parse({ all: [
      { sun: { min: 0, max: 150 } },
      { card: { plant: { plant: 'imitater', imitates: 'peashooter' }, ready: false, affordable: true } },
      { any: [
        { cell: { row: 2, column: 3, layer: 'base', empty: false } },
        { not: { zombie: { row: 2, minColumn: 3.2, maxColumn: 5.5 } } },
      ] },
    ] });
    const description = describePvzCondition(condition);
    for (const text of ['全部满足(', '任一满足(', '不满足(', '≥ 0', '≤ 150',
      '模仿者(豌豆射手)', '冷却未完成', '阳光足够', '底座层有植物', '≥ 3.2', '≤ 5.5']) {
      expect(description).toContain(text);
    }
    expect(describePvzCondition({ sun: { max: 0 } })).not.toContain('undefined');
    expect(describePvzCondition({ zombie: { row: 1 } })).not.toContain('undefined');
    expect(describePvzCondition({ zombie: { row: [1] } })).toBe(describePvzCondition({ zombie: { row: 1 } }));
    expect(describePvzCondition({ zombie: { row: [2, 3, 4], minColumn: 4, minCount: 3 } }))
      .toBe('第2排、第3排、第4排合计至少 3 只可见存活敌方僵尸，列位置 ≥ 4');
    expect(describePvzCondition({ card: { plant: 'sunflower', affordable: false } })).toContain('阳光不足');
    expect(describePvzCondition({ cell: { row: 1, column: 1, layer: 'pumpkin', empty: true } })).toContain('南瓜层为空');
  });

  it('serializes finite definitions with recursive references resolving from the parameters root', () => {
    const parameters = JSON.parse(JSON.stringify({
      type: 'object',
      properties: { steps: { type: 'array', items: {
        type: 'object', properties: { until: PVZ_CONDITION_SCHEMA },
      } } },
      $defs: PVZ_CONDITION_DEFS,
    }));
    const refs: string[] = [];
    function inspect(value: unknown): void {
      if (Array.isArray(value)) {
        value.forEach(inspect);
      } else if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        if (typeof object.$ref === 'string') refs.push(object.$ref);
        Object.values(object).forEach(inspect);
      }
    }
    inspect(parameters);
    expect(refs.length).toBeGreaterThan(1);
    for (const ref of refs) {
      const resolved = ref.slice(2).split('/').reduce((value, key) => value[key], parameters);
      expect(resolved).toBe(parameters.$defs.pvzCondition);
    }
    const variants = parameters.$defs.pvzCondition.oneOf;
    expect(variants.map((variant: { required: string[] }) => variant.required[0]).sort())
      .toEqual(['all', 'any', 'card', 'cell', 'not', 'sun', 'zombie']);
    for (const variant of variants) expect(variant.additionalProperties).toBe(false);
  });
});
