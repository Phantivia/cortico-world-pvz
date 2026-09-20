import {
  describePvzCondition,
  evaluatePvzCondition,
  parsePvzCondition,
  type PvzCondition,
} from './conditions.ts';
import type { PvzSnapshot } from './protocol.ts';
import { describePvzStep, parsePvzDo, parsePvzQueueMode, type PvzDoStep, type PvzQueueMode } from './skills.ts';

/**
 * 触发器在条件成真时提交队列，默认一次。有限重复须先观察到条件为假，再次成真才提交。
 * 普通传送带触发器预留全部剩余次数；waitForCards 等待可用余卡，打响前不预留。
 * 绑定武装时的棋盘运行:关卡结束、换棋盘或离开棋盘就撤掉,不带进下一关。
 */
export interface PvzTrigger {
  id: number;
  condition: PvzCondition;
  steps: PvzDoStep[];
  queue: PvzQueueMode;
  scope: { mode: number; runId: number };
  armedAt: number;
  expiresAt: number | null;
  maxFirings: number;
  remainingFirings: number;
  waitForCards: boolean;
  conditionActive: boolean;
}

export type PvzTriggerOutcome = 'fired' | 'expired' | 'cancelled' | 'invalidated';

export interface PvzTriggerReport {
  triggerId: number;
  outcome: PvzTriggerOutcome;
  text: string;
}

export interface PvzTriggerTableOptions {
  snapshot: () => PvzSnapshot | null;
  /** 打响:把队列交给执行器,返回受理回执。 */
  fire: (trigger: PvzTrigger) => string;
  canFire?: (trigger: PvzTrigger, snapshot: PvzSnapshot | null) => boolean;
  report: (report: PvzTriggerReport) => void;
  nextId: () => number;
  now?: () => number;
}

const TERMINAL_SCREENS = new Set(['award', 'defeat', 'main_menu', 'mode_selector', 'seed_picker', 'credits']);

export function parsePvzArm(args: Record<string, unknown>): {
  condition: PvzCondition; steps: PvzDoStep[]; queue: PvzQueueMode; expiresInMs: number | null; maxFirings: number; waitForCards: boolean;
} {
  const extra = Object.keys(args).filter((key) => !['when', 'steps', 'queue', 'expiresInMs', 'maxFirings', 'waitForCards'].includes(key));
  if (extra.length) throw new Error(`pvz_arm 不认识字段:${extra.join('、')}`);
  const condition = parsePvzCondition(args.when);
  if ('error' in condition) throw new Error(`when: ${condition.error}`);
  const steps = parsePvzDo(args.steps);
  if ('error' in steps) throw new Error(steps.error);
  const queue = args.queue === undefined ? { mode: 'now' as const } : parsePvzQueueMode(args.queue);
  if ('error' in queue) throw new Error(queue.error);
  const ttl = args.expiresInMs;
  if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1000 || ttl > 600_000)) {
    throw new Error('expiresInMs 必须是 1000–600000 的整数');
  }
  const maxFirings = args.maxFirings === undefined ? 1 : args.maxFirings;
  if (typeof maxFirings !== 'number' || !Number.isInteger(maxFirings) || maxFirings < 1 || maxFirings > 16) {
    throw new Error('maxFirings 必须是 1–16 的整数');
  }
  const waitForCards = args.waitForCards ?? false;
  if (typeof waitForCards !== 'boolean' || args.waitForCards === null) throw new Error('waitForCards 必须是布尔值');
  if (waitForCards && steps.steps.some(step => step.skill !== 'plant' || step.when !== 'now')) {
    throw new Error('waitForCards 只接受 when:now 的种植步骤');
  }
  return { condition: condition.condition, steps: steps.steps, queue: queue.mode,
    expiresInMs: (ttl as number | undefined) ?? null, maxFirings, waitForCards };
}

export function describePvzTrigger(trigger: PvzTrigger): string {
  return `${describePvzCondition(trigger.condition)} → ${trigger.steps.map(describePvzStep).join('；')}`
    + (trigger.waitForCards ? '；缺卡等待，不提前占卡' : '')
    + (trigger.maxFirings > 1 ? `；剩余${trigger.remainingFirings}/${trigger.maxFirings}次，每次须条件重新成真` : '');
}

export class PvzTriggerTable {
  private triggers: PvzTrigger[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: PvzTriggerTableOptions) {}

  /** 只能在棋盘上武装:条件问的是这块棋盘上的事实。 */
  arm(
    condition: PvzCondition,
    steps: PvzDoStep[],
    queue: PvzQueueMode,
    expiresInMs: number | null,
    maxFirings = 1,
    waitForCards = false,
  ): PvzTrigger {
    const snapshot = this.opts.snapshot();
    if (snapshot?.screen !== 'board' || !snapshot.board) {
      throw new Error('触发器只能在棋盘上武装:它问的是当前棋盘上的事实');
    }
    const now = this.now();
    const trigger: PvzTrigger = {
      id: this.opts.nextId(),
      condition,
      steps: structuredClone(steps),
      queue,
      scope: { mode: snapshot.mode, runId: snapshot.board.runId },
      armedAt: now,
      expiresAt: expiresInMs === null ? null : now + expiresInMs,
      maxFirings,
      remainingFirings: maxFirings,
      waitForCards,
      conditionActive: false,
    };
    this.triggers.push(trigger);
    this.armTimer();
    // 武装那一刻条件已经成立就直接打响,不等下一份快照。
    this.evaluate(snapshot);
    return trigger;
  }

  disarm(id: number, reason = '按触发器号撤掉'): string | null {
    const trigger = this.triggers.find((item) => item.id === id);
    if (!trigger) return null;
    this.remove(trigger);
    this.opts.report({ triggerId: id, outcome: 'cancelled', text: `触发器#${id} 已撤掉:${reason}` });
    return `已撤掉触发器#${id}`;
  }

  /** 清空全部,不逐个回报:用于 pvz_stop 全停与 World 停机。 */
  clear(): number[] {
    const ids = this.triggers.map((item) => item.id);
    this.triggers = [];
    this.armTimer();
    return ids;
  }

  list(): PvzTrigger[] {
    return [...this.triggers];
  }

  /** 每份新快照调一次:过期、离开棋盘、条件为真三件事按这个顺序判。 */
  evaluate(snapshot: PvzSnapshot | null): void {
    const now = this.now();
    for (const trigger of [...this.triggers]) {
      if (!this.triggers.includes(trigger)) continue;
      if (trigger.expiresAt !== null && now >= trigger.expiresAt) {
        this.remove(trigger);
        this.opts.report({
          triggerId: trigger.id, outcome: 'expired',
          text: `触发器#${trigger.id} 到期撤掉:${describePvzTrigger(trigger)}`,
        });
        continue;
      }
      if (snapshot && this.leftScope(snapshot, trigger)) {
        this.remove(trigger);
        this.opts.report({
          triggerId: trigger.id, outcome: 'invalidated',
          text: `触发器#${trigger.id} 随关卡结束撤掉:${describePvzTrigger(trigger)}`,
        });
        continue;
      }
      const matched = evaluatePvzCondition(trigger.condition, snapshot);
      if (matched === false) trigger.conditionActive = false;
      if (matched !== true || trigger.conditionActive) continue;
      if (this.opts.canFire && !this.opts.canFire(trigger, snapshot)) continue;
      trigger.conditionActive = true;
      trigger.remainingFirings -= 1;
      if (trigger.remainingFirings === 0) this.remove(trigger);
      const receipt = this.opts.fire(trigger);
      this.opts.report({
        triggerId: trigger.id, outcome: 'fired',
        text: `触发器#${trigger.id} 打响（${describePvzCondition(trigger.condition)}）:${receipt}`
          + (trigger.maxFirings > 1 ? `；剩余${trigger.remainingFirings}次` : ''),
      });
    }
  }

  render(): string {
    if (this.triggers.length === 0) return '';
    const now = this.now();
    return `；待触发 ${this.triggers.map((trigger) => `触发器#${trigger.id}「${describePvzTrigger(trigger)}」`
      + (trigger.expiresAt === null ? '' : `（剩余${Math.max(0, Math.ceil((trigger.expiresAt - now) / 1000))}秒）`)).join('、')}`;
  }

  private leftScope(snapshot: PvzSnapshot, trigger: PvzTrigger): boolean {
    return snapshot.mode !== trigger.scope.mode
      || (snapshot.board !== null && snapshot.board.runId !== trigger.scope.runId)
      || snapshot.lastRun?.runId === trigger.scope.runId
      || TERMINAL_SCREENS.has(snapshot.screen);
  }

  private remove(trigger: PvzTrigger): void {
    this.triggers = this.triggers.filter((item) => item !== trigger);
    this.armTimer();
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const deadlines = this.triggers.map((item) => item.expiresAt).filter((at): at is number => at !== null);
    if (deadlines.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.evaluate(this.opts.snapshot());
    }, Math.max(0, Math.min(...deadlines) - this.now()));
    this.timer.unref?.();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}
