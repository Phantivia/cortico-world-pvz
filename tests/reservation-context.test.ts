import { expect, it } from 'vitest';
import { PvzExecutor, renderPvzQueue } from '../src/executor.ts';
import { boardState, snapshot } from './helpers.ts';

it('keeps future work visible while a task parks and removes it as the task advances', async () => {
  const current = snapshot({ screen: 'board', board: boardState({ cards: [{
    slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
    ready: false, affordable: true, cooldown: 'long', cooldownRemainingPercent: 50,
    cooldownRemainingSeconds: 4, x: 80, y: 40,
  }] }) });
  const landed: string[] = [];
  const executor = new PvzExecutor({
    snapshot: () => current,
    execute: async step => {
      landed.push(step.skill);
      if (step.skill === 'plant') current.board!.cards[0]!.ready = false;
      return { outcome: 'done', text: 'completed' };
    },
    cancelNative: async () => {}, report: () => {}, nextId: () => 1,
  });
  executor.submit([
    { skill: 'plant', plant: 'peashooter', row: 2, column: 3, when: 'ready' },
    { skill: 'collect', what: 'coins', until: 'visible_clear' },
    { skill: 'plant', plant: 'peashooter', row: 3, column: 3, when: 'ready' },
  ]);
  const waiting = executor.status();
  expect(waiting.reservations[0]!.followingSteps).toHaveLength(2);
  expect(renderPvzQueue(waiting)).toContain('随后:收集金币直到当前可见目标清空；把 豌豆射手 种在第3排第3列');
  current.board!.cards[0]!.ready = true;
  executor.wake();
  for (let index = 0; index < 12; index++) await Promise.resolve();
  expect(landed).toEqual(['plant', 'collect']);
  const next = executor.status();
  expect(next.reservations[0]!.at).toEqual({ row: 3, column: 3 });
  expect(next.reservations[0]!.followingSteps).toEqual([]);
  expect(renderPvzQueue(next)).not.toContain('随后:');
  current.board!.cards[0]!.ready = true;
  executor.wake();
  for (let index = 0; index < 12; index++) await Promise.resolve();
  expect(landed).toEqual(['plant', 'collect', 'plant']);
  expect(executor.status().reservations).toEqual([]);
});
