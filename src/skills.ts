import {
  PLANT_NAMES,
  cellText,
  plantDisplayName,
  plantTypeOf,
  rowText,
  specialActionNameOf,
} from './names.ts';

export const PVZ_QUEUE_MODES = ['replace', 'append', 'now'] as const;

export type PvzQueueMode = typeof PVZ_QUEUE_MODES[number];

export type PvzPlantWhen = 'now' | 'ready' | 'ready_and_affordable';

export type PvzPlantName = typeof PLANT_NAMES[number];

export interface PvzCellSelector {
  row: number;
  column: number;
}

export type PvzSeedSelector = PvzPlantName | { plant: 'imitater'; imitates: PvzPlantName };

export type PvzPlantColumn = number | { aheadOf: 'nearest_hostile'; minGap: number }
  | { emptyPot: 'nearest_house' };
export type PvzPlantRow = number | { bossProjectile: 'iceball' | 'fireball' };

export interface PvzSpecialEntityTargetSelector {
  kind: 'plant' | 'zombie' | 'grid_item' | 'collectible';
  name?: string;
  at?: PvzCellSelector;
}

export interface PvzWhackAllVisibleTargetSelector {
  kind: 'zombie';
  scope: 'all_visible';
}

export type PvzSpecialTargetSelector =
  | PvzSpecialEntityTargetSelector
  | PvzWhackAllVisibleTargetSelector;

export type PvzDoStep =
  | { skill: 'menu'; action: string }
  | { skill: 'profile_create'; name: string }
  | {
      skill: 'choose_seeds';
      seeds: PvzSeedSelector[];
      mode: 'replace' | 'toggle';
      confirm: boolean;
    }
  | {
      skill: 'plant';
      plant: PvzSeedSelector;
      row: PvzPlantRow;
      column: PvzPlantColumn;
      when: PvzPlantWhen;
    }
  | { skill: 'shovel'; row: number; column: number }
  | {
      skill: 'collect';
      what: 'coins' | 'resources' | 'award' | 'usable_seed';
      until: 'once' | 'visible_clear';
      plant?: PvzPlantName;
    }
  /** World 自排的收阳光工作。解析器不认这个 skill，只有 worlds-pvz 自己能产出它。 */
  | { skill: 'auto_sun' }
  | {
      skill: 'special';
      action: string;
      at?: PvzCellSelector;
      to?: PvzCellSelector;
      card?: string;
      target?: PvzSpecialTargetSelector;
      targets?: PvzSpecialTargetSelector[];
    }
  | { skill: 'interact'; target: string }
  | { skill: 'visual_click'; x: number; y: number };

export type PvzDoParseResult = { steps: PvzDoStep[] } | { error: string };

export function parsePvzQueueMode(raw: unknown): { mode: PvzQueueMode } | { error: string } {
  if (raw === undefined || raw === null) return { mode: 'replace' };
  if (typeof raw !== 'string' || !(PVZ_QUEUE_MODES as readonly string[]).includes(raw)) {
    return { error: `queue 只认 ${PVZ_QUEUE_MODES.join('/')}(不写 = replace)` };
  }
  return { mode: raw as PvzQueueMode };
}

export function parsePvzDo(raw: unknown): PvzDoParseResult {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'steps 必须是非空数组' };
  const steps: PvzDoStep[] = [];
  for (let index = 0; index < raw.length; index++) {
    const parsed = parseStep(raw[index], index + 1);
    if ('error' in parsed) return parsed;
    steps.push(parsed.step);
  }
  return { steps };
}

export function describePvzStep(step: PvzDoStep): string {
  return describeAction(step);
}

export function describePvzPlantPosition(row: PvzPlantRow, column: PvzPlantColumn): string {
  const lane = typeof row === 'number' ? rowText(row) : `当前可见${row.bossProjectile === 'iceball' ? '冰球' : '火球'}所在排`;
  if (typeof column === 'number') return `${lane}第${column}列`;
  if ('emptyPot' in column) return `${lane}最靠近房子的可见空花盆`;
  return column.minGap === 0
    ? `${lane}最近敌对僵尸脚下那格起第一个能下的格`
    : `${lane}最近敌对僵尸脚下往屋方向第${column.minGap}格起第一个能下的格`;
}

function describeAction(step: PvzDoStep): string {
  switch (step.skill) {
    case 'menu': return `菜单操作 ${step.action}`;
    case 'profile_create': return `创建档案「${step.name}」`;
    case 'choose_seeds': return `选卡 ${step.seeds.map(pvzSeedSelectorDisplayName).join('、')}${step.confirm ? '并确认' : ''}`;
    case 'plant': return `把 ${pvzSeedSelectorDisplayName(step.plant)} 种在${describePvzPlantPosition(step.row, step.column)}`;
    case 'shovel': return `铲除${cellText(step.row, step.column)}`;
    case 'collect': return `收集${collectName(step.what)}${step.plant ? `（${pvzSeedSelectorDisplayName(step.plant)}）` : ''}${step.until === 'visible_clear' ? '直到当前可见目标清空' : '一次'}`;
    case 'auto_sun': return '自动收取场上阳光';
    case 'special': {
      if (step.action === 'whack' && step.targets) {
        return `锤击当前可见僵尸 ${step.targets.map(specialTargetName).join('、')}`;
      }
      const at = step.at ? ` ${cellText(step.at.row, step.at.column)}` : '';
      const to = step.to ? ` → ${cellText(step.to.row, step.to.column)}` : '';
      return `特殊操作 ${step.action}${step.card ? `(${step.card})` : ''}${at}${to}`;
    }
    case 'interact': return `交互 ${step.target}`;
    case 'visual_click': return `兼容点击 (${step.x},${step.y})`;
  }
}

function parseStep(raw: unknown, index: number): { step: PvzDoStep } | { error: string } {
  const value = object(raw);
  if (!value) return { error: `第 ${index} 步必须是对象` };
  // 条件与有效期不是一步的属性:它们是独立的触发器,打响时才把步骤交给队列。
  if ('startWhen' in value || 'expiresInMs' in value) {
    return { error: `第 ${index} 步不收 startWhen/expiresInMs：条件触发用 pvz_arm({when, steps}) 单独武装` };
  }
  return parseAction(value, index);
}

function parseAction(raw: unknown, index: number): { step: PvzDoStep } | { error: string } {
  const value = object(raw);
  if (!value) return { error: `第 ${index} 步必须是对象` };
  const skill = value.skill;
  if (typeof skill !== 'string') return { error: `第 ${index} 步缺少 skill` };

  switch (skill) {
    case 'menu': {
      const invalid = keys(value, ['skill', 'action']);
      if (invalid) return badField(index, invalid);
      const action = semanticText(value.action);
      return action ? { step: { skill, action } } : { error: `第 ${index} 步 action 必须是语义名称` };
    }
    case 'profile_create': {
      const invalid = keys(value, ['skill', 'name']);
      if (invalid) return badField(index, invalid);
      if (typeof value.name !== 'string') {
        return { error: `第 ${index} 步 name 必须是 1–12 个 UTF-16 code units` };
      }
      const name = value.name.trim();
      if (name.length === 0 || name.length > 12) {
        return { error: `第 ${index} 步 name 必须是 1–12 个 UTF-16 code units` };
      }
      if (/[\u0000-\u001f\u007f]/.test(name)) {
        return { error: `第 ${index} 步 name 不能包含控制字符` };
      }
      return { step: { skill, name } };
    }
    case 'choose_seeds': return parseChooseSeeds(value, index);
    case 'plant': return parsePlant(value, index);
    case 'shovel': {
      const invalid = keys(value, ['skill', 'row', 'column']);
      if (invalid) return badField(index, invalid);
      const cell = parseCellFields(value.row, value.column);
      return cell ? { step: { skill, ...cell } } : { error: `第 ${index} 步 row/column 不在棋盘范围内` };
    }
    case 'collect': return parseCollect(value, index);
    case 'special': return parseSpecial(value, index);
    case 'interact': {
      const invalid = keys(value, ['skill', 'target']);
      if (invalid) return badField(index, invalid);
      const target = semanticText(value.target);
      return target ? { step: { skill, target } } : { error: `第 ${index} 步 target 必须是语义名称` };
    }
    case 'visual_click': {
      const invalid = keys(value, ['skill', 'x', 'y']);
      if (invalid) return badField(index, invalid);
      if (!integer(value.x, 0, 799) || !integer(value.y, 0, 599)) {
        return { error: `第 ${index} 步 x/y 必须位于 800×600 逻辑画面内` };
      }
      return { step: { skill, x: value.x, y: value.y } };
    }
    default:
      return { error: `第 ${index} 步不认识 skill:${skill}` };
  }
}

function parseChooseSeeds(value: Record<string, unknown>, index: number): { step: PvzDoStep } | { error: string } {
  const invalid = keys(value, ['skill', 'seeds', 'mode', 'confirm']);
  if (invalid) return badField(index, invalid);
  if (!Array.isArray(value.seeds) || value.seeds.length === 0 || value.seeds.length > 10) {
    return { error: `第 ${index} 步 seeds 必须是 1–10 个语义植物名` };
  }
  const seeds: PvzSeedSelector[] = [];
  const seen = new Set<string>();
  let hasImitater = false;
  for (const raw of value.seeds) {
    let seed: PvzSeedSelector;
    if (typeof raw === 'number' || typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
      return { error: `第 ${index} 步 seeds 禁止数字植物名，必须写当前可选卡片的名称` };
    }
    if (typeof raw === 'string') {
      const plant = plantName(raw);
      if (!plant) return { error: `第 ${index} 步 seeds 无法识别植物名 ${JSON.stringify(raw)}；请使用当前可选卡片列出的名称` };
      if (plant === 'imitater') {
        return { error: `第 ${index} 步 imitater 必须同时指定 imitates` };
      }
      seed = plant;
    } else {
      const imitater = object(raw);
      const plant = imitater ? plantName(imitater.plant) : null;
      const imitates = imitater ? plantName(imitater.imitates) : null;
      if (!imitater || keys(imitater, ['plant', 'imitates'])
        || plant !== 'imitater' || !imitates || imitates === 'imitater') {
        return { error: `第 ${index} 步模仿者必须写 {plant:"imitater",imitates:<canonical name>}` };
      }
      if (hasImitater) return { error: `第 ${index} 步 seeds 只能选择一张 imitater` };
      hasImitater = true;
      seed = { plant: 'imitater', imitates };
    }
    const key = seedName(seed);
    if (seen.has(key)) return { error: `第 ${index} 步 seeds 不能重复:${key}` };
    seen.add(key);
    seeds.push(seed);
  }
  const mode = value.mode ?? 'replace';
  if (mode !== 'replace' && mode !== 'toggle') return { error: `第 ${index} 步 mode 只认 replace/toggle` };
  if (value.confirm !== undefined && typeof value.confirm !== 'boolean') {
    return { error: `第 ${index} 步 confirm 必须是 boolean` };
  }
  return { step: { skill: 'choose_seeds', seeds, mode, confirm: value.confirm ?? false } };
}

function parsePlant(value: Record<string, unknown>, index: number): { step: PvzDoStep } | { error: string } {
  const invalid = keys(value, ['skill', 'plant', 'row', 'column', 'when']);
  if (invalid) return badField(index, invalid);
  let plant: PvzSeedSelector | null;
  if (typeof value.plant === 'string') {
    plant = plantName(value.plant);
    if (plant === 'imitater') plant = null;
  } else {
    const imitater = object(value.plant);
    const kind = imitater ? plantName(imitater.plant) : null;
    const imitates = imitater ? plantName(imitater.imitates) : null;
    plant = imitater && !keys(imitater, ['plant', 'imitates'])
      && kind === 'imitater' && imitates && imitates !== 'imitater'
      ? { plant: 'imitater', imitates }
      : null;
  }
  if (!plant) {
    return {
      error: `第 ${index} 步 plant 必须是 canonical name 或 {plant:"imitater",imitates:<canonical name>}，禁止 id/slot`,
    };
  }
  let row: PvzPlantRow;
  const rowSelector = object(value.row);
  if (integer(value.row, 1, 6)) row = value.row;
  else if (rowSelector && !keys(rowSelector, ['bossProjectile'])
    && (rowSelector.bossProjectile === 'iceball' || rowSelector.bossProjectile === 'fireball')) {
    row = { bossProjectile: rowSelector.bossProjectile };
  } else return { error: `第 ${index} 步 row 必须是 1–6 或 {bossProjectile:"iceball"/"fireball"}` };
  let column: PvzPlantColumn;
  if (integer(value.column, 1, 9)) column = value.column;
  else {
    const relative = object(value.column);
    if (relative && !keys(relative, ['emptyPot']) && relative.emptyPot === 'nearest_house') {
      column = { emptyPot: 'nearest_house' };
    } else if (relative && !keys(relative, ['aheadOf', 'minGap'])
      && relative.aheadOf === 'nearest_hostile' && integer(relative.minGap, 0, 8)) {
      column = { aheadOf: 'nearest_hostile', minGap: relative.minGap };
    } else {
      return { error: `第 ${index} 步 column 必须是 1–9、{aheadOf:"nearest_hostile",minGap:0–8} 或 {emptyPot:"nearest_house"}` };
    }
  }
  const when = value.when ?? 'now';
  if (!['now', 'ready', 'ready_and_affordable'].includes(String(when))) {
    return { error: `第 ${index} 步 when 只认 now/ready/ready_and_affordable` };
  }
  return { step: { skill: 'plant', plant, row, column, when: when as PvzPlantWhen } };
}

function parseCollect(value: Record<string, unknown>, index: number): { step: PvzDoStep } | { error: string } {
  const invalid = keys(value, ['skill', 'what', 'until', 'plant']);
  if (invalid) return badField(index, invalid);
  const allowedWhat = ['coins', 'resources', 'award', 'usable_seed'] as const;
  const what = value.what;
  if (what === 'sun') {
    return { error: `第 ${index} 步不收 what:"sun"：阳光由 World 自动收取，不占你的步骤和队列` };
  }
  if (typeof what !== 'string' || !(allowedWhat as readonly string[]).includes(what)) {
    return { error: `第 ${index} 步 what 只认 ${allowedWhat.join('/')};禁止 collectible ids` };
  }
  const until = value.until ?? 'once';
  if (until !== 'once' && until !== 'visible_clear') {
    return { error: `第 ${index} 步 until 只认 once/visible_clear` };
  }
  if (what === 'usable_seed' && until === 'visible_clear') {
    return { error: `第 ${index} 步 usable_seed 只允许 until=once；捡起后必须先放置或取消` };
  }
  const plant = value.plant === undefined ? undefined : plantName(value.plant);
  if (value.plant !== undefined && (what !== 'usable_seed' || !plant)) {
    return { error: `第 ${index} 步 plant 只用于 usable_seed，必须是植物名称` };
  }
  return {
    step: {
      skill: 'collect',
      what: what as Extract<PvzDoStep, { skill: 'collect' }>['what'],
      until,
      ...(plant ? { plant } : {}),
    },
  };
}

function parseSpecial(value: Record<string, unknown>, index: number): { step: PvzDoStep } | { error: string } {
  const invalid = keys(value, ['skill', 'action', 'at', 'to', 'card', 'target', 'targets']);
  if (invalid) return badField(index, invalid);
  const actionText = semanticText(value.action);
  if (!actionText) return { error: `第 ${index} 步 action 必须是语义名称` };
  const action = specialActionNameOf(actionText);
  const at = value.at === undefined ? undefined : parseCell(value.at);
  const to = value.to === undefined ? undefined : parseCell(value.to);
  if (value.at !== undefined && !at) return { error: `第 ${index} 步 at 必须是 {row,column}` };
  if (value.to !== undefined && !to) return { error: `第 ${index} 步 to 必须是 {row,column}` };
  const card = value.card === undefined ? undefined : semanticText(value.card);
  if (value.card !== undefined && !card) {
    return { error: `第 ${index} 步 card 禁止 slot/数字，必须写当前快照中的语义卡名或 card key` };
  }
  const target = value.target === undefined ? undefined : parseSpecialTarget(value.target);
  if (value.target !== undefined && !target) {
    return { error: `第 ${index} 步 target 必须是 {kind,name?,at?}，禁止 targetId` };
  }
  let targets: PvzSpecialTargetSelector[] | undefined;
  if (value.targets !== undefined) {
    if (!Array.isArray(value.targets) || value.targets.length === 0 || value.targets.length > 32) {
      return { error: `第 ${index} 步 targets 必须是 1–32 个语义目标` };
    }
    const parsedTargets = value.targets.map(parseSpecialTarget);
    if (parsedTargets.some((candidate) => candidate === null)) {
      return { error: `第 ${index} 步 targets 每项必须是 {kind,name?,at?}，禁止 targetId` };
    }
    targets = parsedTargets as PvzSpecialTargetSelector[];
  }
  if (action === 'whack') {
    if (at || to || card) {
      return { error: `第 ${index} 步 whack 只接受语义 target 或 targets` };
    }
    if (target && targets) {
      return { error: `第 ${index} 步 whack 的 target/targets 只能写一个` };
    }
    targets = targets ?? (target ? [target] : undefined);
    if (!targets) {
      return { error: `第 ${index} 步 whack 需要当前可见僵尸的语义 target 或非空 targets` };
    }
    if (targets.some((candidate) => candidate.kind !== 'zombie')) {
      return { error: `第 ${index} 步 whack 的 targets 只接受 zombie` };
    }
    const allVisibleSelectors = targets.filter(isWhackAllVisibleTargetSelector);
    if (allVisibleSelectors.length > 0
      && (allVisibleSelectors.length !== 1 || targets.length !== 1)) {
      return { error: `第 ${index} 步 whack 的 all_visible 必须是唯一目标，不能混用瞬时格子目标` };
    }
    const identities = targets.map(specialTargetIdentity);
    if (new Set(identities).size !== identities.length) {
      return { error: `第 ${index} 步 whack 的 targets 含重复语义目标` };
    }
  } else if (targets) {
    return { error: `第 ${index} 步 targets 只用于 whack；其他特殊动作使用单个 target` };
  } else if (target && isWhackAllVisibleTargetSelector(target)) {
    return { error: `第 ${index} 步 whack 批次目标只用于 whack` };
  }
  return {
    step: {
      skill: 'special', action,
      ...(at ? { at } : {}),
      ...(to ? { to } : {}),
      ...(card ? { card } : {}),
      ...(action === 'whack' ? { targets: targets! } : target ? { target } : {}),
    },
  };
}

function parseSpecialTarget(raw: unknown): PvzSpecialTargetSelector | null {
  const value = object(raw);
  if (!value) return null;
  if (!keys(value, ['kind', 'scope'])
    && value.kind === 'zombie'
    && value.scope === 'all_visible') {
    return { kind: 'zombie', scope: 'all_visible' };
  }
  if (keys(value, ['kind', 'name', 'at'])) return null;
  if (!['plant', 'zombie', 'grid_item', 'collectible'].includes(String(value.kind))) return null;
  const name = value.name === undefined ? undefined : semanticText(value.name);
  const at = value.at === undefined ? undefined : parseCell(value.at);
  if ((value.name !== undefined && !name) || (value.at !== undefined && !at)) return null;
  if (!name && !at) return null;
  return {
    kind: value.kind as PvzSpecialTargetSelector['kind'],
    ...(name ? { name } : {}),
    ...(at ? { at } : {}),
  };
}

function parseCell(raw: unknown): PvzCellSelector | null {
  const value = object(raw);
  if (!value || keys(value, ['row', 'column'])) return null;
  return parseCellFields(value.row, value.column);
}

function parseCellFields(row: unknown, column: unknown): PvzCellSelector | null {
  return integer(row, 1, 6) && integer(column, 1, 9) ? { row, column } : null;
}

function specialTargetIdentity(target: PvzSpecialTargetSelector): string {
  if (isWhackAllVisibleTargetSelector(target)) return 'zombie|scope:all_visible';
  return [
    target.kind,
    target.name?.toLowerCase() ?? '',
    target.at?.row ?? '',
    target.at?.column ?? '',
  ].join('|');
}

function specialTargetName(target: PvzSpecialTargetSelector): string {
  if (isWhackAllVisibleTargetSelector(target)) return '当前全部可锤击僵尸';
  const name = target.name ? ` ${target.name}` : '';
  const at = target.at ? ` ${cellText(target.at.row, target.at.column)}` : '';
  return `${target.kind}${name}${at}`;
}

function isWhackAllVisibleTargetSelector(
  target: PvzSpecialTargetSelector,
): target is PvzWhackAllVisibleTargetSelector {
  return 'scope' in target;
}

export function pvzSeedSelectorName(seed: PvzSeedSelector): string {
  return typeof seed === 'string' ? seed : `imitater(${seed.imitates})`;
}

export function pvzSeedSelectorDisplayName(seed: PvzSeedSelector | string): string {
  const name = typeof seed === 'string' ? seed : seed.imitates;
  const type = plantTypeOf(name);
  const display = type === null ? name : plantDisplayName(type);
  return typeof seed === 'string' ? display : `模仿者(${display})`;
}

const seedName = pvzSeedSelectorName;

function collectName(what: Extract<PvzDoStep, { skill: 'collect' }>['what']): string {
  return ({ coins: '金币', resources: '资源', award: '奖励', usable_seed: '可用种子包' })[what];
}

function plantName(raw: unknown): PvzPlantName | null {
  if (typeof raw !== 'string') return null;
  if (/^\d+$/.test(raw.trim())) return null;
  const type = plantTypeOf(raw);
  return type === null ? null : PLANT_NAMES[type]!;
}

function semanticText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 128 || /^\d+$/.test(value)) return null;
  return value;
}

function integer(raw: unknown, min: number, max: number): raw is number {
  return Number.isInteger(raw) && Number(raw) >= min && Number(raw) <= max;
}

function object(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  return Object.keys(value).find((key) => !allowed.includes(key)) ?? null;
}

function badField(index: number, field: string): { error: string } {
  const opaque = ['id', 'ids', 'slot', 'targetId'].includes(field)
    ? '；pvz_do 禁止裸 id/slot，改用语义 plant/what/at/to/card/target/targets'
    : '';
  return { error: `第 ${index} 步不收字段 ${field}${opaque}` };
}
