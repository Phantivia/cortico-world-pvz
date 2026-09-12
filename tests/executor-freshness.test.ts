import { describe, expect, it } from 'vitest';
import { PvzExecutor, type PvzTaskReport } from '../src/executor.ts';
import type { PvzDoStep } from '../src/skills.ts';
import { boardState, snapshot } from './helpers.ts';

const collect: PvzDoStep = { skill: 'collect', what: 'coins', until: 'once' };
const conditional: PvzDoStep = { skill: 'plant', plant: 'peashooter', row: 2, column: 3, when: 'ready_and_affordable' };
function boardSnapshot() {
  return snapshot({ screen: 'board', board: boardState({ cards: [{
    slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
    ready: false, affordable: true, cooldown: 'long', cooldownRemainingPercent: 50,
    cooldownRemainingSeconds: 4, x: 80, y: 40,
  }] }) });
}
async function settle() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

describe('PvZ queued work freshness', () => {
  it('blocks an already queued immediate action after a fresh read sees a new board run', async () => {
    const current = boardSnapshot();
    const reports: PvzTaskReport[] = [];
    const executed: number[] = [];
    const executor = new PvzExecutor({
      snapshot: () => current,
      refreshSnapshot: async () => { current.board!.runId += 1; },
      execute: async (_step, context) => { executed.push(context.taskId); return { outcome: 'done', text: 'collected' }; },
      cancelNative: async () => {}, report: report => reports.push(report), nextId: () => 1,
    });
    executor.submit([collect]);
    await settle();
    expect(executed).toEqual([]);
    expect(reports).toMatchObject([{ kind: 'blocked', taskId: 1 }]);
    expect(executor.status().running).toBeNull();
  });

  it('expires a parked task at the run terminal even while the old board remains visible', () => {
    const current = boardSnapshot();
    const reports: PvzTaskReport[] = [];
    const executor = new PvzExecutor({
      snapshot: () => current,
      execute: async () => { throw new Error('terminal board must not execute'); },
      cancelNative: async () => {}, report: report => reports.push(report), nextId: () => 1,
    });
    executor.submit([conditional]);
    expect(executor.status().reservations).toHaveLength(1);
    current.lastRun = { resultId: 1, runId: 1, mode: 0, level: 1, outcome: 'won' };
    current.board!.cards[0]!.ready = true;
    executor.wake();
    expect(reports).toMatchObject([{ kind: 'blocked' }]);
    expect(executor.status().reservations).toEqual([]);
  });

  it('parks a ready conditional plant through pause and resumes on an unpaused sample', async () => {
    const current = boardSnapshot();
    current.board!.cards[0]!.ready = true;
    current.board!.paused = true;
    let executions = 0;
    const executor = new PvzExecutor({
      snapshot: () => current,
      execute: async () => { executions++; return { outcome: 'done', text: 'planted' }; },
      cancelNative: async () => {}, report: () => {}, nextId: () => 1,
    });
    executor.submit([conditional]);
    await settle();
    expect(executor.status().reservations).toHaveLength(1);
    expect(executions).toBe(0);
    current.board!.paused = false;
    executor.wake();
    await settle();
    expect(executions).toBe(1);
  });

  it('preserves a future card admission binding across the preceding collect step', async () => {
    const current = boardSnapshot();
    const reports: PvzTaskReport[] = [];
    const skills: string[] = [];
    const executor = new PvzExecutor({
      snapshot: () => current,
      execute: async step => {
        skills.push(step.skill);
        current.board!.cards[0] = { ...current.board!.cards[0]!, slot: 1, ready: true };
        return { outcome: 'done', text: 'collected' };
      },
      cancelNative: async () => {}, report: report => reports.push(report), nextId: () => 1,
    });
    const bound = { ...conditional, binding: { mode: 0, runId: 1, slot: 0, type: 0, imitates: null, name: 'peashooter' } };
    executor.submit([collect, bound]);
    await settle();
    expect(skills).toEqual(['collect']);
    expect(reports).toMatchObject([{ kind: 'blocked' }]);
    expect(reports[0]!.text).toContain('保留卡片已被替换');
  });

  it('does not execute a cancelled task when its older refresh resolves after the replacement', async () => {
    const current = boardSnapshot();
    let releaseRead!: () => void;
    const read = new Promise<void>(resolve => { releaseRead = resolve; });
    let releaseCancel!: () => void;
    const cancel = new Promise<void>(resolve => { releaseCancel = resolve; });
    let refreshes = 0;
    let id = 0;
    const executions: number[] = [];
    const reports: PvzTaskReport[] = [];
    const executor = new PvzExecutor({
      snapshot: () => current,
      refreshSnapshot: () => ++refreshes === 1 ? read : Promise.resolve(),
      execute: async (_step, context) => { executions.push(context.taskId); return { outcome: 'done', text: 'collected' }; },
      cancelNative: () => cancel, report: report => reports.push(report), nextId: () => ++id,
    });
    executor.submit([collect]);
    await settle();
    executor.submit([collect], 'now');
    await settle();
    expect(executions).toEqual([]);
    releaseCancel();
    await settle();
    expect(executions).toEqual([2]);
    releaseRead();
    await settle();
    expect(executions).toEqual([2]);
    expect(reports.map(report => [report.taskId, report.kind])).toEqual([[1, 'cancelled'], [2, 'done']]);
  });

  it('keeps input untouched and reports an unverifiable task when refresh fails', async () => {
    const current = boardSnapshot();
    const reports: PvzTaskReport[] = [];
    const executor = new PvzExecutor({
      snapshot: () => current,
      refreshSnapshot: async () => { throw new Error('sample timeout'); },
      execute: async () => { throw new Error('stale execution'); },
      cancelNative: async () => {}, report: report => reports.push(report), nextId: () => 1,
    });
    executor.submit([collect]);
    await settle();
    expect(reports).toMatchObject([{ kind: 'unverified', taskId: 1 }]);
    expect(reports[0]!.text).toContain('sample timeout');
    expect(executor.status().running).toBeNull();
  });
});
