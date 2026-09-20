export const PVZ_NATIVE_PROTOCOL = 2;

export type PvzScreen =
  | 'loading'
  | 'main_menu'
  | 'seed_picker'
  | 'board'
  | 'defeat'
  | 'award'
  | 'credits'
  | 'mode_selector'
  | 'dialog'
  | 'unknown';

export type PvzModeKind =
  | 'adventure'
  | 'survival'
  | 'minigame'
  | 'vasebreaker'
  | 'i_zombie'
  | 'zen_garden'
  | 'tree_of_wisdom'
  | 'other';

export interface PvzProfileProgress {
  name: string;
  adventureLevel: number;
  adventureCompletions: number;
  coins: number;
  minigamesUnlocked: boolean;
  puzzleUnlocked: boolean;
  survivalUnlocked: boolean;
}

export interface PvzMenuAction {
  id: string;
  label: string;
  enabled: boolean;
  x: number;
  y: number;
  state: 'locked' | 'available' | 'completed' | 'unaffordable' | 'sold_out' | 'selected' | null;
  record: number | null;
}

export interface PvzSeedChoice {
  id: number;
  name: string;
  state: 'chooser' | 'selected' | 'moving' | 'hidden';
  bankSlot: number | null;
  imitates: number | null;
  recommended: boolean;
  fixed: boolean;
  x: number;
  y: number;
}

export interface PvzSeedPickerState {
  capacity: number;
  selected: number[];
  choices: PvzSeedChoice[];
  previewZombies: Array<{ type: number; name: string }>;
  ready: boolean;
}

export type PvzCondition = 'intact' | 'worn' | 'damaged' | 'critical';

export interface PvzPlant {
  id: number;
  type: number;
  name: string;
  row: number;
  column: number;
  /** Visible animation/behavior phase, such as arming, armed, or digesting. */
  phase?: string;
  condition: PvzCondition;
  sleeping: boolean;
  squished: boolean;
  layers: string[];
}

export type PvzZombieSpeed =
  | 'stationary'
  | 'slow'
  | 'normal'
  | 'fast'
  | 'retreating'
  | 'airborne';

export interface PvzZombie {
  id: number;
  type: number;
  name: string;
  row: number;
  column: number;
  /** Horizontal lawn position in columns, rounded to 0.1. */
  columnPosition: number;
  xBand: 'lawn' | 'near' | 'mid' | 'far';
  /** Human-observable movement category; exact internal velocity is never published. */
  speed?: PvzZombieSpeed;
  /** Visible horizontal ground speed in lawn cells per second, rounded to 0.01. */
  speedCellsPerSecond: number;
  /** Visible animation/behavior phase, without internal counters or hidden targets. */
  phase?: string;
  /** Visible chewing animation, independent of the movement phase. */
  eating?: boolean;
  condition: PvzCondition;
  armor: PvzCondition | 'none' | 'lost';
  shield: PvzCondition | 'none' | 'lost';
  hypnotized: boolean;
  slowed: boolean;
  immobilized: boolean;
}

export interface PvzGridItem {
  id: number;
  kind: string;
  row: number;
  /** A portal at the visible right boundary uses board.columns + 1. */
  column: number;
  /** Drawn vase marking; concealed contents never determine this hint. */
  visibleHint?: 'unknown' | 'plant' | 'zombie';
  /** Present only while the game draws the contents through the vase. */
  revealedContent?:
    | { kind: 'plant' | 'zombie'; type: number; name: string }
    | { kind: 'sun'; count: number };
}

export interface PvzCollectible {
  id: number;
  kind: string;
  x: number;
  y: number;
  row: number | null;
  column: number | null;
  containedType?: number;
  containedName?: string;
}

export interface PvzCard {
  slot: number;
  type: number;
  name: string;
  imitates: number | null;
  cost: number | null;
  ready: boolean;
  affordable: boolean;
  cooldown: 'ready' | 'short' | 'medium' | 'long';
  cooldownRemainingPercent: number;
  cooldownRemainingSeconds: number;
  x: number;
  y: number;
}

export interface PvzMower {
  row: number;
  kind: string;
  state: 'ready' | 'triggered' | 'squished';
}

export interface PvzBoardCell {
  row: number;
  column: number;
  terrain: 'lawn' | 'water' | 'roof' | 'unavailable';
  playable: boolean | null;
  blocker: string | null;
  base: 'none' | 'lily_pad' | 'flower_pot' | 'unknown';
}

export interface PvzSpecialTarget {
  action: string;
  kind: 'plant' | 'zombie' | 'grid_item' | 'collectible' | 'card' | 'cell';
  id: number | null;
  slot: number | null;
  row: number | null;
  column: number | null;
}

export interface PvzSpecialState {
  phase: string;
  settled: boolean;
  targets: PvzSpecialTarget[];
}

export interface PvzVisibleProgress {
  kind:
    | 'flags'
    | 'survival_stage'
    | 'score'
    | 'sun_goal'
    | 'brains'
    | 'vases'
    | 'stars'
    | 'boss'
    | 'setup'
    | 'targets'
    | 'complete'
    | 'unknown';
  current: number | null;
  target: number | null;
  stage: number | null;
  label: string;
}

export interface PvzTutorialState {
  kind: 'shovel';
  phase: 'pickup' | 'dig' | 'keep_digging';
  remainingPlants: number;
  allowedActions: ['shovel'];
}

export interface PvzBoardState {
  runId: number;
  rows: number;
  columns: number;
  level: number;
  background: number;
  paused: boolean;
  sun: number;
  cursor: { kind: string; heldType: number | null; logicalX: number; logicalY: number };
  fog: { active: boolean; visibilityRule: 'none' | 'rendered_fog' | 'invisighoul' };
  disclosure: { entitiesVisible: boolean; phase: 'visible' | 'dark' };
  cells: PvzBoardCell[];
  cards: PvzCard[];
  plants: PvzPlant[];
  zombies: PvzZombie[];
  /** The boss spans the right edge; it does not occupy an ordinary lawn cell. */
  boss?: {
    phase: string;
    immobilized: boolean;
    projectile: { kind: 'fireball' | 'iceball'; row: number; columnPosition: number } | null;
  } | null;
  gridItems: PvzGridItem[];
  collectibles: PvzCollectible[];
  mowers: PvzMower[];
  progress: PvzVisibleProgress;
  tutorial: PvzTutorialState | null;
  allowedSpecialActions: string[];
  special: PvzSpecialState | null;
}

export interface PvzDialogState {
  id: number;
  hasPrimary: boolean;
  hasSecondary: boolean;
  primaryLabel: string | null;
  secondaryLabel: string | null;
}

export interface PvzLastRunResult {
  resultId: number;
  runId: number;
  mode: number;
  level: number;
  outcome: 'won' | 'lost';
}

/**
 * 游戏窗口此刻能不能被操作,以及量出来的实况。
 *
 * `managed` = Per-Monitor V2 且 client 恰好 800×600;`onScreen` = 整个 client 落在
 * 同一块显示器的可见范围内。任一为假时植入件会拒绝截图与鼠标消息(窗口 DC 只读得到
 * 屏上的像素,屏外那部分既截不出来也点不进去),同时排一次窗口修正。这两条随每帧
 * 上报,是"动作为什么全被拒"唯一说得清的事实。
 */
export interface PvzWindowPresentation {
  managed: boolean;
  onScreen: boolean;
  minimized: boolean;
  clientWidth: number;
  clientHeight: number;
}

/** 窗口现在可操作吗:截图与鼠标消息都以这一条为前提。 */
export function windowPresentable(presentation: PvzWindowPresentation): boolean {
  return presentation.managed && presentation.onScreen;
}

/**
 * 不可操作时的一句事实。可操作就返回 null——没什么可说的。
 *
 * 只说量到了什么与它挡住了什么,不猜是谁把窗口挪走的。
 */
export function windowPresentationFault(presentation: PvzWindowPresentation): string | null {
  if (windowPresentable(presentation)) return null;
  if (presentation.minimized) {
    return '游戏窗口当前不可操作：窗口已最小化。'
      + '截图与鼠标动作在它被还原之前都会被拒；植入件不会替人还原窗口。';
  }
  const measured = `${presentation.clientWidth}×${presentation.clientHeight}`;
  const faults = [
    presentation.managed ? null : `画面区实测 ${measured}，不是 Per-Monitor V2 的 800×600`,
    presentation.onScreen ? null : '窗口没有整个落在同一块显示器里（有一部分在屏幕外）',
  ].filter((fault): fault is string => fault !== null);
  return `游戏窗口当前不可操作：${faults.join('；')}。`
    + '植入件已排了一次窗口修正；截图与鼠标动作在修好之前都会被拒。';
}

export interface PvzSnapshot {
  protocol: number;
  revision: number;
  monotonicMs: number;
  inputControl: {
    epoch: number;
    menuContext: number;
    queueDepth: number;
    activeActionId: string | null;
  };
  executable: {
    sha256: string;
    version: string;
    profile: string;
    supported: boolean;
  };
  presentation: PvzWindowPresentation;
  screen: PvzScreen;
  scene: number;
  mode: number;
  modeName: string;
  modeKind: PvzModeKind;
  profile: PvzProfileProgress | null;
  lastRun: PvzLastRunResult | null;
  menu: PvzMenuAction[];
  dialog: PvzDialogState | null;
  seedPicker: PvzSeedPickerState | null;
  board: PvzBoardState | null;
}

export type PvzNativeAction =
  | { kind: 'configure'; pollHz: number; cursorMinMs: number; cursorMaxMs: number }
  | { kind: 'menu'; target: string }
  | { kind: 'choose_seed'; seed: number; imitates?: number }
  | { kind: 'profile_create'; name: string }
  | { kind: 'ready' }
  | { kind: 'plant'; slot: number; row: number; column: number }
  | { kind: 'plant'; slot: number; row: number; aheadOf: { minGap: number } }
  | { kind: 'shovel'; row: number; column: number }
  | { kind: 'collect'; ids: number[] }
  | {
      kind: 'special';
      action: string;
      targetId?: number;
      targetIds?: number[];
      expectedLevel?: number;
      slot?: number;
      row?: number;
      column?: number;
      toRow?: number;
      toColumn?: number;
    }
  | { kind: 'interact'; target: string }
  | { kind: 'visual_click'; x: number; y: number }
  | { kind: 'cancel' }
  | { kind: 'shutdown' }
  | { kind: 'detach' }
  | { kind: 'snapshot' }
  | { kind: 'capture' };

export interface PvzCommand {
  type: 'command';
  protocol: number;
  id: string;
  action: PvzNativeAction;
  inputEpoch?: number;
  expectedRevision?: number;
  menuContext?: number;
  expectedCardType?: number;
  expectedCardImitates?: number | null;
}

export interface PvzCommandContext {
  inputEpoch?: number;
  expectedRevision?: number;
  menuContext?: number;
  expectedCardType?: number;
  expectedCardImitates?: number | null;
}

export interface PvzHello {
  type: 'hello';
  protocol: number;
  pid: number;
  architecture: 'x86';
  profile: string;
  executableSha256: string;
  executableVersion: string;
  ownerToken: string;
  supported: boolean;
  reason?: string;
}

export interface PvzNativeAck {
  type: 'ack';
  protocol: number;
  id: string;
  accepted: boolean;
  reason?: string;
}

export interface PvzNativeBatchResult {
  requested: number;
  attempted: number;
  released: number;
  verified: number;
  stale: number;
  scopeStopped: boolean;
}

export interface PvzNativeResult {
  type: 'result';
  protocol: number;
  id: string;
  revision: number;
  outcome: 'executed' | 'rejected' | 'cancelled';
  reason?: string;
  batch?: PvzNativeBatchResult;
  placement?: PvzNativePlacement;
  effect?:
    | 'profile_created'
    | 'target_changed'
    | 'collectibles_collected'
    | 'card_consumed'
    | 'usable_seed_consumed'
    | 'beghouled_purchase'
    | 'zen_care_applied'
    | 'garden_changed'
    | 'tree_fed'
    | 'shovel_applied'
    | 'bowling_launched';
}

export interface PvzNativePlacement {
  row: number;
  column: number;
  targetId: number;
  runId: number;
}

export interface PvzNativeSnapshotMessage {
  type: 'snapshot';
  protocol: number;
  snapshot: PvzSnapshot;
}

export interface PvzNativeFrame {
  type: 'frame';
  protocol: number;
  id: string;
  mime: 'image/png';
  base64: string;
  width: number;
  height: number;
}

export interface PvzNativeLog {
  type: 'log';
  protocol: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export type PvzNativeMessage =
  | PvzHello
  | PvzNativeAck
  | PvzNativeResult
  | PvzNativeSnapshotMessage
  | PvzNativeFrame
  | PvzNativeLog;

export function parseNativeMessage(line: string): PvzNativeMessage {
  const parsed = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('植入件消息必须是 JSON 对象');
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.protocol !== PVZ_NATIVE_PROTOCOL) {
    throw new Error(`植入件协议版本不匹配: ${String(raw.protocol)}`);
  }
  if (!['hello', 'ack', 'result', 'snapshot', 'frame', 'log'].includes(String(raw.type))) {
    throw new Error(`植入件消息类型无效: ${String(raw.type)}`);
  }
  if (raw.type === 'hello') {
    exactKeys(raw, ['type', 'protocol', 'pid', 'architecture', 'profile', 'executableSha256',
      'executableVersion', 'ownerToken', 'supported', 'reason'], 'hello');
    if (!positiveInteger(raw.pid) || raw.architecture !== 'x86' || !text(raw.profile, 128)
      || !sha256(raw.executableSha256) || !text(raw.executableVersion, 64)
      || !/^[0-9a-f]{32}$/.test(String(raw.ownerToken))
      || typeof raw.supported !== 'boolean'
      || !(raw.reason === undefined || text(raw.reason, 1024))) throw new Error('hello 字段无效');
  } else if (raw.type === 'ack') {
    exactKeys(raw, ['type', 'protocol', 'id', 'accepted', 'reason'], 'ack');
    if (!text(raw.id, 128) || typeof raw.accepted !== 'boolean'
      || !(raw.reason === undefined || text(raw.reason, 1024))) {
      throw new Error('ack 字段无效');
    }
  } else if (raw.type === 'result') {
    exactKeys(raw, ['type', 'protocol', 'id', 'revision', 'outcome', 'reason', 'batch', 'effect', 'placement'], 'result');
    if (!text(raw.id, 128) || !nonnegativeInteger(raw.revision)
      || !['executed', 'rejected', 'cancelled'].includes(String(raw.outcome))
      || !(raw.reason === undefined || text(raw.reason, 1024))
      || !(raw.effect === undefined
        || [
          'profile_created',
          'target_changed',
          'collectibles_collected',
          'card_consumed',
          'usable_seed_consumed',
          'beghouled_purchase',
          'zen_care_applied',
          'garden_changed',
          'tree_fed',
          'shovel_applied',
          'bowling_launched',
        ].includes(String(raw.effect)))
      || (raw.effect !== undefined && raw.outcome !== 'executed')) {
      throw new Error('result 字段无效');
    }
    if (raw.batch !== undefined) validateNativeBatchResult(raw.batch);
    if (raw.placement !== undefined) {
      const placement = raw.placement as Record<string, unknown> | null;
      if (!placement || typeof placement !== 'object' || Array.isArray(placement)) throw new Error('placement 字段无效');
      exactKeys(placement, ['row', 'column', 'targetId', 'runId'], 'placement');
      if (raw.outcome !== 'executed' || !positiveInteger(placement.row) || Number(placement.row) > 6
        || !positiveInteger(placement.column) || Number(placement.column) > 9
        || !positiveInteger(placement.targetId) || !positiveInteger(placement.runId)) throw new Error('placement 字段无效');
    }
  } else if (raw.type === 'frame') {
    exactKeys(raw, ['type', 'protocol', 'id', 'mime', 'base64', 'width', 'height'], 'frame');
    if (!text(raw.id, 128) || raw.mime !== 'image/png' || !pngBase64(raw.base64)
      || raw.width !== 800 || raw.height !== 600) throw new Error('frame 字段无效');
  } else if (raw.type === 'snapshot') {
    exactKeys(raw, ['type', 'protocol', 'snapshot'], 'snapshot message');
    const snapshot = raw.snapshot as Record<string, unknown> | null;
    if (!snapshot || snapshot.protocol !== PVZ_NATIVE_PROTOCOL || !nonnegativeInteger(snapshot.revision)
      || !nonnegativeInteger(snapshot.monotonicMs) || !SCREENS.has(String(snapshot.screen))
      || !nonnegativeInteger(snapshot.scene) || !nonnegativeInteger(snapshot.mode)
      || !text(snapshot.modeName, 128) || !MODE_KINDS.has(String(snapshot.modeKind))) {
      throw new Error('snapshot 字段无效');
    }
    exactKeys(snapshot, [
      'protocol', 'revision', 'monotonicMs', 'inputControl', 'executable', 'presentation',
      'screen', 'scene', 'mode', 'modeName', 'modeKind', 'profile', 'lastRun', 'menu', 'dialog',
      'seedPicker', 'board',
    ], 'snapshot');
    const executable = snapshot.executable as Record<string, unknown> | null;
    if (!executable || !sha256(executable.sha256) || !text(executable.version, 64)
      || !text(executable.profile, 128) || typeof executable.supported !== 'boolean') {
      throw new Error('snapshot.executable 字段无效');
    }
    exactKeys(executable, ['sha256', 'version', 'profile', 'supported'], 'snapshot.executable');
    const presentation = snapshot.presentation as Record<string, unknown> | null;
    if (!presentation || typeof presentation.managed !== 'boolean'
      || typeof presentation.onScreen !== 'boolean'
      || typeof presentation.minimized !== 'boolean'
      || !nonnegativeInteger(presentation.clientWidth)
      || !nonnegativeInteger(presentation.clientHeight)
      || (presentation.managed === true
        && (presentation.clientWidth !== 800 || presentation.clientHeight !== 600))
      || (presentation.minimized === true && presentation.onScreen === true)) {
      throw new Error('snapshot.presentation 字段无效');
    }
    exactKeys(
      presentation,
      ['managed', 'onScreen', 'minimized', 'clientWidth', 'clientHeight'],
      'snapshot.presentation',
    );
    const input = snapshot.inputControl as Record<string, unknown> | null;
    if (!input || !nonnegativeInteger(input.epoch) || !nonnegativeInteger(input.menuContext)
      || !nonnegativeInteger(input.queueDepth)
      || !(input.activeActionId === null || text(input.activeActionId, 128))) {
      throw new Error('snapshot.inputControl 字段无效');
    }
    exactKeys(input, ['epoch', 'menuContext', 'queueDepth', 'activeActionId'], 'snapshot.inputControl');
    validateMenu(snapshot.menu);
    validateProfile(snapshot.profile);
    validateLastRun(snapshot.lastRun);
    if ((snapshot.screen === 'seed_picker') !== (snapshot.seedPicker !== null)) {
      throw new Error('snapshot.seedPicker 与画面不一致');
    }
    validateSeedPicker(snapshot.seedPicker);
    if (!(snapshot.board === null || (typeof snapshot.board === 'object'
      && snapshot.board !== null && !Array.isArray(snapshot.board)))) {
      throw new Error('snapshot.board 字段无效');
    }
    const board = snapshot.board as Record<string, unknown> | null;
    if (board) {
      validateBoard(board, Number(snapshot.mode));
      if (board.tutorial !== null
        && (snapshot.screen !== 'board' || snapshot.scene !== 2
          || (snapshot.menu as unknown[]).length !== 0)) {
        throw new Error('snapshot.tutorial 只允许出现在无菜单的关卡引导画面');
      }
    }
    if (snapshot.dialog !== null) validateDialog(snapshot.dialog);
  } else {
    exactKeys(raw, ['type', 'protocol', 'level', 'message'], 'log');
    if (!['debug', 'info', 'warn', 'error'].includes(String(raw.level)) || !text(raw.message, 16_384)) {
      throw new Error('log 字段无效');
    }
  }
  return raw as unknown as PvzNativeMessage;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !accepted.has(key));
  if (unknown.length) throw new Error(`${label} 含未知字段: ${unknown.join(', ')}`);
}

function validateNativeBatchResult(raw: unknown): asserts raw is PvzNativeBatchResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('result.batch 字段无效');
  }
  const batch = raw as Record<string, unknown>;
  exactKeys(
    batch,
    ['requested', 'attempted', 'released', 'verified', 'stale', 'scopeStopped'],
    'result.batch',
  );
  if (!positiveInteger(batch.requested)
    || !nonnegativeInteger(batch.attempted)
    || !nonnegativeInteger(batch.released)
    || !nonnegativeInteger(batch.verified)
    || !nonnegativeInteger(batch.stale)
    || typeof batch.scopeStopped !== 'boolean'
    || Number(batch.attempted) > Number(batch.requested)
    || Number(batch.released) > Number(batch.attempted)
    || Number(batch.verified) > Number(batch.released)
    || Number(batch.attempted) + Number(batch.stale) > Number(batch.requested)) {
    throw new Error('result.batch 字段无效');
  }
}

function integer(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function nonnegativeInteger(value: unknown): boolean {
  return integer(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): boolean {
  return integer(value) && Number(value) > 0;
}

function finite(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function oneDecimal(value: unknown): boolean {
  return finite(value) && Math.abs(Number(value) * 10 - Math.round(Number(value) * 10)) < 1e-9;
}

function twoDecimals(value: unknown): boolean {
  return finite(value) && Math.abs(Number(value) * 100 - Math.round(Number(value) * 100)) < 1e-9;
}

function text(value: unknown, maximum: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function sha256(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function pngBase64(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 8 * 1024 * 1024
    && /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value);
}

const SCREENS = new Set<string>([
  'loading', 'main_menu', 'seed_picker', 'board', 'defeat', 'award', 'credits',
  'mode_selector', 'dialog', 'unknown',
]);
const MODE_KINDS = new Set<string>([
  'adventure', 'survival', 'minigame', 'vasebreaker', 'i_zombie',
  'zen_garden', 'tree_of_wisdom', 'other',
]);
const CONDITIONS = new Set<PvzCondition>(['intact', 'worn', 'damaged', 'critical']);
const PROGRESS_KINDS = new Set<PvzVisibleProgress['kind']>([
  'flags', 'survival_stage', 'score', 'sun_goal', 'brains', 'vases',
  'stars', 'boss', 'setup', 'targets', 'complete', 'unknown',
]);

function validateMenu(value: unknown): void {
  if (!Array.isArray(value) || value.length > 128) throw new Error('snapshot.menu 字段无效');
  const ids = new Set<string>();
  for (const entry of value) {
    const item = entry as Record<string, unknown>;
    if (!item || !text(item.id, 128) || !text(item.label, 256) || typeof item.enabled !== 'boolean'
      || ids.has(String(item.id)) || !finite(item.x) || !finite(item.y)
      || !(item.state === null || [
        'locked', 'available', 'completed', 'unaffordable', 'sold_out', 'selected',
      ].includes(String(item.state)))
      || !nullableNonnegativeInteger(item.record)) {
      throw new Error('snapshot.menu item 字段无效');
    }
    exactKeys(item, ['id', 'label', 'enabled', 'x', 'y', 'state', 'record'], 'snapshot.menu item');
    ids.add(String(item.id));
  }
}

function validateProfile(value: unknown): void {
  if (value === null) return;
  const profile = value as Record<string, unknown>;
  if (!profile || !text(profile.name, 12) || !nonnegativeInteger(profile.adventureLevel)
    || !nonnegativeInteger(profile.adventureCompletions) || !nonnegativeInteger(profile.coins)
    || typeof profile.minigamesUnlocked !== 'boolean' || typeof profile.puzzleUnlocked !== 'boolean'
    || typeof profile.survivalUnlocked !== 'boolean') throw new Error('snapshot.profile 字段无效');
  exactKeys(profile, [
    'name', 'adventureLevel', 'adventureCompletions', 'coins', 'minigamesUnlocked',
    'puzzleUnlocked', 'survivalUnlocked',
  ], 'snapshot.profile');
}

function validateLastRun(value: unknown): void {
  if (value === null) return;
  const result = value as Record<string, unknown>;
  const mode = Number(result?.mode);
  const level = Number(result?.level);
  const levelMatchesMode = mode === 0
    ? positiveInteger(result.level) && level <= 50
    : mode >= 1 && mode <= 70 && level === 0;
  if (!result || !positiveInteger(result.resultId) || !positiveInteger(result.runId)
    || !nonnegativeInteger(result.mode) || mode > 70
    || !nonnegativeInteger(result.level) || !levelMatchesMode
    || !['won', 'lost'].includes(String(result.outcome))) {
    throw new Error('snapshot.lastRun 字段无效');
  }
  exactKeys(result, ['resultId', 'runId', 'mode', 'level', 'outcome'], 'snapshot.lastRun');
}

function validateDialog(value: unknown): void {
  const dialog = value as Record<string, unknown>;
  if (!dialog || !nonnegativeInteger(dialog.id) || typeof dialog.hasPrimary !== 'boolean'
    || typeof dialog.hasSecondary !== 'boolean'
    || !(dialog.primaryLabel === null || text(dialog.primaryLabel, 256))
    || !(dialog.secondaryLabel === null || text(dialog.secondaryLabel, 256))) {
    throw new Error('snapshot.dialog 字段无效');
  }
  exactKeys(dialog, [
    'id', 'hasPrimary', 'hasSecondary', 'primaryLabel', 'secondaryLabel',
  ], 'snapshot.dialog');
}

function validateSeedPicker(value: unknown): void {
  if (value === null) return;
  const picker = value as Record<string, unknown>;
  if (!picker || !positiveInteger(picker.capacity) || Number(picker.capacity) > 10
    || !Array.isArray(picker.selected)
    || picker.selected.length > 10 || !picker.selected.every(nonnegativeInteger)
    || !Array.isArray(picker.choices) || picker.choices.length > 64
    || !Array.isArray(picker.previewZombies) || picker.previewZombies.length > 64
    || typeof picker.ready !== 'boolean') throw new Error('snapshot.seedPicker 字段无效');
  if (new Set(picker.selected as number[]).size !== picker.selected.length
    || picker.selected.length > Number(picker.capacity)) {
    throw new Error('snapshot.seedPicker selected 字段无效');
  }
  exactKeys(picker, ['capacity', 'selected', 'choices', 'previewZombies', 'ready'], 'snapshot.seedPicker');
  const choiceIds = new Set<number>();
  for (const entry of picker.choices) {
    const choice = entry as Record<string, unknown>;
    if (!choice || !nonnegativeInteger(choice.id) || !text(choice.name, 128)
      || choiceIds.has(Number(choice.id))
      || !['chooser', 'selected', 'moving', 'hidden'].includes(String(choice.state))
      || !(choice.bankSlot === null || (nonnegativeInteger(choice.bankSlot)
        && Number(choice.bankSlot) < Number(picker.capacity) && Number(choice.bankSlot) <= 9))
      || !(choice.imitates === null || nonnegativeInteger(choice.imitates))
      || typeof choice.recommended !== 'boolean' || typeof choice.fixed !== 'boolean'
      || !finite(choice.x) || !finite(choice.y)) {
      throw new Error('snapshot.seedPicker choice 字段无效');
    }
    exactKeys(choice, [
      'id', 'name', 'state', 'bankSlot', 'imitates', 'recommended', 'fixed', 'x', 'y',
    ], 'snapshot.seedPicker choice');
    choiceIds.add(Number(choice.id));
  }
  for (const entry of picker.previewZombies) {
    const zombie = entry as Record<string, unknown>;
    if (!zombie || !nonnegativeInteger(zombie.type) || !text(zombie.name, 128)) {
      throw new Error('snapshot.seedPicker previewZombies 字段无效');
    }
    exactKeys(zombie, ['type', 'name'], 'snapshot.seedPicker previewZombies');
  }
}

function validateBoard(board: Record<string, unknown>, mode: number): void {
  exactKeys(board, [
    'runId', 'rows', 'columns', 'level', 'background', 'paused', 'sun', 'cursor', 'fog',
    'disclosure', 'cells', 'cards', 'plants', 'zombies', 'gridItems', 'collectibles',
    'mowers', 'progress', 'tutorial', 'allowedSpecialActions', 'special', 'boss',
  ], 'snapshot.board');
  if (!nonnegativeInteger(board.runId)
    || !positiveInteger(board.rows) || Number(board.rows) > 6
    || !positiveInteger(board.columns) || Number(board.columns) > 9
    || !nonnegativeInteger(board.level) || !nonnegativeInteger(board.background)
    || typeof board.paused !== 'boolean' || !nonnegativeInteger(board.sun)) {
    throw new Error('snapshot.board 字段无效');
  }
  for (const key of ['cells', 'cards', 'plants', 'zombies', 'gridItems', 'collectibles', 'mowers']) {
    const list = board[key];
    if (!Array.isArray(list) || list.length > 4096) throw new Error(`snapshot.${key} 字段无效`);
  }
  if (!Array.isArray(board.allowedSpecialActions) || board.allowedSpecialActions.length > 128
    || !board.allowedSpecialActions.every((item) => text(item, 128))) {
    throw new Error('snapshot.allowedSpecialActions 字段无效');
  }
  const cursor = board.cursor as Record<string, unknown> | null;
  if (!cursor || !text(cursor.kind, 64)
    || !(cursor.heldType === null || nonnegativeInteger(cursor.heldType))
    || !finite(cursor.logicalX) || !finite(cursor.logicalY)) {
    throw new Error('snapshot.cursor 字段无效');
  }
  exactKeys(cursor, ['kind', 'heldType', 'logicalX', 'logicalY'], 'snapshot.cursor');
  const fog = board.fog as Record<string, unknown> | null;
  if (!fog || typeof fog.active !== 'boolean'
    || !['none', 'rendered_fog', 'invisighoul'].includes(String(fog.visibilityRule))
    || fog.active !== (fog.visibilityRule !== 'none')) {
    throw new Error('snapshot.fog 字段无效');
  }
  exactKeys(fog, ['active', 'visibilityRule'], 'snapshot.fog');
  const disclosure = board.disclosure as Record<string, unknown> | null;
  if (!disclosure || typeof disclosure.entitiesVisible !== 'boolean'
    || !['visible', 'dark'].includes(String(disclosure.phase))
    || disclosure.entitiesVisible !== (disclosure.phase === 'visible')) {
    throw new Error('snapshot.disclosure 字段无效');
  }
  exactKeys(disclosure, ['entitiesVisible', 'phase'], 'snapshot.disclosure');
  if (board.boss !== undefined && board.boss !== null) {
    const boss = board.boss as Record<string, unknown>;
    if (!disclosure.entitiesVisible || !(mode === 35 || mode === 0 && board.level === 50)
      || !text(boss.phase, 64)
      || typeof boss.immobilized !== 'boolean') throw new Error('snapshot.boss 字段无效');
    exactKeys(boss, ['phase', 'immobilized', 'projectile'], 'snapshot.boss');
    if (boss.projectile !== null) {
      const ball = boss.projectile as Record<string, unknown> | undefined;
      if (!ball || !['fireball', 'iceball'].includes(String(ball.kind))
        || !positiveInteger(ball.row) || Number(ball.row) > Number(board.rows)
        || !finite(ball.columnPosition) || Number(ball.columnPosition) < -2
        || Number(ball.columnPosition) > 11) throw new Error('snapshot.boss.projectile 字段无效');
      exactKeys(ball, ['kind', 'row', 'columnPosition'], 'snapshot.boss.projectile');
    }
  }
  if (!disclosure.entitiesVisible
    && ['plants', 'zombies', 'gridItems', 'collectibles', 'mowers']
      .some((key) => (board[key] as unknown[]).length > 0)) {
    throw new Error('snapshot.dark disclosure 泄露了不可见实体');
  }
  if (fog.visibilityRule === 'invisighoul' && (board.zombies as unknown[]).length > 0) {
    throw new Error('snapshot.invisighoul 泄露了不可见僵尸');
  }
  const progress = board.progress as Record<string, unknown> | null;
  if (!progress || !PROGRESS_KINDS.has(progress.kind as PvzVisibleProgress['kind'])
    || !nullableNonnegativeInteger(progress.current)
    || !nullableNonnegativeInteger(progress.target)
    || !nullableNonnegativeInteger(progress.stage)
    || !text(progress.label, 512)) {
    throw new Error('snapshot.progress 字段无效');
  }
  exactKeys(progress, ['kind', 'current', 'target', 'stage', 'label'], 'snapshot.progress');
  const cardSlots = new Set<number>();
  for (const entry of board.cards as unknown[]) {
    const card = entry as Record<string, unknown>;
    if (!card || !nonnegativeInteger(card.slot) || Number(card.slot) > 9
      || cardSlots.has(Number(card.slot)) || !nonnegativeInteger(card.type)
      || !text(card.name, 128) || !(card.imitates === null || nonnegativeInteger(card.imitates))
      || !(card.cost === null || nonnegativeInteger(card.cost))
      || typeof card.ready !== 'boolean' || typeof card.affordable !== 'boolean'
      || !['ready', 'short', 'medium', 'long'].includes(String(card.cooldown))
      || card.ready !== (card.cooldown === 'ready')
      || !nonnegativeInteger(card.cooldownRemainingPercent)
      || Number(card.cooldownRemainingPercent) > 100
      || !oneDecimal(card.cooldownRemainingSeconds)
      || Number(card.cooldownRemainingSeconds) < 0
      || !finite(card.x) || !finite(card.y)) throw new Error('snapshot.card 字段无效');
    if (card.cost === null && card.affordable !== true) {
      throw new Error('snapshot.card 无价格卡片的可用性字段无效');
    }
    exactKeys(card, [
      'slot', 'type', 'name', 'imitates', 'cost', 'ready', 'affordable', 'cooldown',
      'cooldownRemainingPercent', 'cooldownRemainingSeconds', 'x', 'y',
    ], 'snapshot.card');
    cardSlots.add(Number(card.slot));
  }
  const zombieIds = new Set<number>();
  for (const entry of board.zombies as unknown[]) {
    const zombie = entry as Record<string, unknown>;
    if (!zombie || !nonnegativeInteger(zombie.id) || !nonnegativeInteger(zombie.type)
      || zombieIds.has(Number(zombie.id))
      || !text(zombie.name, 128) || !positiveInteger(zombie.row) || Number(zombie.row) > Number(board.rows)
      || !nonnegativeInteger(zombie.column) || Number(zombie.column) > Number(board.columns) + 2
      || !oneDecimal(zombie.columnPosition)
      || Number(zombie.columnPosition) < -2
      || Number(zombie.columnPosition) > Number(board.columns) + 2
      || !['lawn', 'near', 'mid', 'far'].includes(String(zombie.xBand))
      || !(zombie.speed === undefined
        || ['stationary', 'slow', 'normal', 'fast', 'retreating', 'airborne']
          .includes(String(zombie.speed)))
      || !twoDecimals(zombie.speedCellsPerSecond)
      || Number(zombie.speedCellsPerSecond) < 0
      || Number(zombie.speedCellsPerSecond) > 20
      || !(zombie.phase === undefined || text(zombie.phase, 128))
      || !(zombie.eating === undefined || typeof zombie.eating === 'boolean')
      || !CONDITIONS.has(zombie.condition as PvzCondition)
      || !['none', 'lost', ...CONDITIONS].includes(zombie.armor as string)
      || !['none', 'lost', ...CONDITIONS].includes(zombie.shield as string)
      || typeof zombie.hypnotized !== 'boolean' || typeof zombie.slowed !== 'boolean'
      || typeof zombie.immobilized !== 'boolean') throw new Error('snapshot.zombie 字段无效');
    exactKeys(zombie, [
      'id', 'type', 'name', 'row', 'column', 'columnPosition', 'xBand',
      'speed', 'speedCellsPerSecond', 'phase', 'eating',
      'condition', 'armor', 'shield',
      'hypnotized', 'slowed', 'immobilized',
    ], 'snapshot.zombie');
    zombieIds.add(Number(zombie.id));
  }
  const plantIds = new Set<number>();
  for (const entry of board.plants as unknown[]) {
    const plant = entry as Record<string, unknown>;
    if (!plant || !nonnegativeInteger(plant.id) || !nonnegativeInteger(plant.type)
      || plantIds.has(Number(plant.id))
      || !text(plant.name, 128) || !positiveInteger(plant.row) || Number(plant.row) > Number(board.rows)
      || !positiveInteger(plant.column) || Number(plant.column) > Number(board.columns)
      || !(plant.phase === undefined || text(plant.phase, 128))
      || !CONDITIONS.has(plant.condition as PvzCondition) || typeof plant.sleeping !== 'boolean'
      || typeof plant.squished !== 'boolean' || !Array.isArray(plant.layers)
      || plant.layers.length > 8 || !plant.layers.every((item) => text(item, 128))) {
      throw new Error('snapshot.plant 字段无效');
    }
    exactKeys(plant, [
      'id', 'type', 'name', 'row', 'column', 'phase', 'condition',
      'sleeping', 'squished', 'layers',
    ], 'snapshot.plant');
    plantIds.add(Number(plant.id));
  }
  const gridItemIds = new Set<number>();
  for (const entry of board.gridItems as unknown[]) {
    const item = entry as Record<string, unknown>;
    if (!item || !nonnegativeInteger(item.id) || !text(item.kind, 128)
      || gridItemIds.has(Number(item.id))
      || !positiveInteger(item.row) || Number(item.row) > Number(board.rows)
      || !positiveInteger(item.column) || Number(item.column) > Number(board.columns)
        + (item.kind === 'round_portal' || item.kind === 'square_portal' ? 1 : 0)) {
      throw new Error('snapshot.gridItem 字段无效');
    }
    exactKeys(item, [
      'id', 'kind', 'row', 'column', 'visibleHint', 'revealedContent',
    ], 'snapshot.gridItem');
    gridItemIds.add(Number(item.id));
    if (!(item.visibleHint === undefined
      || ['unknown', 'plant', 'zombie'].includes(String(item.visibleHint)))) {
      throw new Error('snapshot.gridItem visibleHint 字段无效');
    }
    if (item.revealedContent !== undefined) {
      const revealed = item.revealedContent as Record<string, unknown> | null;
      const entity = revealed && ['plant', 'zombie'].includes(String(revealed.kind))
        && nonnegativeInteger(revealed.type) && text(revealed.name, 128);
      const sun = revealed?.kind === 'sun' && positiveInteger(revealed.count);
      if (!entity && !sun) {
        throw new Error('snapshot.gridItem revealedContent 字段无效');
      }
      exactKeys(revealed!, revealed!.kind === 'sun'
        ? ['kind', 'count']
        : ['kind', 'type', 'name'], 'snapshot.gridItem revealedContent');
    }
  }
  const collectibleIds = new Set<number>();
  for (const entry of board.collectibles as unknown[]) {
    const item = entry as Record<string, unknown>;
    if (!item || !nonnegativeInteger(item.id) || !text(item.kind, 128)
      || collectibleIds.has(Number(item.id))
      || !finite(item.x) || !finite(item.y)
      || !(item.row === null || (positiveInteger(item.row) && Number(item.row) <= Number(board.rows)))
      || !(item.column === null
        || (positiveInteger(item.column) && Number(item.column) <= Number(board.columns)))) {
      throw new Error('snapshot.collectible 字段无效');
    }
    exactKeys(item, [
      'id', 'kind', 'x', 'y', 'row', 'column', 'containedType', 'containedName',
    ], 'snapshot.collectible');
    collectibleIds.add(Number(item.id));
    const contained = item.containedType !== undefined || item.containedName !== undefined;
    if (contained && (!nonnegativeInteger(item.containedType) || !text(item.containedName, 128))) {
      throw new Error('snapshot.collectible contained 字段无效');
    }
  }
  const mowerRows = new Set<number>();
  for (const entry of board.mowers as unknown[]) {
    const mower = entry as Record<string, unknown>;
    if (!mower || !positiveInteger(mower.row) || Number(mower.row) > Number(board.rows)
      || mowerRows.has(Number(mower.row))
      || !['lawn_mower', 'pool_cleaner', 'roof_cleaner', 'super_mower'].includes(String(mower.kind))
      || !['ready', 'triggered', 'squished'].includes(String(mower.state))) {
      throw new Error('snapshot.mower 字段无效');
    }
    exactKeys(mower, ['row', 'kind', 'state'], 'snapshot.mower');
    mowerRows.add(Number(mower.row));
  }
  validateCells(board);
  validateTutorial(board, mode);
  validateSpecial(board, mode);
}

function validateTutorial(board: Record<string, unknown>, mode: number): void {
  if (board.tutorial === null) return;
  const tutorial = board.tutorial as Record<string, unknown> | null;
  if (!tutorial || tutorial.kind !== 'shovel'
    || !['pickup', 'dig', 'keep_digging'].includes(String(tutorial.phase))
    || !positiveInteger(tutorial.remainingPlants) || Number(tutorial.remainingPlants) > 3
    || !Array.isArray(tutorial.allowedActions)
    || tutorial.allowedActions.length !== 1 || tutorial.allowedActions[0] !== 'shovel') {
    throw new Error('snapshot.tutorial 字段无效');
  }
  exactKeys(tutorial, [
    'kind', 'phase', 'remainingPlants', 'allowedActions',
  ], 'snapshot.tutorial');

  const plants = board.plants as Array<Record<string, unknown>>;
  const cells = board.cells as Array<Record<string, unknown>>;
  const plantCells = new Set(plants.map((plant) => `${plant.row}:${plant.column}`));
  const privateListsEmpty = ['cards', 'zombies', 'gridItems', 'collectibles', 'mowers']
    .every((key) => (board[key] as unknown[]).length === 0);
  const tutorialPlantsOnly = plants.length === Number(tutorial.remainingPlants)
    && plants.every((plant) => plant.type === 0 && plant.name === 'peashooter');
  const tutorialCellsOnly = cells.every((cell) => {
    const target = plantCells.has(`${cell.row}:${cell.column}`);
    return cell.terrain === 'lawn' && cell.playable === false && cell.base === 'none'
      && cell.blocker === (target ? 'shovel_tutorial_target' : 'shovel_tutorial_locked');
  });
  const progress = board.progress as Record<string, unknown>;
  const fog = board.fog as Record<string, unknown>;
  const disclosure = board.disclosure as Record<string, unknown>;
  if (mode !== 0 || board.level !== 5 || board.rows !== 5 || board.columns !== 9
    || board.background !== 0 || board.sun !== 0
    || fog.active !== false || fog.visibilityRule !== 'none'
    || disclosure.entitiesVisible !== true || disclosure.phase !== 'visible'
    || !privateListsEmpty || !tutorialPlantsOnly || !tutorialCellsOnly
    || progress.kind !== 'targets' || progress.current !== tutorial.remainingPlants
    || progress.target !== null || progress.stage !== null
    || (board.allowedSpecialActions as unknown[]).length !== 0 || board.special !== null) {
    throw new Error('snapshot.tutorial 泄露了铲子教程之外的棋盘状态');
  }
}

function validateCells(board: Record<string, unknown>): void {
  const rows = Number(board.rows);
  const columns = Number(board.columns);
  const cells = board.cells as unknown[];
  if (cells.length !== rows * columns) throw new Error('snapshot.cells 数量无效');
  const coordinates = new Set<string>();
  for (const entry of cells) {
    const cell = entry as Record<string, unknown>;
    if (!cell || !positiveInteger(cell.row) || Number(cell.row) > rows
      || !positiveInteger(cell.column) || Number(cell.column) > columns
      || !['lawn', 'water', 'roof', 'unavailable'].includes(String(cell.terrain))
      || !(typeof cell.playable === 'boolean' || cell.playable === null)
      || !(cell.blocker === null || text(cell.blocker, 128))
      || !['none', 'lily_pad', 'flower_pot', 'unknown'].includes(String(cell.base))) {
      throw new Error('snapshot.cell 字段无效');
    }
    const fog = board.fog as Record<string, unknown>;
    const disclosure = board.disclosure as Record<string, unknown>;
    const fogUnknown = cell.playable === null
      && cell.blocker === 'fog_hidden'
      && cell.base === 'unknown'
      && fog.visibilityRule === 'rendered_fog'
      && disclosure.entitiesVisible === true;
    const darkUnknown = cell.playable === false
      && cell.blocker === 'dark_hidden'
      && cell.base === 'unknown'
      && disclosure.entitiesVisible === false;
    if (disclosure.entitiesVisible === false && cell.playable !== false) {
      throw new Error('snapshot.cell 黑暗阶段泄露了可操作状态');
    }
    if ((cell.playable === null || cell.base === 'unknown') && !fogUnknown && !darkUnknown) {
      throw new Error('snapshot.cell 雾区未知状态不一致');
    }
    exactKeys(cell, [
      'row', 'column', 'terrain', 'playable', 'blocker', 'base',
    ], 'snapshot.cell');
    const key = `${cell.row}:${cell.column}`;
    if (coordinates.has(key)) throw new Error('snapshot.cell 坐标重复');
    coordinates.add(key);
  }
}

function validateSpecial(board: Record<string, unknown>, mode: number): void {
  const value = board.special;
  const allowed = board.allowedSpecialActions as string[];
  if (value === null) {
    if (allowed.length) throw new Error('snapshot.special 与允许动作不一致');
    return;
  }
  const special = value as Record<string, unknown>;
  if (!special || !text(special.phase, 128) || typeof special.settled !== 'boolean'
    || !Array.isArray(special.targets) || special.targets.length > 4096) {
    throw new Error('snapshot.special 字段无效');
  }
  exactKeys(special, ['phase', 'settled', 'targets'], 'snapshot.special');
  const targetActions = new Set<string>();
  const actionableTargetActions = new Set<string>();
  const targetKeys = new Set<string>();
  const objectiveCoordinates = new Set<string>();
  const entityTargetIds = new Set<string>();
  const plants = new Map((board.plants as Array<{ id: number; type: number; row: number; column: number }>)
    .map((item) => [item.id, item]));
  const zombies = new Map((board.zombies as Array<{ id: number; row: number; column: number }>)
    .map((item) => [item.id, item]));
  const gridItems = new Map((board.gridItems as Array<{ id: number; row: number; column: number }>)
    .map((item) => [item.id, item]));
  const collectibles = new Map((board.collectibles as Array<{
    id: number; row: number | null; column: number | null;
  }>).map((item) => [item.id, item]));
  const cards = new Set((board.cards as Array<{ slot: number }>).map((item) => item.slot));
  for (const entry of special.targets) {
    const target = entry as Record<string, unknown>;
    const kind = String(target?.kind);
    if (!target || !text(target.action, 128)
      || !['plant', 'zombie', 'grid_item', 'collectible', 'card', 'cell'].includes(kind)
      || !nullableNonnegativeInteger(target.id) || !nullableNonnegativeInteger(target.slot)
      || !(target.row === null || (positiveInteger(target.row) && Number(target.row) <= Number(board.rows)))
      || !(target.column === null
        || (positiveInteger(target.column) && Number(target.column) <= Number(board.columns)))) {
      throw new Error('snapshot.special target 字段无效');
    }
    exactKeys(target, [
      'action', 'kind', 'id', 'slot', 'row', 'column',
    ], 'snapshot.special target');
    const action = target.action as string;
    const objective = OBJECTIVE_SPECIAL_ACTIONS.has(action);
    if (action.startsWith('objective_') && !objective) {
      throw new Error('snapshot.special objective target 未知');
    }
    if (objective && (mode !== 22 || kind !== 'cell' || target.id !== null
      || target.slot !== null || target.row === null || target.column === null)) {
      throw new Error(`snapshot.special ${action} 观测目标无效`);
    }
    if (objective) {
      const coordinate = `${target.row}:${target.column}`;
      if (!SEEING_STARS_CELLS.has(coordinate)) {
        throw new Error(`snapshot.special ${action} 图案坐标无效`);
      }
      objectiveCoordinates.add(coordinate);
    }
    const id = target.id as number | null;
    const slot = target.slot as number | null;
    const coordinatesMatch = (entity: { row: number | null; column: number | null } | undefined) =>
      entity !== undefined && target.row === entity.row && target.column === entity.column;
    const referenced = kind === 'plant' ? id !== null && slot === null && coordinatesMatch(plants.get(id))
      : kind === 'zombie' ? id !== null && slot === null && coordinatesMatch(zombies.get(id))
        : kind === 'grid_item' ? id !== null && slot === null && coordinatesMatch(gridItems.get(id))
          : kind === 'collectible' ? id !== null && slot === null && coordinatesMatch(collectibles.get(id))
            : kind === 'card' ? id === null && slot !== null && cards.has(slot)
              && target.row === null && target.column === null
              : id === null
                && (slot === null
                  ? ((target.row === null && target.column === null)
                    || (target.row !== null && target.column !== null))
                  : cards.has(slot) && target.row !== null && target.column !== null);
    if (!referenced) throw new Error('snapshot.special target 引用无效');
    if (id !== null) {
      const actionId = `${target.action}:${id}`;
      if (entityTargetIds.has(actionId)) throw new Error('snapshot.special targetId 有歧义');
      entityTargetIds.add(actionId);
    }
    const key = JSON.stringify([target.action, kind, id, slot, target.row, target.column]);
    if (targetKeys.has(key)) throw new Error('snapshot.special target 重复');
    targetKeys.add(key);
    targetActions.add(action);
    if (!objective) actionableTargetActions.add(action);
  }
  if (new Set(allowed).size !== allowed.length
    || allowed.some((action) => action.startsWith('objective_') || !targetActions.has(action))
    || [...actionableTargetActions].some((action) => !allowed.includes(action))) {
    throw new Error('snapshot.special target 与允许动作不一致');
  }
  if (mode === 22 && special.settled === true) {
    const completed = new Set([...plants.values()]
      .filter((plant) => plant.type === 29)
      .map((plant) => `${plant.row}:${plant.column}`));
    const expected = [...SEEING_STARS_CELLS].filter((coordinate) => !completed.has(coordinate));
    if (objectiveCoordinates.size !== expected.length
      || expected.some((coordinate) => !objectiveCoordinates.has(coordinate))) {
      throw new Error('snapshot.special objective_starfruit 与可见星星图案不一致');
    }
  }
  for (const action of STRICT_GLOBAL_SPECIAL_ACTIONS) {
    const targets = (special.targets as Array<Record<string, unknown>>)
      .filter((target) => target.action === action);
    if (targets.length === 0) continue;
    const target = targets[0]!;
    if (targets.length !== 1 || target.kind !== 'cell' || target.id !== null
      || target.slot !== null || target.row !== null || target.column !== null) {
      throw new Error(`snapshot.special ${action} 全局目标无效`);
    }
  }
  const actions = new Set(allowed);
  if ((mode !== 43 && mode !== 50) && [...ZEN_SPECIAL_ACTIONS].some((action) => actions.has(action))) {
    throw new Error('snapshot.special Zen 动作与游戏模式不一致');
  }
  if (mode !== 43 && [...ZEN_CARE_SPECIAL_ACTIONS].some((action) => actions.has(action))) {
    throw new Error('snapshot.special Zen 养护动作与游戏模式不一致');
  }
  if (mode !== 50 && actions.has('tree_feed')) {
    throw new Error('snapshot.special tree_feed 与游戏模式不一致');
  }
}

const STRICT_GLOBAL_SPECIAL_ACTIONS = new Set([
  'spin',
  'start_onslaught',
  'buy_snorkel',
  'buy_trophy',
  'zen_next_garden',
  'tree_feed',
]);

const OBJECTIVE_SPECIAL_ACTIONS = new Set([
  'objective_starfruit',
]);

const SEEING_STARS_CELLS = new Set([
  '1:4',
  '2:4', '2:5',
  '3:2', '3:3', '3:4', '3:5', '3:6', '3:7',
  '4:4', '4:5', '4:6',
  '5:4', '5:7',
]);

const ZEN_CARE_SPECIAL_ACTIONS = new Set([
  'zen_water',
  'zen_fertilize',
  'zen_bug_spray',
  'zen_phonograph',
  'zen_chocolate',
]);

const ZEN_SPECIAL_ACTIONS = new Set([
  ...ZEN_CARE_SPECIAL_ACTIONS,
  'zen_next_garden',
  'tree_feed',
]);

function nullableNonnegativeInteger(value: unknown): boolean {
  return value === null || nonnegativeInteger(value);
}

export function snapshotKey(snapshot: PvzSnapshot): string {
  const {
    revision: _revision,
    monotonicMs: _monotonicMs,
    inputControl: _inputControl,
    ...semanticState
  } = snapshot;
  return JSON.stringify({ ...semanticState, menuContext: snapshot.inputControl.menuContext });
}
