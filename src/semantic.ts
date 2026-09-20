import { isSunCollectible, isTerminalCollectible } from './collectibles.ts';
import type { PvzLaunchPlacementSelector } from './skills.ts';
import {
  cardDisplayNameOf,
  cellText,
  plantDisplayName,
  plantDisplayNameOf,
  plantName,
  plantTypeOf,
  specialActionDisplayName,
  specialActionNameOf,
  zombieDisplayNameOf,
} from './names.ts';
import type {
  PvzBoardState,
  PvzCard,
  PvzMenuAction,
  PvzNativeAction,
  PvzSnapshot,
  PvzSpecialTarget,
} from './protocol.ts';

export type PvzSemanticState = PvzSnapshot | PvzBoardState;

export function bossHeadVulnerable(phase: string): boolean {
  return ['boss_aiming', 'boss_spitting', 'boss_recovering'].includes(phase);
}

export function emptyFlowerPotCells(board: PvzBoardState): PvzSemanticCell[] {
  if (!board.disclosure.entitiesVisible) return [];
  return board.plants.filter(plant => plant.type === 33 && !plant.squished
    && !board.plants.some(other => other.row === plant.row && other.column === plant.column
      && other.type !== 33 && other.type !== 30 && !other.squished)
    && board.cells.some(cell => cell.row === plant.row && cell.column === plant.column
      && cell.playable === true && !['ice_trail', 'fog_hidden', 'dark_hidden'].includes(cell.blocker ?? '')))
    .map(plant => ({ row: plant.row, column: plant.column }))
    .sort((left, right) => left.row - right.row || left.column - right.column);
}

export type PvzSemanticErrorCode =
  | 'board_unavailable'
  | 'invalid_selector'
  | 'unavailable'
  | 'ambiguous'
  | 'unsupported_action';

export class PvzSemanticError extends Error {
  constructor(
    readonly code: PvzSemanticErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PvzSemanticError';
  }
}

export interface PvzSemanticCard {
  key: string;
  display: string;
  internalSlot: number;
}

export type PvzSemanticCardSelector =
  | string
  | { plant: string; imitates?: string };

/** 阳光不在其中:它由 worlds-pvz 自己收，模型的语义选择里没有这一类。 */
export type PvzCollectibleSelection =
  | 'coins'
  | 'resources'
  | 'award'
  | 'usable_seed';

export interface PvzSemanticCell {
  row: number;
  column: number;
}

export interface PvzSemanticEntityTargetSelector {
  kind: 'plant' | 'zombie' | 'grid_item' | 'collectible';
  name?: string;
  at?: PvzSemanticCell;
}

export interface PvzSemanticWhackAllVisibleSelector {
  kind: 'zombie';
  scope: 'all_visible';
}

export type PvzSemanticTargetSelector =
  | PvzSemanticEntityTargetSelector
  | PvzSemanticWhackAllVisibleSelector;

export interface PvzSemanticSpecialRequest {
  action: string;
  at?: PvzSemanticCell;
  placement?: PvzLaunchPlacementSelector;
  to?: PvzSemanticCell;
  card?: PvzSemanticCardSelector;
  target?: PvzSemanticTargetSelector;
  targets?: PvzSemanticTargetSelector[];
}

type EntityTargetKind = PvzSemanticEntityTargetSelector['kind'];

type SpecialContract =
  | { kind: 'global' }
  | { kind: 'at' }
  | { kind: 'at_to' }
  | { kind: 'card' }
  | { kind: 'card_at' }
  | { kind: 'entity'; targetKind: EntityTargetKind }
  | { kind: 'entity_to'; targetKind: EntityTargetKind };

const SPECIAL_CONTRACTS = {
  break_vase: { kind: 'entity', targetKind: 'grid_item' },
  whack: { kind: 'entity', targetKind: 'zombie' },
  cob_fire: { kind: 'entity_to', targetKind: 'plant' },
  swap: { kind: 'at_to' },
  twist: { kind: 'at' },
  launch: { kind: 'at' },
  drop_brain: { kind: 'at' },
  bowling: { kind: 'card_at' },
  place_zombie: { kind: 'card_at' },
  beghouled_buy: { kind: 'card' },
  spin: { kind: 'global' },
  start_onslaught: { kind: 'global' },
  buy_snorkel: { kind: 'global' },
  buy_trophy: { kind: 'global' },
  zen_water: { kind: 'entity', targetKind: 'plant' },
  zen_fertilize: { kind: 'entity', targetKind: 'plant' },
  zen_bug_spray: { kind: 'entity', targetKind: 'plant' },
  zen_phonograph: { kind: 'entity', targetKind: 'plant' },
  zen_chocolate: { kind: 'entity', targetKind: 'plant' },
  zen_next_garden: { kind: 'global' },
  tree_feed: { kind: 'global' },
} as const satisfies Record<string, SpecialContract>;

export type PvzSemanticSpecialAction = keyof typeof SPECIAL_CONTRACTS;

export const PVZ_SEMANTIC_SPECIAL_ACTIONS = Object.freeze(
  Object.keys(SPECIAL_CONTRACTS) as PvzSemanticSpecialAction[],
);

export function semanticMenuTarget(action: PvzMenuAction): string {
  return action.id.startsWith('mode_') ? normalizedName(action.label) : action.id;
}

export function resolveSemanticMenuAction(
  snapshot: PvzSnapshot,
  target: string,
): PvzMenuAction {
  const key = normalizedName(target);
  // Profile names are game identities; punctuation and case are significant.
  if (target.startsWith('profile:')) {
    const profile = snapshot.menu.find((action) => action.id === target);
    if (!profile) throw new PvzSemanticError('unavailable', `当前界面没有档案 ${target.slice(8)}`);
    return profile;
  }
  const matches = snapshot.menu.filter((action) =>
    !action.id.startsWith('profile:') && normalizedName(semanticMenuTarget(action)) === key);
  if (!matches.length) {
    throw new PvzSemanticError('unavailable', `当前界面没有菜单操作 ${target}`);
  }
  if (matches.length > 1) {
    throw new PvzSemanticError('ambiguous', `菜单操作 ${target} 当前有多个语义目标`);
  }
  return matches[0]!;
}

const COIN_KINDS = new Set(['silver_coin', 'gold_coin', 'diamond', 'coin']);

function boardOf(state: PvzSemanticState): PvzBoardState {
  if ('cards' in state) return state;
  if (state.board) return state.board;
  throw new PvzSemanticError('board_unavailable', '当前没有可见棋盘');
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase().replace(/[ -]+/g, '_');
}

function cardBase(card: PvzCard): { key: string; display: string } {
  if (card.imitates !== null) {
    const imitated = plantName(card.imitates);
    return {
      key: `card:imitater:${normalizedName(imitated)}`,
      display: `imitater(${imitated})`,
    };
  }
  const name = normalizedName(card.name);
  return { key: `card:${name}`, display: name };
}

export function semanticCards(state: PvzSemanticState): PvzSemanticCard[] {
  const cards = [...boardOf(state).cards].sort((left, right) => left.slot - right.slot);
  const totals = new Map<string, number>();
  for (const card of cards) {
    const base = cardBase(card).key;
    totals.set(base, (totals.get(base) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return cards.map((card) => {
    const base = cardBase(card);
    const ordinal = (seen.get(base.key) ?? 0) + 1;
    seen.set(base.key, ordinal);
    const duplicate = (totals.get(base.key) ?? 0) > 1;
    return {
      key: `${base.key}#${ordinal}`,
      display: duplicate ? `${base.display} #${ordinal}` : base.display,
      internalSlot: card.slot,
    };
  });
}

export function canonicalCardKey(state: PvzSemanticState, internalSlot: number): string {
  return semanticCardAt(state, internalSlot).key;
}

export function canonicalCardDisplay(state: PvzSemanticState, internalSlot: number): string {
  return semanticCardAt(state, internalSlot).display;
}

export function localizedCardDisplay(state: PvzSemanticState, internalSlot: number): string {
  const board = boardOf(state);
  const card = board.cards.find((candidate) => candidate.slot === internalSlot);
  if (!card) throw new PvzSemanticError('unavailable', '指定卡片当前不可见');
  const base = card.imitates === null
    ? cardDisplayNameOf(card.type, card.name)
    : `模仿者(${plantDisplayName(card.imitates)})`;
  const same = board.cards
    .filter((candidate) => candidate.type === card.type && candidate.imitates === card.imitates)
    .sort((left, right) => left.slot - right.slot);
  if (same.length === 1) return base;
  return `${base} #${same.findIndex((candidate) => candidate.slot === internalSlot) + 1}`;
}

function semanticCardAt(state: PvzSemanticState, internalSlot: number): PvzSemanticCard {
  const card = semanticCards(state).find((candidate) => candidate.internalSlot === internalSlot);
  if (!card) throw new PvzSemanticError('unavailable', '指定卡片当前不可见');
  return card;
}

export function resolveCardSlot(
  state: PvzSemanticState,
  selector: PvzSemanticCardSelector | unknown,
): number {
  const board = boardOf(state);
  const cards = semanticCards(board);
  if (typeof selector === 'string') {
    const value = normalizedName(selector);
    const canonical = cards.filter((candidate) => normalizedName(candidate.key) === value);
    if (canonical.length) return uniqueCardSlot(canonical, selector);
    const displayed = cards.filter((candidate) => normalizedName(candidate.display) === value);
    if (displayed.length) return uniqueCardSlot(displayed, selector);
    const localized = cards.filter((card) =>
      normalizedName(localizedCardDisplay(board, card.internalSlot)) === value);
    if (localized.length) return uniqueCardSlot(localized, selector);
    const matches = board.cards
      .filter((card) => card.imitates === null && normalizedName(card.name) === value)
      .map((card) => semanticCardAt(board, card.slot));
    return uniqueCardSlot(matches, selector);
  }
  const record = strictRecord(selector, 'card');
  exactKeys(record, ['plant', 'imitates'], 'card');
  const plant = requiredText(record.plant, 'card.plant');
  const plantId = normalizedName(plant);
  const plantType = plantTypeOf(plant);
  const imitaterSelected = plantId === 'imitater' || plantType === 48;
  let matches: PvzSemanticCard[];
  if (record.imitates !== undefined) {
    if (!imitaterSelected) {
      throw new PvzSemanticError('invalid_selector', '只有 imitater 卡片可以指定 imitates');
    }
    const imitatesValue = requiredText(record.imitates, 'card.imitates');
    const imitates = normalizedName(imitatesValue);
    const imitatesType = plantTypeOf(imitatesValue);
    matches = board.cards
      .filter((card) => card.imitates !== null && (
        [
          normalizedName(plantName(card.imitates)),
          normalizedName(plantDisplayName(card.imitates)),
        ].includes(imitates) || card.imitates === imitatesType
      ))
      .map((card) => semanticCardAt(board, card.slot));
  } else {
    if (imitaterSelected) {
      throw new PvzSemanticError('invalid_selector', 'imitater 卡片必须指定 imitates');
    }
    matches = board.cards
      .filter((card) => card.imitates === null
        && (normalizedName(card.name) === plantId || card.type === plantType))
      .map((card) => semanticCardAt(board, card.slot));
  }
  return uniqueCardSlot(matches, record.imitates === undefined
    ? plant
    : `imitater(${String(record.imitates)})`);
}

function uniqueCardSlot(matches: PvzSemanticCard[], selector: unknown): number {
  if (!matches.length) {
    throw new PvzSemanticError('unavailable', `当前没有可见卡片匹配 ${String(selector)}`);
  }
  if (matches.length > 1) {
    const choices = [...matches].sort((left, right) => left.internalSlot - right.internalSlot);
    throw new PvzSemanticError(
      'ambiguous',
      `卡片 ${String(selector)} 有歧义；请使用 ${choices.map((card) => `card:${JSON.stringify(card.display)}`).join(' 或 ')}`,
    );
  }
  return matches[0]!.internalSlot;
}

export function selectCollectibleIds(
  state: PvzSemanticState,
  what: PvzCollectibleSelection,
  plant?: string,
): number[] {
  const board = boardOf(state);
  if (!['coins', 'resources', 'award', 'usable_seed'].includes(what)) {
    throw new PvzSemanticError('invalid_selector', `未知 collectible 语义 ${String(what)}`);
  }
  const selected = board.collectibles.filter((item) => {
    if (isSunCollectible(item.kind)) return false;
    if (what === 'coins') return COIN_KINDS.has(item.kind);
    if (what === 'award') return isTerminalCollectible(item.kind);
    if (what === 'usable_seed') return item.kind === 'usable_seed'
      && (plant === undefined || item.containedType === plantTypeOf(plant));
    return item.kind !== 'usable_seed';
  });
  return selected
    .map((item, index) => ({ item, index }))
    .sort((left, right) =>
      Number(isTerminalCollectible(left.item.kind)) - Number(isTerminalCollectible(right.item.kind))
      || left.index - right.index)
    .map(({ item }) => item.id);
}

/** 当前可见的全部阳光。只有 World 自己的自动收取用它。 */
export function selectSunIds(state: PvzSemanticState): number[] {
  return boardOf(state).collectibles
    .filter((item) => isSunCollectible(item.kind))
    .map((item) => item.id);
}

export function resolveSemanticSpecialAction(
  state: PvzSemanticState,
  request: PvzSemanticSpecialRequest | unknown,
): PvzNativeAction {
  const board = boardOf(state);
  const input = strictRecord(request, 'special');
  const action = specialActionNameOf(requiredText(input.action, 'special.action'));
  const contract = SPECIAL_CONTRACTS[action as PvzSemanticSpecialAction] as SpecialContract | undefined;
  if (!contract) {
    throw new PvzSemanticError('unsupported_action', `特殊动作 ${action} 没有语义契约`);
  }
  if (!board.allowedSpecialActions.includes(action)) {
    throw new PvzSemanticError('unavailable', `当前关卡不允许特殊动作 ${action}`);
  }
  const targets = board.special?.targets.filter((target) => target.action === action) ?? [];
  if (!targets.length) {
    throw new PvzSemanticError('unavailable', `当前观测没有特殊动作目标 ${action}`);
  }

  if (action === 'whack' && input.targets !== undefined) {
    exactKeys(input, ['action', 'targets'], action);
    if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 32) {
      throw new PvzSemanticError('invalid_selector', 'whack.targets 必须包含 1–32 个当前可见僵尸');
    }
    const selected = input.targets.flatMap((selector) =>
      resolveWhackTargetSelector(targets, selector));
    if (!selected.length) {
      throw new PvzSemanticError('unavailable', 'whack 当前没有匹配的可见语义目标');
    }
    selected.sort(compareWhackTargets);
    return { kind: 'special', action, targetIds: selected.map((target) => target.id!) };
  }

  if (contract.kind === 'global') {
    exactKeys(input, ['action'], action);
    requireGlobalTarget(targets, action);
    return { kind: 'special', action };
  }
  if (contract.kind === 'at') {
    if (action === 'launch' && input.placement !== undefined) {
      exactKeys(input, ['action', 'placement'], action);
      const placement = strictRecord(input.placement, 'launch.placement');
      const relative = placement.aheadOf !== undefined;
      exactKeys(placement, relative ? ['row', 'aheadOf', 'minGap'] : ['row', 'edge'], 'launch.placement');
      const row = placement.row;
      if (!Number.isInteger(row) || (row as number) < 1 || (row as number) > board.rows
        || (relative
          ? placement.aheadOf !== 'nearest_hostile' || !Number.isInteger(placement.minGap)
            || (placement.minGap as number) < 0 || (placement.minGap as number) > 8
          : !['nearest_house', 'farthest_house'].includes(placement.edge as string))) {
        throw new PvzSemanticError('invalid_selector', 'launch.placement 必须是 {row,edge:"nearest_house"|"farthest_house"} 或 {row,aheadOf:"nearest_hostile",minGap:0–8}，row 在当前棋盘内');
      }
      let columns = targets.filter(target => target.kind === 'cell' && target.row === row && target.column !== null)
        .map(target => target.column!);
      if (relative) {
        const hostile = board.disclosure.entitiesVisible && board.fog.visibilityRule !== 'invisighoul'
          ? board.zombies.filter(zombie => zombie.row === row && !zombie.hypnotized
            && !['dying', 'burned', 'mowed'].includes(zombie.phase ?? ''))
            .sort((left, right) => left.columnPosition - right.columnPosition || left.id - right.id)[0]
          : undefined;
        if (!hostile) throw new PvzSemanticError('unavailable', `第${row}排当前没有可见的存活敌对僵尸`);
        const start = Math.max(1, hostile.column - (placement.minGap as number));
        columns = columns.filter(column => column <= start);
      }
      if (!columns.length) {
        throw new PvzSemanticError('unavailable', `第${row}排当前没有手持种子包的可用落点`);
      }
      const column = !relative && placement.edge === 'nearest_house' ? Math.min(...columns) : Math.max(...columns);
      return { kind: 'special', action, row: row as number, column };
    }
    exactKeys(input, ['action', 'at'], action);
    const at = parseCell(input.at, board, 'at');
    requireCellTarget(targets, at, action);
    if (action === 'twist' && (at.row >= board.rows || at.column >= board.columns)) {
      throw new PvzSemanticError('invalid_selector', 'twist 的 at 必须是完整 2×2 区域的左上格');
    }
    return { kind: 'special', action, row: at.row, column: at.column };
  }
  if (contract.kind === 'at_to') {
    exactKeys(input, ['action', 'at', 'to'], action);
    const at = parseCell(input.at, board, 'at');
    const to = parseCell(input.to, board, 'to');
    requireCellTarget(targets, at, action);
    requireCellTarget(targets, to, action);
    if (Math.abs(at.row - to.row) + Math.abs(at.column - to.column) !== 1) {
      throw new PvzSemanticError('invalid_selector', 'swap 的 at 与 to 必须正交相邻');
    }
    return {
      kind: 'special', action,
      row: at.row, column: at.column,
      toRow: to.row, toColumn: to.column,
    };
  }
  if (contract.kind === 'card') {
    exactKeys(input, ['action', 'card'], action);
    const slot = resolveCardSlot(board, input.card);
    requireCardTarget(targets, slot, action);
    return { kind: 'special', action, slot };
  }
  if (contract.kind === 'card_at') {
    exactKeys(input, ['action', 'card', 'at'], action);
    const slot = action === 'bowling'
      ? resolveInterchangeableBowlingCard(board, targets, input.card)
      : resolveCardSlot(board, input.card);
    const at = parseCell(input.at, board, 'at');
    requireCardTarget(targets, slot, action);
    requireCellTarget(targets, at, action, action === 'place_zombie' ? slot : undefined);
    if (action === 'bowling' && at.column > 3) {
      throw new PvzSemanticError('invalid_selector', 'bowling 只能投放到第 1–3 列');
    }
    return { kind: 'special', action, slot, row: at.row, column: at.column };
  }

  exactKeys(input, contract.kind === 'entity' ? ['action', 'target'] : ['action', 'target', 'to'], action);
  const target = resolveEntityTarget(board, targets, input.target, contract.targetKind, action);
  const base: PvzNativeAction = {
    kind: 'special', action, targetId: target.id!,
    ...(target.row === null ? {} : { row: target.row }),
    ...(target.column === null ? {} : { column: target.column }),
  };
  if (contract.kind === 'entity') return base;
  const to = parseCell(input.to, board, 'to');
  if (!board.cells.some((cell) => cell.row === to.row && cell.column === to.column)) {
    throw new PvzSemanticError('unavailable', `${cellLabel(to)} 不是当前可见棋盘格`);
  }
  return { ...base, toRow: to.row, toColumn: to.column };
}

function resolveWhackTargetSelector(
  targets: PvzSpecialTarget[],
  selector: unknown,
): PvzSpecialTarget[] {
  const input = strictRecord(selector, 'whack.target');
  exactKeys(input, ['kind', 'scope'], 'whack.target');
  const kind = normalizedName(requiredText(input.kind, 'whack.target.kind'));
  const scope = normalizedName(requiredText(input.scope, 'whack.target.scope'));
  if (kind !== 'zombie' || scope !== 'all_visible') {
    throw new PvzSemanticError(
      'invalid_selector',
      'whack 的选择器必须是 {kind:"zombie",scope:"all_visible"}',
    );
  }
  return targets
    .filter((target) => target.kind === 'zombie' && target.id !== null)
    .sort(compareWhackTargets)
    .slice(0, 32);
}

function compareWhackTargets(left: PvzSpecialTarget, right: PvzSpecialTarget): number {
  return (left.column ?? Number.MAX_SAFE_INTEGER) - (right.column ?? Number.MAX_SAFE_INTEGER)
    || (left.row ?? Number.MAX_SAFE_INTEGER) - (right.row ?? Number.MAX_SAFE_INTEGER)
    || (left.id ?? Number.MAX_SAFE_INTEGER) - (right.id ?? Number.MAX_SAFE_INTEGER);
}

function resolveInterchangeableBowlingCard(
  board: PvzBoardState,
  targets: PvzSpecialTarget[],
  selector: unknown,
): number {
  try {
    const exact = resolveCardSlot(board, selector);
    if (targets.some((target) => target.kind === 'card' && target.slot === exact)) return exact;
  } catch (error) {
    if (!(error instanceof PvzSemanticError)) throw error;
  }
  if (typeof selector !== 'string') return resolveCardSlot(board, selector);
  const base = normalizedName(selector
    .replace(/^card:/i, '')
    .replace(/\s*#\d+\s*$/, ''));
  const interchangeable = board.cards
    .filter((card) => card.imitates === null && normalizedName(card.name) === base)
    .filter((card) => targets.some((target) =>
      target.kind === 'card' && target.slot === card.slot))
    .sort((left, right) => left.slot - right.slot);
  if (interchangeable.length) return interchangeable[0]!.slot;
  return resolveCardSlot(board, selector);
}

function requireGlobalTarget(targets: PvzSpecialTarget[], action: string): void {
  const global = targets.filter((target) => target.kind === 'cell'
    && target.id === null && target.slot === null
    && target.row === null && target.column === null);
  if (global.length !== 1 || targets.length !== 1) {
    throw new PvzSemanticError('unavailable', `${action} 当前没有唯一的全局目标`);
  }
}

function requireCardTarget(targets: PvzSpecialTarget[], slot: number, action: string): void {
  if (!targets.some((target) => target.kind === 'card' && target.slot === slot)) {
    throw new PvzSemanticError('unavailable', `${action} 当前不接受所选卡片`);
  }
}

function requireCellTarget(
  targets: PvzSpecialTarget[],
  cell: PvzSemanticCell,
  action: string,
  slot?: number,
): void {
  if (!targets.some((target) => target.kind === 'cell'
    && target.row === cell.row && target.column === cell.column
    && (slot === undefined || target.slot === slot))) {
    throw new PvzSemanticError('unavailable', `${cellLabel(cell)} 不是当前可用的 ${action} 目标`);
  }
}

function resolveEntityTarget(
  board: PvzBoardState,
  targets: PvzSpecialTarget[],
  selector: unknown,
  expectedKind: EntityTargetKind,
  action: string,
): PvzSpecialTarget {
  const input = strictRecord(selector, 'target');
  exactKeys(input, ['kind', 'name', 'at'], 'target');
  const kind = normalizedName(requiredText(input.kind, 'target.kind'));
  if (kind !== expectedKind) {
    throw new PvzSemanticError(
      'invalid_selector',
      `${action} 的 target.kind 必须是 ${expectedKind}`,
    );
  }
  const name = input.name === undefined ? null : normalizedName(requiredText(input.name, 'target.name'));
  const at = input.at === undefined ? null : parseCell(input.at, board, 'target.at');
  const matches = targets.filter((target) => {
    if (target.kind !== expectedKind || target.id === null) return false;
    const entityName = semanticEntityName(board, target);
    const displayName = localizedSemanticEntityName(board, target);
    if (name !== null && normalizedName(entityName) !== name
      && normalizedName(displayName) !== name) return false;
    return at === null || target.row === at.row && target.column === at.column;
  });
  if (!matches.length) {
    throw new PvzSemanticError('unavailable', `${action} 当前没有匹配的可见语义目标`);
  }
  if (matches.length > 1) {
    throw new PvzSemanticError(
      'ambiguous',
      `${action} 的目标有歧义：${matches.map((target) => describeSemanticTarget(board, target)).join('；')}`,
    );
  }
  return matches[0]!;
}

function semanticEntityName(board: PvzBoardState, target: PvzSpecialTarget): string {
  if (target.id === null) {
    throw new PvzSemanticError('unavailable', '目标没有可见实体身份');
  }
  if (target.kind === 'plant') {
    const entity = board.plants.find((plant) => plant.id === target.id);
    if (entity) return entity.name;
  } else if (target.kind === 'zombie') {
    const entity = board.zombies.find((zombie) => zombie.id === target.id);
    if (entity) return entity.name;
  } else if (target.kind === 'grid_item') {
    const entity = board.gridItems.find((item) => item.id === target.id);
    if (entity) return entity.kind;
  } else if (target.kind === 'collectible') {
    const entity = board.collectibles.find((item) => item.id === target.id);
    if (entity) {
      return entity.containedName ? `${entity.kind}(${entity.containedName})` : entity.kind;
    }
  }
  throw new PvzSemanticError('unavailable', '特殊目标不在当前可见实体列表中');
}

function localizedSemanticEntityName(board: PvzBoardState, target: PvzSpecialTarget): string {
  if (target.id === null) throw new PvzSemanticError('unavailable', '目标没有可见实体身份');
  if (target.kind === 'plant') {
    const entity = board.plants.find((plant) => plant.id === target.id);
    if (entity) return plantDisplayNameOf(entity.type, entity.name);
  } else if (target.kind === 'zombie') {
    const entity = board.zombies.find((zombie) => zombie.id === target.id);
    if (entity) return zombieDisplayNameOf(entity.type, entity.name);
  } else if (target.kind === 'grid_item') {
    const entity = board.gridItems.find((item) => item.id === target.id);
    const names: Record<string, string> = {
      gravestone: '墓碑', grave: '墓碑', crater: '弹坑', ladder: '梯子', vase: '花瓶',
      i_zombie_brain: '脑子', zen_tool: '禅境工具', stinky: '蜗牛', rake: '耙子',
    };
    if (entity) return names[entity.kind] ?? '格子物件';
  } else if (target.kind === 'collectible') {
    const entity = board.collectibles.find((item) => item.id === target.id);
    const names: Record<string, string> = {
      silver_coin: '银币', gold_coin: '金币', diamond: '钻石', sun: '阳光',
      small_sun: '小阳光', large_sun: '大阳光', seed_packet: '种子包', trophy: '奖杯',
      usable_seed: '可用种子包', chocolate: '巧克力', money_bag: '钱袋', present: '礼盒',
    };
    if (entity) {
      const contained = entity.containedType === undefined || entity.containedType === null
        ? entity.containedName
        : plantDisplayNameOf(entity.containedType, entity.containedName ?? '');
      return contained ? `${names[entity.kind] ?? '收集物'}(${contained})` : names[entity.kind] ?? '收集物';
    }
  }
  throw new PvzSemanticError('unavailable', '特殊目标不在当前可见实体列表中');
}

export function describeSemanticTarget(
  state: PvzSemanticState,
  target: PvzSpecialTarget,
): string {
  const board = boardOf(state);
  const action = specialActionDisplayName(target.action);
  if (target.kind === 'card') {
    if (target.slot === null) throw new PvzSemanticError('unavailable', '卡片目标缺少可见卡片');
    return `${action}·${localizedCardDisplay(board, target.slot)}`;
  }
  if (target.kind === 'cell') {
    if (target.row === null || target.column === null) return action;
    const location = cellLabel({ row: target.row, column: target.column });
    if (target.slot === null) return `${action}在${location}`;
    return `${action}·${localizedCardDisplay(board, target.slot)}在${location}`;
  }
  const name = localizedSemanticEntityName(board, target);
  const location = target.row === null || target.column === null
    ? ''
    : `在${cellLabel({ row: target.row, column: target.column })}`;
  return `${action}·${name}${location}`;
}

export function describeSemanticTargets(
  state: PvzSemanticState,
  action?: string,
): string[] {
  const board = boardOf(state);
  const selected = action === undefined
    ? board.special?.targets ?? []
    : board.special?.targets.filter((target) => target.action === normalizedName(action)) ?? [];
  return selected.map((target) => describeSemanticTarget(board, target));
}

function parseCell(value: unknown, board: PvzBoardState, label: string): PvzSemanticCell {
  const input = strictRecord(value, label);
  exactKeys(input, ['row', 'column'], label);
  const row = Number(input.row);
  const column = Number(input.column);
  if (!Number.isInteger(row) || row < 1 || row > board.rows
    || !Number.isInteger(column) || column < 1 || column > board.columns) {
    throw new PvzSemanticError(
      'invalid_selector',
      `${label} 必须是棋盘内的整数 row/column`,
    );
  }
  return { row, column };
}

function cellLabel(cell: PvzSemanticCell): string {
  return cellText(cell.row, cell.column);
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PvzSemanticError('invalid_selector', `${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, allowed: string[], label: string): void {
  const accepted = new Set(allowed);
  const extra = Object.keys(input).filter((key) => !accepted.has(key));
  if (extra.length) {
    throw new PvzSemanticError('invalid_selector', `${label} 不接受字段 ${extra.join(', ')}`);
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PvzSemanticError('invalid_selector', `${label} 必须是非空字符串`);
  }
  return value;
}
