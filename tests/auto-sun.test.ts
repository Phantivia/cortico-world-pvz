import { describe, expect, it } from 'vitest';
import type { PvzBoardState, PvzCollectible } from '../src/protocol.ts';
import {
  afterTimers,
  boardState,
  callTool,
  FakePvzTransport,
  snapshot,
  startWorld,
  type ActionHandler,
} from './helpers.ts';

const PEASHOOTER = {
  slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
  ready: true, affordable: true, cooldown: 'ready' as const,
  cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
};

const handler: ActionHandler = (action, fake) => {
  if (action.kind === 'collect') {
    fake.nativeResult = { outcome: 'executed', effect: 'collectibles_collected' };
    fake.publish((draft) => {
      const ids = new Set(action.ids);
      draft.board!.collectibles = draft.board!.collectibles.filter((item) => !ids.has(item.id));
      draft.board!.sun += 25 * ids.size;
    });
    return;
  }
  fake.nativeResult = { outcome: 'executed' };
  if (action.kind === 'plant' && 'column' in action) {
    fake.publish((draft) => {
      draft.board!.plants.push({
        id: 100 + draft.board!.plants.length, type: 0, name: 'peashooter',
        row: action.row, column: action.column,
        condition: 'intact', sleeping: false, squished: false, layers: [],
      });
      draft.board!.sun -= 100;
    });
    return;
  }
  if (action.kind === 'shovel') {
    fake.publish((draft) => {
      draft.board!.plants = draft.board!.plants.filter((plant) =>
        plant.row !== action.row || plant.column !== action.column);
    });
  }
};

function board(overrides: Partial<PvzBoardState> = {}) {
  return snapshot({
    screen: 'board',
    menu: [],
    board: boardState({ sun: 300, cards: [PEASHOOTER], ...overrides }),
  });
}

function sun(id: number, column = 3): PvzCollectible {
  return { id, kind: 'sun', x: 80 * column, y: 200, row: 2, column };
}

async function start(initial = board()) {
  const transport = new FakePvzTransport(initial);
  transport.actionHandler = handler;
  const started = await startWorld(transport);
  return { transport, ...started };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition timed out');
    await afterTimers(1);
  }
}

function collectCalls(transport: FakePvzTransport): number[][] {
  return transport.commands
    .filter((action) => action.kind === 'collect')
    .map((action) => (action as { ids: number[] }).ids);
}

describe('PvZ 自动收阳光', () => {
  it.each(['spin', 'launch', 'onslaught', 'swap'] as const)(
    '特殊动作 %s 不阻止空闲光标收阳光', async (action) => {
      const { transport, world } = await start(board({ allowedSpecialActions: [action] }));
      try {
        transport.publish((draft) => { draft.board!.collectibles = [sun(1)]; });
        await waitUntil(() => transport.state.board!.collectibles.length === 0);
        expect(transport.state.board!.sun).toBe(325);
      } finally { await world.stop(); }
    },
  );

  it('拾取的种子放下前保留阳光，光标释放后收取', async () => {
    const { transport, world } = await start(board({
      allowedSpecialActions: ['launch'],
      cursor: { kind: 'usable_seed', heldType: 0, logicalX: 200, logicalY: 100 },
      collectibles: [sun(1)],
    }));
    try {
      await afterTimers(40);
      expect(transport.state.board!.collectibles).toHaveLength(1);
      transport.publish((draft) => { draft.board!.cursor.kind = 'normal'; });
      await waitUntil(() => transport.state.board!.collectibles.length === 0);
      expect(transport.state.board!.sun).toBe(325);
    } finally { await world.stop(); }
  });

  it('打僵尸的锤子光标可收阳光，收取不改变光标', async () => {
    const { transport, world } = await start(board({
      allowedSpecialActions: ['whack'],
      cursor: { kind: 'hammer', heldType: null, logicalX: 200, logicalY: 100 },
    }));
    try {
      transport.publish((draft) => { draft.board!.collectibles = [sun(1)]; });
      await waitUntil(() => transport.state.board!.collectibles.length === 0);
      expect(transport.state.board!.sun).toBe(325);
      expect(transport.state.board!.cursor.kind).toBe('hammer');
    } finally { await world.stop(); }
  });

  it('阳光落到场上就自己收走，模型既不出步骤也不收回执', async () => {
    const { transport, world, host } = await start();
    try {
      transport.publish((draft) => { draft.board!.collectibles = [sun(1), sun(2, 5)]; });
      await waitUntil(() => collectCalls(transport).length > 0);
      await afterTimers(20);

      expect(collectCalls(transport)).toEqual([[1, 2]]);
      expect(transport.state.board!.collectibles).toEqual([]);
      expect(host.events.filter(({ event }) => event.type === 'pvz.task')).toEqual([]);
      expect(await callTool(world, 'pvz_queue')).toContain('当前没有执行中的任务');
    } finally { await world.stop(); }
  });

  it('这一批执行期间落下的阳光由下一趟接住', async () => {
    const { transport, world } = await start();
    try {
      transport.actionHandler = (action, fake) => {
        handler(action, fake);
        if (action.kind === 'collect' && !fake.state.board!.collectibles.length
          && action.ids.length === 1 && action.ids[0] === 1) {
          fake.publish((draft) => { draft.board!.collectibles = [sun(2, 6)]; });
        }
      };
      transport.publish((draft) => { draft.board!.collectibles = [sun(1)]; });
      await waitUntil(() => collectCalls(transport).length > 1);
      await afterTimers(20);

      expect(collectCalls(transport)).toEqual([[1], [2]]);
    } finally { await world.stop(); }
  });

  it('不打断正在执行的一步，但步与步之间就把阳光收掉，仍排在等待中的模型任务之前', async () => {
    const { transport, world } = await start();
    try {
      transport.nativeResultDelayMs = 30;
      expect(await callTool(world, 'pvz_do', {
        steps: [
          { skill: 'plant', plant: 'peashooter', row: 1, column: 1 },
          { skill: 'plant', plant: 'peashooter', row: 1, column: 2 },
        ],
      }, 1)).toContain('已受理');
      await waitUntil(() => transport.commands.some((action) => action.kind === 'plant'));
      transport.publish((draft) => { draft.board!.collectibles = [sun(1)]; });
      expect(await callTool(world, 'pvz_do', {
        steps: [{ skill: 'shovel', row: 1, column: 1 }],
        queue: 'append',
      }, 2)).toContain('已受理');
      await waitUntil(() => transport.commands.some((action) => action.kind === 'shovel'));

      // 第一步落下后阳光才出现:它在第二步之前收走,两步的任务照旧跑完,铲子那份排在后面。
      expect(transport.commands.map((action) => action.kind)
        .filter((kind) => kind !== 'snapshot'))
        .toEqual(['plant', 'collect', 'plant', 'shovel']);
    } finally { await world.stop(); }
  });

  it('收阳光占着执行器时，受理回执和队列行说的是正在收阳光，不给它编号也不提 queue:now', async () => {
    const { transport, world } = await start();
    try {
      transport.nativeResultDelayMs = 60;
      transport.publish((draft) => { draft.board!.collectibles = [sun(1)]; });
      await waitUntil(() => transport.commands.some((action) => action.kind === 'collect'));
      const receipt = await callTool(world, 'pvz_do', {
        steps: [{ skill: 'plant', plant: 'peashooter', row: 1, column: 1 }],
      }, 1);
      expect(receipt).toContain('World 正在收阳光；新任务#2排在其后');
      expect(receipt).toContain('[PvZ队列] 正在收阳光，排队的任务随后轮到；排队 任务#2');
      expect(receipt).not.toMatch(/queue:now|当前没有执行中的任务|正在运行的任务#/);
      await waitUntil(() => transport.commands.some((action) => action.kind === 'plant'));
    } finally { await world.stop(); }
  });

  it('模型的 queue:"now" 抢得走自动收取，被抢的那趟不投回执', async () => {
    const { transport, world, host } = await start();
    try {
      transport.nativeResultDelayMs = 200;
      transport.publish((draft) => { draft.board!.collectibles = [sun(1)]; });
      await waitUntil(() => transport.commands.some((action) => action.kind === 'collect'));
      transport.nativeResultDelayMs = 0;
      expect(await callTool(world, 'pvz_do', {
        steps: [{ skill: 'plant', plant: 'peashooter', row: 1, column: 1 }],
        queue: 'now',
      }, 1)).toContain('已受理');
      await waitUntil(() => transport.commands.some((action) => action.kind === 'plant'));
      await afterTimers(20);

      expect(transport.commands.map((action) => action.kind)
        .filter((kind) => kind !== 'snapshot'))
        .toEqual(['collect', 'cancel', 'plant']);
      const reports = host.events.filter(({ event }) => event.type === 'pvz.task');
      expect(reports).toHaveLength(1);
      expect(reports[0]!.event.text).toContain('任务#2');
    } finally { await world.stop(); }
  });

  it.each([
    { label: '暂停中', board: { paused: true } },
    { label: '光标上拿着东西', board: {
      cursor: { kind: 'usable_seed', heldType: 0, logicalX: 200, logicalY: 100 },
    } },
    { label: '打僵尸中手持植物', board: {
      allowedSpecialActions: ['whack'],
      cursor: { kind: 'plant', heldType: 4, logicalX: 200, logicalY: 100 },
      special: { phase: 'ready', settled: true, targets: [] },
    } },
  ])('$label 时不动手', async ({ board: overrides }) => {
    const { transport, world } = await start(board(overrides));
    try {
      transport.publish((draft) => { draft.board!.collectibles = [sun(1)]; });
      await afterTimers(40);

      expect(collectCalls(transport)).toEqual([]);
      expect(transport.state.board!.collectibles).toHaveLength(1);
    } finally { await world.stop(); }
  });

  it('这一场已经结算之后连活都不排，不再多读一次状态', async () => {
    const settled = board();
    settled.lastRun = {
      resultId: 1, runId: settled.board!.runId, mode: 0, level: 1, outcome: 'won',
    };
    const { transport, world } = await start(settled);
    try {
      const reads = transport.snapshotRequests;
      transport.publish((draft) => { draft.board!.collectibles = [sun(1)]; });
      await afterTimers(40);

      expect(collectCalls(transport)).toEqual([]);
      expect(transport.snapshotRequests).toBe(reads);
    } finally { await world.stop(); }
  });

  it('连着收不到才说话，阳光只是自己没了不算', async () => {
    const { transport, world, host } = await start();
    const stuck = (): Array<{ text: string }> => host.events
      .filter(({ event }) => event.type === 'pvz.sun.stuck')
      .map(({ event }) => ({ text: event.text }));
    try {
      transport.actionHandler = (action) => action.kind === 'collect'
        ? { accepted: false, reason: 'a requested collectible disappeared before it could be clicked' }
        : undefined;
      for (const id of [1, 2, 3, 4]) {
        transport.publish((draft) => { draft.board!.collectibles = [sun(id)]; });
        await waitUntil(() => collectCalls(transport).length >= id);
      }
      expect(stuck()).toEqual([]);

      transport.actionHandler = (action) => action.kind === 'collect'
        ? { accepted: false, reason: 'collectible did not enter the collection state before timeout' }
        : undefined;
      // 收不到就退避,第四趟要等三秒多才出手,给足时间。
      for (const id of [5, 6, 7, 8]) {
        transport.publish((draft) => { draft.board!.collectibles = [sun(id)]; });
        await waitUntil(() => collectCalls(transport).length >= id, 8000);
      }
      await afterTimers(20);

      expect(stuck()).toHaveLength(1);
      expect(stuck()[0]!.text).toContain('连续 3 次没有收到');
    } finally { await world.stop(); }
  });

  it('上一趟没收着，阳光还在场上就再来一趟，不等下一颗落下来', async () => {
    const { transport, world } = await start();
    try {
      let refusals = 0;
      transport.actionHandler = (action, fake) => {
        if (action.kind !== 'collect') return undefined;
        if (refusals < 1) {
          refusals += 1;
          return { accepted: false, reason: 'collectible did not enter the collection state before timeout' };
        }
        handler(action, fake);
        return undefined;
      };
      transport.publish((draft) => { draft.board!.collectibles = [sun(1)]; });
      await waitUntil(() => collectCalls(transport).length > 1, 4000);

      // 场上还是那一颗,没有新阳光到场:退避之后照样再点它。
      expect(collectCalls(transport)).toEqual([[1], [1]]);
      expect(transport.state.board!.collectibles).toEqual([]);
    } finally { await world.stop(); }
  });

  it('模型自己收阳光的路已经关掉，resources 也不再是后门', async () => {
    const { transport, world } = await start(board({
      collectibles: [sun(1), { id: 2, kind: 'gold_coin', x: 400, y: 250, row: 3, column: 5 }],
    }));
    try {
      expect(await callTool(world, 'pvz_do', {
        steps: [{ skill: 'collect', what: 'sun', until: 'once' }],
      }, 1)).toContain('阳光由 World 自动收取');
      expect(await callTool(world, 'pvz_do', {
        steps: [{ skill: 'collect', what: 'resources', until: 'visible_clear' }],
      }, 2)).toContain('已受理');
      await waitUntil(() => collectCalls(transport).some((ids) => ids.includes(2)));
      await afterTimers(20);

      // 她那份只拿到金币;阳光那颗是 World 自己收的,她的步骤里没有它。
      expect(collectCalls(transport)).toEqual([[1], [2]]);
      expect(transport.state.board!.collectibles).toEqual([]);
    } finally { await world.stop(); }
  });
});
