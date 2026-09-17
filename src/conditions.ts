import { PLANT_NAMES, cellText, plantDisplayName, plantTypeOf, rowText } from './names.ts';
import type { PvzBoardCell, PvzBoardState, PvzSnapshot } from './protocol.ts';
import type { PvzPlantName, PvzSeedSelector } from './skills.ts';

export type PvzCondition =
  | { sun: { min?: number; max?: number } }
  | { card: { plant: PvzSeedSelector; ready?: boolean; affordable?: boolean } }
  | { cell: { row: number; column: number; layer: 'main' | 'base' | 'pumpkin'; empty: boolean } }
  | { collectible: { kind: string; plant?: PvzPlantName; minCount?: number } }
  | {
      zombie: {
        /** One row, or several rows whose matches are counted together. */
        row: number | number[];
        minColumn?: number;
        maxColumn?: number;
        /** Matches needed across every listed row; omitted means one. */
        minCount?: number;
      };
    }
  | { all: PvzCondition[] }
  | { any: PvzCondition[] }
  | { not: PvzCondition };

type ParseResult = { condition: PvzCondition } | { error: string };

const MAX_DEPTH = 8;
const MAX_NODES = 64;
const MAX_ROWS = 6;
const MAX_COLUMNS = 9;
/** Threshold ceiling, set above the enemy count any lawn holds at once. */
const MAX_ZOMBIE_COUNT = 50;
const MAX_COLLECTIBLE_COUNT = 1024;
// The snapshot protocol includes positions before and beyond the lawn.
const MIN_POSITION = -2;
const MAX_POSITION = MAX_COLUMNS + 2;

/** The root counts as depth 1 and one node; only external parsing imposes size limits. */
export function parsePvzCondition(raw: unknown): ParseResult {
  let nodes = 0;
  function parse(input: unknown, depth: number, path: string): ParseResult {
    if (depth > MAX_DEPTH) return { error: `${path}: 条件深度最多 ${MAX_DEPTH} 层` };
    if (++nodes > MAX_NODES) return { error: `${path}: 条件最多 ${MAX_NODES} 个节点` };
    const value = record(input);
    if (!value || Object.keys(value).length !== 1) {
      return { error: `${path}: 条件必须是恰含一个谓词或组合字段的对象` };
    }
    const key = Object.keys(value)[0];
    const at = `${path}.${key}`;
    if (key === 'all' || key === 'any') {
      const children = value[key];
      if (!Array.isArray(children) || children.length === 0) {
        return { error: `${at}: 必须是非空条件数组` };
      }
      const conditions: PvzCondition[] = [];
      for (let index = 0; index < children.length; index++) {
        const parsed = parse(children[index], depth + 1, `${at}[${index}]`);
        if ('error' in parsed) return parsed;
        conditions.push(parsed.condition);
      }
      return { condition: key === 'all' ? { all: conditions } : { any: conditions } };
    }
    if (key === 'not') {
      const parsed = parse(value.not, depth + 1, at);
      return 'error' in parsed ? parsed : { condition: { not: parsed.condition } };
    }
    const fields = record(value[key]);
    if (!fields) return { error: `${at}: 必须是谓词对象` };
    if (key === 'sun') {
      if (!onlyKeys(fields, ['min', 'max'])
        || !optionalNumber(fields, 'min', 0, Number.MAX_VALUE)
        || !optionalNumber(fields, 'max', 0, Number.MAX_VALUE)
        || (fields.min === undefined && fields.max === undefined)
        || (typeof fields.min === 'number' && typeof fields.max === 'number'
          && fields.min > fields.max)) {
        return { error: `${at}: 需要有限非负 min/max，至少一个且 min ≤ max` };
      }
      return { condition: { sun: {
        ...(fields.min === undefined ? {} : { min: fields.min as number }),
        ...(fields.max === undefined ? {} : { max: fields.max as number }),
      } } };
    }
    if (key === 'card') {
      const plant = parsePlant(fields.plant);
      if (!onlyKeys(fields, ['plant', 'ready', 'affordable']) || !plant
        || ('ready' in fields && typeof fields.ready !== 'boolean')
        || ('affordable' in fields && typeof fields.affordable !== 'boolean')
        || (fields.ready === undefined && fields.affordable === undefined)) {
        return { error: `${at}: 需要植物名或 {plant:"imitater",imitates:植物名}，并指定 ready/affordable 布尔值` };
      }
      return { condition: { card: {
        plant,
        ...(fields.ready === undefined ? {} : { ready: fields.ready as boolean }),
        ...(fields.affordable === undefined ? {} : { affordable: fields.affordable as boolean }),
      } } };
    }
    if (key === 'cell') {
      if (!onlyKeys(fields, ['row', 'column', 'layer', 'empty'])
        || !integer(fields.row, 1, MAX_ROWS) || !integer(fields.column, 1, MAX_COLUMNS)
        || (fields.layer !== 'main' && fields.layer !== 'base' && fields.layer !== 'pumpkin')
        || typeof fields.empty !== 'boolean') {
        return { error: `${at}: 需要 row=1–6、column=1–9、layer=main/base/pumpkin、empty 布尔值` };
      }
      return { condition: { cell: {
        row: fields.row, column: fields.column, layer: fields.layer, empty: fields.empty,
      } } };
    }
    if (key === 'collectible') {
      const plant = fields.plant === undefined ? undefined : canonicalPlant(fields.plant);
      if (!onlyKeys(fields, ['kind', 'minCount', 'plant'])
        || typeof fields.kind !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(fields.kind)
        || (fields.plant !== undefined && (fields.kind !== 'usable_seed' || typeof plant !== 'string'))
        || ('minCount' in fields && !integer(fields.minCount, 1, MAX_COLLECTIBLE_COUNT))) {
        return { error: `${at}: 需要掉落物 kind，minCount=1–${MAX_COLLECTIBLE_COUNT}；plant 仅限 usable_seed 的植物名` };
      }
      return { condition: { collectible: {
        kind: fields.kind,
        ...(typeof plant === 'string' ? { plant } : {}),
        ...(fields.minCount === undefined ? {} : { minCount: fields.minCount as number }),
      } } };
    }
    if (key === 'zombie') {
      const rows = parseRows(fields.row);
      if (!onlyKeys(fields, ['row', 'minColumn', 'maxColumn', 'minCount'])
        || rows === null
        || !optionalNumber(fields, 'minColumn', MIN_POSITION, MAX_POSITION)
        || !optionalNumber(fields, 'maxColumn', MIN_POSITION, MAX_POSITION)
        || (typeof fields.minColumn === 'number' && typeof fields.maxColumn === 'number'
          && fields.minColumn > fields.maxColumn)
        || ('minCount' in fields && !integer(fields.minCount, 1, MAX_ZOMBIE_COUNT))) {
        return { error: `${at}: 需要 row=1–6 或不重复的 1–6 排数组，有限列位置 ${MIN_POSITION}–${MAX_POSITION} 且 minColumn ≤ maxColumn，minCount=1–${MAX_ZOMBIE_COUNT}` };
      }
      return { condition: { zombie: {
        row: rows,
        ...(fields.minColumn === undefined ? {} : { minColumn: fields.minColumn as number }),
        ...(fields.maxColumn === undefined ? {} : { maxColumn: fields.maxColumn as number }),
        ...(fields.minCount === undefined ? {} : { minCount: fields.minCount as number }),
      } } };
    }
    return { error: `${at}: 未知条件字段` };
  }
  return parse(raw, 1, 'condition');
}

function record(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown> : null;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Keeps the caller's single-row or multi-row shape; the array is copied, never retained. */
function parseRows(raw: unknown): number | number[] | null {
  if (integer(raw, 1, MAX_ROWS)) return raw;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ROWS) return null;
  const rows = raw.filter((row) => integer(row, 1, MAX_ROWS)) as number[];
  return rows.length === raw.length && new Set(rows).size === rows.length ? rows : null;
}

function optionalNumber(value: Record<string, unknown>, key: string, min: number, max: number): boolean {
  if (!(key in value)) return true;
  const number = value[key];
  return typeof number === 'number' && Number.isFinite(number) && number >= min && number <= max;
}

function canonicalPlant(raw: unknown): typeof PLANT_NAMES[number] | null {
  if (typeof raw !== 'string' || /^\d+$/.test(raw.trim())) return null;
  const type = plantTypeOf(raw);
  return type === null ? null : PLANT_NAMES[type];
}

function parsePlant(raw: unknown): PvzSeedSelector | null {
  if (typeof raw === 'string') {
    const name = canonicalPlant(raw);
    return name === 'imitater' ? null : name;
  }
  const value = record(raw);
  if (!value || !onlyKeys(value, ['plant', 'imitates'])
    || canonicalPlant(value.plant) !== 'imitater') return null;
  const imitates = canonicalPlant(value.imitates);
  return imitates && imitates !== 'imitater' ? { plant: 'imitater', imitates } : null;
}

/** Card predicates require one matching packet to satisfy every supplied flag. */
export function evaluatePvzCondition(
  condition: PvzCondition,
  snapshot: PvzSnapshot | null,
): boolean | null {
  if ('not' in condition) {
    const result = evaluatePvzCondition(condition.not, snapshot);
    return result === null ? null : !result;
  }
  if ('all' in condition || 'any' in condition) {
    const all = 'all' in condition;
    const children = 'all' in condition ? condition.all : condition.any;
    let unknown = false;
    for (const child of children) {
      const result = evaluatePvzCondition(child, snapshot);
      if (result === !all) return !all;
      if (result === null) unknown = true;
    }
    return unknown ? null : all;
  }
  const board = snapshot?.board;
  if (snapshot?.screen !== 'board' || !board || board.paused) return null;
  if ('sun' in condition) {
    const { min, max } = condition.sun;
    return (min === undefined || board.sun >= min) && (max === undefined || board.sun <= max);
  }
  if ('card' in condition) {
    const { plant, ready, affordable } = condition.card;
    const type = plantTypeOf(typeof plant === 'string' ? plant : plant.imitates);
    return board.cards.some((card) =>
      (typeof plant === 'string'
        ? card.imitates === null && card.type === type
        : card.imitates === type)
      && (ready === undefined || card.ready === ready)
      && (affordable === undefined || card.affordable === affordable));
  }
  if (!board.disclosure.entitiesVisible) return null;
  if ('collectible' in condition) {
    const { kind, plant, minCount = 1 } = condition.collectible;
    const count = board.collectibles.filter((item) => item.kind === kind
      && (plant === undefined || item.containedType === plantTypeOf(plant))).length;
    return count >= minCount ? true : board.fog.active ? null : false;
  }
  if ('cell' in condition) {
    const { row, column, layer, empty } = condition.cell;
    if (row < 1 || row > board.rows || column < 1 || column > board.columns) return null;
    const cell = board.cells.find((cell) => cell.row === row && cell.column === column);
    if (!disclosedCell(cell) || cell.terrain === 'unavailable') return null;
    // The implant omits dead plants; squished plants can remain disclosed.
    const occupied = board.plants.some((plant) => plant.row === row && plant.column === column
      && !plant.squished
      && (plant.type === 16 || plant.type === 33 ? 'base' : plant.type === 30 ? 'pumpkin' : 'main') === layer);
    return occupied !== empty;
  }
  return evaluateZombie(condition.zombie, board);
}

function disclosedCell(cell: PvzBoardCell | undefined): cell is PvzBoardCell {
  return cell !== undefined && cell.playable !== null && cell.base !== 'unknown'
    && cell.blocker !== 'fog_hidden' && cell.blocker !== 'dark_hidden';
}

/** Matches are summed over every listed row, so a partially hidden interval stays unknown. */
function evaluateZombie(
  condition: Extract<PvzCondition, { zombie: unknown }>['zombie'],
  board: PvzBoardState,
): boolean | null {
  const rows = rowsOf(condition);
  const min = condition.minColumn ?? MIN_POSITION;
  const max = condition.maxColumn ?? board.columns + 2;
  if (rows.some((row) => row < 1 || row > board.rows)
    || min < MIN_POSITION || max > board.columns + 2 || min > max) return null;
  if (board.fog.visibilityRule === 'invisighoul') return null;
  // These death animations can be disclosed before the implant filters the dead object.
  const count = board.zombies.filter((zombie) => rows.includes(zombie.row) && !zombie.hypnotized
    && zombie.phase !== 'dying'
    && zombie.phase !== 'burned' && zombie.phase !== 'mowed'
    && zombie.columnPosition >= min && zombie.columnPosition <= max).length;
  if (count >= (condition.minCount ?? 1)) return true;

  // Fog outside the published cell grid has no cell-level disclosure evidence.
  if (board.fog.active && (min < 0.5 || max > board.columns + 0.5)) return null;
  for (const row of rows) {
    for (let column = 1; column <= board.columns; column++) {
      if (column + 0.5 < min || column - 0.5 > max) continue;
      if (!disclosedCell(board.cells.find((cell) => cell.row === row && cell.column === column))) {
        return null;
      }
    }
  }
  return false;
}

function rowsOf(condition: Extract<PvzCondition, { zombie: unknown }>['zombie']): number[] {
  return typeof condition.row === 'number' ? [condition.row] : condition.row;
}

export function describePvzCondition(condition: PvzCondition): string {
  if ('all' in condition) return `全部满足(${condition.all.map(describePvzCondition).join('；')})`;
  if ('any' in condition) return `任一满足(${condition.any.map(describePvzCondition).join('；')})`;
  if ('not' in condition) return `不满足(${describePvzCondition(condition.not)})`;
  if ('collectible' in condition) {
    const { kind, plant, minCount = 1 } = condition.collectible;
    return `可见掉落物 ${kind}${plant ? `（${plantDisplayName(plantTypeOf(plant)!)}）` : ''} 至少 ${minCount} 个`;
  }
  if ('sun' in condition) {
    const { min, max } = condition.sun;
    return `阳光${min === undefined ? '' : ` ≥ ${min}`}${max === undefined ? '' : ` ≤ ${max}`}`;
  }
  if ('card' in condition) {
    const { plant, ready, affordable } = condition.card;
    const name = plantDisplayName(plantTypeOf(typeof plant === 'string' ? plant : plant.imitates)!);
    const flags = [
      ...(ready === undefined ? [] : [ready ? '冷却完成' : '冷却未完成']),
      ...(affordable === undefined ? [] : [affordable ? '阳光足够' : '阳光不足']),
    ];
    return `${typeof plant === 'string' ? name : `模仿者(${name})`}卡片${flags.join('且')}`;
  }
  if ('cell' in condition) {
    const { row, column, layer, empty } = condition.cell;
    const layerName = { main: '主层', base: '底座层', pumpkin: '南瓜层' }[layer];
    return `${cellText(row, column)}${layerName}${empty ? '为空' : '有植物'}`;
  }
  const { minColumn, maxColumn, minCount } = condition.zombie;
  const rows = rowsOf(condition.zombie);
  const where = rows.length === 1 ? rowText(rows[0]!) : `${rows.map(rowText).join('、')}合计`;
  const interval = `${minColumn === undefined ? '' : `，列位置 ≥ ${minColumn}`}${maxColumn === undefined ? '' : `，列位置 ≤ ${maxColumn}`}`;
  return `${where}${minCount === undefined ? '存在' : `至少 ${minCount} 只`}可见存活敌方僵尸${interval}`;
}

/** Place PVZ_CONDITION_DEFS at the pvz_do parameters root alongside properties. */
export const PVZ_CONDITION_SCHEMA = { $ref: '#/$defs/pvzCondition' } as const;

const PLANT_SCHEMA = { type: 'string', enum: PLANT_NAMES.filter((name) => name !== 'imitater') } as const;
const ROW_SCHEMA = { type: 'integer', minimum: 1, maximum: MAX_ROWS } as const;
const POSITION_SCHEMA = { type: 'number', minimum: MIN_POSITION, maximum: MAX_POSITION } as const;

export const PVZ_CONDITION_DEFS = {
  pvzCondition: {
    description: '可自由组合的可见事实条件，用 all/any/not 组合，最多 8 层、64 节点。'
      + '条件成立那一刻由 World 替你落子，中间不再隔一轮观察和思考；未知保留为未知。',
    oneOf: [
      {
        type: 'object', additionalProperties: false, required: ['sun'],
        properties: { sun: {
          type: 'object', additionalProperties: false,
          properties: { min: { type: 'number', minimum: 0 }, max: { type: 'number', minimum: 0 } },
          anyOf: [{ required: ['min'] }, { required: ['max'] }],
        } },
      },
      {
        type: 'object', additionalProperties: false, required: ['card'],
        properties: { card: {
          type: 'object', additionalProperties: false, required: ['plant'],
          description: '存在匹配卡片，同时满足指定的 ready/affordable；没有匹配卡片为 false。',
          properties: {
            plant: { oneOf: [PLANT_SCHEMA, {
              type: 'object', additionalProperties: false, required: ['plant', 'imitates'],
              properties: { plant: { type: 'string', enum: ['imitater'] }, imitates: PLANT_SCHEMA },
            }] },
            ready: { type: 'boolean' }, affordable: { type: 'boolean' },
          },
          anyOf: [{ required: ['ready'] }, { required: ['affordable'] }],
        } },
      },
      {
        type: 'object', additionalProperties: false, required: ['collectible'],
        properties: { collectible: {
          type: 'object', additionalProperties: false, required: ['kind'],
          description: '可见掉落物达到 minCount（默认1），如 usable_seed 种子包。数量不足且有浓雾时为未知。',
          properties: {
            kind: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
            plant: { type: 'string', description: '仅 usable_seed 可用：只统计指定植物名称的种子包。' },
            minCount: { type: 'integer', minimum: 1, maximum: MAX_COLLECTIBLE_COUNT },
          },
        } },
      },
      {
        type: 'object', additionalProperties: false, required: ['cell'],
        properties: { cell: {
          type: 'object', additionalProperties: false, required: ['row', 'column', 'layer', 'empty'],
          description: '主层为空仍可有荷叶或花盆，它们在 base 层。',
          properties: {
            row: ROW_SCHEMA, column: { type: 'integer', minimum: 1, maximum: MAX_COLUMNS },
            layer: { type: 'string', enum: ['main', 'base', 'pumpkin'] }, empty: { type: 'boolean' },
          },
        } },
      },
      {
        type: 'object', additionalProperties: false, required: ['zombie'],
        properties: { zombie: {
          type: 'object', additionalProperties: false, required: ['row'],
          description: '闭区间内可见存活且未被魅惑的僵尸数量达到 minCount(默认 1)。'
            + 'row 写多排时按这几排合计计数，够樱桃炸弹的 3×3 或整片一次性植物用。'
            + '列边界比的是 columnPosition，省略则覆盖整行；数量不足且区间内有隐藏格时为未知。',
          properties: {
            row: { oneOf: [ROW_SCHEMA, {
              type: 'array', minItems: 1, maxItems: MAX_ROWS, uniqueItems: true, items: ROW_SCHEMA,
            }] },
            minColumn: POSITION_SCHEMA,
            maxColumn: POSITION_SCHEMA,
            minCount: { type: 'integer', minimum: 1, maximum: MAX_ZOMBIE_COUNT },
          },
        } },
      },
      ...(['all', 'any'] as const).map((key) => ({
        type: 'object', additionalProperties: false, required: [key],
        properties: { [key]: { type: 'array', minItems: 1, items: PVZ_CONDITION_SCHEMA } },
      })),
      {
        type: 'object', additionalProperties: false, required: ['not'],
        properties: { not: PVZ_CONDITION_SCHEMA },
      },
    ],
  },
} as const;
