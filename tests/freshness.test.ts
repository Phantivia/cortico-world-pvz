import { afterEach, describe, expect, it, vi } from 'vitest';
import { WakeBus } from 'cortico/core/bus.ts';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { PvzRuntime } from '../src/runtime.ts';
import { boardState, callTool, FakePvzTransport, snapshot, startWorld, type FakePvzHost } from './helpers.ts';

afterEach(() => vi.useRealTimers());

describe('PvZ native read fences', () => {
  it('reads changes not yet emitted by the periodic poll without sending input', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    const runtime = new PvzRuntime(transport, () => 100);
    await runtime.start();
    try {
      transport.state.board!.sun = 325;
      expect(runtime.snapshot!.board!.sun).toBe(150);
      const fresh = await runtime.readFreshSnapshot();
      expect(fresh.board!.sun).toBe(325);
      expect(fresh.revision).toBeGreaterThan(1);
      expect(transport.commands).toEqual([]);
      expect(fresh.inputControl.epoch).toBe(0);
    } finally { await runtime.stop(); }
  });

  it('waits past the correlated result revision and rejects reordered samples', async () => {
    vi.useFakeTimers();
    const transport = new FakePvzTransport();
    const runtime = new PvzRuntime(transport, () => 100);
    await runtime.start();
    transport.command = async (_action, _timeout, id) => {
      transport.emit('result', { type: 'result', protocol: 2, id, revision: 10, outcome: 'executed' });
      transport.emit('snapshot', snapshot({ revision: 10 }));
      return { type: 'ack', protocol: 2, id: id!, accepted: true };
    };
    try {
      let resolved = false;
      const read = runtime.readFreshSnapshot().then(value => { resolved = true; return value; });
      await vi.advanceTimersByTimeAsync(10);
      transport.emit('snapshot', snapshot({ revision: 9 }));
      expect(resolved).toBe(false);
      transport.emit('snapshot', snapshot({ revision: 11, screen: 'award' }));
      expect((await read).screen).toBe('award');
      expect(runtime.snapshot!.revision).toBe(11);
    } finally { await runtime.stop(); }
  });

  it('fails a missing post-result snapshot instead of returning a stale cache', async () => {
    vi.useFakeTimers();
    const transport = new FakePvzTransport();
    const runtime = new PvzRuntime(transport, () => 100);
    await runtime.start();
    transport.command = async (_action, _timeout, id) => {
      transport.emit('result', { type: 'result', protocol: 2, id, revision: 1, outcome: 'executed' });
      return { type: 'ack', protocol: 2, id: id!, accepted: true };
    };
    const read = runtime.readFreshSnapshot(40).catch(error => String(error));
    await vi.advanceTimersByTimeAsync(41);
    expect(await read).toContain('缓存不作为当前状态返回');
    expect(runtime.listenerCount('snapshot')).toBe(0);
    await runtime.stop();
  });

  it('invalidates the cached snapshot on disconnect and refuses new reads', async () => {
    const transport = new FakePvzTransport();
    const runtime = new PvzRuntime(transport, () => 100);
    await runtime.start();
    transport.emit('disconnect', new Error('closed'));
    transport.emit('snapshot', snapshot({ revision: 12 }));
    expect(runtime.snapshot).toBeNull();
    await expect(runtime.readFreshSnapshot()).rejects.toThrow('原生传输未连接');
    expect(transport.snapshotRequests).toBe(0);
    await runtime.stop();
  });

  it('does not verify a native effect when its post-result snapshot never arrives', async () => {
    vi.useFakeTimers();
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    const original = transport.command.bind(transport);
    transport.nativeResult = null;
    transport.command = async (action, timeout, id, context) => {
      if (action.kind === 'cancel') return { type: 'ack', protocol: 2, id: id!, accepted: false };
      const ack = await original(action, timeout, id, context);
      transport.emit('result', {
        type: 'result', protocol: 2, id: ack.id, revision: 1,
        outcome: 'executed', effect: 'card_consumed',
      });
      return ack;
    };
    const runtime = new PvzRuntime(transport, () => 30, 30);
    await runtime.start();
    const action = runtime.act({ kind: 'plant', slot: 0, row: 2, column: 3 });
    await vi.advanceTimersByTimeAsync(31);
    expect(await action).toMatchObject({ status: 'unverified', beforeRevision: 1, afterRevision: 1 });
    await runtime.stop();
  });
});

describe('PvZ delivery freshness', () => {
  it('handoff replaces a pending board ticket and flushes a fresh first observation', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    const { world, host } = await startWorld(transport);
    try {
      transport.publish(draft => { draft.board!.sun = 175; });
      await new Promise(resolve => setTimeout(resolve, 5));
      const old = host.deferred.at(-1)!;
      world.onHandoffEnded();
      transport.state.board!.sun = 550;
      expect(await old.render()).toBeNull();
      expect(host.deliveryCalls.at(-1)).toMatchObject({ kind: 'deferred', type: 'pvz.board.snapshot', trigger: 'flush' });
      expect(await host.deferred.at(-1)!.render()).toContain('阳光 550');
    } finally { await world.stop(); }
  });

  it('pvz_observe returns the native state changed since the last periodic sample', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    const { world } = await startWorld(transport);
    try {
      transport.state.board!.sun = 425;
      expect(await callTool(world, 'pvz_observe')).toContain('阳光 425');
      expect(transport.commands).toEqual([]);
    } finally { await world.stop(); }
  });

  it('refreshes a deferred board after waiting and keeps its snapshot classification', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    const { world, host } = await startWorld(transport);
    try {
      transport.publish(draft => { draft.board!.sun = 175; });
      await new Promise(resolve => setTimeout(resolve, 5));
      const deferred = host.deferred.find(event => event.type === 'pvz.board.snapshot')!;
      transport.state.board!.sun = 450;
      expect(deferred.tags).toEqual(['snapshot']);
      const text = await deferred.render();
      expect(text).toContain('阳光 450');
      expect(text).not.toContain('阳光 175');
    } finally { await world.stop(); }
  });

  it('resources wait for another source and render the board after the original batch floor', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    const { world, host } = await startWorld(transport);
    vi.useFakeTimers();
    const bus = connectBus(host);
    try {
      transport.publish(draft => {
        draft.board!.collectibles = [{ id: 1, kind: 'silver_coin', x: 300, y: 200, row: 2, column: 3 }];
      });
      await vi.advanceTimersByTimeAsync(30000);
      expect(bus.takeIfReady()).toBeNull();
      expect(bus.pendingImmediate()).toBe(0);

      bus.push({ event: { cursor: 999, ts: new Date().toISOString(), source: 'other', origin: 'external', type: 'message', text: 'hello' } as EventEnvelope });
      await vi.advanceTimersByTimeAsync(14999);
      expect(bus.takeIfReady()).toBeNull();
      transport.state.board!.sun = 500;
      transport.state.board!.collectibles = [];
      await vi.advanceTimersByTimeAsync(1);
      const items = bus.takeIfReady()!;
      expect(items.filter(item => item.event).map(item => item.event!.type))
        .toEqual(['pvz.collectible.appeared', 'message']);
      const board = items.find(item => item.deferred?.type === 'pvz.board.snapshot')!.deferred!;
      const rendered = await board.render();
      expect(rendered).toContain('阳光 500');
      expect(rendered).not.toContain('银币×1');
    } finally { vi.useRealTimers(); await world.stop(); }
  });

  it('ordinary battlefield changes respect both the batch floor and ceiling', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    const { world, host } = await startWorld(transport);
    vi.useFakeTimers();
    const bus = connectBus(host);
    const appear = (id: number) => transport.publish(draft => {
      draft.board!.zombies.push({
        id, type: 0, name: 'zombie', row: id, column: 9, columnPosition: 9,
        xBand: 'far', speedCellsPerSecond: -0.1, condition: 'intact', armor: 'none',
        shield: 'none', hypnotized: false, slowed: false, immobilized: false,
      });
    });
    try {
      appear(1);
      await vi.advanceTimersByTimeAsync(14999);
      expect(bus.takeIfReady()).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      const first = bus.takeIfReady()!;
      expect(first.some(item => item.event?.type === 'pvz.zombie.visible')).toBe(true);
      await first.find(item => item.deferred)?.deferred!.render();

      appear(2);
      await vi.advanceTimersByTimeAsync(0);
      for (let second = 1; second <= 24; second++) {
        await vi.advanceTimersByTimeAsync(1000);
        transport.publish(draft => { draft.board!.progress.current = second; });
        await vi.advanceTimersByTimeAsync(0);
        expect(bus.takeIfReady()).toBeNull();
      }
      await vi.advanceTimersByTimeAsync(1000);
      expect(bus.takeIfReady()!.some(item => item.event?.type === 'pvz.level.progress')).toBe(true);
    } finally { vi.useRealTimers(); await world.stop(); }
  });

  it('an urgent fact flushes the complete sample in order and carries the delivery-time board', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    const { world, host } = await startWorld(transport);
    vi.useFakeTimers();
    const bus = connectBus(host);
    try {
      const received = bus.nextBatch();
      transport.publish(draft => {
        draft.board!.zombies.push({
          id: 1, type: 0, name: 'zombie', row: 1, column: 2, columnPosition: 2,
          xBand: 'near', speedCellsPerSecond: -0.1, condition: 'intact', armor: 'none',
          shield: 'none', hypnotized: false, slowed: false, immobilized: false,
        });
        draft.board!.collectibles = [{ id: 1, kind: 'silver_coin', x: 300, y: 200, row: 2, column: 3 }];
      });
      await vi.advanceTimersByTimeAsync(0);
      const items = await received;
      expect(items.filter(item => item.event).map(item => item.event!.type))
        .toEqual(['pvz.zombie.visible', 'pvz.collectible.appeared']);
      expect(bus.pending()).toBe(0);
      transport.state.board!.sun = 600;
      expect(await items.find(item => item.deferred)?.deferred!.render()).toContain('阳光 600');
    } finally { vi.useRealTimers(); await world.stop(); }
  });

  it.each(['moved', 'disappeared'] as const)('refreshes Whack targets that %s after the queued sample', async change => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
      board: boardState({
        allowedSpecialActions: ['whack'],
        special: { phase: 'ready', settled: true, targets: [] },
      }),
    }));
    const { world, host } = await startWorld(transport);
    const appear = (id: number) => transport.publish(draft => {
      draft.board!.zombies = [{
        id, type: 0, name: 'zombie', row: 2, column: 7, columnPosition: 7,
        xBand: 'far', speedCellsPerSecond: 0, condition: 'intact', armor: 'none',
        shield: 'none', hypnotized: false, slowed: false, immobilized: false,
      }];
      draft.board!.special!.targets = [{ action: 'whack', kind: 'zombie', id, slot: null, row: 2, column: 7 }];
    });
    try {
      appear(1);
      await new Promise(resolve => setTimeout(resolve, 5));
      const target = host.deferred.find(item => item.type === 'pvz.target.ready')!;
      if (change === 'moved') {
        transport.state.board!.zombies[0]!.column = 4;
        transport.state.board!.zombies[0]!.columnPosition = 4;
        transport.state.board!.special!.targets[0]!.column = 4;
        const text = await target.render();
        expect(text).toContain('普通僵尸在第2排第4列');
        expect(text).not.toContain('普通僵尸在第2排第7列');
      } else {
        transport.state.board!.zombies = [];
        transport.state.board!.special!.targets = [];
        expect(await target.render()).toBeNull();
        appear(2);
        await new Promise(resolve => setTimeout(resolve, 5));
        const next = host.deferred.filter(item => item.type === 'pvz.target.ready').at(-1)!;
        expect(next).not.toBe(target);
        expect(await next.render()).toContain('当前 1 个可锤目标');
      }
      expect(transport.commands).toEqual([]);
    } finally { await world.stop(); }
  });

  it('serializes a delayed do admission before a later stop without resurrecting the task', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    const { world } = await startWorld(transport);
    const original = transport.command.bind(transport);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let waiting = false;
    transport.command = async (...args) => {
      if (args[0].kind === 'snapshot' && !waiting) {
        waiting = true;
        await gate;
      }
      return original(...args);
    };
    try {
      const submitted = callTool(world, 'pvz_do', { steps: [{ skill: 'collect', what: 'coins' }] });
      const stopped = callTool(world, 'pvz_stop');
      await Promise.resolve();
      release();
      expect(await submitted).toContain('已受理');
      expect(await stopped).toContain('当前没有执行中的任务');
      expect(await callTool(world, 'pvz_queue')).not.toContain('正在做任务');
      expect(transport.commands.filter(action => action.kind === 'collect')).toEqual([]);
    } finally { await world.stop(); }
  });
});

function connectBus(host: FakePvzHost): WakeBus {
  const bus = new WakeBus({ quietGapMs: 2000, minBatchAgeMs: 15000, maxBatchAgeMs: 25000, maxBatchSize: 100 });
  const push = host.pushEvent.bind(host);
  host.pushEvent = async (value, options) => {
    const event = await push(value, options);
    if (options?.deliver !== false) bus.push({ event }, options);
    return event;
  };
  const defer = host.pushDeferred.bind(host);
  host.pushDeferred = (value, options) => {
    defer(value, options);
    bus.push({ deferred: { ...value, source: 'pvz', origin: 'external' } }, options);
  };
  return bus;
}
