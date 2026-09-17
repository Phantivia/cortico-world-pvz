import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { PvzTransport } from './bridge.ts';
import { isTerminalCollectible } from './collectibles.ts';
import {
  type PvzNativeAck,
  type PvzNativeAction,
  type PvzNativeBatchResult,
  type PvzNativeFrame,
  type PvzNativeResult,
  type PvzNativePlacement,
  type PvzSpecialTarget,
  type PvzSnapshot,
} from './protocol.ts';
import { cellText, specialActionDisplayName } from './names.ts';
import { pvzNativeReason } from './native-reasons.ts';
import { compactSnapshot } from './render.ts';
import { progressAdvanced } from './progress.ts';
import {
  pvzActionAckBudgetMs,
  pvzActionNativeResultBudgetMs,
  PVZ_NATIVE_TERMINAL_RESULT_BUDGET_MS,
} from './timing.ts';

export type PvzReceiptStatus = 'verified' | 'rejected' | 'unverified';

export interface PvzActionReceipt {
  actionId: string;
  status: PvzReceiptStatus;
  action: PvzNativeAction;
  beforeRevision: number;
  afterRevision: number | null;
  evidence: string[];
  state: Record<string, unknown>;
  batch?: PvzNativeBatchResult;
  placement?: PvzNativePlacement;
}

type PvzVerificationResult =
  | { after: PvzSnapshot; evidence: string[]; batch?: PvzNativeBatchResult; placement?: PvzNativePlacement }
  | { result: PvzNativeResult }
  | null;

export interface PvzRuntimeEvents {
  snapshot: [PvzSnapshot, PvzSnapshot | null];
  result: [PvzNativeResult];
  disconnect: [Error | null];
  diagnostic: [Record<string, unknown>];
}

export class PvzRuntime extends EventEmitter {
  private snapshotValue: PvzSnapshot | null = null;
  private started = false;
  private disconnected = false;
  private processIdValue: number | null = null;
  private ownerTokenValue: string | null = null;
  private readonly nativeResults = new Map<string, PvzNativeResult>();
  private readonly actionStarts = new Map<string, { atMs: number; kind: string }>();

  constructor(
    private readonly transport: PvzTransport,
    private readonly actionTimeoutMs: () => number,
    private readonly nativeResultBudgetMs = PVZ_NATIVE_TERMINAL_RESULT_BUDGET_MS,
  ) {
    super();
    transport.on('snapshot', (snapshot) => {
      if (this.disconnected) return;
      const before = this.snapshotValue;
      if (before && snapshot.revision <= before.revision) return;
      this.snapshotValue = snapshot;
      this.emit('snapshot', snapshot, before);
    });
    transport.on('disconnect', (error) => {
      this.disconnected = true;
      this.snapshotValue = null;
      this.emit('disconnect', error);
    });
    transport.on('result', (result) => {
      const start = this.actionStarts.get(result.id);
      if (start) this.emit('diagnostic', {
        phase: 'native.result', actionId: result.id, kind: start.kind,
        elapsedMs: Date.now() - start.atMs, revision: result.revision, outcome: result.outcome,
      });
      this.nativeResults.set(result.id, result);
      if (this.nativeResults.size > 512) {
        const oldest = this.nativeResults.keys().next().value as string | undefined;
        if (oldest) this.nativeResults.delete(oldest);
      }
      this.emit('result', result);
    });
  }

  override on<K extends keyof PvzRuntimeEvents>(event: K, listener: (...args: PvzRuntimeEvents[K]) => void): this {
    return super.on(event, listener);
  }

  get snapshot(): PvzSnapshot | null {
    return this.snapshotValue;
  }

  get processId(): number | null {
    return this.processIdValue;
  }

  get ownerToken(): string | null {
    return this.ownerTokenValue;
  }

  get artifactDir(): string | null {
    return this.transport.artifactDir;
  }

  async start(): Promise<PvzSnapshot> {
    if (this.started) throw new Error('PvZ runtime 已启动');
    this.started = true;
    this.disconnected = false;
    try {
      const hello = await this.transport.start();
      this.processIdValue = hello.pid;
      this.ownerTokenValue = hello.ownerToken;
      if (!hello.supported) {
        throw new Error(`PvZ 版本不受支持: ${hello.reason ?? hello.profile}`);
      }
      const initial = await this.waitForSnapshot(20_000);
      if (initial.executable.sha256.toLowerCase() !== hello.executableSha256.toLowerCase()
        || initial.executable.version !== hello.executableVersion
        || initial.executable.profile !== hello.profile
        || initial.executable.supported !== hello.supported) {
        throw new Error('PvZ 首快照的可执行文件身份与植入件握手不一致');
      }
      return initial;
    } catch (error) {
      try { await this.transport.stop(); } catch { /* Preserve the original startup failure. */ }
      this.started = false;
      this.processIdValue = null;
      this.ownerTokenValue = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.transport.stop();
  }

  capture(timeoutMs?: number): Promise<PvzNativeFrame> {
    return this.transport.capture(timeoutMs);
  }

  /** The returned sample was captured after this request reached the native bridge. */
  async readFreshSnapshot(timeoutMs = 1500): Promise<PvzSnapshot> {
    if (!this.started || this.disconnected) throw new Error('尚未取得 PvZ 状态：原生传输未连接');
    const startedAtMs = Date.now();
    const deadline = startedAtMs + timeoutMs;
    const remaining = (): number => Math.max(1, deadline - Date.now());
    const id = randomUUID();
    const observed = (snapshot: PvzSnapshot): PvzSnapshot => {
      this.emit('diagnostic', {
        phase: 'snapshot.fresh', requestId: id, requestedAtMs: startedAtMs,
        receivedAtMs: Date.now(), elapsedMs: Date.now() - startedAtMs,
        revision: snapshot.revision, monotonicMs: snapshot.monotonicMs,
        boardRunId: snapshot.board?.runId ?? null,
      });
      return snapshot;
    };
    const ack = await this.transport.command({ kind: 'snapshot' }, remaining(), id);
    if (!ack.accepted) throw new Error(ack.reason ?? '植入件拒绝新鲜读取');
    const result = await this.waitForNativeResult(id, remaining());
    if (result.outcome !== 'executed') throw new Error(result.reason ?? '新鲜读取未完成');
    if (this.snapshotValue && this.snapshotValue.revision > result.revision) return observed(this.snapshotValue);
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.removeListener('snapshot', onSnapshot);
        this.removeListener('disconnect', onDisconnect);
      };
      const onSnapshot = (snapshot: PvzSnapshot): void => {
        if (snapshot.revision <= result.revision) return;
        cleanup();
        resolve(observed(snapshot));
      };
      const onDisconnect = (error: Error | null): void => {
        cleanup();
        reject(error ?? new Error('PvZ 新鲜读取期间断开'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('PvZ 新鲜读取未取得结果之后的快照；缓存不作为当前状态返回'));
      }, remaining());
      timer.unref?.();
      this.on('snapshot', onSnapshot);
      this.once('disconnect', onDisconnect);
    });
  }

  async configure(pollHz: number, cursorMinMs: number, cursorMaxMs: number): Promise<void> {
    const id = randomUUID();
    const ack = await this.transport.command(
      { kind: 'configure', pollHz, cursorMinMs, cursorMaxMs },
      5000,
      id,
      this.snapshotValue ? commandContext(this.snapshotValue, { kind: 'configure', pollHz, cursorMinMs, cursorMaxMs }) : {},
    );
    if (!ack.accepted) throw new Error(ack.reason ?? '植入件拒绝运行时配置');
    const result = await this.waitForNativeResult(id, 5000);
    if (result.outcome !== 'executed') {
      throw new Error(result.reason ?? `植入件配置结果: ${result.outcome}`);
    }
  }

  async act(action: PvzNativeAction, timeoutMs = this.actionTimeoutMs()): Promise<PvzActionReceipt> {
    const actionId = randomUUID();
    const startedAtMs = Date.now();
    this.actionStarts.set(actionId, { atMs: startedAtMs, kind: action.kind });
    try {
      const receipt = await this.performAction(action, timeoutMs, actionId);
      this.emit('diagnostic', {
        phase: 'action.receipt', actionId, kind: action.kind,
        elapsedMs: Date.now() - startedAtMs, status: receipt.status,
        beforeRevision: receipt.beforeRevision, afterRevision: receipt.afterRevision,
      });
      return receipt;
    } finally {
      this.actionStarts.delete(actionId);
    }
  }

  private async performAction(action: PvzNativeAction, timeoutMs: number, actionId: string): Promise<PvzActionReceipt> {
    const before = this.snapshotValue;
    if (!before) throw new Error('尚未取得 PvZ 状态');
    if (!before.executable.supported) throw new Error('当前游戏版本只读，禁止动作');
    const batchExecution = action.kind === 'collect'
      || action.kind === 'special' && action.action === 'whack'
        && (action.targetIds?.length ?? 0) > 0;
    const stateVerificationMs = batchExecution ? this.actionTimeoutMs() : timeoutMs;
    const scaledExecutionMs = batchExecution ? timeoutMs : 0;
    let ack: PvzNativeAck;
    try {
      const ackTimeoutMs = pvzActionAckBudgetMs();
      ack = await this.transport.command(
        action,
        ackTimeoutMs,
        actionId,
        commandContext(before, action),
      );
      this.emit('diagnostic', {
        phase: 'native.ack', actionId, kind: action.kind,
        elapsedMs: Date.now() - this.actionStarts.get(actionId)!.atMs,
        accepted: ack.accepted, beforeRevision: before.revision,
      });
    } catch (error) {
      const evidence = [
        `动作提交未获植入件回执，是否送达未知: ${error instanceof Error ? error.message : String(error)}`,
      ];
      if (action.kind !== 'cancel') evidence.push(await this.cancelQueuedAction());
      return unverifiedReceipt(actionId, action, before, this.snapshotValue ?? before, evidence);
    }
    if (!ack.accepted) return rejectedReceipt(ack, action, before);

    let result: PvzVerificationResult;
    try {
      result = await this.waitForVerification(
        ack.id,
        action,
        before,
        stateVerificationMs,
        pvzActionNativeResultBudgetMs(action.kind, scaledExecutionMs, this.nativeResultBudgetMs),
      );
    } catch (error) {
      const evidence = [
        `动作已受理，但验真传输中断: ${error instanceof Error ? error.message : String(error)}`,
      ];
      if (action.kind !== 'cancel') evidence.push(await this.cancelQueuedAction());
      return unverifiedReceipt(ack.id, action, before, this.snapshotValue ?? before, evidence);
    }
    if (result && 'result' in result) {
      const latest = this.snapshotValue ?? before;
      const evidence = [result.result.reason ?? '植入件中止了这一步，但没有给出原因'];
      const heldCursorAfterCancellation = result.result.outcome === 'cancelled'
        && action.kind !== 'cancel'
        && sameBoardRun(before, latest)
        && latest.board?.cursor.kind !== 'normal';
      if (heldCursorAfterCancellation) evidence.push(await this.cancelQueuedAction());
      return {
        actionId: ack.id,
        status: nativeReceiptStatus(result.result),
        action,
        beforeRevision: before.revision,
        afterRevision: latest.revision,
        evidence,
        state: compactSnapshot(latest),
        ...(result.result.batch ? { batch: result.result.batch } : {}),
      };
    }
    if (result) {
      return {
        actionId: ack.id,
        status: 'verified',
        action,
        beforeRevision: before.revision,
        afterRevision: result.after.revision,
        evidence: result.evidence,
        state: compactSnapshot(result.after),
        ...(result.batch ? { batch: result.batch } : {}),
        ...(result.placement ? { placement: result.placement } : {}),
      };
    }
    const cancellation = action.kind === 'cancel'
      ? '取消动作本身没有在死线内取得状态证据'
      : await this.cancelQueuedAction();
    const latest = this.snapshotValue ?? before;
    return {
      actionId: ack.id,
      status: 'unverified',
      action,
      beforeRevision: before.revision,
      afterRevision: latest.revision,
      evidence: [
        '动作已被植入件接受，但在死线内没有独立状态证据，可能已经生效也可能没有',
        cancellation,
      ],
      state: compactSnapshot(latest),
    };
  }

  private async cancelQueuedAction(): Promise<string> {
    try {
      const timeoutMs = Math.min(2000, Math.max(100, this.actionTimeoutMs()));
      const receipt = await this.act({ kind: 'cancel' }, timeoutMs);
      if (receipt.status === 'verified') return '植入件已清空动作队列并释放内部光标';
      return `取消动作未验真: ${receipt.evidence.join('; ')}`;
    } catch (error) {
      return `取消请求未获回执: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private waitForSnapshot(timeoutMs: number): Promise<PvzSnapshot> {
    if (this.snapshotValue) return Promise.resolve(this.snapshotValue);
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.removeListener('snapshot', onSnapshot);
        this.removeListener('disconnect', onDisconnect);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`PvZ ${timeoutMs / 1000}s 未产生状态快照`));
      }, timeoutMs);
      timer.unref?.();
      const onSnapshot = (snapshot: PvzSnapshot): void => {
        cleanup();
        resolve(snapshot);
      };
      const onDisconnect = (error: Error | null): void => {
        cleanup();
        reject(error ?? new Error('PvZ 植入件在首个快照前断开'));
      };
      this.once('snapshot', onSnapshot);
      this.once('disconnect', onDisconnect);
    });
  }

  private waitForVerification(
    actionId: string,
    action: PvzNativeAction,
    before: PvzSnapshot,
    timeoutMs: number,
    nativeResultBudgetMs: number,
  ): Promise<PvzVerificationResult> {
    return new Promise((resolve, reject) => {
      const observations: PvzSnapshot[] = [];
      let candidate: { after: PvzSnapshot; evidence: string[] } | null = null;
      let executedResult: PvzNativeResult | null = null;
      let terminalAtRevision: number | null = null;
      let cancelledResult: PvzNativeResult | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        this.removeListener('snapshot', onSnapshot);
        this.removeListener('result', onResult);
        this.removeListener('disconnect', onDisconnect);
      };
      const armTimeout = (budgetMs: number): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          cleanup();
          const settled = !(action.kind === 'plant' && 'aheadOf' in action)
            && executedResult?.effect && this.snapshotValue
            && this.snapshotValue.revision > executedResult.revision
            ? {
                after: this.snapshotValue ?? before,
                evidence: nativeExecutedEvidence(executedResult),
                ...(executedResult.batch ? { batch: executedResult.batch } : {}),
              }
            : null;
          resolve(cancelledResult ? { result: cancelledResult } : settled);
        }, budgetMs);
        timer.unref?.();
      };
      const finishCandidate = (): boolean => {
        if (!candidate || !executedResult) return false;
        cleanup();
        const verified = executedResult.reason
          ? { ...candidate, evidence: [...candidate.evidence, executedResult.reason] }
          : candidate;
        resolve({ ...verified,
          ...(executedResult.batch ? { batch: executedResult.batch } : {}),
          ...(executedResult.placement ? { placement: executedResult.placement } : {}),
        });
        return true;
      };
      const onSnapshot = (after: PvzSnapshot): void => {
        observations.push(after);
        if (terminalAtRevision !== null && after.revision <= terminalAtRevision) return;
        if (cancelledResult) {
          cleanup();
          resolve({ result: cancelledResult });
          return;
        }
        const batchEvidence = executedResult
          ? verifiedNativeBatchEvidence(action, executedResult)
          : null;
        const evidence = batchEvidence ?? (
          executedResult?.batch && action.kind === 'collect'
            ? null
            : verifyAction(action, before, after, observations, executedResult?.effect, executedResult?.placement)
        );
        if (!evidence) return;
        candidate = { after, evidence };
        finishCandidate();
      };
      const onResult = (result: PvzNativeResult): void => {
        if (result.id !== actionId) return;
        if (result.outcome === 'executed') {
          executedResult = result;
          terminalAtRevision = result.revision;
          if (candidate && candidate.after.revision <= result.revision) candidate = null;
          if (finishCandidate()) return;
          armTimeout(timeoutMs);
          const current = this.snapshotValue;
          if (current && current.revision > result.revision) onSnapshot(current);
          return;
        }
        if (result.outcome === 'cancelled') {
          cancelledResult = result;
          terminalAtRevision = result.revision;
          armTimeout(timeoutMs);
          const current = this.snapshotValue;
          if (current && current.revision > result.revision) onSnapshot(current);
          return;
        }
        cleanup();
        resolve({ result });
      };
      const onDisconnect = (error: Error | null): void => {
        cleanup();
        reject(error ?? new Error('PvZ 植入件在动作验真时断开'));
      };
      this.on('snapshot', onSnapshot);
      this.on('result', onResult);
      this.once('disconnect', onDisconnect);
      armTimeout(nativeResultBudgetMs);
      const completed = this.nativeResults.get(actionId);
      if (completed) {
        onResult(completed);
        if (completed.outcome === 'rejected') return;
      }
      const current = this.snapshotValue;
      if (current) onSnapshot(current);
    });
  }

  private waitForNativeResult(id: string, timeoutMs: number): Promise<PvzNativeResult> {
    const existing = this.nativeResults.get(id);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.removeListener('result', onResult);
        this.removeListener('disconnect', onDisconnect);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`植入件 ${timeoutMs / 1000}s 未返回执行结果`));
      }, timeoutMs);
      timer.unref?.();
      const onResult = (result: PvzNativeResult): void => {
        if (result.id !== id) return;
        cleanup();
        resolve(result);
      };
      const onDisconnect = (error: Error | null): void => {
        cleanup();
        reject(error ?? new Error('PvZ 植入件在等待执行结果时断开'));
      };
      this.on('result', onResult);
      this.once('disconnect', onDisconnect);
    });
  }
}

function verifiedNativeBatchEvidence(
  action: PvzNativeAction,
  result: PvzNativeResult,
): string[] | null {
  return verifiedWhackBatchEvidence(action, result)
    ?? verifiedCollectBatchEvidence(action, result);
}

function verifiedWhackBatchEvidence(
  action: PvzNativeAction,
  result: PvzNativeResult,
): string[] | null {
  if (action.kind !== 'special' || action.action !== 'whack'
    || action.targetIds === undefined || result.effect !== 'target_changed') return null;
  const batch = result.batch;
  if (!batch || batch.requested !== action.targetIds.length || batch.verified <= 0) return null;
  return [
    `植入件已确认锤击受击 ${batch.verified}/${batch.requested}`,
  ];
}

function verifiedCollectBatchEvidence(
  action: PvzNativeAction,
  result: PvzNativeResult,
): string[] | null {
  if (action.kind !== 'collect' || result.effect !== 'collectibles_collected') return null;
  const batch = result.batch;
  if (!batch || batch.requested !== action.ids.length || batch.verified <= 0
    || batch.scopeStopped || batch.attempted !== batch.released
    || batch.attempted !== batch.verified
    || batch.verified + batch.stale !== batch.requested) return null;
  return [
    `植入件已确认收取 ${batch.verified}/${batch.requested} 个目标`
      + `${batch.stale > 0 ? `；${batch.stale} 个目标在点击前已消失` : ''}`,
  ];
}

/**
 * 带着原因中止的动作是确定失败:植入件知道它为什么停,那不是「不知道成没成」。
 *
 * 未验真只留给两种:它自己说效果确证不了(`certainty: 'unknown'`),或者它一个字都没说。
 */
function nativeReceiptStatus(result: PvzNativeResult): PvzReceiptStatus {
  if (result.outcome === 'rejected') return 'rejected';
  if (!result.reason) return 'unverified';
  return pvzNativeReason(result.reason)?.certainty === 'unknown' ? 'unverified' : 'rejected';
}

function rejectedReceipt(ack: PvzNativeAck, action: PvzNativeAction, before: PvzSnapshot): PvzActionReceipt {
  return {
    actionId: ack.id,
    status: 'rejected',
    action,
    beforeRevision: before.revision,
    afterRevision: before.revision,
    evidence: [ack.reason ?? '植入件拒绝动作'],
    state: compactSnapshot(before),
  };
}

function unverifiedReceipt(
  actionId: string,
  action: PvzNativeAction,
  before: PvzSnapshot,
  after: PvzSnapshot,
  evidence: string[],
): PvzActionReceipt {
  return {
    actionId,
    status: 'unverified',
    action,
    beforeRevision: before.revision,
    afterRevision: after.revision,
    evidence,
    state: compactSnapshot(after),
  };
}

function plantsAt(snapshot: PvzSnapshot, row: number, column: number) {
  return snapshot.board?.plants.filter((plant) => plant.row === row && plant.column === column) ?? [];
}

function plantFootprint(snapshot: PvzSnapshot, row: number, column: number): number {
  return plantsAt(snapshot, row, column)
    .reduce((total, plant) => total + 1 + plant.layers.length, 0);
}

function menuContext(snapshot: PvzSnapshot): string {
  return JSON.stringify({
    screen: snapshot.screen,
    scene: snapshot.scene,
    dialog: snapshot.dialog,
    menu: snapshot.menu.map((item) => [item.id, item.enabled, item.state]),
    inputMenuContext: snapshot.inputControl.menuContext,
  });
}

function specialTargets(snapshot: PvzSnapshot, action: string): PvzSpecialTarget[] {
  return snapshot.board?.special?.targets.filter((target) => target.action === action) ?? [];
}

function specialTarget(
  snapshot: PvzSnapshot,
  action: string,
  selector: { targetId?: number; slot?: number; row?: number; column?: number },
): PvzSpecialTarget | null {
  return specialTargets(snapshot, action).find((target) => {
    if (selector.targetId !== undefined && target.id !== selector.targetId) return false;
    if (selector.slot !== undefined && target.slot !== selector.slot) return false;
    if (selector.row !== undefined && target.row !== selector.row) return false;
    if (selector.column !== undefined && target.column !== selector.column) return false;
    return true;
  }) ?? null;
}

function globalSpecialTarget(snapshot: PvzSnapshot, action: string): PvzSpecialTarget | null {
  return specialTargets(snapshot, action).find((target) => target.kind === 'cell'
    && target.id === null
    && target.slot === null
    && target.row === null
    && target.column === null) ?? null;
}

function visiblePlantSpecialTarget(
  snapshot: PvzSnapshot,
  action: string,
  targetId: number | undefined,
): PvzSpecialTarget | null {
  if (targetId === undefined) return null;
  const target = specialTargets(snapshot, action).find((candidate) =>
    candidate.kind === 'plant' && candidate.id === targetId) ?? null;
  return target && targetEntity(snapshot, target) ? target : null;
}

function targetEntity(snapshot: PvzSnapshot, target: PvzSpecialTarget): unknown {
  const board = snapshot.board;
  if (!board) return null;
  if (target.kind === 'plant') return board.plants.find((item) => item.id === target.id) ?? null;
  if (target.kind === 'zombie') return board.zombies.find((item) => item.id === target.id) ?? null;
  if (target.kind === 'grid_item') return board.gridItems.find((item) => item.id === target.id) ?? null;
  if (target.kind === 'collectible') return board.collectibles.find((item) => item.id === target.id) ?? null;
  if (target.kind === 'card') return board.cards.find((item) => item.slot === target.slot) ?? null;
  return board.cells.find((item) => item.row === target.row && item.column === target.column) ?? null;
}

function plantMatrix(snapshot: PvzSnapshot): string {
  return JSON.stringify((snapshot.board?.plants ?? [])
    .map((plant) => [plant.id, plant.type, plant.row, plant.column, plant.layers])
    .sort((left, right) => Number(left[0]) - Number(right[0])));
}

function sameVisibleBoardRun(before: PvzSnapshot, after: PvzSnapshot): boolean {
  return sameBoardRun(before, after)
    && before.board!.disclosure.entitiesVisible
    && after.board!.disclosure.entitiesVisible;
}

function sameBoardRun(before: PvzSnapshot, after: PvzSnapshot): boolean {
  return before.screen === 'board'
    && after.screen === 'board'
    && before.mode === after.mode
    && before.board !== null
    && after.board !== null
    && before.board.runId === after.board.runId;
}

function winningRunMatchesBoard(before: PvzSnapshot, after: PvzSnapshot): boolean {
  const board = before.board;
  const result = after.lastRun;
  if (before.screen !== 'board' || !board || !result || result.outcome !== 'won'
    || result.runId !== board.runId || result.mode !== before.mode || result.level !== board.level) {
    return false;
  }
  if (after.board !== null && after.board.runId === board.runId) return false;
  const prior = before.lastRun;
  if (!prior) return true;
  if (result.resultId > prior.resultId) return true;
  return result.resultId === prior.resultId
    && result.runId === prior.runId
    && result.mode === prior.mode
    && result.level === prior.level
    && result.outcome === prior.outcome;
}

function commandContext(snapshot: PvzSnapshot, action: PvzNativeAction) {
  const context: {
    inputEpoch: number;
    menuContext: number;
    expectedCardType?: number;
    expectedCardImitates?: number | null;
  } = {
    inputEpoch: snapshot.inputControl.epoch,
    menuContext: snapshot.inputControl.menuContext,
  };
  const slot = action.kind === 'plant'
    ? action.slot
    : action.kind === 'special'
      && ['bowling', 'place_zombie', 'beghouled_buy'].includes(action.action)
      ? action.slot
      : undefined;
  if (slot !== undefined) {
    const card = snapshot.board?.cards.find((item) => item.slot === slot);
    if (card) {
      context.expectedCardType = card.type;
      context.expectedCardImitates = card.imitates;
    }
  }
  return context;
}

/**
 * 点开一个菜单目标之后,这一项自己不再可点。
 *
 * 切场景时 PvZ 不撤掉主菜单按钮,只把整排按钮置灰,所以"目标从列表里消失"只是这件事的
 * 一种呈现形态,另一种是同一项还在、enabled 变成 false。两种都是关于被点那一项的直接
 * 证据;界面上别处的变化不算。
 */
function menuTargetWithdrawn(target: string, before: PvzSnapshot, after: PvzSnapshot): boolean {
  if (!before.menu.some((item) => item.id === target && item.enabled)) return false;
  const current = after.menu.find((item) => item.id === target);
  return !current || !current.enabled;
}

function verifyMenuTarget(target: string, before: PvzSnapshot, after: PvzSnapshot): string[] | null {
  if ((target === 'restart' || target === 'main_menu')
    && before.menu.some((item) => item.id === target && item.enabled)
    && after.dialog?.hasPrimary && after.dialog.primaryLabel === target
    && after.dialog.hasSecondary && after.dialog.secondaryLabel === 'cancel'
    && after.dialog.id !== before.dialog?.id
    && after.menu.some((item) => item.id === target && item.enabled)) {
    return [`${target} 已打开确认对话，等待确认`];
  }
  if (target.startsWith('profile:')) {
    const offered = before.menu.find((item) => item.id === target && item.enabled);
    const selected = after.menu.find((item) => item.id === target && item.enabled && item.state === 'selected');
    return offered && selected && before.dialog !== null && after.dialog?.id === before.dialog.id
      ? [`档案 ${selected.label} 已选中，等待 confirm 确认`]
      : null;
  }
  if (target === 'confirm' && before.menu.some((item) => item.id.startsWith('profile:'))) {
    const selected = before.menu.find((item) => item.id.startsWith('profile:') && item.state === 'selected');
    return selected && before.menu.some((item) => item.id === 'confirm' && item.enabled)
      && after.profile?.name === selected.label
      && !after.menu.some((item) => item.id.startsWith('profile:'))
      && JSON.stringify(before.dialog) !== JSON.stringify(after.dialog)
      ? [`当前档案已确认：${selected.label}`]
      : null;
  }
  if (target === 'pause') {
    return before.board && !before.board.paused && after.board?.paused
      ? ['棋盘已暂停']
      : null;
  }
  if (target === 'resume') {
    const resumable = before.board?.paused || before.screen === 'dialog' && before.board === null
      && before.menu.some(item => item.id === 'resume' && item.enabled);
    return resumable && before.mode === after.mode && after.screen === 'board'
      && after.board && !after.board.paused
      ? ['棋盘已继续']
      : null;
  }
  if (target === 'main_menu') {
    return before.screen !== 'main_menu' && after.screen === 'main_menu'
      ? ['已返回主菜单']
      : null;
  }
  if (target === 'advance') {
    const offered = before.menu.some((item) => item.id === target && item.enabled);
    return offered && menuContext(before) !== menuContext(after)
      ? ['当前标题、奖励或对话步骤已推进']
      : null;
  }
  if (target === 'confirm' || target === 'cancel') {
    return before.dialog !== null && JSON.stringify(before.dialog) !== JSON.stringify(after.dialog)
      ? [`对话已执行 ${target}`]
      : null;
  }
  if (target === 'restart') {
    const offered = before.menu.some((item) => item.id === target && item.enabled);
    const newRun = before.board && after.board && before.board.runId !== after.board.runId;
    return offered && (after.screen === 'loading' || after.screen === 'seed_picker'
      || newRun)
      ? ['当前关卡已重新载入']
      : null;
  }
  if (target === 'onslaught') {
    const offered = before.menu.some((item) => item.id === target && item.enabled);
    return offered && before.board?.paused && after.board && !after.board.paused
      ? ['关卡已从布阵状态推进']
      : null;
  }

  if (target.startsWith('store_buy_')) {
    const offered = before.menu.some((item) => item.id === target && item.enabled);
    const beforeItem = before.menu.find((item) => item.id === target);
    const afterItem = after.menu.find((item) => item.id === target);
    const coinsSpent = before.profile !== null && after.profile !== null
      && after.profile.coins < before.profile.coins;
    const itemChanged = JSON.stringify(beforeItem) !== JSON.stringify(afterItem);
    return offered && coinsSpent && menuContext(before) !== menuContext(after)
      && (itemChanged || afterItem === undefined)
      ? [`商店目标 ${target} 已购买`]
      : null;
  }

  const offered = before.menu.some((item) => item.id === target && item.enabled);
  if (offered && target.startsWith('page_') && menuContext(before) !== menuContext(after)) {
    return [`模式选择页已切换到 ${target}`];
  }
  if (menuTargetWithdrawn(target, before, after)) {
    return [`菜单目标 ${target} 已离开当前交互状态`];
  }
  return null;
}

const NATIVE_EFFECT_TEXT: Record<string, string> = {
  card_consumed: '这张卡已经被这次种植消耗掉了',
  shovel_applied: '铲子已经落在目标格上',
  profile_created: '新档案已经建好',
  collectibles_collected: '目标掉落物已经被收走',
  target_changed: '被锤的目标出现了受击变化',
  bowling_launched: '坚果已经从传送带发出去了',
  usable_seed_consumed: '这一包已经用掉了',
  beghouled_purchase: '这次升级已经买下',
  zen_care_applied: '这次照料已经作用在目标植物上',
  garden_changed: '已经换到下一个花园',
  tree_fed: '这次喂食已经生效',
};

/** 游戏内部确认了什么;快照那边没比出变化时,回执说的就是这一条。 */
function nativeExecutedEvidence(result: PvzNativeResult): string[] {
  const effect = result.effect ? NATIVE_EFFECT_TEXT[result.effect] : undefined;
  return [
    effect ?? '这次输入已经在游戏内部完成',
    ...(result.reason ? [result.reason] : []),
  ];
}

export function verifyAction(
  action: PvzNativeAction,
  before: PvzSnapshot,
  after: PvzSnapshot,
  observations: readonly PvzSnapshot[] = [],
  nativeEffect?: PvzNativeResult['effect'],
  placement?: PvzNativePlacement,
): string[] | null {
  if (after.revision <= before.revision) return null;
  if (action.kind === 'choose_seed') {
    const had = before.seedPicker?.selected.includes(action.seed) ?? false;
    const has = after.seedPicker?.selected.includes(action.seed) ?? false;
    const choice = after.seedPicker?.choices.find((item) => item.id === action.seed);
    if (choice?.state !== (has ? 'selected' : 'chooser')) return null;
    if (!had && has && action.imitates !== undefined) {
      if (choice?.imitates !== action.imitates) return null;
    }
    return had !== has ? [`选卡状态已变化: ${action.seed} ${had ? '已移除' : '已选择'}`] : null;
  }
  if (action.kind === 'profile_create') {
    const offered = before.menu.some((item) => item.id === 'profile_create' && item.enabled);
    return offered && before.screen === 'dialog' && before.dialog !== null
      && nativeEffect === 'profile_created'
      && after.screen === 'main_menu' && after.dialog === null
      && after.profile?.name === action.name
      && menuContext(before) !== menuContext(after)
      ? ['本地玩家档案已创建并进入下一界面']
      : null;
  }
  if (action.kind === 'ready') {
    return after.screen === 'board' && before.screen !== 'board'
      ? ['画面已从选卡切换到棋盘']
      : null;
  }
  if (action.kind === 'plant') {
    if (!sameBoardRun(before, after)) return null;
    const relative = 'aheadOf' in action;
    if (relative && (!placement || placement.row !== action.row || placement.runId !== before.board?.runId)) return null;
    const column = 'column' in action ? action.column : placement!.column;
    const beforeCard = before.board?.cards.find((c) => c.slot === action.slot);
    const afterCard = after.board?.cards.find((c) => c.slot === action.slot);
    if (!beforeCard) return null;
    const blindAttempt = before.board?.cells.some((cell) =>
      cell.row === action.row && cell.column === column
      && (cell.playable === null || cell.blocker === 'dark_hidden')) ?? false;
    const expectedType = beforeCard.imitates ?? beforeCard.type;
    const beforeIds = new Set(plantsAt(before, action.row, column).map((plant) => plant.id));
    const visibleObservations = [...observations, after]
      .filter((snapshot) => sameVisibleBoardRun(before, snapshot));
    const planted = visibleObservations.some((snapshot) =>
      plantsAt(snapshot, action.row, column)
        .some((plant) => plant.type === expectedType && !beforeIds.has(plant.id)));
    if (planted) return [`${cellText(action.row, column)}的植物层已变化`];
    if (relative) return null;
    const spentSun = (after.board?.sun ?? Number.POSITIVE_INFINITY) < (before.board?.sun ?? 0);
    const cursorReleased = after.board?.cursor.kind === 'normal';
    const cardReplaced = !afterCard
      || afterCard.type !== beforeCard.type
      || afterCard.imitates !== beforeCard.imitates;
    const cardConsumed = cardReplaced || !afterCard.ready;
    const beforePlantIds = new Set((before.board?.plants ?? []).map((plant) => plant.id));
    const wrongCellPlantAppeared = visibleObservations.some((snapshot) =>
      (snapshot.board?.plants ?? []).some((plant) => !beforePlantIds.has(plant.id)
        && plant.type === expectedType
        && (plant.row !== action.row || plant.column !== action.column)));
    const zeroCostCardConsumed = beforeCard.cost === 0 && !cardReplaced
      && afterCard !== undefined && !afterCard.ready;
    const conveyorCardConsumed = beforeCard.cost === null
      && nativeEffect === 'card_consumed';
    if (blindAttempt && beforeCard.ready && cardConsumed && cursorReleased
      && (spentSun || zeroCostCardConsumed || conveyorCardConsumed)
      && !wrongCellPlantAppeared) {
      return [`遮蔽落点后卡槽 ${action.slot} 已消耗且内部光标已释放（目标格动态内容仍未知）`];
    }
    return null;
  }
  if (action.kind === 'shovel') {
    const beforeFootprint = plantFootprint(before, action.row, action.column);
    if (sameVisibleBoardRun(before, after)) {
      const afterFootprint = plantFootprint(after, action.row, action.column);
      return beforeFootprint > 0 && afterFootprint < beforeFootprint
        ? [`${cellText(action.row, action.column)}的植物层已减少或改变`]
        : null;
    }
    const completedTutorial = before.board?.tutorial?.kind === 'shovel'
      && before.board.tutorial.remainingPlants === 1
      && beforeFootprint > 0
      && nativeEffect === 'shovel_applied'
      && before.mode === 0 && after.mode === 0
      && before.scene === 2 && after.scene === 2
      && after.screen === 'dialog' && after.board === null
      && menuContext(before) !== menuContext(after);
    return completedTutorial
      ? [`${cellText(action.row, action.column)}的最后一株教程植物已铲除，教程对话已继续`]
      : null;
  }
  if (action.kind === 'collect') {
    if (nativeEffect !== 'collectibles_collected') return null;
    const offered = new Set(before.board?.collectibles.map((item) => item.id) ?? []);
    if (!action.ids.length || action.ids.some((id) => !offered.has(id))) return null;
    if (sameBoardRun(before, after)) {
      const remaining = new Set(after.board?.collectibles.map((item) => item.id) ?? []);
      if (action.ids.every((id) => !remaining.has(id))) {
        return [`目标掉落物已确认收取: ${action.ids.join(',')}`];
      }
      return null;
    }
    const terminalRequested = before.board?.collectibles.some((item) =>
      action.ids.includes(item.id) && isTerminalCollectible(item.kind)) ?? false;
    if (terminalRequested && winningRunMatchesBoard(before, after)
      && ['mode_selector', 'seed_picker', 'main_menu', 'credits', 'award', 'dialog']
        .includes(after.screen)) {
      return [`目标掉落物已确认收取并推进到 ${after.screen}: ${action.ids.join(',')}`];
    }
    return null;
  }
  if (action.kind === 'cancel') {
    const cursor = after.board?.cursor.kind;
    const modeOwnedCursor = cursor === 'hammer'
      && after.board?.allowedSpecialActions.includes('whack') === true;
    const cursorReleased = after.board === null || cursor === 'normal' || modeOwnedCursor;
    if (after.inputControl.epoch > before.inputControl.epoch
      && after.inputControl.queueDepth === 0
      && after.inputControl.activeActionId === null
      && cursorReleased) {
      return [cursor === 'normal' && before.board?.cursor.kind !== 'normal'
        ? '动作队列已清空，游戏内部光标已释放持有物'
        : '动作队列已清空且输入控制代次已推进'];
    }
    return null;
  }
  if (action.kind === 'menu') {
    return verifyMenuTarget(action.target, before, after);
  }
  if (action.kind === 'interact') {
    if (action.target.startsWith('store_buy_')) {
      return verifyMenuTarget(action.target, before, after);
    }
    return menuTargetWithdrawn(action.target, before, after)
      ? [`交互目标 ${action.target} 已完成并离开当前状态`]
      : null;
  }
  if (action.kind === 'visual_click') {
    return menuContext(before) !== menuContext(after)
      ? [`视觉兼容点击 (${action.x},${action.y}) 后界面状态已变化`]
      : null;
  }
  if (action.kind === 'special') {
    if (action.action === 'buy_trophy') {
      const target = specialTarget(before, action.action, {});
      return before.screen === 'board'
        && before.board !== null
        && target !== null
        && after.screen === 'award'
        ? ['水族馆奖杯购买已进入完成状态']
        : null;
    }
    if (action.action === 'zen_next_garden') {
      const target = globalSpecialTarget(before, action.action);
      const publicGardenChanged = before.screen === 'board'
        && before.board !== null
        && after.screen === 'board'
        && after.board !== null
        && (before.mode !== after.mode
          || before.board.runId !== after.board.runId
          || before.board.background !== after.board.background);
      return nativeEffect === 'garden_changed' && target && publicGardenChanged
        ? ['禅境花园已切换到新的公开棋盘状态']
        : null;
    }
    if (action.action === 'tree_feed') {
      const target = globalSpecialTarget(before, action.action);
      return nativeEffect === 'tree_fed' && before.screen === 'board'
        && before.board !== null && target
        ? ['智慧树已完成一次喂养']
        : null;
    }
    if (action.action === 'whack' && action.targetIds !== undefined) {
      if (!action.targetIds.length || new Set(action.targetIds).size !== action.targetIds.length) {
        return null;
      }
      const targets = action.targetIds.map((targetId) =>
        specialTarget(before, action.action, { targetId }));
      if (targets.some((target) => target?.kind !== 'zombie')) return null;
      const visibleObservations = [...observations, after]
        .filter((snapshot) => sameVisibleBoardRun(before, snapshot));
      const changed = targets.filter((target) => {
        const beforeEntity = targetEntity(before, target!);
        return beforeEntity !== null && visibleObservations.some((snapshot) => {
          const afterEntity = targetEntity(snapshot, target!);
          return afterEntity === null || JSON.stringify(afterEntity) !== JSON.stringify(beforeEntity);
        });
      }).length;
      return nativeEffect === 'target_changed' && changed > 0
        ? [`当前锤击批次观察到 ${changed}/${action.targetIds.length} 个目标状态变化`]
        : null;
    }
    if (!sameVisibleBoardRun(before, after)) return null;
    const board = after.board;
    if (!before.board || !board) return null;
    if (ZEN_CARE_ACTIONS.has(action.action)) {
      const target = visiblePlantSpecialTarget(before, action.action, action.targetId);
      return nativeEffect === 'zen_care_applied' && target
        ? [`${action.action} 已应用到可见植物 ${target.id}`]
        : null;
    }
    const target = specialTarget(before, action.action, {
      ...(action.targetId === undefined ? {} : { targetId: action.targetId }),
      ...(action.slot === undefined ? {} : { slot: action.slot }),
    });
    const cellTarget = specialTarget(before, action.action, {
      ...(action.row === undefined ? {} : { row: action.row }),
      ...(action.column === undefined ? {} : { column: action.column }),
    });
    if (!target && !cellTarget) return null;
    const targetGone = target !== null && specialTarget(after, action.action, {
      ...(target.id === null ? {} : { targetId: target.id }),
      ...(target.slot === null ? {} : { slot: target.slot }),
      ...(target.kind !== 'cell' || target.row === null ? {} : { row: target.row }),
      ...(target.kind !== 'cell' || target.column === null ? {} : { column: target.column }),
    }) === null;
    const at = target?.row !== null && target?.row !== undefined
      ? cellText(target.row, target.column!)
      : action.row !== undefined && action.column !== undefined
        ? cellText(action.row, action.column)
        : specialActionDisplayName(action.action);

    if (action.action === 'break_vase' && target?.kind === 'grid_item') {
      const beforeEntity = targetEntity(before, target);
      const afterEntity = targetEntity(after, target);
      return beforeEntity && afterEntity === null
        ? [`${at}的花瓶状态已变化`]
        : null;
    }
    if (['swap', 'twist'].includes(action.action)) {
      return board.special?.settled && plantMatrix(before) !== plantMatrix(after)
        ? [`${action.action} 后植物矩阵已变化`]
        : null;
    }
    if (action.action === 'whack' && target?.kind === 'zombie') {
      const beforeEntity = targetEntity(before, target);
      const afterEntity = targetEntity(after, target);
      return nativeEffect === 'target_changed' && beforeEntity
        && (afterEntity === null || JSON.stringify(beforeEntity) !== JSON.stringify(afterEntity))
        ? [`${at}的目标僵尸状态已变化`]
        : null;
    }
    if (action.action === 'spin') {
      const sawRolling = observations.some((snapshot) => snapshot.board?.special?.phase === 'rolling');
      const packetsChanged = JSON.stringify(before.board.cards) !== JSON.stringify(board.cards);
      return board.special?.settled && board.special.phase === 'ready' && (sawRolling || packetsChanged)
        ? ['spin 已完成滚动并回到可输入阶段']
        : null;
    }
    if (action.action === 'beghouled_buy' && action.slot !== undefined
      && target?.kind === 'card') {
      const publicChange = board.sun < before.board.sun
        || plantMatrix(before) !== plantMatrix(after)
        || JSON.stringify(before.board.gridItems) !== JSON.stringify(board.gridItems)
        || targetGone;
      return nativeEffect === 'beghouled_purchase' && publicChange
        ? [`Beghouled 顶栏卡包 ${action.slot} 已购买并生效`]
        : null;
    }
    if (action.action === 'start_onslaught') {
      const phaseAdvanced = before.board.special?.phase === 'setup_ready'
        && board.special?.phase === 'onslaught';
      const progressAdvanced = before.board.progress.kind === 'setup'
        && board.progress.kind !== 'setup';
      return targetGone && (phaseAdvanced || progressAdvanced)
        ? ['关卡已从布阵状态推进到猛攻阶段']
        : null;
    }
    if (action.action === 'bowling' && action.slot !== undefined
      && action.row !== undefined && action.column !== undefined) {
      const beforeCard = before.board.cards.find((item) => item.slot === action.slot);
      const afterCard = board.cards.find((item) => item.slot === action.slot);
      const oldIds = new Set(before.board.plants.map((plant) => plant.id));
      const rollingPlant = board.plants.some((plant) => !oldIds.has(plant.id)
        && plant.row === action.row && plant.type === beforeCard?.type);
      const nativeLaunch = nativeEffect === 'bowling_launched'
        && board.cursor.kind === 'normal';
      return beforeCard && (rollingPlant || nativeLaunch)
        ? ['bowling 后目标卡槽或滚动坚果状态已变化']
        : null;
    }
    if (action.action === 'place_zombie' && action.slot !== undefined
      && action.row !== undefined && action.column !== undefined) {
      const oldIds = new Set(before.board.zombies.map((zombie) => zombie.id));
      const placed = board.zombies.some((zombie) => !oldIds.has(zombie.id)
        && zombie.row === action.row && zombie.column === action.column);
      return placed
        ? [`已在${cellText(action.row, action.column)}放下僵尸卡`]
        : null;
    }
    if (action.action === 'launch' && action.row !== undefined && action.column !== undefined) {
      const oldIds = new Set(before.board.plants.map((plant) => plant.id));
      const planted = board.plants.some((plant) => !oldIds.has(plant.id)
        && plant.row === action.row && plant.column === action.column
        && (before.board!.cursor.heldType === null || plant.type === before.board!.cursor.heldType));
      if (planted) return [`已把可用植物包用在${cellText(action.row, action.column)}`];
      const beforeCell = before.board.cells.find((cell) =>
        cell.row === action.row && cell.column === action.column);
      const blindTarget = beforeCell?.playable === null && beforeCell.blocker === 'fog_hidden';
      const heldType = before.board.cursor.heldType;
      const wrongCellPlantAppeared = heldType !== null && observations.some((snapshot) =>
        sameVisibleBoardRun(before, snapshot)
        && (snapshot.board?.plants ?? []).some((plant) => !oldIds.has(plant.id)
          && plant.type === heldType
          && (plant.row !== action.row || plant.column !== action.column)));
      return blindTarget
        && before.board.cursor.kind === 'usable_seed'
        && heldType !== null
        && nativeEffect === 'usable_seed_consumed'
        && board.cursor.kind === 'normal'
        && !wrongCellPlantAppeared
        ? [`已把可用植物包用在雾里的${cellText(action.row, action.column)}（那一格里有什么仍然看不见）`]
        : null;
    }
    if (action.action === 'cob_fire' && target?.kind === 'plant') {
      return targetGone ? [`玉米加农炮 ${target.id} 已进入装填状态`] : null;
    }
    if (action.action === 'drop_brain' && action.row !== undefined && action.column !== undefined) {
      const oldIds = new Set(before.board.gridItems.map((item) => item.id));
      const brain = board.gridItems.some((item) => !oldIds.has(item.id)
        && item.kind === 'i_zombie_brain' && item.row === action.row && item.column === action.column);
      return brain ? [`已在${cellText(action.row, action.column)}放下脑子`] : null;
    }
    if (action.action === 'buy_snorkel') {
      const oldIds = new Set(before.board.zombies.map((zombie) => zombie.id));
      const bought = board.zombies.some((zombie) => !oldIds.has(zombie.id));
      return bought && board.sun < before.board.sun ? ['水族馆已购入新的潜水僵尸'] : null;
    }
    return null;
  }
  if (action.kind === 'configure' || action.kind === 'shutdown' || action.kind === 'detach' || action.kind === 'capture') return null;
  return null;
}

const ZEN_CARE_ACTIONS = new Set([
  'zen_water',
  'zen_fertilize',
  'zen_bug_spray',
  'zen_phonograph',
  'zen_chocolate',
]);
