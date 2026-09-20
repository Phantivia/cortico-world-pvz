import { fork, spawn, type ChildProcess } from 'node:child_process';
import { emitLogNote, logChildStdio } from 'cortico/core/ipc-logger.ts';
import { nowIso } from 'cortico/core/util.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  World,
  WorldHost,
  WorldConsoleDecl,
  ToolDef,
  ToolOutcome,
} from 'cortico/core/types.ts';
import { normalizePvzExecutablePath, PVZ_CONFIG_GROUP, type PvzConfigSection } from './config.ts';
import type {
  ChildToMain,
  EngineCast,
  EngineInitReply,
  EngineNote,
  EngineRequest,
  HostRequest,
  PvzOwnershipIdentity,
  PvzPhotoFrameReply,
} from './engine-ipc.ts';
import { PVZ_TOOL_DECLS } from './tools.ts';
import { PVZ_PANEL_DECLS } from './world.ts';
import { readWindowsProcessCreationTime } from './bridge.ts';
import { pvzActionCompletionBudgetMs } from './timing.ts';

const CHILD_ENTRY = fileURLToPath(new URL('./engine-child.ts', import.meta.url));
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
/** The definition passes the deployment's data directory; only a proxy built without one lands here. */
const DEFAULT_OWNERSHIP_DIRECTORY = join(tmpdir(), 'cortico-pvz-ownership');
const FRAME_TIMEOUT_MS = 15_000;
const INIT_TIMEOUT_MS = 3 * 60_000;
const DEFERRED_RENDER_TIMEOUT_MS = 2500;
const RESTART_DELAY_MS = 3000;
/**
 * 自动重启仅恢复 引擎子进程 掉线，并受滚动窗口次数上限限制；超限时停止并报告。游戏退出后保持未启动，等待操作员从控制台启动。
 */
const RESTART_MAX_ATTEMPTS = 4;
const RESTART_WINDOW_MS = 10 * 60_000;
const TASK_ID_GENERATION_STRIDE = 1_000_000;

export interface PvzWorldProxyOptions {
  cfg: PvzConfigSection;
  timezone?: string;
  botName?: string;
  ownershipDirectory?: string;
  engineFactory?: () => ChildProcess;
  ownerTokenFactory?: () => string;
  processCreationTimeReader?: (pid: number) => Promise<string | null>;
  targetProcessStateReader?: (executable: string) => Promise<PvzTargetProcessState>;
}

export type PvzTargetProcessState = 'absent' | 'present' | 'unknown';


export interface PvzGamePanelState {
  phase: 'stopped' | 'starting' | 'running' | 'recovering' | 'error';
  detail: string | null;
  pid: number | null;
  /** 现在按「停止」有事可做吗:有 引擎子进程、有可回收的租约,或正在启动。 */
  stoppable: boolean;
}

interface PendingRpc {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class PvzWorldProxy implements World {
  readonly id = 'pvz';

  private host: WorldHost | null = null;
  private child: ChildProcess | null = null;
  private spawnPromise: Promise<void> | null = null;
  private ready = false;
  private stopping = false;
  private generation = 0;
  private snapshotDeliveryEpoch = 0;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRpc>();
  private readonly outstandingTasks = new Map<number, number>();
  private readonly terminalTaskIds = new Set<number>();
  private configTimer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  /** 滚动窗口内已经重启过几次,以及上一次是什么时候(防重启风暴)。 */
  private restartCount = 0;
  private lastRestartAt = 0;
  private failureEpisode = false;
  private pendingRecoveryEvent: Extract<HostRequest, { kind: 'push' }> | null = null;
  private lastConfigJson = '';
  private ownershipIdentity: PvzOwnershipIdentity | null = null;
  private ownershipRecordPath: string | null = null;
  private startingOwnerToken: string | null = null;
  private prelaunchFailureGeneration: number | null = null;
  private declCache: Pick<WorldConsoleDecl, 'lamps' | 'badges' | 'links'> = {};
  private launchRequested = false;
  private launchError: string | null = null;
  /** 停在「未启动」时的原因(人按了停止 / 游戏自己没了),没有就是从没起过。 */
  private stoppedDetail: string | null = null;
  private readonly ownsGame: boolean;
  private readonly closeOwnedGameOnStop: boolean;

  constructor(private readonly options: PvzWorldProxyOptions) {
    this.ownsGame = options.cfg.launch;
    this.closeOwnedGameOnStop = this.ownsGame && options.cfg.closeOnStop;
  }

  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    const declarations = this.host?.modelFacts.accepts('image/jpeg') === true
      ? PVZ_TOOL_DECLS
      : PVZ_TOOL_DECLS.filter(({ name }) => name !== 'pvz_glance');
    return declarations.map((decl) => ({
      ...decl,
      handler: async (args, context) => {
        try {
          if (decl.name === 'pvz_glance') return await this.photoDirect();
          const generation = this.generation;
          const result = await this.rpc({
            kind: 'tool',
            name: decl.name,
            args,
            role: context.role,
            callId: context.callId ?? null,
            round: context.round ?? null,
          }, toolRpcTimeoutMs(decl.name, this.options.cfg, args));
          if (decl.name === 'pvz_do' && typeof result === 'string'
            && !result.startsWith('[pvz_do 失败]')) {
            this.trackAcceptedTask(result, generation);
          }
          return result as string;
        } catch (error) {
          return `[${decl.name} 失败] PvZ 引擎子进程 不可用: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    }));
  }

  console(): WorldConsoleDecl {
    const game = this.gamePanelState();
    return {
      lamps: this.declCache.lamps ?? [
        {
          label: '引擎',
          state: game.phase === 'running' ? 'online'
            : game.phase === 'error' ? 'error'
              : ['starting', 'recovering'].includes(game.phase) ? 'loading' : 'offline',
          hint: game.detail ?? undefined,
        },
      ],
      badges: this.declCache.badges ?? [
        {
          label: 'PvZ',
          value: ({
            stopped: '未启动', starting: '启动中', running: '运行中', recovering: '恢复中', error: '启动失败',
          } as const)[game.phase],
          tone: game.phase === 'running' ? 'on' : 'off',
        },
      ],
      panels: [...PVZ_PANEL_DECLS],
      invoke: (panel, method) => this.invokePanel(panel, method),
      links: this.declCache.links ?? [],
      promptDocs: [
        {
          key: 'worlds.pvz.envPrompt',
          title: '植物大战僵尸 · 环境提示词',
          description: '语义状态、特殊关卡、验真与迷雾边界。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
      config: [PVZ_CONFIG_GROUP],
    };
  }

  onHandoffEnded(): void {
    const child = this.child;
    const host = this.host;
    if (!host || !child || !this.ready) return;
    const generation = this.generation;
    const epoch = ++this.snapshotDeliveryEpoch;
    host.pushDeferred({
      type: 'pvz.board.snapshot', senderKey: 'pvz.board', tags: ['snapshot'],
      render: async () => {
        if (this.child !== child || this.generation !== generation
          || this.snapshotDeliveryEpoch !== epoch) return null;
        try {
          return await this.rpcBound(child, generation, { kind: 'handoff-snapshot' }, DEFERRED_RENDER_TIMEOUT_MS) as string;
        } catch (error) {
          if (this.child !== child || this.generation !== generation) return null;
          host.log.warn('PvZ 交接后刷新失败', { error: String(error) });
          return '[PvZ] 交接后未能刷新当前状态，请用 pvz_observe 重读后再规划。';
        }
      },
    }, { trigger: 'flush' });
  }

  async start(host: WorldHost): Promise<void> {
    if (!this.ownsGame) {
      throw new Error('worlds-pvz 首次接入只支持由 World 启动游戏；PID 附加保留给所有权令牌恢复');
    }
    this.host = host;
    this.stopping = false;
    this.configTimer = setInterval(() => this.pushConfigIfChanged(), 1000);
    this.configTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const requested = this.launchRequested;
    this.clearLifecycleTimers();
    if (this.configTimer) clearInterval(this.configTimer);
    this.configTimer = null;
    try {
      await this.shutdownGame(requested);
    } finally {
      this.host = null;
    }
  }

  /**
   * 关掉这一局:引擎子进程 停机回执 → 目标进程退出 → 回收持久所有权记录。
   *
   * World 停机(`stop`)与控制台「停止」共用这一条,两边唯一的差别是后者把 World 留在
   * 挂载态。`requested` 是进来这一刻的 launchRequested:引擎子进程 已经不在、而游戏
   * 还活着时,要先按租约把 引擎子进程 拉回来才关得掉游戏。
   */
  private async shutdownGame(requested: boolean): Promise<void> {
    let failure: Error | null = null;
    let shutdownConfirmed = !this.closeOwnedGameOnStop;
    try {
      if (this.spawnPromise) await this.spawnPromise;
      if (!this.child && requested && this.closeOwnedGameOnStop
        && await this.hasRecoverableOwnership()) {
        await this.spawn();
      }
      const child = this.child;
      if (child) {
        try {
          await this.rpc({ kind: 'shutdown' }, 20_000);
          shutdownConfirmed = true;
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        await waitExit(child, 3000);
        if (child.exitCode === null && !child.killed) child.kill();
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      this.teardownChild(new Error('PvZ World 已停止'));
      this.outstandingTasks.clear();
      this.terminalTaskIds.clear();
      this.launchRequested = false;
    }
    if (this.closeOwnedGameOnStop && shutdownConfirmed) {
      const identity = this.ownershipIdentity;
      if (!identity || !this.ownershipRecordPath) {
        failure ??= new Error('PvZ 停机已回执，但缺少可核验的持久所有权身份');
      } else {
        if (!removeOwnershipRecord(this.ownershipRecordPath, identity)) {
          failure ??= new Error('PvZ 已退出，但持久所有权记录已被其他进程改写，拒绝清除');
        }
      }
      if (!failure) {
        this.ownershipIdentity = null;
        this.startingOwnerToken = null;
      }
    }
    if (failure) throw failure;
  }

  private spawn(): Promise<void> {
    if (this.spawnPromise) return this.spawnPromise;
    const operation = this.spawnOnce();
    const tracked = operation.finally(() => {
      if (this.spawnPromise === tracked) this.spawnPromise = null;
    });
    this.spawnPromise = tracked;
    return tracked;
  }

  private async spawnOnce(): Promise<void> {
    const generation = ++this.generation;
    this.terminalTaskIds.clear();
    this.prelaunchFailureGeneration = null;
    const intent = await this.prepareSpawnIntent();
    const ownershipFile = this.ownershipRecordPath!;
    let child: ChildProcess;
    try {
      child = this.options.engineFactory?.() ?? fork(CHILD_ENTRY, [], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (error) {
      const record = readOwnershipRecord(ownershipFile);
      if (record.kind === 'starting'
        && sameStartingTransaction(record.record, {
          ownerToken: intent.ownerToken,
          executable: resolve(normalizePvzExecutablePath(this.options.cfg.executable)),
          managerPid: process.pid,
        })
        && removeStartingOwnershipRecord(ownershipFile, record.record)) {
        this.startingOwnerToken = null;
      }
      throw error;
    }
    this.child = child;
    this.ready = false;
    if (this.host) logChildStdio(child, this.host.log);
    child.on('message', (message) => {
      if (generation === this.generation) {
        void this.onMessage(message as ChildToMain, child, generation);
      }
    });
    child.on('error', (error) => {
      if (generation === this.generation) this.host?.log.error('PvZ 引擎子进程 出错', { error: String(error) });
    });
    child.on('exit', (code) => {
      if (generation === this.generation) this.onExit(code);
    });
    this.lastConfigJson = JSON.stringify(this.options.cfg);
    try {
      const cfg = JSON.parse(this.lastConfigJson) as PvzConfigSection;
      cfg.executable = normalizePvzExecutablePath(cfg.executable);
      if (intent.recoveryIdentity) {
        cfg.launch = false;
        cfg.attachPid = intent.recoveryIdentity.pid;
      }
      const reply = await this.rpc({
        kind: 'init',
        init: {
          cfg,
          timezone: this.options.timezone ?? 'Asia/Shanghai',
          botName: this.options.botName ?? 'bot',
          taskIdBase: taskIdBaseForGeneration(generation),
          ownedProcess: this.ownsGame,
          ownerToken: intent.ownerToken,
          recoveryIdentity: intent.recoveryIdentity,
          ownershipFile,
        },
      }, INIT_TIMEOUT_MS) as EngineInitReply;
      const identity = parseOwnershipIdentity(reply);
      if (!identity || identity.phase !== 'resumed') {
        throw new Error('PvZ 引擎子进程 返回了无效或未恢复的目标进程所有权身份');
      }
      this.acceptOwnershipIdentity(identity, intent);
      this.ready = true;
      await this.finishRecoveryEpisode();
    } catch (error) {
      if (child.exitCode === null && !child.killed) child.kill();
      await waitExit(child, 3000);
      const record = readOwnershipRecord(ownershipFile);
      if (record.kind === 'owned') this.ownershipIdentity = record.identity;
      await this.cleanupFailedStartingIntent({
        ownershipFile,
        intent,
        generation,
        engineExited: child.exitCode !== null,
      });
      this.teardownChild(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private async cleanupFailedStartingIntent(input: {
    ownershipFile: string;
    intent: SpawnIntent;
    generation: number;
    engineExited: boolean;
  }): Promise<void> {
    if (input.intent.recoveryIdentity) return;
    const record = readOwnershipRecord(input.ownershipFile);
    if (record.kind !== 'starting' || !sameStartingTransaction(record.record, {
      ownerToken: input.intent.ownerToken,
      executable: resolve(normalizePvzExecutablePath(this.options.cfg.executable)),
      managerPid: process.pid,
    })) return;

    if (this.prelaunchFailureGeneration !== input.generation) {
      if (!input.engineExited) return;
      let state: PvzTargetProcessState;
      try {
        state = await (this.options.targetProcessStateReader ?? readWindowsExecutableProcessState)(
          record.record.executable,
        );
      } catch (error) {
        this.host?.log.warn('无法核验失败启动事务的目标进程，保留 PvZ ownership 记录', {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (state !== 'absent') return;
    }

    if (removeStartingOwnershipRecord(input.ownershipFile, record.record)) {
      this.startingOwnerToken = null;
    }
  }

  private async prepareSpawnIntent(): Promise<SpawnIntent> {
    const ownershipFile = this.ownershipRecordPath ?? ownershipPathForExecutable(
      this.options.cfg.executable,
      this.options.ownershipDirectory,
    );
    this.ownershipRecordPath = ownershipFile;
    const record = readOwnershipRecord(ownershipFile);
    if (record.kind === 'owned') {
      const currentCreationTime = await this.readProcessCreationTime(record.identity.pid);
      if (currentCreationTime !== record.identity.creationTime) {
        if (!removeOwnershipRecord(ownershipFile, record.identity)) {
          throw new Error('已退出的 PvZ 所有权记录在回收时被其他进程改写');
        }
        this.ownershipIdentity = null;
        return this.createStartingIntent(ownershipFile);
      }
      this.ownershipIdentity = record.identity;
      this.startingOwnerToken = null;
      return { ownerToken: record.identity.ownerToken, recoveryIdentity: record.identity };
    }
    if (record.kind === 'invalid') {
      throw new Error(`PvZ 所有权记录无效，拒绝启动或附加: ${ownershipFile}`);
    }
    if (record.kind === 'starting') {
      throw new Error('已有 PvZ 启动事务尚未交付完整进程身份，拒绝重复启动');
    }
    if (this.ownershipIdentity) {
      const currentCreationTime = await this.readProcessCreationTime(this.ownershipIdentity.pid);
      if (currentCreationTime !== this.ownershipIdentity.creationTime) {
        this.ownershipIdentity = null;
        return this.createStartingIntent(ownershipFile);
      }
      writeOwnershipRecord(ownershipFile, this.ownershipIdentity);
      return {
        ownerToken: this.ownershipIdentity.ownerToken,
        recoveryIdentity: this.ownershipIdentity,
      };
    }
    if (this.startingOwnerToken) {
      throw new Error('PvZ 启动事务的所有权记录丢失，拒绝重复启动');
    }
    return this.createStartingIntent(ownershipFile);
  }

  private createStartingIntent(ownershipFile: string): SpawnIntent {
    const ownerToken = this.options.ownerTokenFactory?.() ?? randomBytes(16).toString('hex');
    if (!/^[0-9a-f]{32}$/.test(ownerToken)) {
      throw new Error('PvZ 所有权令牌生成器返回了无效令牌');
    }
    createStartingOwnershipRecord(ownershipFile, {
      state: 'starting',
      ownerToken,
      executable: resolve(normalizePvzExecutablePath(this.options.cfg.executable)),
      managerPid: process.pid,
      createdAt: new Date().toISOString(),
    });
    this.startingOwnerToken = ownerToken;
    return { ownerToken, recoveryIdentity: null };
  }

  private readProcessCreationTime(pid: number): Promise<string | null> {
    return (this.options.processCreationTimeReader ?? readWindowsProcessCreationTime)(pid);
  }

  private async hasRecoverableOwnership(): Promise<boolean> {
    if (!this.ownershipRecordPath && !this.ownershipIdentity && !this.startingOwnerToken) return false;
    const ownershipFile = this.ownershipRecordPath ?? ownershipPathForExecutable(
      this.options.cfg.executable,
      this.options.ownershipDirectory,
    );
    this.ownershipRecordPath = ownershipFile;
    const record = readOwnershipRecord(ownershipFile);
    if (record.kind === 'owned') {
      const currentCreationTime = await this.readProcessCreationTime(record.identity.pid);
      if (currentCreationTime !== record.identity.creationTime) {
        if (!removeOwnershipRecord(ownershipFile, record.identity)) {
          throw new Error('已退出的 PvZ 所有权记录在停机回收时被其他进程改写');
        }
        this.ownershipIdentity = null;
        this.startingOwnerToken = null;
        return false;
      }
      this.ownershipIdentity = record.identity;
      return true;
    }
    if (record.kind === 'missing' && !this.ownershipIdentity && !this.startingOwnerToken) return false;
    if (record.kind === 'missing' && this.ownershipIdentity) {
      const currentCreationTime = await this.readProcessCreationTime(this.ownershipIdentity.pid);
      if (currentCreationTime !== this.ownershipIdentity.creationTime) {
        this.ownershipIdentity = null;
        return false;
      }
      return true;
    }
    if (record.kind === 'starting') {
      throw new Error('PvZ 启动事务尚未交付完整身份，无法确认受控停机');
    }
    throw new Error('PvZ 所有权记录无效，无法确认受控停机');
  }

  private acceptOwnershipIdentity(identity: PvzOwnershipIdentity, intent?: SpawnIntent): void {
    const expected = intent?.recoveryIdentity ?? this.ownershipIdentity;
    const expectedToken = intent?.ownerToken ?? this.startingOwnerToken;
    if (expected && !sameOwnedProcess(expected, identity)) {
      throw new Error('PvZ 引擎子进程 交付的进程身份与持久所有权记录不一致');
    }
    if (expected?.phase === 'suspended'
      && identity.primaryThreadId !== expected.primaryThreadId) {
      throw new Error('PvZ 引擎子进程 未交付暂停态 lease 中记录的恢复线程身份');
    }
    if (!expected && identity.ownerToken !== expectedToken) {
      throw new Error('PvZ 引擎子进程 交付的所有权令牌与启动事务不一致');
    }
    if (intent?.recoveryIdentity && identity.mode !== 'attach') {
      throw new Error('PvZ 引擎子进程 恢复结果没有使用附加模式');
    }
    if (intent && !intent.recoveryIdentity && identity.mode !== 'launch') {
      throw new Error('PvZ 引擎子进程 首次启动结果没有使用托管启动模式');
    }
    const ownershipFile = this.ownershipRecordPath;
    if (!ownershipFile) throw new Error('PvZ 所有权记录路径尚未建立');
    writeOwnershipRecord(ownershipFile, identity);
    this.ownershipIdentity = identity;
    this.startingOwnerToken = null;
  }

  private onExit(code: number | null): void {
    const hadReady = this.ready;
    const unexpected = !this.stopping && this.launchRequested;
    if (unexpected) this.failOutstandingTasks(this.generation, code);
    else this.dropOutstandingTasks(this.generation);
    this.teardownChild(new Error(`PvZ 引擎子进程 已退出(${String(code)})`));
    if (!unexpected || !hadReady) return;
    if (!this.ownedIdentity()) {
      // 一个可核验的目标身份都没有,就没有"进程已经没了"的证据。照旧交给重启去撞墙。
      this.beginRecoveryEpisode(code);
      return;
    }
    void this.recoverOrConclude(code);
  }

  /**
   * 引擎子进程 意外退出之后先分诊,再决定说什么。
   *
   * 只有「游戏还活着、掉的是 引擎子进程」才值得自动恢复——那是按租约附加回去,游戏
   * 一帧不掉。持有的那个进程确凿地没了(绝大多数时候是操作员亲手关掉了窗口),自动
   * 重启会把游戏重新拉起来,等于否掉人的操作;这一条改成停在「未启动」并说清楚。
   *
   * 分诊要在报"正在自动恢复"之前做完,否则先喊了恢复、再宣布已停,两句自相矛盾。
   */
  private async recoverOrConclude(code: number | null): Promise<void> {
    const alive = await this.ownedGameAlive();
    if (this.stopping || !this.launchRequested) return;
    if (alive === 'gone') {
      this.concludeGameClosed(code);
      return;
    }
    this.beginRecoveryEpisode(code);
  }

  private beginRecoveryEpisode(code: number | null): void {
    if (!this.failureEpisode) {
      this.failureEpisode = true;
      this.host?.pushEvent({
        ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'),
        source: this.id,
        type: 'pvz.lifecycle',
        text: `[PvZ] 引擎子进程 已退出(${String(code)})，正在自动恢复。`,
        senderKey: 'pvz.lifecycle',
      }, { trigger: 'flush' }).catch(() => undefined);
    }
    this.scheduleRestart();
  }

  /** 内存里或盘上租约里那个已交付的目标身份。 */
  private ownedIdentity(): PvzOwnershipIdentity | null {
    if (this.ownershipIdentity) return this.ownershipIdentity;
    if (!this.ownershipRecordPath) return null;
    const record = readOwnershipRecord(this.ownershipRecordPath);
    return record.kind === 'owned' ? record.identity : null;
  }

  /**
   * 目标游戏进程此刻还是启动的那一个吗(PID 复用按创建时间排除)。
   *
   * 读不出来只报 `unknown`——误判成"人关了游戏"会把一次本可恢复的掉线变成整场停摆。
   */
  private async ownedGameAlive(): Promise<'alive' | 'gone' | 'unknown'> {
    const identity = this.ownedIdentity();
    if (!identity) return 'unknown';
    try {
      const creationTime = await this.readProcessCreationTime(identity.pid);
      if (creationTime === null) return 'gone';
      return creationTime === identity.creationTime ? 'alive' : 'gone';
    } catch (error) {
      this.host?.log.warn('无法核验 PvZ 游戏进程是否仍在，按仍在处理', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 'unknown';
    }
  }

  /** 游戏进程已经不在了:停在「未启动」,回收租约,并让她听见这件事。 */
  private concludeGameClosed(code: number | null): void {
    const identity = this.ownedIdentity();
    const file = this.ownershipRecordPath;
    this.endRecoveryAttempts();
    this.ownershipIdentity = null;
    this.startingOwnerToken = null;
    if (identity && file && !removeOwnershipRecord(file, identity)) {
      this.host?.log.warn('PvZ 游戏已退出，但持久所有权记录已被其他进程改写，保留不动');
    }
    this.stoppedDetail = `游戏进程已退出(engine ${String(code)});没有自动重启，按「启动游戏」重新开始`;
    this.host?.pushEvent({
      ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'),
      source: this.id,
      type: 'pvz.lifecycle',
      text: '[PvZ] 游戏进程已经退出，worlds-pvz 已停回未启动，不会自己把游戏重新拉起来。',
      senderKey: 'pvz.lifecycle',
    }, { trigger: 'flush' }).catch(() => undefined);
  }

  /** 重启预算用光:同样停手,但留 error 相位,说明是恢复失败而不是人关的。 */
  private abandonRecovery(detail: string): void {
    this.endRecoveryAttempts();
    this.launchError = detail;
    this.host?.pushEvent({
      ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'),
      source: this.id,
      type: 'pvz.lifecycle',
      text: `[PvZ] 引擎子进程 恢复失败，已停手：${detail}`,
      senderKey: 'pvz.lifecycle',
    }, { trigger: 'flush' }).catch(() => undefined);
  }

  private endRecoveryAttempts(): void {
    this.launchRequested = false;
    this.failureEpisode = false;
    this.pendingRecoveryEvent = null;
    this.restartCount = 0;
    this.lastRestartAt = 0;
    this.clearLifecycleTimers();
  }

  private clearLifecycleTimers(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.recoveryNotifyTimer) clearTimeout(this.recoveryNotifyTimer);
    this.recoveryNotifyTimer = null;
  }

  private scheduleRestart(): void {
    if (this.stopping || !this.launchRequested || this.restartTimer) return;
    const now = Date.now();
    if (this.lastRestartAt > 0 && now - this.lastRestartAt > RESTART_WINDOW_MS) this.restartCount = 0;
    this.lastRestartAt = now;
    this.restartCount += 1;
    if (this.restartCount > RESTART_MAX_ATTEMPTS) {
      this.abandonRecovery(
        `${RESTART_WINDOW_MS / 60_000} 分钟内已重启 ${RESTART_MAX_ATTEMPTS} 次仍未连上`,
      );
      return;
    }
    const delayMs = Math.min(RESTART_DELAY_MS * (2 ** (this.restartCount - 1)), 60_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restartTick();
    }, delayMs);
    this.restartTimer.unref?.();
  }

  /** 每一次重启前都重新分诊一遍:等待这几秒里游戏可能已经被关掉了。 */
  private async restartTick(): Promise<void> {
    if (this.stopping || !this.launchRequested) return;
    if (this.ownedIdentity() && await this.ownedGameAlive() === 'gone') {
      if (!this.stopping && this.launchRequested) this.concludeGameClosed(null);
      return;
    }
    if (this.stopping || !this.launchRequested) return;
    try {
      await this.spawn();
    } catch (error) {
      this.host?.log.error('PvZ 引擎子进程 重启失败', { error: String(error) });
      this.scheduleRestart();
    }
  }

  private teardownChild(error: Error): void {
    this.ready = false;
    this.child?.removeAllListeners();
    this.child = null;
    this.declCache = {};
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async onMessage(
    message: ChildToMain,
    sourceChild: ChildProcess,
    generation: number,
  ): Promise<void> {
    if (message.t === 'rep') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error ?? 'PvZ 引擎子进程 请求失败'));
      return;
    }
    if (message.t === 'hreq') {
      const result = await this.handleHostRequest(message.req, generation).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
      );
      if (this.child === sourceChild && this.generation === generation && sourceChild.connected) {
        sourceChild.send({ t: 'hrep', id: message.id, ...result });
      }
      return;
    }
    this.handleNote(message.note, sourceChild, generation);
  }

  private handleHostRequest(request: HostRequest, generation = this.generation): Promise<unknown> {
    const host = this.host;
    if (!host) return Promise.reject(new Error('PvZ 宿主未连接'));
    const taskId = terminalTaskId(request);
    if (taskId !== null) {
      if (!taskIdBelongsToGeneration(taskId, generation)) {
        return Promise.reject(new Error(`PvZ 引擎子进程 任务#${taskId} 不属于当前代次`));
      }
      if (this.terminalTaskIds.has(taskId)) return Promise.resolve(acknowledgedEvent(request));
      this.terminalTaskIds.add(taskId);
      this.outstandingTasks.delete(taskId);
    }
    if (request.kind === 'push' && request.evt.type === 'pvz.connected' && this.failureEpisode) {
      this.pendingRecoveryEvent = request;
      return Promise.resolve({
        ...request.evt,
        cursor: 0,
        origin: request.evt.origin ?? 'external',
      });
    }
    return host.pushEvent(request.evt, request.opts);
  }

  private trackAcceptedTask(reply: string, generation: number): void {
    const taskId = acceptedTaskId(reply);
    if (taskId === null || !taskIdBelongsToGeneration(taskId, generation)) {
      const child = this.child;
      if (child) this.castBound(child, generation, { kind: 'cancel-action' });
      throw new Error('PvZ 引擎子进程 入队回执缺少当前代次的任务号');
    }
    if (this.terminalTaskIds.has(taskId)) return;
    if (this.child && this.generation === generation) {
      this.outstandingTasks.set(taskId, generation);
      return;
    }
    this.publishLostTask(taskId, generation, null);
  }

  private failOutstandingTasks(generation: number, code: number | null): void {
    for (const [taskId, taskGeneration] of this.outstandingTasks) {
      if (taskGeneration === generation) this.publishLostTask(taskId, generation, code);
    }
  }

  private dropOutstandingTasks(generation: number): void {
    for (const [taskId, taskGeneration] of this.outstandingTasks) {
      if (taskGeneration === generation) this.outstandingTasks.delete(taskId);
    }
  }

  private publishLostTask(taskId: number, generation: number, code: number | null): void {
    if (this.terminalTaskIds.has(taskId)) return;
    this.terminalTaskIds.add(taskId);
    this.outstandingTasks.delete(taskId);
    const host = this.host;
    if (!host) return;
    host.pushEvent({
      ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'),
      source: this.id,
      type: 'pvz.task',
      text: `任务#${taskId}未验真: 引擎子进程 退出(${String(code)})，原生动作结果未知；请重新观察后再规划。`,
      senderKey: `pvz.task.${taskId}`,
      meta: { taskId, engineGeneration: generation, terminal: 'unverified' },
    }, { trigger: 'flush' }).catch((error) => {
      host.log.warn('PvZ 引擎子进程 退出任务终态投递失败', { taskId, error: String(error) });
    });
  }

  private handleNote(note: EngineNote, sourceChild: ChildProcess, generation: number): void {
    const host = this.host;
    if (!host) return;
    if (note.kind === 'ownership') {
      if (this.child !== sourceChild || this.generation !== generation) return;
      const identity = parseOwnershipIdentity(note);
      try {
        if (!identity) throw new Error('PvZ 引擎子进程 交付的所有权身份格式无效');
        this.acceptOwnershipIdentity(identity);
      } catch (error) {
        host.log.error('PvZ 引擎子进程 交付的所有权身份无效或与恢复目标不一致', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (sourceChild.exitCode === null && !sourceChild.killed) sourceChild.kill();
      }
      return;
    }
    if (note.kind === 'prelaunch-failure') {
      if (this.child === sourceChild && this.generation === generation) {
        this.prelaunchFailureGeneration = generation;
        host.log.warn('PvZ 引擎子进程 在启动游戏前失败', { error: note.error });
      }
      return;
    }
    if (note.kind === 'log') {
      emitLogNote(host.log, note, this.options.timezone ?? 'Asia/Shanghai');
      return;
    }
    if (note.kind === 'status') {
      this.declCache = note.decl;
      return;
    }
    const type = note.type;
    const deliveryEpoch = this.snapshotDeliveryEpoch;
    host.pushDeferred(
      {
        type,
        ...(note.senderKey !== undefined ? { senderKey: note.senderKey } : {}),
        ...(note.meta !== undefined ? { meta: note.meta } : {}),
        ...(note.tags !== undefined ? { tags: note.tags } : {}),
        render: async () => {
          if (this.child !== sourceChild || this.generation !== generation) return null;
          if (type === 'pvz.board.snapshot' && this.snapshotDeliveryEpoch !== deliveryEpoch) return null;
          try {
            return await this.rpcBound(
              sourceChild,
              generation,
              { kind: 'render-deferred', type, renderId: note.renderId },
              DEFERRED_RENDER_TIMEOUT_MS,
            ) as string | null;
          } catch (error) {
            if (this.child !== sourceChild || this.generation !== generation) return null;
            host.log.warn('PvZ 投递快照刷新失败', { type, error: String(error) });
            return '[PvZ] 投递时未能刷新当前状态，请用 pvz_observe 重读后再规划。';
          }
        },
      },
      note.trigger !== undefined ? { trigger: note.trigger } : undefined,
    );
  }

  private async photoDirect(): Promise<string | ToolOutcome> {
    const host = this.host;
    if (!host) return '[pvz_glance 失败] 宿主未连接';
    const frame = await this.rpc({ kind: 'photo-frame' }, FRAME_TIMEOUT_MS) as PvzPhotoFrameReply;
    const bytes = Buffer.from(frame.frameBase64, 'base64');
    return { text: frame.text, blobs: [{ bytes, mime: frame.mime, fallbackText: frame.text }] };
  }

  private gamePanelState(): PvzGamePanelState {
    const pid = this.ownershipIdentity?.pid ?? null;
    // 「停止」要按得动的判据不是 引擎子进程 在不在,而是还有没有游戏可关:引擎子进程 掉了
    // 而租约还指着一个活进程时,停止那一条正是把它拉回来关掉游戏的唯一出口。
    const stoppable = this.child !== null || this.spawnPromise !== null
      || this.launchRequested || this.ownershipIdentity !== null;
    if (this.ready) {
      return { phase: 'running', detail: '游戏、植入件与 引擎子进程 已连接', pid, stoppable };
    }
    if (this.failureEpisode && this.launchRequested) {
      return { phase: 'recovering', detail: '引擎子进程 正在恢复连接', pid, stoppable };
    }
    if (this.spawnPromise || this.child) {
      return { phase: 'starting', detail: '正在启动游戏并等待植入件连接', pid, stoppable };
    }
    if (this.launchError) return { phase: 'error', detail: this.launchError, pid, stoppable };
    return {
      phase: 'stopped',
      detail: this.stoppedDetail ?? '未启动，不会连接植入件',
      pid,
      stoppable,
    };
  }

  private async invokePanel(panel: string, method: string): Promise<PvzGamePanelState> {
    if (panel !== 'game') throw new Error(`未知面板:${panel}`);
    if (method === 'state') return this.gamePanelState();
    if (method === 'stop') return await this.stopFromConsole();
    if (method !== 'start') throw new Error(`未知面板方法:${method}`);
    if (!this.host) throw new Error('PvZ World 尚未挂载');
    const host = this.host;
    if (this.ready) return this.gamePanelState();
    if (this.spawnPromise) {
      await this.spawnPromise;
      return this.gamePanelState();
    }

    this.launchRequested = true;
    this.launchError = null;
    this.stoppedDetail = null;
    await host.pushEvent({
      ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'),
      source: this.id,
      origin: 'internal',
      type: 'pvz.lifecycle',
      text: '[PvZ] 操作员正在启动游戏，等待窗口、植入件与 引擎子进程 就绪。',
      senderKey: 'pvz.lifecycle',
    }, { trigger: 'flush' });
    try {
      await this.spawn();
      return this.gamePanelState();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.launchRequested = false;
      this.launchError = detail;
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = null;
      await host.pushEvent({
        ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'),
        source: this.id,
        origin: 'internal',
        type: 'pvz.lifecycle',
        text: `[PvZ] 游戏启动失败:${detail}`,
        senderKey: 'pvz.lifecycle',
      }, { trigger: 'flush' }).catch((pushError) => {
        host.log.warn('PvZ 启动失败事件投递失败', { error: String(pushError) });
      });
      throw error;
    }
  }

  /**
   * 控制台「停止」:与 World 停机同一条收尾,只是 World 本身留在挂载态。
   *
   * 先把 launchRequested 落下再收尾——中途 引擎子进程 退出时 `onExit` 只看这一个标志
   * 判断"是不是意外",不落它就会一边关一边自动重启。
   */
  private async stopFromConsole(): Promise<PvzGamePanelState> {
    const host = this.host;
    if (!host) throw new Error('PvZ World 尚未挂载');
    const requested = this.launchRequested;
    this.endRecoveryAttempts();
    this.launchError = null;
    try {
      await this.shutdownGame(requested);
      this.stoppedDetail = this.closeOwnedGameOnStop
        ? '操作员已停止：游戏已退出'
        : '操作员已停止 引擎子进程；游戏按配置保持运行';
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.launchError = `停止未确认:${detail}`;
      throw error;
    } finally {
      await host.pushEvent({
        ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'),
        source: this.id,
        origin: 'internal',
        type: 'pvz.lifecycle',
        text: this.launchError
          ? `[PvZ] 操作员停止游戏，但收尾没走完:${this.launchError}`
          : '[PvZ] 操作员已停止游戏，worlds-pvz 回到未启动。',
        senderKey: 'pvz.lifecycle',
      }, { trigger: 'flush' }).catch((pushError) => {
        host.log.warn('PvZ 停止事件投递失败', { error: String(pushError) });
      });
    }
    return this.gamePanelState();
  }

  private rpc(request: EngineRequest, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child || !child.connected) return Promise.reject(new Error('PvZ 引擎子进程 未运行'));
    return this.rpcBound(child, this.generation, request, timeoutMs);
  }

  private rpcBound(
    child: ChildProcess,
    generation: number,
    request: EngineRequest,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.child !== child || this.generation !== generation || !child.connected) {
      return Promise.reject(new Error('PvZ 引擎子进程 代次已失效'));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (request.kind === 'tool' && actionTool(request.name) && request.name !== 'pvz_stop') {
          this.castBound(child, generation, { kind: 'cancel-action' });
        }
        reject(new Error(`PvZ 引擎子进程 ${timeoutMs / 1000}s 未回执 ${request.kind}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.send({ t: 'req', id, req: request });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private cast(cast: EngineCast): void {
    const child = this.child;
    if (!child) return;
    this.castBound(child, this.generation, cast);
  }

  private castBound(child: ChildProcess, generation: number, cast: EngineCast): void {
    if (this.child !== child || this.generation !== generation || !child.connected) return;
    child.send({ t: 'cast', cast });
  }

  private pushConfigIfChanged(): void {
    if (!this.ready) return;
    const json = JSON.stringify(this.options.cfg);
    if (json === this.lastConfigJson) return;
    this.lastConfigJson = json;
    this.cast({ kind: 'config', cfg: JSON.parse(json) as PvzConfigSection });
  }

  private async finishRecoveryEpisode(): Promise<void> {
    if (!this.failureEpisode) return;
    const pending = this.pendingRecoveryEvent;
    if (this.stopping) {
      this.failureEpisode = false;
      this.pendingRecoveryEvent = null;
      return;
    }
    const host = this.host;
    if (!host) return;
    const event = pending?.evt ?? {
      ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'),
      source: this.id,
      type: 'pvz.lifecycle',
      text: '[PvZ] 引擎子进程 已恢复。',
      senderKey: 'pvz.lifecycle',
    };
    try {
      await host.pushEvent({
        ...event,
        text: pending ? `[PvZ] 引擎子进程 已恢复。\n${event.text}` : event.text,
      }, { trigger: 'flush' });
      this.failureEpisode = false;
      this.pendingRecoveryEvent = null;
    } catch (error) {
      host.log.warn('PvZ 恢复事件投递失败，将重试', { error: String(error) });
      if (!this.recoveryNotifyTimer) {
        this.recoveryNotifyTimer = setTimeout(() => {
          this.recoveryNotifyTimer = null;
          void this.finishRecoveryEpisode();
        }, 3000);
        this.recoveryNotifyTimer.unref?.();
      }
    }
  }
}

function taskIdBaseForGeneration(generation: number): number {
  const base = generation * TASK_ID_GENERATION_STRIDE;
  if (!Number.isSafeInteger(base)) throw new Error('PvZ 引擎子进程 代次已超出安全任务号范围');
  return base;
}

function taskIdBelongsToGeneration(taskId: number, generation: number): boolean {
  const base = taskIdBaseForGeneration(generation);
  return Number.isSafeInteger(taskId)
    && taskId > base
    && taskId < base + TASK_ID_GENERATION_STRIDE;
}

function acceptedTaskId(reply: string): number | null {
  const match = /^任务#([1-9]\d*) 已受理:/.exec(reply);
  if (!match) return null;
  const taskId = Number(match[1]);
  return Number.isSafeInteger(taskId) ? taskId : null;
}

function terminalTaskId(request: HostRequest): number | null {
  if (request.kind !== 'push' || request.evt.type !== 'pvz.task') return null;
  const match = /^pvz.task.([1-9]\d*)$/.exec(request.evt.senderKey ?? '');
  if (!match) return null;
  const taskId = Number(match[1]);
  return Number.isSafeInteger(taskId) ? taskId : null;
}

function acknowledgedEvent(request: Extract<HostRequest, { kind: 'push' }>): unknown {
  return {
    ...request.evt,
    cursor: 0,
    origin: request.evt.origin ?? 'external',
  };
}

function actionTool(name: string): boolean {
  return PVZ_TOOL_DECLS.some((decl) => decl.name === name && decl.tags.includes('act'));
}

export function toolRpcTimeoutMs(
  name: string,
  cfg: Pick<PvzConfigSection, 'actionTimeoutMs' | 'cursorDurationMs'>,
  _args: Record<string, unknown> = {},
): number {
  if (name !== 'pvz_stop') return 30_000;
  const actionMs = Math.min(30_000, Math.max(500, cfg.actionTimeoutMs));
  return 30_000 + pvzActionCompletionBudgetMs('cancel', actionMs);
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

export function readWindowsExecutableProcessState(
  executable: string,
): Promise<PvzTargetProcessState> {
  const windowsDir = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const powershell = resolve(windowsDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    '$expected = [IO.Path]::GetFullPath($env:CORTICO_PVZ_EXPECTED_EXE)',
    '$name = [IO.Path]::GetFileNameWithoutExtension($expected)',
    '$present = $false',
    '$unknown = $false',
    '$items = @(Get-Process -Name $name -ErrorAction SilentlyContinue)',
    'foreach ($p in $items) {',
    '  try { $candidate = $p.Path } catch { $unknown = $true; continue }',
    '  if ([string]::IsNullOrWhiteSpace($candidate)) { $unknown = $true; continue }',
    '  try { $candidate = [IO.Path]::GetFullPath($candidate) } catch { $unknown = $true; continue }',
    '  if ([string]::Equals($candidate, $expected, [StringComparison]::OrdinalIgnoreCase)) {',
    '    $present = $true',
    '    break',
    '  }',
    '}',
    "if ($present) { 'present' } elseif ($unknown) { 'unknown' } else { 'absent' }",
  ].join('; ');
  return new Promise((resolveState, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CORTICO_PVZ_EXPECTED_EXE: resolve(executable) },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 3000);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const value = stdout.trim().toLowerCase();
      if (timedOut) {
        reject(new Error('核验 PvZ 可执行文件进程超时'));
      } else if (code !== 0) {
        reject(new Error(`无法核验 PvZ 可执行文件进程: ${stderr.trim() || `PowerShell ${String(code)}`}`));
      } else if (value === 'absent' || value === 'present' || value === 'unknown') {
        resolveState(value);
      } else {
        reject(new Error('无法核验 PvZ 可执行文件进程: 返回值格式无效'));
      }
    });
  });
}

interface StartingOwnershipRecord {
  state: 'starting';
  ownerToken: string;
  executable: string;
  managerPid: number;
  createdAt: string;
}

type OwnershipRecordRead =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'starting'; record: StartingOwnershipRecord }
  | { kind: 'owned'; identity: PvzOwnershipIdentity };

interface SpawnIntent {
  ownerToken: string;
  recoveryIdentity: PvzOwnershipIdentity | null;
}

function readOwnershipRecord(path: string): OwnershipRecordRead {
  if (!existsSync(path)) return { kind: 'missing' };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (value.state === 'starting') {
      if (!/^[0-9a-f]{32}$/.test(String(value.ownerToken))
        || typeof value.executable !== 'string' || !isAbsolute(value.executable)
        || !Number.isSafeInteger(value.managerPid) || Number(value.managerPid) <= 0
        || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
        return { kind: 'invalid' };
      }
      return {
        kind: 'starting',
        record: {
          state: 'starting',
          ownerToken: String(value.ownerToken),
          executable: resolve(value.executable),
          managerPid: Number(value.managerPid),
          createdAt: value.createdAt,
        },
      };
    }
    const identity = parseOwnershipIdentity(value);
    return identity ? { kind: 'owned', identity } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

function parseOwnershipIdentity(value: unknown): PvzOwnershipIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!['launch', 'attach'].includes(String(record.mode))
    || !['suspended', 'resumed'].includes(String(record.phase))
    || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
    || !/^[0-9a-f]{32}$/.test(String(record.ownerToken))
    || !/^[0-9a-f]{16}$/.test(String(record.creationTime))
    || !(record.primaryThreadId === null
      || (Number.isSafeInteger(record.primaryThreadId) && Number(record.primaryThreadId) > 0))
    || typeof record.artifactDir !== 'string' || !isAbsolute(record.artifactDir)
    || !/^[0-9a-f]{64}$/.test(basename(record.artifactDir))) return null;
  if (record.phase === 'suspended' && record.primaryThreadId === null) return null;
  return {
    mode: record.mode as PvzOwnershipIdentity['mode'],
    phase: record.phase as PvzOwnershipIdentity['phase'],
    pid: Number(record.pid),
    ownerToken: String(record.ownerToken),
    creationTime: String(record.creationTime),
    primaryThreadId: record.primaryThreadId === null ? null : Number(record.primaryThreadId),
    artifactDir: resolve(record.artifactDir),
  };
}

function createStartingOwnershipRecord(path: string, record: StartingOwnershipRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  let handle: number;
  try {
    handle = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('另一个 Cortico 进程已取得 PvZ 启动所有权');
    }
    throw error;
  }
  try {
    writeFileSync(handle, `${JSON.stringify(record)}\n`, 'utf8');
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function writeOwnershipRecord(path: string, identity: PvzOwnershipIdentity): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(handle, `${JSON.stringify({ ok: true, ...identity })}\n`, 'utf8');
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  try {
    replaceOwnershipRecord(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* The temporary file may already have moved. */ }
    throw error;
  }
}

function replaceOwnershipRecord(temporary: string, path: string): void {
  const retryable = new Set(['EACCES', 'EBUSY', 'EPERM']);
  const delays = [0, 5, 10, 20, 40, 80, 120];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    try {
      renameSync(temporary, path);
      return;
    } catch (error) {
      lastError = error;
      if (!retryable.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw lastError;
}

function removeOwnershipRecord(path: string, expected: PvzOwnershipIdentity): boolean {
  const record = readOwnershipRecord(path);
  if (record.kind === 'missing') return true;
  if (record.kind !== 'owned' || !sameOwnedProcess(record.identity, expected)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
}

function sameStartingTransaction(
  record: StartingOwnershipRecord,
  expected: Pick<StartingOwnershipRecord, 'ownerToken' | 'executable' | 'managerPid'>,
): boolean {
  return record.ownerToken === expected.ownerToken
    && record.managerPid === expected.managerPid
    && resolve(record.executable).toLowerCase() === resolve(expected.executable).toLowerCase();
}

function removeStartingOwnershipRecord(path: string, expected: StartingOwnershipRecord): boolean {
  const record = readOwnershipRecord(path);
  if (record.kind === 'missing') return true;
  if (record.kind !== 'starting' || !sameStartingTransaction(record.record, expected)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function sameOwnedProcess(a: PvzOwnershipIdentity, b: PvzOwnershipIdentity): boolean {
  return a.pid === b.pid
    && a.ownerToken === b.ownerToken
    && a.creationTime === b.creationTime
    && resolve(a.artifactDir).toLowerCase() === resolve(b.artifactDir).toLowerCase()
    && (a.primaryThreadId === null || b.primaryThreadId === null
      || a.primaryThreadId === b.primaryThreadId);
}

export function ownershipPathForExecutable(executable: string, directory?: string): string {
  const normalized = resolve(normalizePvzExecutablePath(executable)).replaceAll('\\', '/').toLowerCase();
  const key = createHash('sha256').update(normalized).digest('hex');
  return join(directory ?? DEFAULT_OWNERSHIP_DIRECTORY, `${key}.json`);
}
