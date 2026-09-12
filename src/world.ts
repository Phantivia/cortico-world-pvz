import { fileURLToPath } from 'node:url';
import type {
  World,
  WorldHost,
  WorldPanelDecl,
  WorldConsoleDecl,
  ToolCallContext,
  ToolDef,
  ToolOutcome,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { PvzNativeBridge, type PvzTransport } from './bridge.ts';
import { isTerminalCollectible } from './collectibles.ts';
import { PVZ_CONFIG_GROUP, type PvzConfigSection } from './config.ts';
import {
  PvzExecutor,
  renderPvzQueue,
  type PvzExecutionContext,
  type PvzPlantAdmissionBinding,
  type PvzStepResult,
  type PvzTaskReport,
} from './executor.ts';
import {
  createPvzEventMemory,
  isWhackSnapshot,
  pvzEventTrigger,
  renderWhackPrefetchCue,
  renderWhackTaskState,
  renderWhackTargetReady,
  trackSnapshot,
  type PvzTrackedEvent,
} from './events.ts';
import type { PvzOwnershipIdentity } from './engine-ipc.ts';
import {
  cardDisplayNameOf,
  cellText,
  plantDisplayName,
  plantDisplayNameOf,
  plantTypeOf,
  rowText,
  zombieDisplayNameOf,
} from './names.ts';
import { pvzNativeReason, type PvzNativeReason } from './native-reasons.ts';
import {
  snapshotKey,
  windowPresentationFault,
  type PvzBoardState,
  type PvzCard,
  type PvzNativeAction,
  type PvzProfileProgress,
  type PvzSeedChoice,
  type PvzSeedPickerState,
  type PvzSnapshot,
} from './protocol.ts';
import { blockerLabel, renderSnapshot, renderTacticalSnapshot } from './render.ts';
import { PvzRuntime, type PvzActionReceipt } from './runtime.ts';
import {
  resolveSemanticMenuAction,
  semanticMenuTarget,
  resolveSemanticSpecialAction,
  selectCollectibleIds,
  selectSunIds,
} from './semantic.ts';
import {
  describePvzStep,
  describePvzPlantPosition,
  parsePvzDo,
  parsePvzQueueMode,
  pvzSeedSelectorDisplayName,
  pvzSeedSelectorName,
  type PvzDoStep,
} from './skills.ts';
import { pvzCollectExecutionBudgetMs, pvzWhackExecutionBudgetMs } from './timing.ts';
import { describePvzTrigger, parsePvzArm, PvzTriggerTable, type PvzTriggerReport } from './triggers.ts';
import {
  PVZ_TOOL_DECLS,
  WHACK_SKILL_QUEUE_LENGTH,
} from './tools.ts';
import { progressFilteredSeedChoices, seedAllowedByPublicProgress } from './unlocks.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const MAX_VISIBLE_CLEAR_RESCANS = 2;
const MAX_COLLECT_STATE_TIMEOUT_RESCANS = 1;
const VISIBLE_CLEAR_RESCAN_WAIT_MS = 250;
const CONVEYOR_PLANT_RETRY_WAIT_MS = 300;
const WHACK_SKILL_TARGET_WAIT_MS = 3000;
const WHACK_STALE_SNAPSHOT_WAIT_MS = 500;
const WHACK_PREFETCH_RETRY_MS = 5000;
const WHACK_PREFETCH_LEASE_MS = 30_000;
const WHACK_PREFETCH_FALLBACK_GRACE_MS = 10_000;
const ROUTINE_EVENT_WINDOW_MS = 5000;
const WHACK_TACTICAL_ARCHIVE_ONLY_EVENTS = new Set([
  'pvz.level.progress',
  'pvz.visibility.changed',
  'pvz.actions.changed',
  'pvz.zombie.visible',
  'pvz.threat.approaching',
  'pvz.threat.close',
]);
const COLLECT_STATE_TIMEOUT = 'collectible did not enter the collection state before timeout';
const TRANSIENT_COLLECT_FAILURES = new Set([
  'one or more collectibles are no longer visible',
  'a requested collectible disappeared before it could be clicked',
  'failed to post collectible input from a current target',
  COLLECT_STATE_TIMEOUT,
]);
/** 阳光在点到之前自己没了:这是掉落物的正常寿命,不算自动收取出故障。 */
const SUN_SWEEP_VANISHED = new Set([
  'one or more collectibles are no longer visible',
  'a requested collectible disappeared before it could be clicked',
]);
const SUN_SWEEP_ALARM_FAILURES = 3;
const SUN_SWEEP_MIN_RETRY_MS = 400;
const SUN_SWEEP_MAX_RETRY_MS = 6_000;

/** 连着收不到就把间隔翻上去:一颗点不动的阳光十来秒就自己没了,不值得一直抢光标。 */
function sunSweepRetryDelayMs(failures: number): number {
  return Math.min(SUN_SWEEP_MAX_RETRY_MS, SUN_SWEEP_MIN_RETRY_MS * 2 ** Math.max(failures, 0));
}

export interface PvzWorldOptions {
  cfg: PvzConfigSection;
  timezone?: string;
  botName?: string;
  transportFactory?: () => PvzTransport;
  onTransportFailure?: (error: Error) => void;
  ownedProcess?: boolean;
  ownerToken?: string;
  recoveryIdentity?: PvzOwnershipIdentity;
  ownershipFile?: string;
  onOwnership?: (ownership: PvzOwnershipIdentity) => void;
  onPrelaunchFailure?: (error: Error) => void;
  taskIdBase?: number;
}

export interface PvzPhotoFrameReply {
  frameBase64: string;
  mime: 'image/png';
  text: string;
  width: number;
  height: number;
}

type BoundWhackStep = Extract<PvzDoStep, { skill: 'special' }> & {
  binding: WhackQueueScope;
};

interface WhackQueueScope {
  mode: number;
  runId: number;
  level: number;
}

interface WhackPrefetchWindow {
  sourceTaskId: number;
  scope: WhackQueueScope;
  openedAtMs: number;
  fallbackEligibleAtMs: number | null;
  lastFallbackAtMs: number;
  fallbackPending: boolean;
}

type WhackSkillProbe =
  | { kind: 'ready'; targetIds: number[] }
  | { kind: 'wait'; revision: number }
  | { kind: 'boundary'; text: string };

type BoundConditionalPlantStep = Extract<PvzDoStep, { skill: 'plant' }> & {
  binding: PvzPlantAdmissionBinding;
};

/**
 * 棋盘可见、没有锤击流水线,且这么久没投出过快照时,下一份快照以 flush 叫醒 agent。
 * 只兜「棋盘在变、却没有任何值得成文的事件」的空档(阳光数这类);必须比部署的
 * 合批上限慢,否则它会绕过操作者设的攒批地板,把普通战场变化重新变成每次都叫醒。
 */
const BOARD_WAKE_INTERVAL_MS = 30_000;

/**
 * 控制台面板的声明:局部 id + 真标题,渲染在 `src/worlds/pvz/console/` 的浏览器扩展里
 * (键就是这里的 id)。代理与开发态截图器共用这一份——面板声明一旦两边不同,扩展
 * 那个键就只在其中一条路上对得上。
 */
export const PVZ_PANEL_DECLS: readonly WorldPanelDecl[] = [
  {
    id: 'game',
    title: '游戏',
    description: '启动、停止由 worlds-pvz 托管的植物大战僵尸。手动关掉游戏窗口不会被自动拉起来。',
    getMethods: ['state'],
  },
];

export class PvzWorld implements World {
  readonly id = 'pvz';

  private host: WorldHost | null = null;
  private runtime: PvzRuntime | null = null;
  private latest: PvzSnapshot | null = null;
  private connected = false;
  private starting = false;
  private stopping = false;
  private lastError = '';
  private lastDeferredKey = '';
  private boardSnapshotPending = false;
  /** 上一份棋盘快照投出(发车刻渲染)或以 flush 挂单的时刻 */
  private lastBoardWakeAt = 0;
  private boardSnapshotTicket = 0;
  private whackTargetPending = false;
  private whackTargetTicket = 0;
  private whackTargetSuppressed = false;
  private routineEventScope = '';
  private routineEventMonotonicMs = -1;
  private readonly recentRoutineEvents = new Map<string, number>();
  private lastFrameKey = '';
  private lastFrameAtMs = 0;
  private readonly executor: PvzExecutor;
  private readonly triggers: PvzTriggerTable;
  private nextTaskId: number;
  private lastTaskReport: PvzTaskReport | null = null;
  private lastWhackTaskReport: PvzTaskReport | null = null;
  private activeWhackBatchTaskId: number | null = null;
  private activeWhackQueueTaskId: number | null = null;
  private bufferedWhackQueueTaskId: number | null = null;
  private whackPrefetchWindow: WhackPrefetchWindow | null = null;
  private whackPrefetchRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly whackTaskScopes = new Map<number, WhackQueueScope>();
  private lastPvzDoTurnKey: string | null = null;
  private sunSweepTaskId: number | null = null;
  private sunSweepFailures = 0;
  private sunSweepRetryAtMs = 0;
  private sunSweepRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepingBetweenSteps = false;
  private mutationTail: Promise<unknown> = Promise.resolve();
  private ownershipIdentityValue: PvzOwnershipIdentity | null = null;
  private readonly eventMemory = createPvzEventMemory();

  constructor(private readonly options: PvzWorldOptions) {
    this.nextTaskId = options.taskIdBase ?? 0;
    this.executor = new PvzExecutor({
      snapshot: () => this.latest,
      refreshSnapshot: async () => { await this.requireRuntime().readFreshSnapshot(); },
      execute: (step, context) => this.executeTaskStep(step, context),
      cancelNative: () => this.cancelNativeInput(),
      report: (report) => this.onTaskReport(report),
      reportInternal: (report) => this.onSunSweepReport(report),
      nextId: () => ++this.nextTaskId,
      diagnostic: (data) => this.host?.log.info('PvZ 执行时序', data),
    });
    // 触发器与任务共用一个号段:一份 pvz_stop 里的号不会指向两样东西。
    this.triggers = new PvzTriggerTable({
      snapshot: () => this.latest,
      fire: (trigger) => this.executor.submit(trigger.steps, trigger.queue, []),
      report: (report) => this.onTriggerReport(report),
      nextId: () => ++this.nextTaskId,
    });
  }

  envPromptVars(): Record<string, string> {
    return {};
  }

  console(): WorldConsoleDecl {
    const supported = this.latest?.executable.supported;
    const state = this.connected ? (supported ? 'online' : 'error') : this.starting ? 'loading' : 'offline';
    const presentation = this.latest?.presentation ?? null;
    const windowFault = presentation ? windowPresentationFault(presentation) : null;
    return {
      lamps: [
        { label: '引擎', state: this.starting ? 'loading' : this.runtime ? 'online' : 'offline', hint: this.starting ? '启动中' : '高频监视器' },
        { label: '植入件', state, hint: this.lastError || this.latest?.executable.profile || '未连接' },
        { label: '游戏', state: this.latest ? 'online' : 'offline', hint: this.latest?.screen ?? '无状态' },
        {
          label: '窗口',
          state: !presentation ? 'offline' : windowFault ? 'error' : 'online',
          hint: windowFault ?? (presentation ? '800×600，整个在一块显示器里' : '未连接'),
        },
      ],
      badges: [
        { label: '画面', value: this.latest?.screen ?? '未连接', tone: this.connected ? 'on' : 'off' },
        { label: '模式', value: this.latest?.modeName ?? '-', tone: 'plain' },
        { label: '版本', value: supported === false ? '拒绝动作' : supported ? '已验证' : '-', tone: supported === false ? 'off' : 'plain' },
        {
          label: '窗口',
          value: presentation
            ? `${presentation.clientWidth}×${presentation.clientHeight}${presentation.onScreen ? '' : ' 出屏'}`
            : '-',
          tone: !presentation ? 'plain' : windowFault ? 'off' : 'on',
        },
      ],
      promptDocs: [
        {
          key: 'worlds.pvz.envPrompt',
          title: '植物大战僵尸 · 环境提示词',
          description: '语义状态、操作验真、特殊关卡和迷雾边界。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
      config: [PVZ_CONFIG_GROUP],
    };
  }

  tools(): ToolDef[] {
    return PVZ_TOOL_DECLS.map((decl) => ({
      ...decl,
      handler: async (args, context): Promise<string | ToolOutcome> => {
        try {
          if (decl.name === 'pvz_do' || decl.name === 'pvz_stop' || decl.name === 'pvz_arm') {
            const result = this.mutationTail.then(() => this.handlePublicTool(decl.name, args, context));
            this.mutationTail = result.catch(() => undefined);
            return await result;
          }
          return await this.handlePublicTool(decl.name, args, context);
        } catch (error) {
          return `[${decl.name} 失败] ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    }));
  }

  async start(host: WorldHost): Promise<void> {
    this.resetEventDeliveryState();
    this.host = host;
    this.starting = true;
    this.stopping = false;
    const transport = this.options.transportFactory?.() ?? new PvzNativeBridge({
      executable: this.options.cfg.executable,
      launch: this.options.cfg.launch,
      attachPid: this.options.cfg.attachPid,
      shutdownOnStop: (this.options.ownedProcess ?? this.options.cfg.launch)
        && this.options.cfg.closeOnStop,
      buildDir: this.options.cfg.nativeBuildDir,
      pollHz: this.options.cfg.pollHz,
      cursorDurationMs: this.options.cfg.cursorDurationMs,
      ...(this.options.ownerToken ? { ownerToken: this.options.ownerToken } : {}),
      ...(this.options.recoveryIdentity ? { recoveryIdentity: this.options.recoveryIdentity } : {}),
      ...(this.options.ownershipFile ? { ownershipFile: this.options.ownershipFile } : {}),
    });
    transport.on('log', (entry) => {
      const log = host.log.child('native');
      log[entry.level](entry.message);
    });
    transport.on('prelaunchFailure', (error) => {
      this.options.onPrelaunchFailure?.(error);
    });
    transport.on('ownership', (ownership) => {
      this.ownershipIdentityValue = ownership;
      this.options.onOwnership?.(ownership);
    });
    transport.on('disconnect', (error) => {
      this.connected = false;
      this.latest = null;
      this.resetEventDeliveryState();
      const failure = error ?? new Error('PvZ 植入件连接已关闭');
      this.lastError = failure.message;
      void this.executor.stopAndWait('PvZ 连接中断').catch(() => undefined);
      if (!this.stopping) this.options.onTransportFailure?.(failure);
    });
    const runtime = new PvzRuntime(transport, () => this.options.cfg.actionTimeoutMs);
    this.runtime = runtime;
    runtime.on('diagnostic', (data) => this.host?.log.info('PvZ 原生时序', data));
    runtime.on('snapshot', (snapshot, before) => this.onSnapshot(snapshot, before));
    try {
      await runtime.start();
      this.connected = true;
      this.lastError = '';
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await runtime.stop().catch(() => undefined);
      this.runtime = null;
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.triggers.clear();
    await this.executor.stopAndWait('worlds-pvz World 停止').catch((error) => {
      this.host?.log.warn('PvZ 原生输入释放未验真', { error: String(error) });
    });
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime) await runtime.stop();
    this.connected = false;
    this.latest = null;
    this.resetEventDeliveryState();
    this.host = null;
  }

  async configureNative(): Promise<void> {
    const [cursorMinMs, cursorMaxMs] = this.options.cfg.cursorDurationMs;
    await this.requireRuntime().configure(this.options.cfg.pollHz, cursorMinMs, cursorMaxMs);
  }

  onHandoffEnded(): void {
    this.resetHandoffDelivery();
    if (this.host && this.latest) this.queueBoardSnapshot(this.host, this.latest, true, 'flush');
  }

  async handoffSnapshot(): Promise<string> {
    this.resetHandoffDelivery();
    this.boardSnapshotPending = true;
    try {
      return await this.renderFreshBoardSnapshot();
    } finally {
      this.boardSnapshotPending = false;
    }
  }

  private resetHandoffDelivery(): void {
    this.boardSnapshotTicket += 1;
    this.boardSnapshotPending = false;
    this.lastDeferredKey = '';
    this.lastPvzDoTurnKey = null;
  }

  async photoFrame(): Promise<PvzPhotoFrameReply> {
    const runtime = this.requireRuntime();
    const before = this.requireSnapshot();
    // 窗口 DC 只读得到屏上的像素:窗口出屏就会截出黑边。半张假画面比没有画面更坏。
    const windowFault = windowPresentationFault(before.presentation);
    if (windowFault) throw new Error(windowFault);
    const beforeKey = snapshotKey(before);
    const frame = await runtime.capture();
    const after = this.requireSnapshot();
    if (beforeKey === snapshotKey(after)) {
      this.lastFrameKey = beforeKey;
      this.lastFrameAtMs = Date.now();
    } else {
      this.lastFrameKey = '';
      this.lastFrameAtMs = 0;
    }
    return {
      frameBase64: frame.base64,
      mime: frame.mime,
      width: frame.width,
      height: frame.height,
      text: `PvZ 窗口画面 ${frame.width}×${frame.height}；语义状态仍以 pvz_observe 为准。`,
    };
  }

  get processId(): number | null {
    return this.runtime?.processId ?? null;
  }

  get ownerToken(): string | null {
    return this.runtime?.ownerToken ?? null;
  }

  get artifactDir(): string | null {
    return this.runtime?.artifactDir ?? null;
  }

  get ownershipIdentity(): PvzOwnershipIdentity | null {
    return this.ownershipIdentityValue;
  }

  private async handlePublicTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<string | ToolOutcome> {
    if (name === 'pvz_observe') {
      await this.requireRuntime().readFreshSnapshot();
      const detail = args.detail === 'full' ? 'full' : 'summary';
      return this.renderObservation(detail);
    }
    if (name === 'pvz_glance') {
      return '[pvz_glance 失败] 图像应由主进程代理直接取得';
    }
    if (name === 'pvz_do') {
      await this.requireRuntime().readFreshSnapshot();
      // 窗口不可操作时每一次鼠标消息都会被植入件拒掉。与其让整队动作一步步失败、
      // 回执里还说不出为什么,不如在入队这一刻就把量到的事实交出去。
      const windowFault = this.latest && windowPresentationFault(this.latest.presentation);
      if (windowFault) throw new Error(windowFault);
      const turnKey = context.round === undefined ? null : `${context.role}:${context.round}`;
      if (turnKey !== null && turnKey === this.lastPvzDoTurnKey) {
        throw new Error('本轮已经提交过一个技能队列；等待任务回执和最新快照后，在下一轮再提交');
      }
      const parsedMode = parsePvzQueueMode(args.queue);
      if ('error' in parsedMode) throw new Error(parsedMode.error);
      const cancel = args.cancel === undefined ? [] : args.cancel;
      if (!Array.isArray(cancel) || cancel.length > 64 || cancel.some(id =>
        !Number.isSafeInteger(id) || id < 1) || new Set(cancel).size !== cancel.length) {
        throw new Error('cancel 必须是不重复的任务号数组，最多64项');
      }
      const cancelledIds = new Set<number>(cancel);
      const parsed = parsePvzDo(args.steps);
      if ('error' in parsed) throw new Error(parsed.error);
      // 条件 plant 可位于队列中间；执行至该步时停放，卡片就绪后从同一步继续。
      for (let index = 0; index < parsed.steps.length - 1; index++) {
        const step = parsed.steps[index]!;
        if (step.skill === 'collect' && step.what === 'usable_seed') {
          const next = parsed.steps[index + 1];
          if (index !== parsed.steps.length - 2
            || next?.skill !== 'special' || next.action !== 'launch') {
            throw new Error(
              `第 ${index + 1} 步捡起可用种子包后，只能紧跟一个作为队尾的 launch；该种子落地并返回新快照后再规划下一包`,
            );
          }
        }
      }
      const board = this.latest?.screen === 'board' ? this.latest.board : null;
      const whackSteps = parsed.steps.filter(isWhackStep);
      const liveWhackBoard = board !== null && this.latest !== null && isWhackSnapshot(this.latest);
      let whackAdmission: { scope: WhackQueueScope; continuation: boolean } | null = null;
      if (liveWhackBoard) {
        const menuTransition = parsed.steps.length === 1
          && parsed.steps[0]?.skill === 'menu';
        if (menuTransition && this.hasWhackPipeline()) {
          throw new Error('实时锤击技能队列仍在执行或预取中，不能插入菜单操作');
        }
        const window = this.whackPrefetchWindow;
        if (whackSteps.length === 0 && window && this.bufferedWhackQueueTaskId === null) {
          throw new Error(
            `[PvZ·锤击预取] 当前锤击任务#${window.sourceTaskId}的后继缓冲位为空；`
            + `先按预取提示用 queue:"append" 提交后继锤击队列`,
          );
        }
      }
      this.requireConveyorCardBudget(board, parsed.steps);
      if (whackSteps.length > 0) {
        if (!liveWhackBoard || !board || !this.latest) {
          throw new Error('锤击步骤只能在当前可见的锤僵尸棋盘提交');
        }
        if (parsed.steps.length !== WHACK_SKILL_QUEUE_LENGTH
          || whackSteps.length !== WHACK_SKILL_QUEUE_LENGTH) {
          throw new Error(
            `每次响应必须产出一份恰含 ${WHACK_SKILL_QUEUE_LENGTH} 个锤击步骤的有限队列`,
          );
        }
        const invalidIndex = parsed.steps.findIndex((step) => !isWhackAllVisibleStep(step));
        if (invalidIndex >= 0) {
          throw new Error(
            `锤击队列第 ${invalidIndex + 1} 步必须使用 targets:[{kind:"zombie",scope:"all_visible"}]`,
          );
        }
        const scope = whackScopeOf(this.latest);
        const window = this.whackPrefetchWindow;
        if (window) {
          if (!sameWhackScope(window.scope, scope)) {
            this.clearWhackPrefetchWindow(window);
            throw new Error('锤击预取窗口所属关卡已变化；等待当前关卡的新目标事件');
          }
          if (this.bufferedWhackQueueTaskId !== null) {
            throw new Error(`锤击任务#${this.bufferedWhackQueueTaskId}已占用唯一预取缓冲位`);
          }
          whackAdmission = { scope, continuation: true };
        } else {
          const outstanding = this.activeWhackQueueTaskId ?? this.bufferedWhackQueueTaskId;
          if (outstanding !== null) {
            throw new Error(`锤击任务#${outstanding}仍在执行；只在 pvz.task.prefetch 到达后追加下一份队列`);
          }
          resolveSemanticSpecialAction(board, {
            action: 'whack', targets: whackSteps[0]!.targets,
          });
          this.lastWhackTaskReport = null;
          whackAdmission = { scope, continuation: false };
        }
      }
      const decisionBarrier = whackAdmission === null
        ? parsed.steps.findIndex(requiresFreshStateAfter)
        : -1;
      if (decisionBarrier >= 0 && decisionBarrier !== parsed.steps.length - 1) {
        throw new Error(
          `第 ${decisionBarrier + 1} 步 ${describePvzStep(parsed.steps[decisionBarrier]!)} 会改变特殊阶段或界面，必须作为本次技能队列的最后一步；收到回执和新快照后再产出下一轮队列`,
        );
      }
      const steps = parsed.steps.map((step): PvzDoStep => {
        if (step.skill === 'special' && step.action === 'whack') {
          return {
            ...step,
            binding: whackAdmission!.scope,
          } as BoundWhackStep;
        }
        if (step.skill === 'plant' && step.when !== 'now') {
          if (!board || this.latest?.screen !== 'board') {
            throw new Error('条件 plant 只能在当前棋盘内提交，不能停放到未来关卡');
          }
          const card = this.executor.selectUnreservedCard(step.plant, undefined, parsedMode.mode, cancelledIds);
          if (!card) {
            throw new Error(`${pvzSeedSelectorDisplayName(step.plant)} 当前没有可绑定的未占用卡片`);
          }
          return {
            ...step,
            binding: {
              mode: this.latest.mode,
              runId: board.runId,
              slot: card.slot,
              type: card.type,
              imitates: card.imitates,
              name: card.name,
            },
          } as BoundConditionalPlantStep;
        }
        return step;
      });
      const cells = board ? plantCellNotes(board, parsed.steps) : [];
      const accepted = this.executor.submit(steps, parsedMode.mode, cancel)
        + (cells.length ? `\n[落点现状] ${cells.join('；')}` : '');
      if (whackAdmission) {
        const taskId = this.nextTaskId;
        this.whackTaskScopes.set(taskId, whackAdmission.scope);
        if (whackAdmission.continuation) {
          const window = this.whackPrefetchWindow;
          if (window) this.clearWhackPrefetchWindow(window);
          if (this.activeWhackQueueTaskId === null) {
            this.activeWhackQueueTaskId = taskId;
          } else {
            this.bufferedWhackQueueTaskId = taskId;
          }
        } else {
          this.activeWhackQueueTaskId = taskId;
        }
      }
      if (turnKey !== null) this.lastPvzDoTurnKey = turnKey;
      // 受理回执不附世界快照：唤醒帧的 pvz.board.snapshot 在投递时渲染，且同轮只能提交一份队列。
      return whackAdmission && this.lastWhackTaskReport
        ? `${accepted}\n[上一份锤击队列回执] ${renderWhackReportSummary(this.lastWhackTaskReport)}`
        : accepted;
    }
    if (name === 'pvz_queue') return this.renderQueueStatus();
    if (name === 'pvz_arm') {
      await this.requireRuntime().readFreshSnapshot();
      const request = parsePvzArm(args);
      // 触发器打响时直接进执行器,绕过 pvz_do 的受理;传送带的那一张卡在这里就要算上。
      this.requireConveyorCardBudget(
        this.latest?.screen === 'board' ? this.latest.board : null,
        request.steps,
      );
      const trigger = this.triggers.arm(request.condition, request.steps, request.queue, request.expiresInMs);
      const armed = this.triggers.list().some((item) => item.id === trigger.id);
      return `${armed
        ? `触发器#${trigger.id} 已武装:${describePvzTrigger(trigger)}`
          + (trigger.expiresAt === null ? '' : `；${Math.round(request.expiresInMs! / 1000)}秒内没打响就撤掉`)
        : `触发器#${trigger.id} 武装时条件已经成立，当场打响`}\n${this.renderQueueLine()}`;
    }
    if (name === 'pvz_stop') {
      if (args.triggerId !== undefined) {
        const triggerId = integerArg(args.triggerId, 'triggerId', 1, Number.MAX_SAFE_INTEGER);
        const stopped = this.triggers.disarm(triggerId) ?? `触发器#${triggerId}已打响、到期或不存在`;
        return `${stopped}\n${this.renderQueueStatus()}`;
      }
      if (args.taskId !== undefined) {
        const taskId = integerArg(args.taskId, 'taskId', 1, Number.MAX_SAFE_INTEGER);
        const stopped = await this.executor.cancelAndWait(taskId);
        return `${stopped}\n${this.renderQueueStatus()}`;
      }
      if (context.role !== 'system'
        && (this.hasWhackPipeline()
          || (this.latest !== null && isWhackSnapshot(this.latest)))) {
        const outstanding = this.activeWhackQueueTaskId ?? this.bufferedWhackQueueTaskId;
        const task = outstanding === null
          ? '当前实时锤击棋盘'
          : `锤击任务#${outstanding}`;
        throw new Error(
          `${task}由逐响应有限 skill 队列驱动；等待任务、预取或 pvz.target.ready，不能用 pvz_stop 催促、替换或空转`,
        );
      }
      const disarmed = this.triggers.clear();
      const stopped = await this.executor.stopAndWait('收到 pvz_stop')
        ?? (disarmed.length ? `撤掉了触发器 ${disarmed.map((id) => `#${id}`).join('、')}` : null);
      if (context.role === 'system') {
        const window = this.whackPrefetchWindow;
        if (window) this.clearWhackPrefetchWindow(window);
        const host = this.host;
        if (host && this.latest && renderWhackTargetReady(this.latest) !== null
          && !this.hasWhackPipeline()) this.queueWhackTarget(host);
      }
      return `${stopped ?? '当前没有排队任务；原生输入已释放'}\n${this.renderQueueStatus()}`;
    }
    throw new Error(`未知工具 ${name}`);
  }

  private async executeTaskStep(
    step: PvzDoStep,
    context: PvzExecutionContext,
  ): Promise<PvzStepResult> {
    if (context.aborted()) return { outcome: 'blocked', text: context.abortedBy() ?? '任务已停止' };
    await this.sweepSunBetweenSteps(step, context);
    if (context.aborted()) return { outcome: 'blocked', text: context.abortedBy() ?? '任务已停止' };
    if (step.skill === 'menu') {
      if (isLifecycleExit(step.action)) {
        return { outcome: 'blocked', text: '托管游戏不能由任务退出' };
      }
      let target = this.resolveMenuActionOrNull(step.action);
      if (!target) {
        await this.waitForSnapshotAfter(
          this.requireSnapshot().revision,
          Math.min(600, Math.max(150, this.options.cfg.actionTimeoutMs)),
        );
        target = this.resolveMenuActionOrNull(step.action);
      }
      if (!target) {
        const snapshot = this.requireSnapshot();
        const offered = snapshot.menu.filter((item) => item.enabled)
          .map((item) => semanticMenuTarget(item));
        return {
          outcome: 'yield',
          text: `这一步要的「${step.action}」当前画面上没有；现在是${screenText(snapshot.screen)}，`
            + `这里能点的是 ${offered.join('、') || '（没有可点的菜单动作）'}`,
        };
      }
      if (!target.enabled) return { outcome: 'blocked', text: `菜单操作 ${step.action} 尚未可用` };
      if (target.id === 'profile_create') {
        return { outcome: 'blocked', text: '创建档案必须使用带 name 的 profile_create 步骤' };
      }
      const action: PvzNativeAction = target.id === 'ready'
        ? { kind: 'ready' }
        : target.id.startsWith('store_buy_')
          ? { kind: 'interact', target: target.id }
          : { kind: 'menu', target: target.id };
      return this.semanticReceipt(await this.requireRuntime().act(action), `菜单操作 ${step.action} 已完成`);
    }
    if (step.skill === 'profile_create') {
      const offered = this.requireSnapshot().menu.some((item) =>
        item.id === 'profile_create' && item.enabled);
      if (!offered) return { outcome: 'blocked', text: '当前界面不能创建档案' };
      const name = profileNameArg(step.name);
      return this.semanticReceipt(
        await this.requireRuntime().act({ kind: 'profile_create', name }),
        `档案「${name}」已创建`,
      );
    }
    if (step.skill === 'choose_seeds') return this.executeSeedTask(step, context);
    if (step.skill === 'plant') {
      const plant = pvzSeedSelectorName(step.plant);
      const plantLabel = pvzSeedSelectorDisplayName(step.plant);
      const board = this.requireBoard(true);
      const row = integerArg(step.row, 'row', 1, board.rows);
      const column = typeof step.column === 'number'
        ? integerArg(step.column, 'column', 1, board.columns) : step.column;
      const position = describePvzPlantPosition(row, column);
      const cell = typeof column === 'number'
        ? board.cells.find((item) => item.row === row && item.column === column) : null;
      const darkBlindTarget = !board.disclosure.entitiesVisible && cell?.blocker === 'dark_hidden';
      if (typeof column === 'number' && (!cell || (cell.playable === false && !darkBlindTarget))) {
        return {
          outcome: 'blocked',
          text: `${position}当前不可种植${cell?.blocker ? `:${blockerLabel(cell.blocker)}` : ''}`,
        };
      }
      const mineThreat = plant === 'potato_mine' && typeof column === 'number'
        ? unarmableMineThreat(board, row)
        : null;
      if (mineThreat) {
        return {
          outcome: 'blocked',
          // 受阻回执只报读数与结论,换什么手段是她的判断(worlds-report-facts)。
          text: `${zombieDisplayNameOf(mineThreat.type, mineThreat.name)} 已经逼到${rowText(row)}且这排割草机已经用掉了，土豆雷来不及武装`,
        };
      }
      let slot: number;
      const reserved = context.reservedCard;
      if (reserved) {
        const snapshot = this.requireSnapshot();
        const card = board.cards.find((candidate) => candidate.slot === reserved.slot);
        if (snapshot.mode !== reserved.mode || board.runId !== reserved.runId
          || !card || card.type !== reserved.type || card.imitates !== reserved.imitates) {
          return { outcome: 'blocked', text: `${plantLabel} 的条件保留已随关卡状态失效` };
        }
        slot = reserved.slot;
      } else {
        const card = this.executor.selectUnreservedCard(step.plant, context.taskId);
        if (!card) return { outcome: 'blocked', text: `当前没有未被条件任务占用的 ${plantLabel} 卡片` };
        slot = card.slot;
      }
      const conveyor = typeof column === 'number' && isConveyorBoard(board);
      const initial = this.requireSnapshot();
      let retries = 0;
      while (true) {
        const receipt = await this.requireRuntime().act(typeof column === 'number'
          ? { kind: 'plant', slot, row, column }
          : { kind: 'plant', slot, row, aheadOf: { minGap: column.minGap } });
        const placed = receipt.placement;
        const result = this.semanticReceipt(receipt,
          `${plantLabel} 已种在${placed ? cellText(placed.row, placed.column) : position}`);
        if (result.outcome === 'done') {
          return retries > 0
            ? { outcome: 'done', text: `${result.text}（传送带卡位稳定后自动重选 ${retries} 次）` }
            : result;
        }
        // 相对落点被打回只影响这一步:目标没了、这排没格、卡没冷却好都是当下这株的事,
        // 队列里跟着的经济与防线照做。任务级屏障只剩「没这张卡」与「关卡已变」,那在受理时就判。
        if (typeof column !== 'number' && receipt.status === 'rejected') {
          return { outcome: 'yield', text: `${plantLabel} 没能种在${position}：${result.text}` };
        }
        if (typeof column === 'number' && receipt.status === 'rejected' && (!conveyor || reserved || retries >= 1
          || context.aborted() || !isTransientConveyorPlantRejection(receipt))) {
          // 打回的理由要按打回之后的状态说,不是提交时那一份。
          await this.waitForSnapshotAfter(
            receipt.afterRevision ?? receipt.beforeRevision,
            Math.min(300, Math.max(100, this.options.cfg.actionTimeoutMs)),
          );
          return {
            outcome: 'yield',
            text: `${plantLabel} 没能种到${cellText(row, column)}：`
              + this.plantFailureText(receipt, slot, row, column),
          };
        }
        if (!conveyor || reserved || retries >= 1 || context.aborted()
          || !isTransientConveyorPlantRejection(receipt)) return result;
        const fresh = await this.waitForSnapshotAfter(
          receipt.afterRevision ?? receipt.beforeRevision,
          CONVEYOR_PLANT_RETRY_WAIT_MS,
        );
        if (context.aborted()) {
          return { outcome: 'blocked', text: context.abortedBy() ?? '任务已停止' };
        }
        if (fresh?.screen !== 'board' || !fresh.board
          || fresh.mode !== initial.mode || fresh.board.runId !== initial.board?.runId) return result;
        const freshCard = this.executor.selectUnreservedCard(step.plant, context.taskId);
        if (!freshCard) return result;
        slot = freshCard.slot;
        retries += 1;
      }
    }
    if (step.skill === 'shovel') {
      const board = this.requireBoard();
      const row = integerArg(step.row, 'row', 1, board.rows);
      const column = integerArg(step.column, 'column', 1, board.columns);
      if (board.tutorial && !board.plants.some((plant) =>
        plant.row === row && plant.column === column)) {
        return { outcome: 'blocked', text: `${cellText(row, column)}不是当前铲子教程目标` };
      }
      return this.semanticReceipt(
        await this.requireRuntime().act({ kind: 'shovel', row, column }),
        `${cellText(row, column)}已铲除`,
      );
    }
    if (step.skill === 'collect') return this.executeCollectTask(step, context);
    if (step.skill === 'auto_sun') return this.executeSunSweep();
    if (step.skill === 'special') {
      if (step.action === 'whack') return this.executeWhackBatchTask(step, context);
      const board = this.requireBoard();
      const request: Record<string, unknown> = {
        action: step.action,
        ...(step.at ? { at: step.at } : {}),
        ...(step.to ? { to: step.to } : {}),
        ...(step.card ? { card: step.card } : {}),
        ...(step.target ? { target: step.target } : {}),
      };
      let action: PvzNativeAction;
      try {
        action = resolveSemanticSpecialAction(board, request);
      } catch (error) {
        return { outcome: 'blocked', text: error instanceof Error ? error.message : String(error) };
      }
      return this.semanticReceipt(
        await this.requireRuntime().act(action),
        `特殊操作 ${step.action} 已完成`,
      );
    }
    if (step.skill === 'interact') {
      if (isLifecycleExit(step.target)) {
        return { outcome: 'blocked', text: '托管游戏不能由任务退出' };
      }
      let target;
      try {
        target = resolveSemanticMenuAction(this.requireSnapshot(), step.target);
      } catch (error) {
        return { outcome: 'blocked', text: error instanceof Error ? error.message : String(error) };
      }
      if (!target.enabled) return { outcome: 'blocked', text: `交互 ${step.target} 尚未可用` };
      if (target.id === 'profile_create') {
        return { outcome: 'blocked', text: '创建档案必须使用带 name 的 profile_create 步骤' };
      }
      return this.semanticReceipt(
        await this.requireRuntime().act({ kind: 'interact', target: target.id }),
        `交互 ${step.target} 已完成`,
      );
    }
    const snapshot = this.requireSnapshot();
    if (snapshot.screen !== 'unknown' || snapshot.menu.length || snapshot.dialog) {
      return { outcome: 'blocked', text: '视觉坐标点击只用于没有语义控件的未知兼容界面' };
    }
    if (Date.now() - this.lastFrameAtMs > 15_000 || this.lastFrameKey !== snapshotKey(snapshot)) {
      return { outcome: 'blocked', text: '需要先取得与当前界面一致的 pvz_glance 画面' };
    }
    return this.semanticReceipt(
      await this.requireRuntime().act({ kind: 'visual_click', x: step.x, y: step.y }),
      `兼容点击 (${step.x},${step.y}) 已完成`,
    );
  }

  private async executeSeedTask(
    step: Extract<PvzDoStep, { skill: 'choose_seeds' }>,
    context: PvzExecutionContext,
  ): Promise<PvzStepResult> {
    const snapshot = this.requireSnapshot();
    const picker = snapshot.seedPicker;
    if (!picker) return { outcome: 'blocked', text: '当前不在选卡画面' };
    const choices = progressFilteredSeedChoices(snapshot.profile, picker.choices);
    const desired = step.seeds.map((seed) => seedRequest(seed, choices, snapshot.profile));
    if (step.mode === 'replace' && desired.length > picker.capacity) {
      return { outcome: 'blocked', text: `选卡数量 ${desired.length} 超过容量 ${picker.capacity}` };
    }
    const replacement = step.mode === 'replace' ? seedReplacementPlan(picker, desired) : null;
    const selectionError = replacement ? replacement.error : fixedToggleError(picker, desired);
    if (selectionError) return { outcome: 'blocked', text: selectionError };
    let changed = 0;
    const apply = async (action: PvzNativeAction): Promise<PvzStepResult | null> => {
      if (context.aborted()) return { outcome: 'blocked', text: context.abortedBy() ?? '任务已停止' };
      const receipt = await this.requireRuntime().act(action);
      const result = this.semanticReceipt(receipt, '选卡变化已验真');
      if (result.outcome === 'done') {
        changed += 1;
        return null;
      }
      return {
        ...result,
        text: `${changed > 0 ? `已完成 ${changed} 次选卡变化；` : ''}${result.text}`,
      };
    };

    if (replacement) {
      for (const action of replacement.actions) {
        const failure = await apply(action);
        if (failure) return failure;
      }
    } else {
      for (const seed of desired) {
        const failure = await apply({ kind: 'choose_seed', ...seed });
        if (failure) return failure;
      }
    }
    if (step.confirm) {
      const current = this.requireSnapshot().seedPicker;
      if (!current?.ready) {
        return {
          outcome: 'blocked',
          text: `${changed > 0 ? `已完成 ${changed} 次选卡变化；` : ''}卡组尚未选满，不能开始`,
        };
      }
      const failure = await apply({ kind: 'ready' });
      if (failure) return failure;
    }
    return {
      outcome: changed > 0 ? 'done' : 'noop',
      text: changed > 0 ? `选卡已完成，共验真 ${changed} 次变化` : '卡组原本已符合要求',
    };
  }

  private async executeCollectTask(
    step: Extract<PvzDoStep, { skill: 'collect' }>,
    context: PvzExecutionContext,
  ): Promise<PvzStepResult> {
    let collected = 0;
    let verifiedPasses = 0;
    let transientRescans = 0;
    while (verifiedPasses < 8) {
      if (context.aborted()) return { outcome: 'blocked', text: context.abortedBy() ?? '任务已停止' };
      const snapshot = this.latest;
      const board = snapshot?.board;
      if (!board) {
        return collected > 0
          ? { outcome: 'done', text: `已收集 ${collected} 个目标，界面随后推进` }
          : { outcome: 'blocked', text: '当前没有可收集的棋盘' };
      }
      const selected = selectCollectibleIds(board, step.what);
      const byId = new Map(board.collectibles.map((item) => [item.id, item]));
      const ordinary = selected.filter((id) => !isTerminalCollectible(byId.get(id)!.kind));
      const terminal = selected.filter((id) => isTerminalCollectible(byId.get(id)!.kind));
      const ids = step.what === 'usable_seed'
        ? selected.slice(0, 1)
        : ordinary.length > 0
          ? ordinary.slice(0, 128)
          : terminal.slice(0, 1);
      if (!ids.length) {
        return {
          outcome: collected > 0 ? 'done' : 'noop',
          text: collected > 0 ? `已收集 ${collected} 个${collectibleLabel(step.what)}` : `当前没有可见${collectibleLabel(step.what)}`,
        };
      }
      const timeoutMs = pvzCollectExecutionBudgetMs(
        ids.length,
        this.options.cfg.cursorDurationMs[1],
        this.options.cfg.actionTimeoutMs,
      );
      const receipt = await this.requireRuntime().act({ kind: 'collect', ids }, timeoutMs);
      const result = this.semanticReceipt(
        receipt,
        `已收集 ${ids.length} 个${collectibleLabel(step.what)}`,
      );
      if (result.outcome !== 'done') {
        const terminalBatch = ids.some((id) => isTerminalCollectible(byId.get(id)!.kind));
        if (!context.aborted() && shouldAwaitVisibleCollectibleRescan(
          step,
          receipt,
          snapshot,
          terminalBatch,
          transientRescans,
        )) {
          const fresh = await this.waitForSnapshotAfter(
            snapshot.revision,
            VISIBLE_CLEAR_RESCAN_WAIT_MS,
          );
          if (!context.aborted() && sameCollectibleRun(snapshot, fresh)) {
            transientRescans += 1;
            continue;
          }
        }
        if (!context.aborted()
          && transientRescans >= MAX_COLLECT_STATE_TIMEOUT_RESCANS
          && isOrdinaryVisibleCollectTimeout(step, receipt, snapshot, terminalBatch)
          && sameCollectibleRun(snapshot, this.latest)) {
          return {
            outcome: 'partial',
            text: `${collected > 0 ? `此前已收集 ${collected} 个；` : ''}阳光或资源点击已送达，但收集状态连续超时；已释放输入并继续后续步骤`,
          };
        }
        return {
          ...result,
          text: `${collected > 0 ? `此前已收集 ${collected} 个；` : ''}${result.text}`,
        };
      }
      const batch = receipt.batch?.requested === ids.length ? receipt.batch : null;
      const verified = batch?.verified ?? ids.length;
      collected += verified;
      verifiedPasses += 1;
      if (verified < ids.length) {
        return {
          outcome: 'partial',
          text: `已确认收集 ${collected} 个${collectibleLabel(step.what)}；本批确认 ${verified}/${ids.length} 个`
            + `${batch && batch.stale > 0 ? `，${batch.stale} 个在点击前已消失` : ''}`,
        };
      }
      if (step.until === 'once' || step.what === 'usable_seed') {
        return { outcome: 'done', text: `已收集 ${collected} 个${collectibleLabel(step.what)}` };
      }
    }
    return {
      outcome: 'partial',
      text: `连续收集 ${collected} 个${collectibleLabel(step.what)}后仍有新目标出现`,
    };
  }

  /**
   * 一趟自动收阳光:收下手那一刻看得见的那一批,一次原生批量点击。
   *
   * 这一批执行期间落下的阳光由下一趟接住,不在这里循环重扫——循环会让内部光标被无限
   * 续用,而光标是模型种植和铲除唯一的通道。
   */
  private async executeSunSweep(): Promise<PvzStepResult> {
    const snapshot = this.latest;
    if (!snapshot || !sunSweepable(snapshot)) {
      return { outcome: 'noop', text: '棋盘此刻不接受自动收取' };
    }
    const ids = selectSunIds(snapshot.board);
    if (!ids.length) return { outcome: 'noop', text: '场上没有可见阳光' };
    const kinds = snapshot.board.collectibles
      .filter((item) => ids.includes(item.id))
      .map((item) => item.kind);
    const sunBefore = snapshot.board.sun;
    const receipt = await this.requireRuntime().act(
      { kind: 'collect', ids },
      pvzCollectExecutionBudgetMs(
        ids.length,
        this.options.cfg.cursorDurationMs[1],
        this.options.cfg.actionTimeoutMs,
      ),
    );
    const result = this.semanticReceipt(receipt, `已收取 ${ids.length} 份阳光`);
    // 每一趟都记下点了哪几颗、什么种类、阳光涨了多少:一颗一颗对得上,才能说清哪一种没收着。
    this.host?.log.info('PvZ 自动收阳光', {
      lane: this.sweepingBetweenSteps ? 'between_steps' : 'task',
      ids,
      kinds,
      outcome: result.outcome,
      batch: receipt.batch ?? null,
      sunBefore,
      sunAfter: this.latest?.board?.sun ?? null,
      evidence: receipt.evidence,
    });
    this.recordSunSweep(result.outcome === 'done', receipt);
    return result;
  }

  /** 连着收不到才值得说话:单次落空是掉落物寿命，连续落空多半是界面或窗口卡住了。 */
  private recordSunSweep(collected: boolean, receipt: PvzActionReceipt): void {
    if (collected) {
      this.sunSweepFailures = 0;
      return;
    }
    if (receipt.evidence.length > 0
      && receipt.evidence.every((item) => SUN_SWEEP_VANISHED.has(item))) return;
    this.sunSweepFailures += 1;
    this.host?.log.warn('PvZ 自动收阳光落空', {
      failures: this.sunSweepFailures,
      evidence: receipt.evidence,
    });
    const host = this.host;
    if (!host || this.sunSweepFailures !== SUN_SWEEP_ALARM_FAILURES) return;
    host.pushEvent(
      {
        ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'),
        source: this.id,
        type: 'pvz.sun.stuck',
        text: `[PvZ] 自动收阳光连续 ${SUN_SWEEP_ALARM_FAILURES} 次没有收到（${
          readReceiptEvidence(receipt.evidence).text}）；`
          + '场上的阳光还在，先确认界面或窗口是不是卡住了。',
        senderKey: 'pvz-auto-sun',
      },
      { trigger: 'debounce' },
    ).catch((error) => host.log.warn('PvZ 自动收阳光告警投递失败', { error: String(error) }));
  }

  /**
   * 阳光在场就排一趟收取,不看模型在做什么:内部光标忙着的时候这一趟排在队里等,
   * 不打断正在执行的任务。
   *
   * 判据是「场上还有阳光」而不是「这一份快照里新落了阳光」:上一趟被撤掉、被替换,
   * 或者那会儿光标正拿着种子包,先前那颗阳光就得等下一颗落下来才有人管,而它的寿命
   * 等不到——浓雾夜里阳光菇是唯一的进项,一颗 15 点的小阳光就这么放没了。
   */
  private armSunSweep(snapshot: PvzSnapshot): void {
    if (this.sunSweepTaskId !== null || !sunSweepable(snapshot)) return;
    if (Date.now() < this.sunSweepRetryAtMs) return;
    if (!selectSunIds(snapshot.board).length) return;
    this.sunSweepTaskId = this.executor.submitInternal([{ skill: 'auto_sun' }]);
  }

  private onSunSweepReport(report: PvzTaskReport): void {
    if (this.sunSweepTaskId !== report.taskId) return;
    this.sunSweepTaskId = null;
    // 收着了就接着收这批执行期间新落的。没收着就退避一下再来:阳光还在场上,但一颗
    // 点不动的阳光会把光标一趟趟占掉,而光标是模型种植和铲除唯一的通道。
    if (report.kind === 'done') {
      this.sunSweepRetryAtMs = 0;
      const snapshot = this.latest;
      if (snapshot) this.armSunSweep(snapshot);
      return;
    }
    const delayMs = sunSweepRetryDelayMs(this.sunSweepFailures);
    this.sunSweepRetryAtMs = Date.now() + delayMs;
    if (this.sunSweepRetryTimer) clearTimeout(this.sunSweepRetryTimer);
    this.sunSweepRetryTimer = setTimeout(() => {
      this.sunSweepRetryTimer = null;
      const snapshot = this.latest;
      if (snapshot) this.armSunSweep(snapshot);
    }, delayMs);
    this.sunSweepRetryTimer.unref?.();
  }

  /**
   * 步与步之间把地上的阳光收掉。一份队列能跑上半分钟,期间落下的阳光等不到队列跑完:
   * 内部任务排在模型任务之前,但不抢占正在执行的那一项。第一步不收,那会耽误她刚下的决定。
   */
  private async sweepSunBetweenSteps(
    step: PvzDoStep,
    context: PvzExecutionContext,
  ): Promise<void> {
    if (step.skill === 'auto_sun' || context.stepIndex === 0 || this.sweepingBetweenSteps) return;
    const snapshot = this.latest;
    if (!snapshot || !sunSweepable(snapshot) || !selectSunIds(snapshot.board).length) return;
    this.sweepingBetweenSteps = true;
    try {
      await this.executeSunSweep();
    } catch (error) {
      this.host?.log.warn('PvZ 步间收阳光出错', { error: String(error) });
    } finally {
      this.sweepingBetweenSteps = false;
    }
  }

  private async executeWhackBatchTask(
    step: Extract<PvzDoStep, { skill: 'special' }>,
    context: PvzExecutionContext,
  ): Promise<PvzStepResult> {
    const scope = (step as BoundWhackStep).binding;
    const binding = await this.waitForWhackSkillTarget(scope, context);
    if (binding.kind !== 'ready') {
      return { outcome: 'yield', text: binding.text };
    }
    const action: PvzNativeAction = {
      kind: 'special', action: 'whack', targetIds: binding.targetIds,
      expectedLevel: scope.level,
    };
    const count = binding.targetIds.length;
    const timeoutMs = pvzWhackExecutionBudgetMs(
      count,
      this.options.cfg.cursorDurationMs[1],
      this.options.cfg.actionTimeoutMs,
    );
    this.activeWhackBatchTaskId = context.taskId;
    let result: PvzStepResult;
    try {
      const receipt = await this.requireRuntime().act(action, timeoutMs);
      const progress = receipt.batch;
      const matchingProgress = progress?.requested === count ? progress : null;
      const releasedInputs = matchingProgress !== null
        && matchingProgress.released === matchingProgress.attempted;
      const fullyAccountedTargets = matchingProgress !== null
        && matchingProgress.attempted + matchingProgress.stale === matchingProgress.requested;
      const boundedLocalOutcome = matchingProgress !== null
        && releasedInputs
        && (fullyAccountedTargets || matchingProgress.scopeStopped);
      const completeVerification = matchingProgress !== null
        && matchingProgress.verified === matchingProgress.requested;
      if (matchingProgress && (completeVerification || boundedLocalOutcome)) {
        if (receipt.status !== 'verified'
          || matchingProgress.verified < matchingProgress.requested
          || matchingProgress.scopeStopped) {
          const noObservedEffect = matchingProgress.attempted - matchingProgress.verified;
          result = {
            outcome: 'partial',
            text: `第 ${context.stepIndex + 1}/${context.stepCount} 个锤击步骤部分完成：确认受击 ${matchingProgress.verified}/${matchingProgress.requested}`
              + `，实际尝试 ${matchingProgress.attempted} 个`
              + `，确认释放 ${matchingProgress.released} 次`
              + `${noObservedEffect > 0 ? `，${noObservedEffect} 次点击未观察到受击变化` : ''}`
              + `${matchingProgress.stale > 0 ? `，${matchingProgress.stale} 个在执行前已离开可锤击状态` : ''}`
              + `${matchingProgress.scopeStopped ? '；关卡已经切换，本批剩下的动作停了' : ''}`,
          };
        } else {
          result = {
            outcome: 'done',
            text: `第 ${context.stepIndex + 1}/${context.stepCount} 个锤击步骤已确认受击 ${matchingProgress.verified}/${matchingProgress.requested}`,
          };
        }
        if ((receipt.status !== 'verified' || matchingProgress.scopeStopped)
          && boundedLocalOutcome
          && !context.aborted()) {
          await this.waitForSnapshotAfter(
            receipt.afterRevision ?? receipt.beforeRevision,
            WHACK_STALE_SNAPSHOT_WAIT_MS,
          );
        }
      } else if (matchingProgress) {
        const unreleased = matchingProgress.attempted - matchingProgress.released;
        const unaccounted = matchingProgress.requested
          - matchingProgress.attempted
          - matchingProgress.stale;
        result = {
          outcome: 'unverified',
          text: `锤击批次未形成可继续边界：请求 ${matchingProgress.requested} 个，实际尝试 ${matchingProgress.attempted} 个，确认释放 ${matchingProgress.released} 次，确认命中 ${matchingProgress.verified} 个，执行前消失 ${matchingProgress.stale} 个`
            + `${unreleased > 0 ? `；${unreleased} 次输入未确认释放` : ''}`
            + `${unaccounted > 0 ? `；${unaccounted} 个目标未记账` : ''}`,
        };
      } else if (receipt.status === 'verified') {
        result = {
          outcome: 'unverified',
          text: '锤击批次缺少与本次技能队列一致的结构化执行计数',
        };
      } else {
        result = this.semanticReceipt(
          receipt,
          `第 ${context.stepIndex + 1}/${context.stepCount} 个锤击步骤已确认受击效果（请求 ${count} 个可见目标）`,
        );
      }
    } finally {
      if (this.activeWhackBatchTaskId === context.taskId) {
        this.activeWhackBatchTaskId = null;
      }
    }
    if (result.outcome !== 'blocked' && result.outcome !== 'unverified' && !context.aborted()) {
      await this.openWhackPrefetch(context, scope);
    }
    return result;
  }

  private async waitForWhackSkillTarget(
    scope: WhackQueueScope,
    context: PvzExecutionContext,
  ): Promise<Exclude<WhackSkillProbe, { kind: 'wait' }>> {
    const waitMs = Math.min(
      WHACK_SKILL_TARGET_WAIT_MS,
      Math.max(150, this.options.cfg.actionTimeoutMs),
    );
    const deadline = Date.now() + waitMs;
    while (true) {
      if (context.aborted()) {
        return { kind: 'boundary', text: context.abortedBy() ?? '锤击技能队列已停止' };
      }
      const probe = this.probeWhackSkillTarget(scope);
      if (probe.kind !== 'wait') return probe;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          kind: 'boundary',
          text: `第 ${context.stepIndex + 1}/${context.stepCount} 个锤击步骤在 ${waitMs}ms 内没有等到新的可见批次`,
        };
      }
      const fresh = await this.waitForSnapshotAfter(probe.revision, Math.min(remaining, 100));
      if (!fresh && Date.now() >= deadline) {
        return {
          kind: 'boundary',
          text: `第 ${context.stepIndex + 1}/${context.stepCount} 个锤击步骤在 ${waitMs}ms 内没有等到新的可见批次`,
        };
      }
    }
  }

  private probeWhackSkillTarget(scope: WhackQueueScope): WhackSkillProbe {
    const snapshot = this.latest;
    if (!snapshot) {
      return { kind: 'boundary', text: '锤击技能队列绑定的关卡运行已经结束或切换' };
    }
    if (isTransientWhackSample(snapshot)) {
      return { kind: 'wait', revision: snapshot.revision };
    }
    if (!snapshotMatchesWhackScope(snapshot, scope)) {
      return { kind: 'boundary', text: '锤击技能队列绑定的关卡运行已经结束或切换' };
    }
    const board = snapshot.board!;
    const visible = board.special?.targets.some((target) =>
      target.action === 'whack' && target.kind === 'zombie' && target.id !== null) === true;
    if (!visible) return { kind: 'wait', revision: snapshot.revision };
    try {
      const action = resolveSemanticSpecialAction(board, {
        action: 'whack',
        targets: [{ kind: 'zombie', scope: 'all_visible' }],
      });
      const targetIds = action.kind === 'special' ? action.targetIds ?? [] : [];
      return targetIds.length > 0
        ? { kind: 'ready', targetIds: [...targetIds] }
        : { kind: 'wait', revision: snapshot.revision };
    } catch {
      return { kind: 'wait', revision: snapshot.revision };
    }
  }

  private async openWhackPrefetch(
    context: PvzExecutionContext,
    scope: WhackQueueScope,
  ): Promise<void> {
    if (this.activeWhackQueueTaskId !== context.taskId
      || this.bufferedWhackQueueTaskId !== null
      || this.whackPrefetchWindow !== null) return;
    const host = this.host;
    const snapshot = this.latest;
    if (!host || !snapshot || !snapshotMatchesWhackScope(snapshot, scope)) return;
    const cue = renderWhackPrefetchCue(snapshot, context.taskId);
    if (!cue) return;
    const window: WhackPrefetchWindow = {
      sourceTaskId: context.taskId,
      scope: { ...scope },
      openedAtMs: Date.now(),
      fallbackEligibleAtMs: null,
      lastFallbackAtMs: 0,
      fallbackPending: false,
    };
    this.whackPrefetchWindow = window;
    this.scheduleWhackPrefetchMaintenance(window, WHACK_PREFETCH_RETRY_MS);
    const previous = this.lastWhackTaskReport
      && this.lastWhackTaskReport.taskId !== context.taskId
      ? `[上一份锤击队列回执] ${renderWhackReportSummary(this.lastWhackTaskReport)}\n`
      : '';
    try {
      await host.pushEvent(
        {
          ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'),
          source: this.id,
          type: 'pvz.task.prefetch',
          text: `${previous}${cue}`,
          senderKey: `pvz-whack-prefetch-${context.taskId}`,
          origin: 'internal',
          ephemeral: true,
        },
        { trigger: 'flush' },
      );
    } catch (error) {
      if (this.whackPrefetchWindow === window) this.clearWhackPrefetchWindow(window);
      host.log.warn('PvZ 锤击队列预取投递失败', {
        taskId: context.taskId,
        error: String(error),
      });
    }
  }

  /** 当前快照里有没有这个菜单动作;没有就是没有,不当异常抛。 */
  private resolveMenuActionOrNull(action: unknown): PvzSnapshot['menu'][number] | null {
    try {
      return resolveSemanticMenuAction(this.requireSnapshot(), String(action));
    } catch {
      return null;
    }
  }

  private waitForSnapshotAfter(revision: number, timeoutMs: number): Promise<PvzSnapshot | null> {
    const current = this.latest;
    if (current && current.revision > revision) return Promise.resolve(current);
    const runtime = this.requireRuntime();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (snapshot: PvzSnapshot | null): void => {
        if (timer) clearTimeout(timer);
        runtime.removeListener('snapshot', onSnapshot);
        resolve(snapshot);
      };
      const onSnapshot = (snapshot: PvzSnapshot): void => {
        if (snapshot.revision > revision) finish(snapshot);
      };
      timer = setTimeout(() => {
        const latest = this.latest;
        finish(latest && latest.revision > revision ? latest : null);
      }, timeoutMs);
      timer.unref?.();
      runtime.on('snapshot', onSnapshot);
      const latest = this.latest;
      if (latest && latest.revision > revision) finish(latest);
    });
  }

  private semanticReceipt(receipt: PvzActionReceipt, success: string): PvzStepResult {
    if (receipt.status === 'verified') return { outcome: 'done', text: success };
    const text = this.receiptFailureText(receipt);
    return receipt.status === 'rejected'
      ? { outcome: 'blocked', text }
      : { outcome: 'unverified', text };
  }

  /**
   * 种植失败优先使用植入件报告的原因，缺失时才读取失败后的卡片与格子；事后状态可能已恢复，不能覆盖操作当时的证据。
   */
  private plantFailureText(
    receipt: PvzActionReceipt,
    slot: number,
    row: number,
    column: number,
  ): string {
    const native = receipt.evidence.reduce<PvzNativeReason | null>(
      (found, item) => found ?? pvzNativeReason(item), null);
    if (native) {
      const board = this.requireBoard(true);
      const card = board.cards.find((candidate) => candidate.slot === slot);
      const cell = native.text === CELL_REFUSED_TEXT && card
        ? plantCellFact(board, row, column, card.imitates ?? card.type)
        : null;
      return cell ? `${native.text}；${cell}` : native.text;
    }
    const observed = plantRejectionFacts(this.requireBoard(true), slot, row, column);
    return observed.length > 0 ? observed.join('；') : this.receiptFailureText(receipt);
  }

  private receiptFailureText(receipt: PvzActionReceipt): string {
    const { text, untranslated } = readReceiptEvidence(receipt.evidence);
    if (untranslated.length > 0) {
      this.host?.log.warn('PvZ 植入件原因缺中文映射', {
        action: receipt.action.kind,
        reasons: untranslated,
      });
    }
    return text;
  }

  private async cancelNativeInput(): Promise<void> {
    const timeoutMs = Math.min(5000, Math.max(500, this.options.cfg.actionTimeoutMs));
    const receipt = await this.requireRuntime().act({ kind: 'cancel' }, timeoutMs);
    if (receipt.status !== 'verified') {
      throw new Error('原生输入释放没有验真');
    }
  }

  private renderObservation(detail: 'summary' | 'full'): string {
    return [
      renderSnapshot(this.requireSnapshot(), detail),
      this.renderQueueStatus(),
    ].join('\n');
  }

  private renderQueueStatus(): string {
    const lines = [this.renderQueueLine()];
    if (this.lastTaskReport) lines.push(`[最近回执] ${this.lastTaskReport.text}`);
    return lines.join('\n');
  }

  private renderQueueLine(): string {
    return `[PvZ队列] ${renderPvzQueue(this.executor.status())}${this.triggers.render()}`;
  }

  /**
   * 传送带和保龄球棋盘上卡片从带子上来,用掉一张下一张才推过来,名字要等新快照才知道。
   * 一类卡能排几步,看带子上此刻有几张同类的:同类之间没有分别,落点由步骤自己给。
   * 在途的队列与已武装的触发器一起算。只算模型自己的活,World 收阳光不碰卡。
   */
  private requireConveyorCardBudget(board: PvzBoardState | null, steps: readonly PvzDoStep[]): void {
    if (!board || !isConveyorBoard(board)) return;
    const adding = conveyorCardDemand(board, steps);
    if (adding.size === 0) return;
    const pending = conveyorCardDemand(board, [
      ...this.executor.pendingSteps(),
      ...this.triggers.list().flatMap((trigger) => trigger.steps),
    ]);
    for (const [key, count] of adding) {
      const inFlight = pending.get(key) ?? 0;
      const available = board.cards.filter((card) => conveyorCardKey(card) === key).length;
      if (inFlight + count <= available) continue;
      const held = inFlight > 0 ? `，在途的队列与触发器已经占了 ${inFlight} 张` : '';
      throw new Error(
        `传送带上「${conveyorCardLabel(board, key)}」此刻有 ${available} 张，这次要 ${count} 张${held}`
        + '；等前面那些落定并收到新快照再排',
      );
    }
  }

  /** 触发器的四种结局都作为事件投出;打响那条随后还会有那份队列自己的 pvz.task。 */
  private onTriggerReport(report: PvzTriggerReport): void {
    const host = this.host;
    if (!host) return;
    host.pushEvent(
      {
        ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'),
        source: this.id,
        type: 'pvz.trigger',
        text: report.text,
        senderKey: `pvz.trigger.${report.triggerId}`,
        meta: { triggerId: report.triggerId, outcome: report.outcome },
      },
      { trigger: report.outcome === 'fired' ? 'flush' : 'debounce' },
    ).catch((error) => host.log.warn('PvZ 触发器事件投递失败', {
      triggerId: report.triggerId,
      error: String(error),
    }));
  }

  private onTaskReport(report: PvzTaskReport): void {
    this.lastTaskReport = report;
    const whackScope = this.whackTaskScopes.get(report.taskId);
    if (whackScope) {
      this.onWhackTaskReport(report, whackScope);
      return;
    }
    const host = this.host;
    if (!host) return;
    const onWhackBoard = this.latest !== null && isWhackSnapshot(this.latest);
    if (this.latest && !onWhackBoard) this.queueBoardSnapshot(host, this.latest, true);
    const whackState = onWhackBoard && !this.hasWhackPipeline() && this.latest
      ? renderWhackTaskState(this.latest)
      : null;
    const queueStatus = `[回执时队列] ${renderPvzQueue(this.executor.status())}`;
    const currentScreen = this.latest && !this.latest.board
      ? `\n${renderSnapshot(this.latest, 'summary')}`
      : '';
    const fresh = whackState === null ? currentScreen : `\n${whackState}`;
    const text = `${report.text}\n${queueStatus}${fresh}`;
    host.pushEvent(
      {
        ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'),
        source: this.id,
        type: 'pvz.task',
        text,
        senderKey: `pvz.task.${report.taskId}`,
        meta: { taskId: report.taskId, terminal: report.kind, steps: report.steps },
      },
      {
        trigger: report.kind === 'cancelled' ? 'debounce' : 'flush',
      },
    ).catch((error) => host.log.warn('PvZ 任务回执投递失败', {
      taskId: report.taskId,
      error: String(error),
    }));
  }

  private onWhackTaskReport(report: PvzTaskReport, scope: WhackQueueScope): void {
    this.lastWhackTaskReport = report;
    this.whackTaskScopes.delete(report.taskId);
    if (this.bufferedWhackQueueTaskId === report.taskId) {
      this.bufferedWhackQueueTaskId = null;
    }
    if (this.activeWhackQueueTaskId === report.taskId) {
      this.activeWhackQueueTaskId = this.bufferedWhackQueueTaskId;
      this.bufferedWhackQueueTaskId = null;
    }
    if (this.whackPrefetchWindow?.sourceTaskId === report.taskId
      && (report.kind === 'cancelled'
        || !this.latest
        || (!isTransientWhackSample(this.latest)
          && !snapshotMatchesWhackScope(this.latest, scope)))) {
      this.clearWhackPrefetchWindow(this.whackPrefetchWindow);
    }

    const host = this.host;
    if (!host) return;
    if (this.latest?.board) this.lastDeferredKey = snapshotKey(this.latest);
    const state = this.latest && snapshotMatchesWhackScope(this.latest, scope)
      ? renderWhackTaskState(this.latest)
      : null;
    const text = `${report.text}\n[PvZ队列] ${renderPvzQueue(this.executor.status())}`
      + (state ? `\n${state}` : '');
    host.pushEvent(
      {
        ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'),
        source: this.id,
        type: 'pvz.task',
        text,
        senderKey: `pvz.task.${report.taskId}`,
        origin: 'internal',
        ephemeral: true,
      },
      { deliver: false, trigger: 'piggyback' },
    ).catch((error) => host.log.warn('PvZ 锤击队列回执归档失败', {
      taskId: report.taskId,
      error: String(error),
    }));

    if (!this.hasWhackPipeline()) {
      this.whackTargetSuppressed = false;
      if (!this.stopping && report.kind !== 'cancelled' && this.latest
        && renderWhackTargetReady(this.latest) !== null) {
        this.queueWhackTarget(host);
      }
    } else if (this.activeWhackQueueTaskId === null
      && this.bufferedWhackQueueTaskId === null
      && this.whackPrefetchWindow?.sourceTaskId === report.taskId) {
      const window = this.whackPrefetchWindow;
      this.armWhackPrefetchFallback(window);
      this.queueWhackPrefetchFallback(host, window);
    }
  }

  private onSnapshot(snapshot: PvzSnapshot, before: PvzSnapshot | null): void {
    if (isWhackSnapshot(snapshot)
      && (!before || !isWhackSnapshot(before)
        || before.board?.runId !== snapshot.board?.runId
        || before.board?.level !== snapshot.board?.level)) {
      this.lastWhackTaskReport = null;
    }
    this.latest = snapshot;
    this.connected = true;
    this.executor.wake();
    this.triggers.evaluate(snapshot);
    this.armSunSweep(snapshot);
    const host = this.host;
    if (!host) return;
    const prefetchWindow = this.whackPrefetchWindow;
    if (prefetchWindow && !isTransientWhackSample(snapshot)) {
      if (!snapshotMatchesWhackScope(snapshot, prefetchWindow.scope)) {
        this.clearWhackPrefetchWindow(prefetchWindow);
        if (!this.hasWhackPipeline() && renderWhackTargetReady(snapshot) !== null) {
          this.whackTargetSuppressed = false;
          this.queueWhackTarget(host);
        }
      } else {
        this.maintainWhackPrefetchWindow(prefetchWindow);
      }
    }
    const events = trackSnapshot(snapshot, before, this.eventMemory);
    const whackEventLoop = isWhackSnapshot(snapshot)
      || (before !== null && isWhackSnapshot(before));
    this.prepareRoutineEventWindow(snapshot);
    const delivered: PvzTrackedEvent[] = [];
    const archived: PvzTrackedEvent[] = [];
    let queueWhackTargetEvent = false;
    for (const event of events) {
      if (event.type === 'pvz.target.ready') {
        if (whackEventLoop
          && this.activeWhackBatchTaskId === null
          && !this.hasWhackPipeline()) {
          this.whackTargetSuppressed = false;
          queueWhackTargetEvent = true;
        } else {
          if (whackEventLoop) this.whackTargetSuppressed = true;
          archived.push(event);
        }
        continue;
      }
      if (whackEventLoop && WHACK_TACTICAL_ARCHIVE_ONLY_EVENTS.has(event.type)) {
        archived.push(event);
        continue;
      }
      // 例行的「卡片可用」只是快照卡片行的复述:落库可查,不进上下文。
      // 带新卡身份到来(传送带)或锤僵尸棋盘的那种是 urgent,照常投递。
      if (event.type === 'pvz.card.ready' && !event.urgent) {
        archived.push(event);
        continue;
      }
      if (!event.routineKey || this.claimRoutineEvent(event)) {
        delivered.push(event);
        continue;
      }
      archived.push(event);
    }

    const whackTargetSharesBatch = queueWhackTargetEvent && delivered.length > 0;
    if (queueWhackTargetEvent) {
      this.queueWhackTarget(host, whackTargetSharesBatch ? 'piggyback' : 'flush');
    }
    const whackTargetCarriesSnapshot = whackEventLoop && this.whackTargetPending;
    if (this.options.cfg.emitBoardDeltas && (snapshot.board || delivered.length > 0)
      && !whackTargetCarriesSnapshot
      && (!whackEventLoop || delivered.length > 0)) {
      // 棋盘可见、没有锤击流水线时,快照按节拍 flush:这就是对局中的定时唤醒。
      const wake = snapshot.screen === 'board'
        && this.activeWhackBatchTaskId === null
        && !this.hasWhackPipeline()
        && Date.now() - this.lastBoardWakeAt >= BOARD_WAKE_INTERVAL_MS;
      if (this.queueBoardSnapshot(host, snapshot, false, wake ? 'flush' : 'piggyback') && wake) {
        this.lastBoardWakeAt = Date.now();
      }
    }
    for (const event of archived) {
      this.pushTrackedEvent(host, event, { deliver: false });
    }

    // Flush only after every fact from this sample is queued, preserving their order.
    const flushBatch = whackTargetSharesBatch || delivered.some(event => event.urgent);
    for (let index = 0; index < delivered.length; index++) {
      const event = delivered[index]!;
      this.pushTrackedEvent(host, event, {
        trigger: flushBatch
          ? index === delivered.length - 1 ? 'flush' : 'piggyback'
          : pvzEventTrigger(event),
      });
    }

  }

  private prepareRoutineEventWindow(snapshot: PvzSnapshot): void {
    const scope = `${snapshot.screen}:${snapshot.mode}:${snapshot.board?.runId ?? 'none'}`;
    if (scope !== this.routineEventScope || snapshot.monotonicMs < this.routineEventMonotonicMs) {
      this.recentRoutineEvents.clear();
      this.routineEventScope = scope;
    }
    this.routineEventMonotonicMs = snapshot.monotonicMs;
    for (const [key, atMs] of this.recentRoutineEvents) {
      if (snapshot.monotonicMs - atMs >= ROUTINE_EVENT_WINDOW_MS) {
        this.recentRoutineEvents.delete(key);
      }
    }
  }

  private claimRoutineEvent(event: PvzTrackedEvent): boolean {
    const key = `${event.type}:${event.routineKey}`;
    if (this.recentRoutineEvents.has(key)) return false;
    this.recentRoutineEvents.set(key, this.routineEventMonotonicMs);
    return true;
  }

  private pushTrackedEvent(
    host: WorldHost,
    event: PvzTrackedEvent,
    options: { trigger?: 'flush' | 'debounce' | 'piggyback'; deliver?: boolean },
  ): void {
    host.pushEvent(
      {
        ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'),
        source: this.id,
        type: event.type,
        text: event.text,
        senderKey: event.senderKey ?? 'pvz',
        meta: {
          snapshotRevision: this.latest?.revision,
          snapshotMonotonicMs: this.latest?.monotonicMs,
          boardRunId: this.latest?.board?.runId ?? null,
        },
      },
      options,
    ).catch((error) => host.log.warn('PvZ 事件投递失败', { type: event.type, error: String(error) }));
  }

  /** 返回是否真的挂了单:同一份快照已在途或与上次投出的相同时不重复挂。 */
  private queueBoardSnapshot(
    host: WorldHost,
    snapshot: PvzSnapshot,
    force = false,
    trigger: 'piggyback' | 'flush' = 'piggyback',
  ): boolean {
    if (this.boardSnapshotPending || !force && snapshotKey(snapshot) === this.lastDeferredKey) return false;
    this.boardSnapshotPending = true;
    const ticket = ++this.boardSnapshotTicket;
    host.pushDeferred(
      {
        type: 'pvz.board.snapshot',
        senderKey: 'pvz.board',
        tags: ['snapshot'],
        render: async () => {
          if (ticket !== this.boardSnapshotTicket) return null;
          try {
            const text = await this.renderFreshBoardSnapshot();
            this.lastBoardWakeAt = Date.now();
            return ticket === this.boardSnapshotTicket ? text : null;
          } catch (error) {
            return `[PvZ] 当前状态刷新失败：${String(error)}。请用 pvz_observe 重读后再规划。`;
          } finally {
            if (ticket === this.boardSnapshotTicket) this.boardSnapshotPending = false;
          }
        },
      },
      { trigger },
    );
    return true;
  }

  private async renderFreshBoardSnapshot(): Promise<string> {
    const latest = await this.requireRuntime().readFreshSnapshot();
    this.lastDeferredKey = snapshotKey(latest);
    return [
      latest.board ? renderTacticalSnapshot(latest) : renderSnapshot(latest, 'summary'),
      this.renderQueueLine(),
    ].join('\n');
  }

  private queueWhackTarget(host: WorldHost, trigger: 'flush' | 'piggyback' = 'flush'): void {
    if (this.whackTargetPending) return;
    this.whackTargetPending = true;
    const ticket = ++this.whackTargetTicket;
    host.pushDeferred(
      {
        type: 'pvz.target.ready',
        senderKey: 'pvz.target',
        render: async () => {
          if (ticket !== this.whackTargetTicket) return null;
          try {
            if (this.activeWhackBatchTaskId !== null || this.hasWhackPipeline()) return null;
            const snapshot = await this.requireRuntime().readFreshSnapshot();
            if (ticket !== this.whackTargetTicket
              || this.activeWhackBatchTaskId !== null || this.hasWhackPipeline()) return null;
            const cue = renderWhackTargetReady(snapshot);
            if (!cue) return null;
            return this.lastWhackTaskReport
              ? `[上一份锤击队列回执] ${renderWhackReportSummary(this.lastWhackTaskReport)}\n${cue}`
              : cue;
          } finally {
            if (ticket === this.whackTargetTicket) this.whackTargetPending = false;
          }
        },
      },
      { trigger },
    );
  }

  private queueWhackPrefetchFallback(
    host: WorldHost,
    window: WhackPrefetchWindow,
  ): void {
    if (this.whackPrefetchWindow !== window
      || window.fallbackPending
      || window.lastFallbackAtMs !== 0
      || window.fallbackEligibleAtMs === null
      || Date.now() < window.fallbackEligibleAtMs
      || this.activeWhackQueueTaskId !== null
      || this.bufferedWhackQueueTaskId !== null
      || !this.latest
      || !snapshotMatchesWhackScope(this.latest, window.scope)) return;
    const cue = renderWhackPrefetchCue(this.latest, window.sourceTaskId, 'idle');
    if (!cue) return;
    window.fallbackPending = true;
    window.lastFallbackAtMs = Date.now();
    const text = this.lastWhackTaskReport
      ? `[上一份锤击队列回执] ${renderWhackReportSummary(this.lastWhackTaskReport)}\n${cue}`
      : cue;
    host.pushEvent(
      {
        ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'),
        source: this.id,
        type: 'pvz.task.prefetch',
        text,
        senderKey: `pvz-whack-prefetch-fallback-${window.sourceTaskId}`,
        origin: 'internal',
        ephemeral: true,
      },
      { trigger: 'flush' },
    ).then(() => {
      if (this.whackPrefetchWindow !== window) return;
      window.fallbackPending = false;
      this.scheduleWhackPrefetchMaintenance(window, WHACK_PREFETCH_RETRY_MS);
    }).catch((error) => {
      if (this.whackPrefetchWindow === window) {
        window.fallbackPending = false;
        window.lastFallbackAtMs = 0;
        this.scheduleWhackPrefetchMaintenance(window, WHACK_PREFETCH_RETRY_MS);
      }
      host.log.warn('PvZ 锤击预取恢复投递失败', {
        taskId: window.sourceTaskId,
        error: String(error),
      });
    });
  }

  private armWhackPrefetchFallback(window: WhackPrefetchWindow): void {
    if (this.whackPrefetchWindow !== window || window.lastFallbackAtMs !== 0) return;
    if (window.fallbackEligibleAtMs === null) {
      window.fallbackEligibleAtMs = Date.now();
    }
  }

  private clearWhackPrefetchWindow(window: WhackPrefetchWindow): void {
    if (this.whackPrefetchWindow !== window) return;
    window.fallbackPending = false;
    this.whackPrefetchWindow = null;
    if (this.whackPrefetchRetryTimer) {
      clearTimeout(this.whackPrefetchRetryTimer);
      this.whackPrefetchRetryTimer = null;
    }
  }

  private scheduleWhackPrefetchMaintenance(
    window: WhackPrefetchWindow,
    delayMs: number,
  ): void {
    if (this.whackPrefetchWindow !== window) return;
    if (this.whackPrefetchRetryTimer) clearTimeout(this.whackPrefetchRetryTimer);
    const leaseRemainingMs = Math.max(0, this.whackPrefetchLeaseRemainingMs(window));
    this.whackPrefetchRetryTimer = setTimeout(() => {
      this.whackPrefetchRetryTimer = null;
      this.maintainWhackPrefetchWindow(window);
    }, Math.min(Math.max(0, delayMs), leaseRemainingMs));
    this.whackPrefetchRetryTimer.unref?.();
  }

  private maintainWhackPrefetchWindow(window: WhackPrefetchWindow): void {
    if (this.whackPrefetchWindow !== window) return;
    const host = this.host;
    const snapshot = this.latest;
    const leaseRemainingMs = this.whackPrefetchLeaseRemainingMs(window);
    if (!host || !snapshot || leaseRemainingMs <= 0) {
      this.clearWhackPrefetchWindow(window);
      if (host && snapshot && !this.hasWhackPipeline()
        && renderWhackTargetReady(snapshot) !== null) {
        this.whackTargetSuppressed = false;
        this.queueWhackTarget(host);
      }
      return;
    }
    if (isTransientWhackSample(snapshot)) {
      this.scheduleWhackPrefetchMaintenance(
        window,
        Math.min(WHACK_PREFETCH_RETRY_MS, leaseRemainingMs),
      );
      return;
    }
    if (!snapshotMatchesWhackScope(snapshot, window.scope)) {
      this.clearWhackPrefetchWindow(window);
      if (!this.hasWhackPipeline() && renderWhackTargetReady(snapshot) !== null) {
        this.whackTargetSuppressed = false;
        this.queueWhackTarget(host);
      }
      return;
    }
    if (this.activeWhackQueueTaskId === null
      && this.bufferedWhackQueueTaskId === null
      && window.lastFallbackAtMs === 0
      && !window.fallbackPending) {
      this.armWhackPrefetchFallback(window);
      if (window.fallbackEligibleAtMs !== null
        && Date.now() >= window.fallbackEligibleAtMs) {
        this.queueWhackPrefetchFallback(host, window);
      }
    }
    const fallbackDelayMs = window.lastFallbackAtMs !== 0 || window.fallbackPending
      ? WHACK_PREFETCH_RETRY_MS
      : window.fallbackEligibleAtMs === null
        ? WHACK_PREFETCH_RETRY_MS
        : Math.max(0, window.fallbackEligibleAtMs - Date.now());
    this.scheduleWhackPrefetchMaintenance(
      window,
      Math.min(WHACK_PREFETCH_RETRY_MS, fallbackDelayMs, leaseRemainingMs),
    );
  }

  private whackPrefetchLeaseRemainingMs(window: WhackPrefetchWindow): number {
    const openDeadlineMs = window.openedAtMs + WHACK_PREFETCH_LEASE_MS;
    const fallbackDeadlineMs = window.lastFallbackAtMs === 0
      ? 0
      : window.lastFallbackAtMs + WHACK_PREFETCH_FALLBACK_GRACE_MS;
    return Math.max(openDeadlineMs, fallbackDeadlineMs) - Date.now();
  }

  private resetEventDeliveryState(): void {
    this.boardSnapshotTicket += 1;
    this.lastDeferredKey = '';
    this.boardSnapshotPending = false;
    this.whackTargetPending = false;
    this.whackTargetTicket += 1;
    this.whackTargetSuppressed = false;
    this.routineEventScope = '';
    this.routineEventMonotonicMs = -1;
    this.recentRoutineEvents.clear();
    this.activeWhackBatchTaskId = null;
    this.activeWhackQueueTaskId = null;
    this.bufferedWhackQueueTaskId = null;
    const prefetchWindow = this.whackPrefetchWindow;
    if (prefetchWindow) this.clearWhackPrefetchWindow(prefetchWindow);
    else if (this.whackPrefetchRetryTimer) {
      clearTimeout(this.whackPrefetchRetryTimer);
      this.whackPrefetchRetryTimer = null;
    }
    this.whackTaskScopes.clear();
    this.lastWhackTaskReport = null;
    this.lastPvzDoTurnKey = null;
    this.sunSweepTaskId = null;
    this.sunSweepFailures = 0;
    this.sunSweepRetryAtMs = 0;
    if (this.sunSweepRetryTimer) {
      clearTimeout(this.sunSweepRetryTimer);
      this.sunSweepRetryTimer = null;
    }
  }

  private hasWhackPipeline(): boolean {
    return this.activeWhackQueueTaskId !== null
      || this.bufferedWhackQueueTaskId !== null
      || this.whackPrefetchWindow !== null
      || this.whackTaskScopes.size > 0;
  }

  private requireRuntime(): PvzRuntime {
    if (!this.runtime) throw new Error(this.lastError || 'PvZ 引擎子进程 未启动');
    return this.runtime;
  }

  private requireSnapshot(): PvzSnapshot {
    const snapshot = this.latest;
    if (!snapshot) throw new Error('尚未取得 PvZ 状态');
    return snapshot;
  }

  private requireBoard(allowDark = false) {
    const snapshot = this.requireSnapshot();
    if (snapshot.screen !== 'board') throw new Error('当前不在可操作棋盘');
    const board = snapshot.board;
    if (!board) throw new Error('当前不在可操作棋盘');
    if (!allowDark && !board.disclosure.entitiesVisible) {
      throw new Error('当前棋盘处于黑暗遮蔽阶段，等待可见快照后再操作');
    }
    return board;
  }
}

/**
 * 这一刻能不能由 World 自己去点阳光。
 *
 * 内部光标是独占的:光标上拿着种子包、铲子或锤子时,一次自动点击会把模型手里的动作
 * 弄没。特殊动作关卡(锤僵尸、禅境花园、传送带)整关都在争这支光标， World 不插手；
 * 已结算的这一场也不再动手。
 */
function sunSweepable(snapshot: PvzSnapshot): snapshot is PvzSnapshot & { board: PvzBoardState } {
  const board = snapshot.board;
  return snapshot.screen === 'board'
    && board !== null
    && !board.paused
    && board.cursor.kind === 'normal'
    && board.allowedSpecialActions.length === 0
    && !isWhackSnapshot(snapshot)
    && snapshot.lastRun?.runId !== board.runId;
}

function isLifecycleExit(target: string): boolean {
  const id = target.toLowerCase().replaceAll('-', '_');
  return id === 'close' || id === 'close_game' || id.startsWith('quit') || id.startsWith('exit');
}

function requiresFreshStateAfter(step: PvzDoStep): boolean {
  // 投掷坚果既不换画面也不改特殊阶段:带子往前挪一位,盘面照旧,所以一份队列里可以连着丢几颗。
  if (step.skill === 'special') return step.action !== 'bowling';
  return step.skill === 'interact'
    || step.skill === 'visual_click'
    || step.skill === 'profile_create'
    || step.skill === 'choose_seeds' && step.confirm
    || step.skill === 'collect' && step.what === 'award';
}

function isWhackStep(
  step: PvzDoStep,
): step is Extract<PvzDoStep, { skill: 'special' }> {
  return step.skill === 'special' && step.action === 'whack';
}

function isWhackAllVisibleStep(
  step: PvzDoStep,
): step is Extract<PvzDoStep, { skill: 'special' }> {
  if (!isWhackStep(step)) return false;
  const selectors = step.targets;
  return step.at === undefined
    && step.to === undefined
    && step.card === undefined
    && step.target === undefined
    && selectors?.length === 1
    && selectors[0]?.kind === 'zombie'
    && 'scope' in selectors[0]
    && selectors[0].scope === 'all_visible';
}

function whackScopeOf(snapshot: PvzSnapshot): WhackQueueScope {
  const board = snapshot.board;
  if (snapshot.screen !== 'board' || !board || !isWhackSnapshot(snapshot)) {
    throw new Error('当前不在实时锤击棋盘');
  }
  return { mode: snapshot.mode, runId: board.runId, level: board.level };
}

function sameWhackScope(left: WhackQueueScope, right: WhackQueueScope): boolean {
  return left.mode === right.mode && left.runId === right.runId && left.level === right.level;
}

function snapshotMatchesWhackScope(snapshot: PvzSnapshot, scope: WhackQueueScope): boolean {
  return snapshot.screen === 'board'
    && snapshot.board !== null
    && isWhackSnapshot(snapshot)
    && snapshot.mode === scope.mode
    && snapshot.board.runId === scope.runId
    && snapshot.board.level === scope.level;
}

function isTransientWhackSample(snapshot: PvzSnapshot): boolean {
  return snapshot.screen === 'loading' && snapshot.board === null;
}

function renderWhackReportSummary(report: PvzTaskReport): string {
  const outcomeName: Record<string, string> = {
    done: '完成', noop: '无变化', partial: '部分完成', yield: '暂空',
    blocked: '受阻', unverified: '未验真', cut: '截断', cancelled: '已取消',
  };
  const counts = new Map<string, number>();
  for (const step of report.steps) counts.set(step.outcome, (counts.get(step.outcome) ?? 0) + 1);
  const outcomes = [...counts]
    .map(([outcome, count]) => `${outcomeName[outcome] ?? outcome} ${count}`)
    .join('、');
  const last = report.steps.at(-1);
  return `任务#${report.taskId} ${outcomeName[report.kind] ?? report.kind}，已执行 ${report.steps.length}/${WHACK_SKILL_QUEUE_LENGTH} 个锤击步骤`
    + `${outcomes ? `（${outcomes}）` : ''}`
    + `${last ? `；末项：${last.text}` : ''}`;
}

function integerArg(value: unknown, name: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} 必须是 ${minimum}–${maximum} 的整数`);
  }
  return number;
}

interface RequestedSeed {
  seed: number;
  imitates?: number;
}

interface SeedReplacementPlan {
  actions: PvzNativeAction[];
  error: string | null;
}

function fixedSeedNames(picker: PvzSeedPickerState, ids: readonly number[]): string {
  return ids.map((id) => picker.choices.find((choice) => choice.id === id)?.name ?? String(id)).join(', ');
}

function fixedToggleError(
  picker: PvzSeedPickerState,
  desired: readonly RequestedSeed[],
): string | null {
  const fixed = desired
    .map((request) => request.seed)
    .filter((id) => picker.selected.includes(id)
      && picker.choices.some((choice) => choice.id === id && choice.fixed));
  return fixed.length
    ? `戴夫固定卡不能切换: ${fixedSeedNames(picker, fixed)}`
    : null;
}

function seedReplacementPlan(
  picker: PvzSeedPickerState,
  desired: readonly RequestedSeed[],
): SeedReplacementPlan {
  const fixed = picker.selected.filter((id) =>
    picker.choices.some((choice) => choice.id === id && choice.fixed));
  const desiredIds = desired.map((request) => request.seed);
  const missing = fixed.filter((id) => !desiredIds.includes(id));
  if (missing.length) {
    return {
      actions: [],
      error: `replace 必须保留戴夫固定卡: ${fixedSeedNames(picker, missing)}`,
    };
  }
  const achievableOrder = [
    ...fixed,
    ...desiredIds.filter((id) => !fixed.includes(id)),
  ];
  if (desiredIds.some((id, index) => achievableOrder[index] !== id)) {
    return {
      actions: [],
      error: `戴夫固定卡必须保持在卡槽前部并维持顺序: ${fixedSeedNames(picker, fixed)}`,
    };
  }
  const imitater = picker.choices.find((choice) => choice.id === 48);
  const sameOrder = desired.length === picker.selected.length
    && desired.every((request, index) => picker.selected[index] === request.seed
      && (request.imitates === undefined || imitater?.imitates === request.imitates));
  if (sameOrder) return { actions: [], error: null };
  return {
    actions: [
      ...picker.selected
        .filter((id) => !fixed.includes(id))
        .map((seed): PvzNativeAction => ({ kind: 'choose_seed', seed })),
      ...desired
        .filter((request) => !fixed.includes(request.seed))
        .map((request): PvzNativeAction => ({ kind: 'choose_seed', ...request })),
    ],
    error: null,
  };
}

function seedRequest(
  value: unknown,
  choices: readonly PvzSeedChoice[],
  profile: PvzProfileProgress | null,
): RequestedSeed {
  let seedValue = value;
  let imitates: number | undefined;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 2 || keys[0] !== 'imitates' || keys[1] !== 'plant'
      || plantTypeOf(record.plant) !== 48) {
      throw new Error('模仿者选卡必须是 { plant: "imitater", imitates: <基础植物> }');
    }
    const target = plantTypeOf(record.imitates);
    if (target === null || target > 39 || !seedAllowedByPublicProgress(profile, target)
      || !choices.some((choice) => choice.id === target && choice.state !== 'hidden')) {
      throw new Error(`模仿者不能模仿 ${String(record.imitates)}`);
    }
    seedValue = record.plant;
    imitates = target;
  }
  const seed = plantTypeOf(seedValue);
  if (seed === null) throw new Error(`未知植物 ${String(seedValue)}`);
  if (!seedAllowedByPublicProgress(profile, seed)) {
    throw new Error(`植物 ${String(seedValue)} 尚未由当前档案解锁`);
  }
  if (seed === 48 && imitates === undefined) {
    throw new Error('模仿者必须明确指定要模仿的基础植物');
  }
  const choice = choices.find((item) => item.id === seed && item.state !== 'hidden');
  if (!choice) throw new Error(`植物 ${String(seedValue)} 当前不可选`);
  return imitates === undefined ? { seed } : { seed, imitates };
}

function profileNameArg(value: unknown): string {
  if (typeof value !== 'string') throw new Error('name 必须是字符串');
  const name = value.trim();
  if (!name.length || name.length > 12) throw new Error('name 必须为 1–12 个 UTF-16 code units');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('name 不能包含控制字符');
  return name;
}

function collectibleLabel(what: Extract<PvzDoStep, { skill: 'collect' }>['what']): string {
  return ({
    sun: '阳光',
    coins: '金币',
    resources: '资源',
    award: '奖励',
    usable_seed: '可用种子包',
  })[what];
}

function unarmableMineThreat(board: PvzBoardState, row: number): PvzBoardState['zombies'][number] | null {
  if (!board.disclosure.entitiesVisible
    || board.mowers.some((mower) => mower.row === row)) return null;
  return board.zombies.find((zombie) =>
    !zombie.hypnotized
    && zombie.row === row
    && (zombie.xBand === 'near' || zombie.xBand === 'lawn')) ?? null;
}

function isConveyorBoard(board: PvzBoardState): boolean {
  return board.cards.length > 0 && board.cards.every((card) => card.cost === null);
}

function consumesConveyorCard(step: PvzDoStep): boolean {
  return step.skill === 'plant'
    || (step.skill === 'special' && step.action === 'bowling');
}

/** 一张卡的身份:类型加模仿对象。同身份的几张在游戏里没有分别。 */
function conveyorCardKey(card: PvzCard): string {
  return `${card.type}/${card.imitates ?? -1}`;
}

/** 一步要的那类卡。卡名可能带 ` #N` 次序后缀,那只是当前排位,去掉。 */
function conveyorCardKeyOfStep(board: PvzBoardState, step: PvzDoStep): string | null {
  if (step.skill === 'plant') {
    const imitater = typeof step.plant === 'object';
    const name = typeof step.plant === 'string' ? step.plant : step.plant.imitates;
    const type = plantTypeOf(name);
    if (type === null) return null;
    return imitater ? `${IMITATER_PLANT_TYPE}/${type}` : `${type}/-1`;
  }
  if (step.skill !== 'special' || step.action !== 'bowling') return null;
  if (typeof step.card !== 'string') return null;
  const base = step.card.replace(/\s*#\d+$/u, '').trim();
  const type = plantTypeOf(base);
  if (type !== null) return `${type}/-1`;
  const match = board.cards.find((card) =>
    cardDisplayNameOf(card.type, card.name) === base || card.name === base);
  return match ? conveyorCardKey(match) : null;
}

/** 这一批步骤按卡片身份要几张。认不出身份的步骤不计入:预算只对能数清的那些说话。 */
function conveyorCardDemand(
  board: PvzBoardState,
  steps: readonly PvzDoStep[],
): Map<string, number> {
  const demand = new Map<string, number>();
  for (const step of steps) {
    if (!consumesConveyorCard(step)) continue;
    const key = conveyorCardKeyOfStep(board, step);
    if (key === null) continue;
    demand.set(key, (demand.get(key) ?? 0) + 1);
  }
  return demand;
}

function conveyorCardLabel(board: PvzBoardState, key: string): string {
  const card = board.cards.find((candidate) => conveyorCardKey(candidate) === key);
  if (card) return cardDisplayNameOf(card.type, card.name);
  const [type, imitates] = key.split('/').map(Number);
  return imitates >= 0 ? `模仿者(${plantDisplayName(imitates)})` : plantDisplayName(type);
}

/**
 * 打回之后卡和格子的现状:冷却、阳光、占格。
 *
 * 只在植入件说不出原因时用得上,读数是打回之后重读的,不是按下去那一刻的。
 */
/** 荷叶、花盆只承载不占格;南瓜套在植物外;升级卡与咖啡豆本来就落在植物上。 */
const CARRIER_PLANT_TYPES = new Set([16, 33]);
const PUMPKIN_PLANT_TYPE = 30;
const PLANT_ON_PLANT_TYPES = new Set([35, 40, 41, 42, 43, 44, 45, 46]);
/** 植入件对这一格的通用说法;棋盘能读出具体是什么挡着时,把那条事实接在后面。 */
const IMITATER_PLANT_TYPE = 48;
const CELL_REFUSED_TEXT = '这一格不收这株植物';

const CARRIER_BLOCKERS: Readonly<Record<string, string>> = {
  requires_lily_pad: '荷叶', requires_flower_pot: '花盆',
};

function terrainWord(terrain: PvzBoardState['cells'][number]['terrain']): string {
  return ({ lawn: '草地', water: '水面', roof: '屋顶', unavailable: '不可用地格' })[terrain];
}

/** 这一格挡着这株植物的现状:站在那儿的植物,或者还没垫上的承载物。读的是此刻的棋盘。 */
function plantCellFact(
  board: PvzBoardState,
  row: number,
  column: number,
  type: number,
  carrierPending = false,
): string | null {
  if (PLANT_ON_PLANT_TYPES.has(type)) return null;
  const here = board.plants.filter((plant) => plant.row === row && plant.column === column);
  const sameLayer = CARRIER_PLANT_TYPES.has(type) || type === PUMPKIN_PLANT_TYPE
    ? here.filter((plant) => plant.type === type)
    : here.filter((plant) => !CARRIER_PLANT_TYPES.has(plant.type) && plant.type !== PUMPKIN_PLANT_TYPE);
  if (sameLayer.length > 0) {
    return `${cellText(row, column)}已有${sameLayer
      .map((plant) => plantDisplayNameOf(plant.type, plant.name)).join('+')}`;
  }
  if (CARRIER_PLANT_TYPES.has(type) || carrierPending) return null;
  const cell = board.cells.find((candidate) => candidate.row === row && candidate.column === column);
  const carrier = cell && CARRIER_BLOCKERS[cell.blocker ?? ''];
  return carrier
    ? `${cellText(row, column)}是${terrainWord(cell!.terrain)},还没有${carrier}`
    : null;
}

/**
 * 受理时逐步读一遍落点。她凭旧帧重提已经落地的步、或者把射手排在承载物前面时,回执当场
 * 说出那一格现在是什么样;同一份队列里更早的步骤已经垫上承载物的,不再提。只报事实,不撤步。
 */
function plantCellNotes(board: PvzBoardState, steps: readonly PvzDoStep[]): string[] {
  const notes: string[] = [];
  const carriersPlaced = new Set<string>();
  steps.forEach((step, index) => {
    if (step.skill !== 'plant' || typeof step.column !== 'number') return;
    const type = plantTypeOf(typeof step.plant === 'string' ? step.plant : step.plant.imitates);
    if (type === null) return;
    const key = `${step.row},${step.column}`;
    const fact = plantCellFact(board, step.row, step.column, type, carriersPlaced.has(key));
    if (CARRIER_PLANT_TYPES.has(type)) carriersPlaced.add(key);
    if (fact) notes.push(`第${index + 1}步 ${fact}`);
  });
  return notes;
}

function plantRejectionFacts(
  board: PvzBoardState,
  slot: number,
  row: number,
  column: number,
): string[] {
  const facts: string[] = [];
  const card = board.cards.find((candidate) => candidate.slot === slot);
  const cell = board.cells.find((candidate) => candidate.row === row && candidate.column === column);
  if (!card) facts.push('那张卡已经不在卡槽里了');
  else if (!card.ready) {
    facts.push(`这张卡又回到冷却里，还剩 ${card.cooldownRemainingSeconds.toFixed(1)} 秒`);
  } else if (!card.affordable) {
    facts.push(`阳光不够，这张卡要 ${card.cost ?? '?'} 点，现在有 ${board.sun} 点`);
  }
  if (cell && cell.playable === false) {
    facts.push(cell.blocker
      ? `${cellText(row, column)}被占住了：${blockerLabel(cell.blocker)}`
      : `${cellText(row, column)}这会儿不能种`);
  }
  return facts;
}

function screenText(screen: PvzSnapshot['screen']): string {
  return ({
    loading: '载入中', main_menu: '主菜单', seed_picker: '选卡界面', board: '棋盘',
    defeat: '失败结算', award: '奖励界面', credits: '制作人员', mode_selector: '模式选择',
    dialog: '对话框', unknown: '认不出来的界面',
  })[screen];
}

function isTransientConveyorPlantRejection(receipt: PvzActionReceipt): boolean {
  if (receipt.status !== 'rejected') return false;
  return receipt.evidence.some((item) => [
    'planting slot is not present in the seed bank',
    'planting slot does not hold the plant the action asked for',
    'planting seed packet is not active in the seed bank',
    'seed bank packet identity could not be verified',
    'failed to post seed-bank selection input',
  ].includes(item));
}

function shouldAwaitVisibleCollectibleRescan(
  step: Extract<PvzDoStep, { skill: 'collect' }>,
  receipt: PvzActionReceipt,
  before: PvzSnapshot,
  terminalBatch: boolean,
  rescans: number,
): boolean {
  const timeout = receipt.evidence.some((item) => item === COLLECT_STATE_TIMEOUT);
  const maxRescans = timeout ? MAX_COLLECT_STATE_TIMEOUT_RESCANS : MAX_VISIBLE_CLEAR_RESCANS;
  if (rescans >= maxRescans || step.until !== 'visible_clear'
    || step.what === 'award' || step.what === 'usable_seed' || terminalBatch) return false;
  if (before.screen !== 'board' || !before.board) return false;
  return receipt.evidence.some((item) => TRANSIENT_COLLECT_FAILURES.has(item));
}

function isOrdinaryVisibleCollectTimeout(
  step: Extract<PvzDoStep, { skill: 'collect' }>,
  receipt: PvzActionReceipt,
  before: PvzSnapshot,
  terminalBatch: boolean,
): boolean {
  return step.until === 'visible_clear'
    && step.what !== 'award'
    && step.what !== 'usable_seed'
    && !terminalBatch
    && before.screen === 'board'
    && before.board !== null
    && receipt.evidence.some((item) => item === COLLECT_STATE_TIMEOUT);
}

function sameCollectibleRun(before: PvzSnapshot | null, after: PvzSnapshot | null): boolean {
  return before?.screen === 'board' && before.board !== null
    && after?.screen === 'board' && after.board !== null
    && after.mode === before.mode && after.board.runId === before.board.runId;
}

function scrubInternalIds(item: string): string {
  return item
    .replace(/\b(?:action|target|object|entity|collectible)[_-]?id\s*[:=#]?\s*[0-9]+\b/giu, '内部目标')
    .replace(/\bslot\s*[:=#]?\s*[0-9]+\b/giu, '语义卡位')
    .replace(/\b0x[0-9a-f]+\b/giu, '内部地址')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * 回执正文:植入件的英文原因换成那一句确切中文,证据链自己写的中文原样带过。
 *
 * 译不出的一条老实报出来并回报给调用方 —— 编一句听着像解释的话比报个错更坏,
 * 而且映射一旦漂掉必须有人看得见。
 */
function readReceiptEvidence(items: readonly string[]): { text: string; untranslated: string[] } {
  const untranslated: string[] = [];
  const parts = items.map((item) => {
    const mapped = pvzNativeReason(item);
    if (mapped) return mapped.text;
    if (/[一-鿿]/u.test(item)) return scrubInternalIds(item);
    untranslated.push(item);
    return `植入件中止了这一步（原文：${scrubInternalIds(item)}）`;
  }).filter(Boolean);
  return { text: parts.join('；'), untranslated };
}
