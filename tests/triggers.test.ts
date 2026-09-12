import { afterEach, describe, expect, it, vi } from 'vitest';
import { PvzExecutor, renderPvzQueue, type PvzTaskReport } from '../src/executor.ts';
import { parsePvzDo, type PvzDoStep } from '../src/skills.ts';
import { afterTimers, boardState, callTool, FakePvzTransport, snapshot, startWorld } from './helpers.ts';

afterEach(() => vi.useRealTimers());

const collect: PvzDoStep = { skill: 'collect', what: 'coins', until: 'once' };
const plant: PvzDoStep = {
  skill: 'plant', plant: 'peashooter', row: 2, column: 3, when: 'ready_and_affordable',
};

function fixture() {
  const state = snapshot({ screen: 'board', board: boardState({
    sun: 50,
    cards: [{ slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
      ready: false, affordable: false, cooldown: 'long', cooldownRemainingPercent: 20,
      cooldownRemainingSeconds: 5, x: 80, y: 40 }],
  }) });
  const reports: PvzTaskReport[] = [];
  const executed: Array<{ taskId: number; step: number }> = [];
  let id = 0;
  const executor = new PvzExecutor({
    snapshot: () => state,
    execute: async (step, context) => {
      executed.push({ taskId: context.taskId, step: context.stepIndex });
      if (step.skill === 'collect') {
        state.board!.sun = 150;
        state.board!.cards[0]!.affordable = true;
      }
      return { outcome: 'done', text: '完成当前动作' };
    },
    cancelNative: async () => {}, report: report => reports.push(report), nextId: () => ++id,
  });
  return { state, executor, reports, executed };
}

async function settle() {
  for (let index = 0; index < 24; index++) await Promise.resolve();
}

describe('PvZ 触发器:条件独立于队列,打响那一刻才把队列交出去', () => {
  const peashooter = {
    slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
    ready: true, affordable: true, cooldown: 'ready' as const, cooldownRemainingPercent: 0,
    cooldownRemainingSeconds: 0, x: 80, y: 40,
  };
  const zombie = (row: number, columnPosition: number) => ({
    id: 900 + row, type: 0, name: 'zombie', row, column: Math.floor(columnPosition + 0.5), columnPosition,
    xBand: 'mid' as const, speedCellsPerSecond: 0.17, condition: 'intact' as const, armor: 'none' as const,
    shield: 'none' as const, hypnotized: false, slowed: false, immobilized: false,
  });
  const arm = (extra: Record<string, unknown> = {}) => ({
    when: { zombie: { row: 2, maxColumn: 5 } },
    steps: [{ skill: 'plant', plant: 'peashooter', row: 2, column: 3 }],
    ...extra,
  });
  const board = () => boardState({ sun: 300, cards: [peashooter] });

  it('武装后不占队列也不占卡片;条件在新快照上成真就打响,把队列以 now 交给执行器', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', menu: [], board: board() }));
    const { world, host } = await startWorld(transport);
    try {
      const receipt = await callTool(world, 'pvz_arm', arm());
      expect(receipt).toContain('触发器#1 已武装:第2排存在可见存活敌方僵尸，列位置 ≤ 5 → 把 豌豆射手 种在第2排第3列');
      expect(receipt).toContain('[PvZ队列] 当前没有执行中的任务；待触发 触发器#1「');
      await afterTimers(20);
      expect(transport.commands.filter((action) => action.kind === 'plant')).toHaveLength(0);
      expect(await callTool(world, 'pvz_do', { steps: [{ skill: 'plant', plant: 'peashooter', row: 1, column: 1 }] }))
        .toContain('任务#2 已受理');
      await afterTimers(40);

      host.events.length = 0;
      transport.publish((draft) => { draft.board!.zombies.push(zombie(2, 4.4)); });
      await afterTimers(150);

      const fired = host.events.find(({ event }) => event.type === 'pvz.trigger');
      expect(fired?.event.text).toContain('触发器#1 打响（第2排存在可见存活敌方僵尸，列位置 ≤ 5）:任务#3 已受理:把 豌豆射手 种在第2排第3列');
      expect(fired?.event.meta).toMatchObject({ triggerId: 1, outcome: 'fired' });
      expect(fired?.options?.trigger).toBe('flush');
      expect(transport.commands.filter((action) => action.kind === 'plant').map((action) => 'column' in action ? action.column : null))
        .toEqual([1, 3]);
      expect(await callTool(world, 'pvz_queue')).not.toContain('待触发');
    } finally {
      await world.stop();
    }
  });

  it('武装那一刻条件已经成立就当场打响', async () => {
    const state = snapshot({ screen: 'board', menu: [], board: board() });
    state.board!.zombies.push(zombie(2, 3.2));
    const transport = new FakePvzTransport(state);
    const { world } = await startWorld(transport);
    try {
      const receipt = await callTool(world, 'pvz_arm', arm());
      expect(receipt).toContain('触发器#1 武装时条件已经成立，当场打响');
      await afterTimers(40);
      expect(transport.commands.filter((action) => action.kind === 'plant')).toHaveLength(1);
    } finally {
      await world.stop();
    }
  });

  it('到期没打响就撤掉并回报;pvz_stop 按触发器号撤掉', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', menu: [], board: board() }));
    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_arm', arm({ expiresInMs: 1000 }))).toContain('1秒内没打响就撤掉');
      expect(await callTool(world, 'pvz_arm', arm({ when: { sun: { min: 1000 } } }))).toContain('触发器#2 已武装');
      expect(await callTool(world, 'pvz_stop', { triggerId: 2 })).toContain('已撤掉触发器#2');
      expect(await callTool(world, 'pvz_stop', { triggerId: 2 })).toContain('触发器#2已打响、到期或不存在');
      await afterTimers(1150);
      const outcomes = host.events.filter(({ event }) => event.type === 'pvz.trigger')
        .map(({ event }) => [event.meta?.triggerId, event.meta?.outcome]);
      expect(outcomes).toEqual([[2, 'cancelled'], [1, 'expired']]);
      expect(await callTool(world, 'pvz_queue')).not.toContain('待触发');
      expect(transport.commands.filter((action) => action.kind === 'plant')).toHaveLength(0);
    } finally {
      await world.stop();
    }
  });

  it('关卡结束随之撤掉,不带进下一关;不在棋盘上不能武装', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', menu: [], board: board() }));
    const { world, host } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_arm', arm());
      transport.publish((draft) => {
        draft.screen = 'award';
        draft.lastRun = { resultId: 1, runId: draft.board!.runId, mode: draft.mode, level: 1, outcome: 'won' };
        draft.board = null;
      });
      await afterTimers(40);
      const gone = host.events.find(({ event }) => event.type === 'pvz.trigger');
      expect(gone?.event.meta).toMatchObject({ triggerId: 1, outcome: 'invalidated' });
      expect(await callTool(world, 'pvz_arm', arm())).toContain('触发器只能在棋盘上武装');
    } finally {
      await world.stop();
    }
  });

  it('步骤上的 startWhen 被拒并指向 pvz_arm;pvz_stop 全停连触发器一起清', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', menu: [], board: board() }));
    const { world } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: [{ ...arm().steps[0], startWhen: { sun: { min: 50 } } }] }))
        .toContain('条件触发用 pvz_arm({when, steps}) 单独武装');
      await callTool(world, 'pvz_arm', arm());
      expect(await callTool(world, 'pvz_stop')).toContain('撤掉了触发器 #1');
      expect(await callTool(world, 'pvz_queue')).not.toContain('待触发');
    } finally {
      await world.stop();
    }
  });
});

describe('相对落点在队列里的写法', () => {
  it('relative positioning stays unresolved while its card is parked', () => {
    const { executor } = fixture();
    const parsed = parsePvzDo([{ ...plant, column: { aheadOf: 'nearest_hostile', minGap: 2 } }]);
    if ('error' in parsed) throw new Error(parsed.error);
    executor.submit(parsed.steps);
    expect(executor.status().reservations[0]?.at.column).toEqual({ aheadOf: 'nearest_hostile', minGap: 2 });
    expect(renderPvzQueue(executor.status())).toContain('最近敌对僵尸脚下往屋方向第2格');
    executor.stop();
  });

  it('spells the zero gap as the target cell rather than a distance of zero', () => {
    const { executor } = fixture();
    const parsed = parsePvzDo([{ ...plant, column: { aheadOf: 'nearest_hostile', minGap: 0 } }]);
    if ('error' in parsed) throw new Error(parsed.error);
    executor.submit(parsed.steps);
    const rendered = renderPvzQueue(executor.status());
    expect(rendered).toContain('最近敌对僵尸脚下那格');
    expect(rendered).not.toContain('第0格');
    executor.stop();
  });
});

describe('one-call PvZ intent replacement', () => {
  it.each(['cancel', 'replace intent'] as const)('%s waits for input release and the old step exit', async operation => {
    const state = snapshot({ screen: 'board', board: boardState() });
    let releaseInput!: () => void;
    let releaseCancellation!: () => void;
    const input = new Promise<void>(resolve => { releaseInput = resolve; });
    const cancellation = new Promise<void>(resolve => { releaseCancellation = resolve; });
    const began: number[] = [];
    const reports: PvzTaskReport[] = [];
    let id = 0;
    const executor = new PvzExecutor({
      snapshot: () => state,
      execute: async (_step, context) => {
        began.push(context.taskId);
        if (context.taskId === 1) await input;
        return { outcome: 'done', text: '已执行' };
      },
      cancelNative: async () => { await cancellation; },
      report: report => reports.push(report), nextId: () => ++id,
    });
    executor.submit([collect]);
    await settle();
    executor.submit([collect], 'append');
    const stopped = operation === 'cancel'
      ? executor.cancelAndWait(1)
      : Promise.resolve(executor.submit([collect], 'append', [1]));
    await settle();
    expect(began).toEqual([1]);
    releaseCancellation();
    await settle();
    expect(began).toEqual([1]);
    releaseInput();
    await stopped;
    await settle();
    expect(began).toEqual(operation === 'cancel' ? [1, 2] : [1, 2, 3]);
    expect(reports.filter(report => report.taskId === 1)).toMatchObject([{ kind: 'cancelled' }]);
  });

  it('validates a replacement before cancelling and can reuse the released card in the same submission', async () => {
    const { state } = fixture();
    const transport = new FakePvzTransport(state);
    const { world } = await startWorld(transport);
    try {
      const first = await callTool(world, 'pvz_do', { steps: [plant] });
      expect(first).toContain('任务#1');
      expect(await callTool(world, 'pvz_do', {
        cancel: [1], queue: 'append', steps: [{ ...plant, row: 9 }],
      })).toContain('失败');
      const live = await callTool(world, 'pvz_observe');
      expect(live).toContain('任务#1');
      const replaced = await callTool(world, 'pvz_do', {
        cancel: [1], queue: 'append', steps: [{ ...plant, row: 3 }],
      });
      expect(replaced).toContain('撤掉了 任务#1');
      expect(replaced).toContain('任务#2');
      expect(replaced).toContain('第3排第3列');
      expect(transport.commands).toEqual([]);
    } finally { await world.stop(); }
  });
});
