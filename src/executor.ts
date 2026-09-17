import type { PvzCard, PvzSnapshot } from './protocol.ts';
import { cellText, plantName } from './names.ts';
import { localizedCardDisplay } from './semantic.ts';
import {
  describePvzStep,
  describePvzPlantPosition,
  pvzSeedSelectorDisplayName,
  pvzSeedSelectorName,
  type PvzDoStep,
  type PvzPlantWhen,
  type PvzQueueMode,
  type PvzSeedSelector,
  type PvzPlantColumn,
} from './skills.ts';

export type PvzStepOutcome = 'done' | 'noop' | 'partial' | 'yield' | 'blocked' | 'unverified';

export interface PvzStepResult {
  outcome: PvzStepOutcome;
  text: string;
}

export interface PvzStepLanding {
  step: number;
  what: string;
  outcome: PvzStepOutcome | 'cut';
  text: string;
}

export interface PvzTaskReport {
  kind: 'done' | 'partial' | 'blocked' | 'unverified' | 'cancelled';
  taskId: number;
  text: string;
  steps: readonly PvzStepLanding[];
}

export interface PvzExecutionContext {
  taskId: number;
  stepIndex: number;
  stepCount: number;
  reservedCard: PvzReservedCard | null;
  aborted(): boolean;
  abortedBy(): string | null;
}

export interface PvzReservedCard {
  mode: number;
  runId: number;
  plant: string;
  slot: number;
  type: number;
  imitates: number | null;
}

export interface PvzPlantAdmissionBinding {
  mode: number;
  runId: number;
  slot: number;
  type: number;
  imitates: number | null;
  name: string;
  /** Conveyor inventory is reserved by type and count; its array slots compact after use. */
  conveyor?: boolean;
}

export interface PvzExecutorOptions {
  snapshot: () => PvzSnapshot | null;
  refreshSnapshot?: () => Promise<void>;
  execute: (step: PvzDoStep, context: PvzExecutionContext) => Promise<PvzStepResult>;
  /** Resolves only after the native input epoch, queue, and held cursor have been cleared. */
  cancelNative: (reason: string) => Promise<void>;
  report: (report: PvzTaskReport) => void;
  /** Terminal state of a `submitInternal` task; it never reaches the model. */
  reportInternal?: (report: PvzTaskReport) => void;
  nextId: () => number;
  diagnostic?: (data: Record<string, unknown>) => void;
  now?: () => number;
}

/** 一份卡片预留。`forStep` 非空表示它留给的是后面那一步,不是这一行正在说的那一步。 */
export interface PvzReservedCardView {
  card: string;
  forStep: number | null;
}

export interface PvzQueueStatus {
  running: {
    taskId: number;
    label: string;
    stepIndex: number;
    stepCount: number;
    step: string;
    elapsedMs: number;
    reservedCard: PvzReservedCardView | null;
  } | null;
  waiting: Array<{ taskId: number; label: string }>;
  reservations: Array<{
    taskId: number;
    plant: string;
    at: { row: number; column: PvzPlantColumn };
    waitingFor: Exclude<PvzPlantWhen, 'now'>;
    reservedCard: PvzReservedCardView;
    followingSteps: string[];
  }>;
  hold: string | null;
  /** World 自排的收阳光任务正占着执行器;模型的队列排在它后面,不是卡住。 */
  collectingSun: boolean;
}

interface QueuedTask {
  id: number;
  order: number;
  priority: number;
  /** Work the module queued for itself: invisible to the model and never reported to it. */
  internal: boolean;
  steps: PvzDoStep[];
  stepIndex: number;
  stepLog: PvzStepLanding[];
  enqueuedAt: number;
  startedAt: number | null;
  terminal: boolean;
  reservationBinding: PlantBinding | null;
  boardScope: { mode: number; runId: number } | null;
}

interface AbortToken {
  aborted: boolean;
  by: string | null;
}

interface RunningTask {
  task: QueuedTask;
  token: AbortToken;
  stepStartedAt: number;
  stepBegan: boolean;
}

interface InterruptedTask {
  task: QueuedTask;
  report: PvzTaskReport;
  native: 'pending' | 'released' | 'failed';
  failure: string | null;
  barrier: Promise<void>;
  resolveBarrier: () => void;
}

interface PlantReservation {
  kind: 'plant';
  task: QueuedTask;
  plant: string;
  at: { row: number; column: PvzPlantColumn };
  waitingFor: Exclude<PvzPlantWhen, 'now'>;
}

type TaskReservation = PlantReservation;

interface PlantBinding extends PvzReservedCard {
  stepIndex: number;
  name: string;
  conveyor?: boolean;
}

type AdmissionBoundPlantStep = Extract<PvzDoStep, { skill: 'plant' }> & {
  binding: PvzPlantAdmissionBinding;
};

type ReservationDecision =
  | { kind: 'ready' }
  | { kind: 'wait'; reservation: TaskReservation }
  | { kind: 'blocked'; text: string };

/** 这些画面上没有绑定任务的那块棋盘。 */
const OFF_BOARD_SCREENS = new Set(['award', 'defeat', 'main_menu', 'mode_selector', 'seed_picker', 'credits']);

/** 只把东西从盘上收走,不改动植物布局;本场结算后棋盘还在时仍然允许。 */
const PICKUP_SKILLS = new Set(['collect', 'auto_sun']);

/** A serialized, observable queue of semantic PvZ work. */
export class PvzExecutor {
  private running: RunningTask | null = null;
  private queue: QueuedTask[] = [];
  private reservations: TaskReservation[] = [];
  private order = 0;
  private headPriority = 0;
  private cancelPending = false;
  private cancelFailure: string | null = null;
  private executionPending = false;
  private interrupted: InterruptedTask | null = null;
  private nativeCancellationPromise: Promise<void> | null = null;

  constructor(private readonly opts: PvzExecutorOptions) {}

  submit(steps: readonly PvzDoStep[], mode: PvzQueueMode = 'replace', cancel: readonly number[] = []): string {
    if (steps.length === 0) throw new Error('PvZ task needs at least one step');
    const runningBeforeSubmit = this.running;
    const id = this.opts.nextId();
    const task = this.createTask(id, steps, mode === 'now' ? --this.headPriority : 0, false);

    const cancelledIds = new Set(cancel);
    const cancelled = this.activeTasks().filter(candidate => cancelledIds.has(candidate.id));
    if (this.running && cancelledIds.has(this.running.task.id)) {
      this.interrupt(`被新任务#${id}撤掉`);
    }
    this.queue = this.queue.filter(candidate => !cancelledIds.has(candidate.id));
    this.reservations = this.reservations.filter(item => !cancelledIds.has(item.task.id));
    for (const old of cancelled) {
      if (old !== this.interrupted?.task) this.cancelTask(old, `被新任务#${id}撤掉`, false);
    }
    const dropped = mode === 'replace' ? this.takeWaiting((candidate) => !candidate.internal) : [];
    for (const old of dropped) this.cancelTask(old, `被新任务#${id}替换`, false);

    const interrupted = mode === 'now' ? this.interrupt(`被 queue:now 的任务#${id}抢占`) : null;
    this.queue.push(task);
    this.sortQueue();
    this.opts.diagnostic?.({ phase: 'task.accepted', taskId: id, mode, atMs: task.enqueuedAt });
    this.pump();

    const notes = [
      cancelled.length ? `撤掉了 ${cancelled.map(item => `任务#${item.id}`).join('、')}` : null,
      interrupted ? `叫停了任务#${interrupted}` : null,
      dropped.length > 0 ? `撤掉等待中的 ${dropped.map((item) => `任务#${item.id}`).join('、')}` : null,
      // World 自排的收阳光任务对模型不可见:说它在收阳光,不给它编号,也不提 queue:now——
      // 那句话曾把「排在收阳光后面」读成「卡住了」,引出一轮一轮的 now+cancel。
      mode === 'replace' && runningBeforeSubmit && !cancelledIds.has(runningBeforeSubmit.task.id)
        ? runningBeforeSubmit.task.internal
          ? `World 正在收阳光；新任务#${id}排在其后，几秒内轮到`
          : `正在运行的任务#${runningBeforeSubmit.task.id}仍会继续整项任务（当前第 ${runningBeforeSubmit.task.stepIndex + 1}/${runningBeforeSubmit.task.steps.length} 步）；新任务#${id}排在其后；若必须立即改动作，用 queue:now`
        : null,
    ].filter(Boolean);
    return `任务#${id} 已受理:${labelOf(task)}。${notes.length > 0 ? ` ${notes.join('；')}。` : ''}`
      + `\n[PvZ队列] ${renderPvzQueue(this.status(), id)}`;
  }

  /**
   * World 自己排的一项工作。它排在同优先级模型任务之前——掉落物有寿命，种植意图没有
   * ——但不抢占正在执行的任务，模型的 `queue:"now"` 反过来可以抢占它。终态只回给
   * `reportInternal`。
   */
  submitInternal(steps: readonly PvzDoStep[]): number {
    const id = this.opts.nextId();
    const task = this.createTask(id, steps, 0, true);
    this.queue.push(task);
    this.sortQueue();
    this.pump();
    return id;
  }

  /** Re-evaluate parked card reservations after a fresh snapshot arrives. */
  wake(): number {
    const awakened = this.releaseReadyReservations();
    this.pump();
    return awakened;
  }

  /** Stop current work and cancel every queued or parked task. */
  stop(reason = 'pvz_stop'): string | null {
    const running = this.running;
    const waiting = this.takeWaiting();
    if (!running && waiting.length === 0) return null;

    if (running) {
      this.interrupt(reason);
    }
    for (const task of waiting) this.cancelTask(task, reason, false);

    return `已停止${running ? `任务#${running.task.id}` : '当前工作'}`
      + `${waiting.length > 0 ? `，撤掉等待中的 ${waiting.map((task) => `任务#${task.id}`).join('、')}` : ''}`;
  }

  /** Stop all work and resolve only after the native release fence and interrupted action exit. */
  async stopAndWait(reason = 'pvz_stop'): Promise<string | null> {
    const stopped = this.stop(reason);
    const interrupted = this.interrupted;
    const release = this.nativeCancellationPromise
      ?? (interrupted?.native === 'released'
        ? Promise.resolve()
        : this.beginNativeCancellation(reason));
    await release;
    if (interrupted) await interrupted.barrier;
    if (this.cancelFailure) throw new Error(this.cancelFailure);
    return stopped;
  }

  async cancelAndWait(taskId: number): Promise<string> {
    const reason = `按任务号撤掉任务#${taskId}`;
    if (this.running?.task.id === taskId) this.interrupt(reason);
    const interrupted = this.interrupted;
    if (interrupted?.task.id === taskId) {
      await this.nativeCancellationPromise;
      await interrupted.barrier;
      if (this.cancelFailure) throw new Error(this.cancelFailure);
      this.pump();
      return `${reason}，原生输入已释放`;
    }
    const task = this.activeTasks().find(candidate => candidate.id === taskId);
    if (!task) return `任务#${taskId}已结束或不在当前队列中`;
    this.queue = this.queue.filter(candidate => candidate !== task);
    this.reservations = this.reservations.filter(item => item.task !== task);
    this.cancelTask(task, reason, false);
    this.pump();
    return reason;
  }

  /** 只描述模型自己的队列;World 自排的工作不出现在这里。 */
  status(): PvzQueueStatus {
    const running = this.running && !this.running.task.internal ? this.running : null;
    const snapshot = this.opts.snapshot();
    const waiting = this.queue.filter((task) => !task.internal).sort(taskOrder).map((task) => ({
      taskId: task.id,
      label: task.steps.slice(task.stepIndex).map(describePvzStep).join('；'),
    }));
    const reservations = this.reservations.filter((item): item is PlantReservation => item.kind === 'plant')
      .sort(reservationOrder).map((reservation) => ({
      taskId: reservation.task.id,
      plant: reservation.plant,
      at: { ...reservation.at },
      waitingFor: reservation.waitingFor,
      reservedCard: this.reservedCardDisplay(reservation.task, snapshot)
        ?? { card: pvzSeedSelectorDisplayName(reservation.plant), forStep: null },
      followingSteps: reservation.task.steps.slice(reservation.task.stepIndex + 1).map(describePvzStep),
    }));
    return {
      running: running
        ? {
            taskId: running.task.id,
            label: labelOf(running.task),
            stepIndex: running.task.stepIndex,
            stepCount: running.task.steps.length,
            step: describePvzStep(running.task.steps[running.task.stepIndex]),
            elapsedMs: this.now() - running.stepStartedAt,
            reservedCard: this.reservedCardDisplay(running.task, snapshot),
          }
        : null,
      waiting,
      reservations,
      hold: this.cancelPending
        ? '正在释放原生输入与内部光标'
        : this.cancelFailure
          ?? (this.executionPending && !this.running ? '正在等待被取消的执行退出' : null),
      collectingSun: this.running?.task.internal ?? false,
    };
  }

  /** Admission discounts only reservations that submit(mode) will release, without mutating tasks. */
  selectUnreservedCard(
    plant: PvzSeedSelector,
    exceptTaskId?: number,
    admissionMode?: PvzQueueMode,
    cancelledIds?: ReadonlySet<number>,
  ): PvzCard | null {
    const snapshot = this.opts.snapshot();
    const board = snapshot?.board;
    if (!snapshot || !board) return null;
    return [...board.cards]
      .filter((card) => cardMatchesSelector(card, plant))
      .filter((card) => !this.isCardReserved(
        snapshot.mode,
        board.runId,
        card,
        exceptTaskId,
        admissionMode,
        cancelledIds,
      ))
      .sort((left, right) => cardConditionRank(left, 'now') - cardConditionRank(right, 'now')
        || left.slot - right.slot)[0] ?? null;
  }

  private createTask(
    id: number,
    steps: readonly PvzDoStep[],
    priority: number,
    internal: boolean,
  ): QueuedTask {
    const snapshot = this.opts.snapshot();
    const now = this.now();
    return {
      id,
      order: ++this.order,
      priority,
      internal,
      steps: structuredClone([...steps]),
      stepIndex: 0,
      stepLog: [],
      enqueuedAt: now,
      startedAt: null,
      terminal: false,
      reservationBinding: admissionPlantBinding(steps),
      boardScope: snapshot?.board
        && steps.some(step => ['plant', 'shovel', 'collect', 'auto_sun', 'special'].includes(step.skill))
        && !steps.every(step => step.skill === 'special' && step.action === 'whack')
        ? { mode: snapshot.mode, runId: snapshot.board.runId }
        : null,
    };
  }

  private pump(): void {
    if (this.running || this.interrupted || this.executionPending
      || this.cancelPending || this.cancelFailure) return;
    this.releaseReadyReservations();
    while (!this.running) {
      const task = this.queue.shift();
      if (!task) return;
      const decision = this.reservationFor(task);
      if (decision.kind === 'wait') {
        this.reservations.push(decision.reservation);
        continue;
      }
      const token: AbortToken = { aborted: false, by: null };
      const now = this.now();
      task.startedAt ??= now;
      this.running = { task, token, stepStartedAt: now, stepBegan: false };
      queueMicrotask(() => void this.run(task, token));
    }
  }

  private async run(task: QueuedTask, token: AbortToken): Promise<void> {
    while (!token.aborted && this.running?.task === task) {
      try {
        await this.opts.refreshSnapshot?.();
      } catch (error) {
        if (token.aborted || this.running?.task !== task) return;
        this.running = null;
        this.finish(task, {
          kind: 'unverified', taskId: task.id, steps: [...task.stepLog],
          text: `任务#${task.id} 未验真:执行前无法刷新状态：${String(error)}`,
        });
        this.pump();
        return;
      }
      if (token.aborted || this.running?.task !== task) return;
      const decision = this.reservationFor(task);
      if (decision.kind === 'wait') {
        this.running = null;
        this.reservations.push(decision.reservation);
        this.pump();
        return;
      }
      if (decision.kind === 'blocked') {
        this.running = null;
        this.blockTask(task, decision.text);
        this.pump();
        return;
      }

      const running = this.running;
      const step = task.steps[task.stepIndex];
      running.stepStartedAt = this.now();
      running.stepBegan = true;
      this.opts.diagnostic?.({
        phase: 'task.step.started', taskId: task.id, step: task.stepIndex + 1,
        ageMs: this.now() - task.enqueuedAt, revision: this.opts.snapshot()?.revision,
      });
      let result: PvzStepResult;
      this.executionPending = true;
      try {
        result = await this.opts.execute(step, {
          taskId: task.id,
          stepIndex: task.stepIndex,
          stepCount: task.steps.length,
          reservedCard: reservedCardOf(task),
          aborted: () => token.aborted,
          abortedBy: () => token.by,
        });
      } catch (error) {
        result = {
          outcome: 'unverified',
          text: error instanceof Error ? error.message : String(error),
        };
      } finally {
        this.executionPending = false;
        this.finalizeInterrupted();
        if (token.aborted) this.pump();
      }
      if (token.aborted || this.running?.task !== task) return;

      task.stepLog.push({
        step: task.stepIndex + 1,
        what: describePvzStep(step),
        outcome: result.outcome,
        text: result.text,
      });
      // Target loss is local to the current step; known prerequisite failures and
      // ambiguous side effects remain task barriers.
      if (result.outcome === 'blocked' || result.outcome === 'unverified') {
        this.running = null;
        this.finish(task, {
          kind: result.outcome,
          taskId: task.id,
          text: `任务#${task.id} 在第 ${task.stepIndex + 1}/${task.steps.length} 步${result.outcome === 'blocked' ? '受阻' : '未验真'}:${result.text}`,
          steps: [...task.stepLog],
        });
        this.pump();
        return;
      }

      task.stepIndex += 1;
      task.reservationBinding = admissionPlantBinding(task.steps, task.stepIndex);
      running.stepBegan = false;
      if (task.stepIndex < task.steps.length) continue;

      this.running = null;
      const partial = task.stepLog.some((landing) =>
        landing.outcome === 'partial' || landing.outcome === 'yield');
      this.finish(task, {
        kind: partial ? 'partial' : 'done',
        taskId: task.id,
        text: `任务#${task.id}${partial ? '部分完成' : '完成'}:${task.stepLog.map((landing) => landing.text).join('；')}`,
        steps: [...task.stepLog],
      });
      this.pump();
      return;
    }
  }

  private interrupt(reason: string): number | null {
    const running = this.running;
    if (!running) return null;
    running.token.aborted = true;
    running.token.by = reason;
    this.running = null;
    let resolveBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { resolveBarrier = resolve; });
    this.interrupted = {
      task: running.task,
      report: this.cancellationReport(running.task, reason, running.stepBegan),
      native: 'pending',
      failure: null,
      barrier,
      resolveBarrier,
    };
    this.beginNativeCancellation(reason);
    return running.task.id;
  }

  private beginNativeCancellation(reason: string): Promise<void> {
    if (this.nativeCancellationPromise) return this.nativeCancellationPromise;
    this.cancelPending = true;
    this.cancelFailure = null;
    if (this.interrupted) {
      this.interrupted.native = 'pending';
      this.interrupted.failure = null;
    }
    let cancellation!: Promise<void>;
    cancellation = Promise.resolve()
      .then(() => this.opts.cancelNative(reason))
      .then(
        () => {
          this.cancelPending = false;
          this.cancelFailure = null;
          if (this.interrupted) this.interrupted.native = 'released';
          this.finalizeInterrupted();
          this.pump();
        },
        (error: unknown) => {
          this.cancelPending = false;
          this.cancelFailure = `原生输入取消失败:${error instanceof Error ? error.message : String(error)}`;
          if (this.interrupted) {
            this.interrupted.native = 'failed';
            this.interrupted.failure = this.cancelFailure;
          }
          this.finalizeInterrupted();
        },
      )
      .finally(() => {
        if (this.nativeCancellationPromise === cancellation) this.nativeCancellationPromise = null;
      });
    this.nativeCancellationPromise = cancellation;
    return cancellation;
  }

  private cancelTask(task: QueuedTask, reason: string, cut: boolean): void {
    this.finish(task, this.cancellationReport(task, reason, cut));
  }

  private cancellationReport(task: QueuedTask, reason: string, cut: boolean): PvzTaskReport {
    const steps = [...task.stepLog];
    if (cut && !steps.some((landing) => landing.step === task.stepIndex + 1)) {
      steps.push({
        step: task.stepIndex + 1,
        what: describePvzStep(task.steps[task.stepIndex]),
        outcome: 'cut',
        text: reason,
      });
    }
    const where = task.startedAt === null
      ? '尚未执行'
      : cut
        ? `执行到第 ${task.stepIndex + 1}/${task.steps.length} 步`
        : `停在第 ${task.stepIndex + 1}/${task.steps.length} 步之前`;
    return {
      kind: 'cancelled',
      taskId: task.id,
      text: `任务#${task.id} 未完成:${where}，${reason}`,
      steps,
    };
  }

  private finalizeInterrupted(): void {
    const interrupted = this.interrupted;
    if (!interrupted || interrupted.native === 'pending' || this.executionPending) return;
    this.interrupted = null;
    if (interrupted.native === 'released') {
      this.finish(interrupted.task, interrupted.report);
    } else {
      this.finish(interrupted.task, {
        ...interrupted.report,
        kind: 'unverified',
        text: `任务#${interrupted.task.id} 未验真:中断动作已退出，但${interrupted.failure ?? '原生输入释放状态未知'}`,
      });
    }
    interrupted.resolveBarrier();
  }

  private finish(task: QueuedTask, report: PvzTaskReport): void {
    if (task.terminal) return;
    task.terminal = true;
    this.opts.diagnostic?.({
      phase: 'task.terminal', taskId: task.id, outcome: report.kind,
      ageMs: this.now() - task.enqueuedAt,
    });
    if (task.internal) this.opts.reportInternal?.(report);
    else this.opts.report(report);
  }

  private blockTask(task: QueuedTask, text: string): void {
    if (task.terminal) return;
    const step = task.steps[task.stepIndex];
    task.stepLog.push({
      step: task.stepIndex + 1,
      what: describePvzStep(step),
      outcome: 'blocked',
      text,
    });
    this.finish(task, {
      kind: 'blocked',
      taskId: task.id,
      text: `任务#${task.id} 在第 ${task.stepIndex + 1}/${task.steps.length} 步受阻:${text}`,
      steps: [...task.stepLog],
    });
  }

  private reservationFor(task: QueuedTask): ReservationDecision {
    const snapshot = this.opts.snapshot();
    const scope = task.boardScope;
    const step = task.steps[task.stepIndex];
    if (scope && snapshot) {
      if (snapshot.mode !== scope.mode
        || snapshot.board && snapshot.board.runId !== scope.runId
        || OFF_BOARD_SCREENS.has(snapshot.screen)) {
        return { kind: 'blocked', text: '任务绑定已过期:关卡运行已变化或已离开绑定的关卡棋盘' };
      }
      // 结算过的这一场棋盘还在时,掉落物仍在盘上等着收;改动植物布局的意图已经作废。
      if (snapshot.lastRun?.runId === scope.runId && !PICKUP_SKILLS.has(step.skill)) {
        return { kind: 'blocked', text: '本场已结算,棋盘上只剩收取掉落物' };
      }
    }
    let binding = task.reservationBinding;
    if (binding && snapshot && snapshot.mode !== binding.mode) {
      return { kind: 'blocked', text: '条件种植绑定已过期:游戏模式已变化' };
    }

    if (binding && snapshot && OFF_BOARD_SCREENS.has(snapshot.screen)) {
      return { kind: 'blocked', text: '条件种植绑定已过期:已离开绑定的关卡棋盘' };
    }

    const board = snapshot?.board;
    let card: PvzCard | undefined;
    if (binding && board) {
      const bound = binding;
      if (board.runId !== bound.runId) {
        return { kind: 'blocked', text: '条件种植绑定已过期:关卡运行已变化' };
      }
      card = bound.conveyor
        ? board.cards.find((candidate) => sameCardType(candidate, bound))
        : board.cards.find((candidate) => candidate.slot === bound.slot);
      if (card && bound.conveyor) bound.slot = card.slot;
      if (!card || !sameCard(card, bound)) {
        return { kind: 'blocked', text: '条件种植绑定已过期:保留卡片已被替换' };
      }
    }

    if (step.skill !== 'plant' || step.when === 'now') return { kind: 'ready' };
    const reservation: PlantReservation = {
      kind: 'plant', task, plant: pvzSeedSelectorName(step.plant),
      at: { row: step.row, column: step.column }, waitingFor: step.when,
    };
    if (binding && binding.stepIndex !== task.stepIndex) {
      task.reservationBinding = null;
      binding = null;
      card = undefined;
    }
    if (snapshot?.screen !== 'board' || !board || board.paused) return { kind: 'wait', reservation };
    if (!binding) {
      const matches = [...board.cards]
        .filter((candidate) => cardMatchesSelector(candidate, step.plant))
        .sort((left, right) => cardConditionRank(left, step.when) - cardConditionRank(right, step.when)
          || left.slot - right.slot);
      if (matches.length === 0) {
        return { kind: 'blocked', text: `当前棋盘没有 ${pvzSeedSelectorDisplayName(step.plant)} 卡片` };
      }
      card = matches.find((candidate) => !this.isCardReserved(
        snapshot.mode,
        board.runId,
        candidate,
        task.id,
      ));
      if (!card) return { kind: 'wait', reservation };
      binding = {
        stepIndex: task.stepIndex,
        mode: snapshot.mode,
        runId: board.runId,
        plant: pvzSeedSelectorName(step.plant),
        slot: card.slot,
        type: card.type,
        imitates: card.imitates,
        name: normalizedName(card.name),
        conveyor: board.cards.every(candidate => candidate.cost === null),
      };
      task.reservationBinding = binding;
    }

    if (!card) {
      card = board.cards.find((candidate) => candidate.slot === binding.slot);
    }
    if (!card || !sameCard(card, binding)) {
      return { kind: 'blocked', text: '条件种植绑定已过期:保留卡片已被替换' };
    }
    const ready = card.ready && (step.when === 'ready' || card.affordable);
    return ready ? { kind: 'ready' } : { kind: 'wait', reservation };
  }

  private isCardReserved(
    mode: number,
    runId: number,
    card: PvzCard,
    exceptTaskId?: number,
    admissionMode?: PvzQueueMode,
    cancelledIds?: ReadonlySet<number>,
  ): boolean {
    return this.activeTasks().some((candidate) => {
      if (cancelledIds?.has(candidate.id)) return false;
      if (admissionMode === 'replace' && candidate !== this.running?.task) return false;
      if (admissionMode === 'now' && candidate === this.running?.task) return false;
      const binding = candidate.reservationBinding;
      return candidate.id !== exceptTaskId && !candidate.terminal && binding !== null
        && !binding.conveyor
        && binding.stepIndex >= candidate.stepIndex
        && binding.mode === mode && binding.runId === runId
        && sameCard(card, binding);
    });
  }

  /** 准入期就绑好的卡可能属于后面某一步,所以这里连它归哪一步一起报。 */
  private reservedCardDisplay(task: QueuedTask, snapshot: PvzSnapshot | null): PvzReservedCardView | null {
    const binding = task.reservationBinding;
    const board = snapshot?.board;
    if (!binding || binding.stepIndex < task.stepIndex || !snapshot || !board
      || snapshot.mode !== binding.mode || board.runId !== binding.runId
      || !board.cards.some(card => binding.conveyor ? sameCardType(card, binding) : sameCard(card, binding))) return null;
    return {
      card: binding.conveyor
        ? pvzSeedSelectorDisplayName((task.steps[binding.stepIndex] as AdmissionBoundPlantStep).plant)
        : localizedCardDisplay(board, binding.slot),
      forStep: binding.stepIndex === task.stepIndex ? null : binding.stepIndex + 1,
    };
  }

  /**
   * 模型那些还没做的步骤:正在执行的那一步连同它后面的,加上排队与停靠任务的剩余步骤。
   * World 自排的工作不在其中。给受理时要按整条队列算预算的调用方用。
   */
  pendingSteps(): PvzDoStep[] {
    return this.activeTasks().filter((task) => !task.internal && !task.terminal)
      .sort(taskOrder).flatMap((task) => task.steps.slice(task.stepIndex));
  }

  private activeTasks(): QueuedTask[] {
    return [...new Set([
      ...(this.running ? [this.running.task] : []),
      ...this.queue,
      ...this.reservations.map((reservation) => reservation.task),
    ])];
  }

  private releaseReadyReservations(): number {
    if (this.reservations.length === 0) return 0;
    const ready: QueuedTask[] = [];
    const waiting: TaskReservation[] = [];
    const blocked: Array<{ task: QueuedTask; text: string }> = [];
    for (const reservation of this.reservations) {
      const decision = this.reservationFor(reservation.task);
      if (decision.kind === 'wait') waiting.push(decision.reservation);
      else if (decision.kind === 'ready') ready.push(reservation.task);
      else blocked.push({ task: reservation.task, text: decision.text });
    }
    this.reservations = waiting;
    this.queue.push(...ready);
    this.sortQueue();
    for (const item of blocked) this.blockTask(item.task, item.text);
    return ready.length;
  }

  private takeWaiting(select: (task: QueuedTask) => boolean = () => true): QueuedTask[] {
    const tasks = [
      ...this.queue,
      ...this.reservations.map((reservation) => reservation.task),
    ].filter(select).sort(taskOrder);
    const taken = new Set(tasks);
    this.queue = this.queue.filter((task) => !taken.has(task));
    this.reservations = this.reservations.filter((item) => !taken.has(item.task));
    return tasks;
  }

  private sortQueue(): void {
    this.queue.sort(taskOrder);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

/**
 * 受理回执、任务结局事件与投递快照共用队列渲染。namedTask 指向相邻且已逐步展示的任务，其标签不再重复。
 */
export function renderPvzQueue(status: PvzQueueStatus, namedTask?: number): string {
  const label = (taskId: number, text: string): string => taskId === namedTask ? '' : `「${text}」`;
  const head = status.running
    ? `正在做任务#${status.running.taskId}${label(status.running.taskId, status.running.label)}`
      + `(第 ${status.running.stepIndex + 1}/${status.running.stepCount} 步:${status.running.step}`
      + `${reservedCardText(status.running.reservedCard)})`
    : status.hold
      ? `输入暂不可用(${status.hold})`
      : status.collectingSun
        ? '正在收阳光，排队的任务随后轮到'
        : '当前没有执行中的任务';
  const waiting = status.waiting.length > 0
    ? `；排队 ${status.waiting.map((task) =>
      `任务#${task.taskId}${label(task.taskId, task.label)}`).join('、')}`
    : '';
  const parked = status.reservations.map((reservation) => ({
    taskId: reservation.taskId,
    step: `把 ${pvzSeedSelectorDisplayName(reservation.plant)} `
      + `种在${describePvzPlantPosition(reservation.at.row, reservation.at.column)}`
      + `，等${reservation.waitingFor === 'ready' ? '冷却' : '冷却并阳光足够'}`,
    reservedCard: reservation.reservedCard as PvzReservedCardView | null,
    followingSteps: reservation.followingSteps,
  }));
  const parkedText = parked.length > 0
    ? `；等待中 ${parked.map((item) => `任务#${item.taskId} ${item.step}`
      + reservedCardText(item.reservedCard)
      + (item.followingSteps.length > 0 ? `；随后:${item.followingSteps.join('；')}` : '')).join('、')}`
    : '';
  return `${head}${waiting}${parkedText}`;
}

function reservedCardText(reserved: PvzReservedCardView | null): string {
  if (!reserved) return '';
  return `；占用卡 ${reserved.card}${reserved.forStep === null ? '' : `（留给第 ${reserved.forStep} 步）`}`;
}

function reservedCardOf(task: QueuedTask): PvzReservedCard | null {
  const binding = task.reservationBinding;
  if (!binding || binding.stepIndex !== task.stepIndex) return null;
  return {
    mode: binding.mode,
    runId: binding.runId,
    plant: binding.plant,
    slot: binding.slot,
    type: binding.type,
    imitates: binding.imitates,
  };
}

function admissionPlantBinding(steps: readonly PvzDoStep[], fromIndex = 0): PlantBinding | null {
  const stepIndex = steps.findIndex((step, index) => index >= fromIndex
    && step.skill === 'plant' && step.when !== 'now' && 'binding' in step);
  if (stepIndex < 0) return null;
  const step = steps[stepIndex] as AdmissionBoundPlantStep;
  return {
    stepIndex,
    mode: step.binding.mode,
    runId: step.binding.runId,
    plant: pvzSeedSelectorName(step.plant),
    slot: step.binding.slot,
    type: step.binding.type,
    imitates: step.binding.imitates,
    name: normalizedName(step.binding.name),
    conveyor: step.binding.conveyor,
  };
}

function sameCard(card: PvzCard, binding: PlantBinding): boolean {
  return card.slot === binding.slot
    && sameCardType(card, binding);
}

function sameCardType(card: PvzCard, binding: PlantBinding): boolean {
  return card.type === binding.type
    && card.imitates === binding.imitates
    && normalizedName(card.name) === binding.name;
}

function cardConditionRank(card: PvzCard, when: PvzPlantWhen): number {
  return card.ready && (when === 'ready' || card.affordable) ? 0 : 1;
}

function cardMatchesSelector(card: PvzCard, selector: PvzSeedSelector): boolean {
  if (typeof selector === 'string') {
    return card.imitates === null && normalizedName(card.name) === selector;
  }
  return card.imitates !== null
    && normalizedName(plantName(card.imitates)) === selector.imitates;
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase().replace(/[ -]+/g, '_');
}

function labelOf(task: QueuedTask): string {
  return task.steps.map(describePvzStep).join('；');
}

function taskOrder(a: QueuedTask, b: QueuedTask): number {
  return a.priority - b.priority || lane(a) - lane(b) || a.order - b.order;
}

/** 同优先级里 World 自己的工作先走:掉落物有寿命,排队的种植意图没有。 */
function lane(task: QueuedTask): number {
  return task.internal ? 0 : 1;
}

function reservationOrder(a: TaskReservation, b: TaskReservation): number {
  return taskOrder(a.task, b.task);
}
