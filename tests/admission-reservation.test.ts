import { describe, expect, it } from 'vitest';
import { PvzExecutor, type PvzStepResult, type PvzTaskReport } from '../src/executor.ts';
import { parsePvzDo, type PvzDoStep } from '../src/skills.ts';
import { afterTimers, boardState, callTool, FakePvzTransport, snapshot, startWorld } from './helpers.ts';

function currentBoard(ready = false) {
  return snapshot({
    screen: 'board', menu: [],
    board: boardState({
      cards: [{
        slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
        ready, affordable: true, cooldown: ready ? 'ready' : 'long',
        cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0, x: 80, y: 40,
      }],
    }),
  });
}

const plant = (column: number) => ({
  skill: 'plant', plant: 'peashooter', row: 2, column, when: 'ready_and_affordable',
});

function steps(column: number): PvzDoStep[] {
  const result = parsePvzDo([plant(column)]);
  if ('error' in result) throw new Error(result.error);
  return result.steps;
}

describe('PvZ reservation admission', () => {
  it('skips excess immediate packets and still plants the other conveyor cards', async () => {
    const initial = currentBoard(true);
    initial.board!.level = 10;
    const card = { ...initial.board!.cards[0]!, cost: null };
    initial.board!.cards = [card, { ...card, slot: 1, type: 1, name: 'sunflower' }];
    const transport = new FakePvzTransport(initial);
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'plant' || !('column' in action)) return;
      const used = fake.state.board!.cards.find(item => item.slot === action.slot)!;
      fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
      fake.publish(draft => {
        draft.board!.plants.push({
          id: 900 + action.column, type: used.type, name: used.name, row: action.row, column: action.column,
          condition: 'intact', sleeping: false, squished: false, layers: [],
        });
        draft.board!.cards = draft.board!.cards.filter(item => item.slot !== action.slot)
          .map((item, slot) => ({ ...item, slot }));
      });
    };
    const { world, host } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', { steps: [
        { ...plant(3), when: 'now' },
        { ...plant(4), when: 'now' },
        { ...plant(5), plant: 'sunflower', when: 'now' },
      ] });
      await afterTimers(60);
      expect(transport.state.board!.plants.map(item => [item.name, item.column]))
        .toEqual([['peashooter', 3], ['sunflower', 5]]);
      expect(transport.state.board!.cards).toEqual([]);
      const report = host.events.find(({ event }) => event.type === 'pvz.task')!.event.text;
      expect(report).toContain('部分完成');
      expect(report).toContain('本步超出剩余张数');
    } finally { await world.stop(); }
  });

  it.each(['one task', 'two tasks'])('consumes distinct conveyor cards after slot compaction in %s', async (grouping) => {
    const initial = currentBoard();
    initial.board!.level = 10;
    const card = { ...initial.board!.cards[0]!, cost: null };
    initial.board!.cards = [card,
      { ...card, slot: 1, type: 1, name: 'sunflower' }, { ...card, slot: 2 }];
    const transport = new FakePvzTransport(initial);
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'plant' || !('column' in action)) return;
      const used = fake.state.board!.cards.find(item => item.slot === action.slot)!;
      expect(used.name).toBe('peashooter');
      fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
      fake.publish((draft) => {
        draft.board!.plants.push({
          id: 900 + action.column, type: used.type, name: used.name, row: action.row, column: action.column,
          condition: 'intact', sleeping: false, squished: false, layers: [],
        });
        draft.board!.cards = draft.board!.cards.filter(item => item.slot !== action.slot)
          .map((item, slot) => ({ ...item, slot }));
      });
    };
    const { world, host } = await startWorld(transport);
    try {
      if (grouping === 'one task') {
        expect(await callTool(world, 'pvz_do', { steps: [plant(3), plant(4)] })).toContain('已受理');
      } else {
        expect(await callTool(world, 'pvz_do', { steps: [plant(3)] })).toContain('已受理');
        expect(await callTool(world, 'pvz_do', { queue: 'append', steps: [plant(4)] })).toContain('已受理');
      }
      expect(await callTool(world, 'pvz_do', { queue: 'append', steps: [plant(5)] })).toContain('已经占了 2 张');
      transport.publish(draft => { for (const item of draft.board!.cards) item.ready = true; });
      await afterTimers(60);
      expect(transport.commands).toEqual([
        { kind: 'plant', slot: 0, row: 2, column: 3 },
        { kind: 'plant', slot: 1, row: 2, column: 4 },
      ]);
      expect(transport.state.board!.plants.map(item => item.column)).toEqual([3, 4]);
      expect(transport.state.board!.cards.map(item => item.name)).toEqual(['sunflower']);
      expect(host.events.some(({ event }) => event.type === 'pvz.task'
        && event.text.includes('已被替换'))).toBe(false);
    } finally {
      await world.stop();
    }
  });

  it('replaces a parked planting reservation and executes only its new destination', async () => {
    const transport = new FakePvzTransport(currentBoard());
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'plant' || !('column' in action)) return;
      fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
      fake.publish((draft) => {
        draft.board!.plants.push({
          id: 901, type: 0, name: 'peashooter', row: action.row, column: action.column,
          condition: 'intact', sleeping: false, squished: false, layers: [],
        });
        draft.board!.cards[0]!.ready = false;
      });
    };
    const { world, host } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', { steps: [plant(3)] });
      const replacement = await callTool(world, 'pvz_do', { queue: 'replace', steps: [plant(4)] });
      expect(replacement).toContain('任务#2 已受理');
      expect(await callTool(world, 'pvz_queue'))
        .toContain('任务#2 把 豌豆射手 种在第2排第4列，等冷却并阳光足够；占用卡 豌豆射手');
      expect(host.events.some(({ event }) => event.type === 'pvz.task'
        && event.text.includes('任务#1 未完成') && event.text.includes('替换'))).toBe(true);
      transport.publish((draft) => { draft.board!.cards[0]!.ready = true; });
      await afterTimers(30);
      expect(transport.commands).toEqual([{ kind: 'plant', slot: 0, row: 2, column: 4 }]);
      expect(transport.state.board!.plants).toMatchObject([{ row: 2, column: 4 }]);
    } finally {
      await world.stop();
    }
  });

  it('preserves the old reservation when a later step fails admission', async () => {
    const transport = new FakePvzTransport(currentBoard());
    const { world, host } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', { steps: [plant(3)] });
      const rejected = await callTool(world, 'pvz_do', {
        queue: 'replace', steps: [plant(4), { ...plant(5), plant: 'sunflower' }],
      });
      expect(rejected).toContain('向日葵 当前没有可绑定的未占用卡片');
      expect(await callTool(world, 'pvz_queue'))
        .toContain('任务#1 把 豌豆射手 种在第2排第3列，等冷却并阳光足够；占用卡 豌豆射手');
      expect(host.events.filter(({ event }) => event.type === 'pvz.task')).toEqual([]);
      expect(transport.commands).toEqual([]);
    } finally {
      await world.stop();
    }
  });

  it.each(['append', 'now'] as const)('%s retains reservations belonging to parked tasks', async (queue) => {
    const transport = new FakePvzTransport(currentBoard());
    const { world } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', { steps: [plant(3)] });
      expect(await callTool(world, 'pvz_do', { queue, steps: [plant(4)] }))
        .toContain('豌豆射手 当前没有可绑定的未占用卡片');
      expect(await callTool(world, 'pvz_queue'))
        .toContain('任务#1 把 豌豆射手 种在第2排第3列，等冷却并阳光足够；占用卡 豌豆射手');
    } finally {
      await world.stop();
    }
  });

  it('discounts the parked card for replace and the running card for now in the same queue', async () => {
    let current = currentBoard(true);
    current.board!.cards.push({
      ...current.board!.cards[0]!, slot: 1, type: 1, name: 'sunflower', ready: false,
    });
    let nextId = 0;
    let finish!: (result: PvzStepResult) => void;
    const execution = new Promise<PvzStepResult>((resolve) => { finish = resolve; });
    const executor = new PvzExecutor({
      snapshot: () => current,
      execute: () => execution,
      cancelNative: async () => {},
      report: () => {},
      nextId: () => ++nextId,
    });
    executor.submit([{ ...steps(3)[0]!, plant: 'sunflower' } as PvzDoStep]);
    executor.submit(steps(4), 'append');
    await afterTimers();
    try {
      const before = executor.status();
      expect(before.running?.taskId).toBe(2);
      expect(before.reservations.map((reservation) => reservation.taskId)).toEqual([1]);
      expect(executor.selectUnreservedCard('peashooter', undefined, 'replace')).toBeNull();
      expect(executor.selectUnreservedCard('sunflower', undefined, 'replace')).toMatchObject({ slot: 1 });
      expect(executor.selectUnreservedCard('peashooter', undefined, 'now')).toMatchObject({ slot: 0 });
      expect(executor.selectUnreservedCard('sunflower', undefined, 'now')).toBeNull();
      expect(executor.selectUnreservedCard('peashooter', undefined, 'append')).toBeNull();
      expect(executor.selectUnreservedCard('sunflower', undefined, 'append')).toBeNull();
      expect(executor.status().reservations).toEqual(before.reservations);
      expect(executor.status().running?.taskId).toBe(2);

      current = structuredClone(current);
      current.board!.runId += 1;
      expect(executor.selectUnreservedCard('peashooter', undefined, 'replace')).toMatchObject({ slot: 0 });
      expect(executor.selectUnreservedCard('sunflower', undefined, 'now')).toMatchObject({ slot: 1 });
    } finally {
      finish({ outcome: 'done', text: 'old execution released' });
      await executor.stopAndWait();
    }
  });

  it('expires a replaced reservation when the board run changes before the card becomes ready', async () => {
    const transport = new FakePvzTransport(currentBoard());
    const { world, host } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', { steps: [plant(3)] });
      expect(await callTool(world, 'pvz_do', { queue: 'replace', steps: [plant(4)] }))
        .toContain('任务#2 已受理');
      transport.publish((draft) => {
        draft.board!.runId += 1;
        draft.board!.cards[0]!.ready = true;
      });
      await afterTimers(30);
      expect(transport.commands).toEqual([]);
      expect(host.events.some(({ event }) => event.type === 'pvz.task'
        && event.text.includes('任务#2') && event.text.includes('关卡运行已变化'))).toBe(true);
      expect(await callTool(world, 'pvz_queue')).not.toContain('等待中 任务#2');
    } finally {
      await world.stop();
    }
  });

  it('transfers a running reservation to now only after the native cancellation fence', async () => {
    const current = currentBoard(true);
    const reports: PvzTaskReport[] = [];
    const executed: number[] = [];
    let nextId = 0;
    let finishFirst!: (result: PvzStepResult) => void;
    const first = new Promise<PvzStepResult>((resolve) => { finishFirst = resolve; });
    let releaseNative!: () => void;
    const fence = new Promise<void>((resolve) => { releaseNative = resolve; });
    const executor = new PvzExecutor({
      snapshot: () => current,
      execute: async (_step, context) => {
        executed.push(context.taskId);
        return context.taskId === 1 ? first : { outcome: 'done', text: 'planted' };
      },
      cancelNative: () => fence,
      report: (report) => reports.push(report),
      nextId: () => ++nextId,
    });
    executor.submit(steps(3));
    await afterTimers();
    expect(executor.selectUnreservedCard('peashooter', undefined, 'replace')).toBeNull();
    expect(executor.selectUnreservedCard('peashooter', undefined, 'append')).toBeNull();
    expect(executor.selectUnreservedCard('peashooter', undefined, 'now')).toMatchObject({ slot: 0 });
    expect(executor.status().running?.taskId).toBe(1);
    executor.submit(steps(4), 'now');
    finishFirst({ outcome: 'done', text: 'old action exited' });
    await afterTimers();
    expect(executed).toEqual([1]);
    releaseNative();
    await afterTimers();
    expect(executed).toEqual([1, 2]);
    expect(reports.map((report) => [report.taskId, report.kind])).toEqual([[1, 'cancelled'], [2, 'done']]);
  });
});
