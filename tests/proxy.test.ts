import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorldHost } from 'cortico/core/types.ts';
import { PVZ_DEFAULTS } from '../src/config.ts';
import { toolCallContextFromRequest } from '../src/engine-ipc.ts';
import type {
  ChildToMain,
  EngineNote,
  EngineRequest,
  HostRequest,
} from '../src/engine-ipc.ts';
import { PvzWorldProxy, toolRpcTimeoutMs } from '../src/proxy.ts';
import { FakePvzHost } from './helpers.ts';

interface ProxyInternals {
  host: WorldHost | null;
  child: ChildProcess | null;
  generation: number;
  ready: boolean;
  stopping: boolean;
  launchRequested: boolean;
  failureEpisode: boolean;
  outstandingTasks: Map<number, number>;
  onExit(code: number | null): void;
  onMessage(message: ChildToMain, child: ChildProcess, generation: number): Promise<void>;
  handleHostRequest(request: HostRequest): Promise<unknown>;
  handleNote(note: EngineNote, child: ChildProcess, generation: number): void;
  finishRecoveryEpisode(): Promise<void>;
  rpcBound(
    child: ChildProcess,
    generation: number,
    request: EngineRequest,
    timeoutMs: number,
  ): Promise<unknown>;
}

function makeProxy(): { proxy: PvzWorldProxy; inner: ProxyInternals; host: FakePvzHost } {
  const proxy = new PvzWorldProxy({ cfg: structuredClone(PVZ_DEFAULTS) });
  const inner = proxy as unknown as ProxyInternals;
  const host = new FakePvzHost();
  inner.host = host as unknown as WorldHost;
  return { proxy, inner, host };
}

function fakeChild(sent: unknown[]): ChildProcess {
  return {
    connected: true,
    send: (message: unknown) => { sent.push(message); return true; },
    removeAllListeners: () => undefined,
  } as unknown as ChildProcess;
}

async function acceptTask(input: {
  proxy: PvzWorldProxy;
  inner: ProxyInternals;
  host: FakePvzHost;
  child: ChildProcess;
  sent: Array<Record<string, unknown>>;
  generation: number;
  taskId: number;
}): Promise<string> {
  const tool = input.proxy.tools().find(({ name }) => name === 'pvz_do')!;
  const pending = tool.handler({ steps: [{ skill: 'collect', what: 'sun' }] }, {
    role: 'test',
    log: input.host.log,
  });
  const request = input.sent.at(-1) as { t: 'req'; id: number };
  await input.inner.onMessage({
    t: 'rep', id: request.id, ok: true,
    value: `任务#${input.taskId} 已受理:收集可见阳光。\n[PvZ队列] 等待中`,
  }, input.child, input.generation);
  const result = await pending;
  return typeof result === 'string' ? result : result.text;
}

afterEach(() => vi.useRealTimers());

describe('PvZ 引擎子进程 代理生命周期', () => {
  it('交接钩子同步挂好 flush 快照，使旧票据失效并在新批次经 IPC 现读', async () => {
    const { proxy, inner, host } = makeProxy();
    const sent: Array<Record<string, unknown>> = [];
    const child = fakeChild(sent);
    inner.child = child;
    inner.generation = 4;
    inner.ready = true;
    inner.handleNote({ kind: 'arm-deferred', type: 'pvz.board.snapshot', renderId: 11, tags: ['snapshot'] }, child, 4);
    const old = host.deferred[0]!;
    proxy.onHandoffEnded();
    expect(host.deliveryCalls.at(-1)).toMatchObject({ kind: 'deferred', trigger: 'flush' });
    expect(await old.render()).toBeNull();
    expect(sent).toEqual([]);
    const pending = host.deferred.at(-1)!.render();
    const request = sent.at(-1) as { t: 'req'; id: number; req: EngineRequest };
    expect(request.req.kind).toBe('handoff-snapshot');
    await inner.onMessage({ t: 'rep', id: request.id, ok: true, value: 'new board and queue' }, child, 4);
    expect(await pending).toBe('new board and queue');
    expect(host.deferred.at(-1)!.tags).toEqual(['snapshot']);
  });

  it('保留 deferred 标签和票据身份，渲染超时明确要求重读', async () => {
    vi.useFakeTimers();
    const { inner, host } = makeProxy();
    const sent: Array<Record<string, unknown>> = [];
    const child = fakeChild(sent);
    inner.child = child;
    inner.generation = 3;
    inner.handleNote({ kind: 'arm-deferred', type: 'pvz.board.snapshot', renderId: 7, tags: ['snapshot'] }, child, 3);
    const pending = host.deferred[0]!.render();
    expect(host.deferred[0]!.tags).toEqual(['snapshot']);
    expect((sent[0]!.req as EngineRequest)).toMatchObject({ kind: 'render-deferred', renderId: 7 });
    await vi.advanceTimersByTimeAsync(2501);
    expect(await pending).toContain('pvz_observe');
  });

  it('把主循环轮号随工具请求传给 引擎子进程 并恢复成工具上下文', async () => {
    const { proxy, inner, host } = makeProxy();
    const sent: Array<Record<string, unknown>> = [];
    const child = fakeChild(sent);
    inner.child = child;
    inner.generation = 4;
    const tool = proxy.tools().find(({ name }) => name === 'pvz_queue')!;

    const pending = tool.handler({}, {
      role: 'main', log: host.log, callId: 'call-17', round: 23,
    });
    const message = sent.at(-1) as {
      t: 'req'; id: number; req: Extract<EngineRequest, { kind: 'tool' }>;
    };
    expect(message.req).toMatchObject({
      kind: 'tool', name: 'pvz_queue', role: 'main', callId: 'call-17', round: 23,
    });
    expect(toolCallContextFromRequest(message.req)).toEqual({
      role: 'main', callId: 'call-17', round: 23,
    });
    await inner.onMessage({
      t: 'rep', id: message.id, ok: true, value: '[PvZ队列] 空闲',
    }, child, 4);
    expect(await pending).toBe('[PvZ队列] 空闲');

    expect(toolCallContextFromRequest({
      kind: 'tool', name: 'pvz_queue', args: {}, role: 'test', callId: null, round: null,
    })).toEqual({ role: 'test' });
  });

  it('纯文本模型不挂载截图工具', () => {
    const { proxy } = makeProxy();
    expect(proxy.tools().map(({ name }) => name)).toEqual([
      'pvz_observe',
      'pvz_do',
      'pvz_queue',
      'pvz_arm',
      'pvz_stop',
    ]);
  });

  it('视觉模型挂载截图工具', () => {
    const { proxy, host } = makeProxy();
    host.modelFacts.accepts = () => true;

    expect(proxy.tools().map(({ name }) => name)).toEqual([
      'pvz_observe',
      'pvz_do',
      'pvz_queue',
      'pvz_arm',
      'pvz_stop',
      'pvz_glance',
    ]);
  });

  it('入队调用使用短 RPC 死线，停止操作为原生取消栅栏预留时间', () => {
    expect(toolRpcTimeoutMs('pvz_observe', PVZ_DEFAULTS)).toBe(30_000);
    expect(toolRpcTimeoutMs('pvz_do', PVZ_DEFAULTS, {
      steps: Array.from({ length: 64 }, () => ({ skill: 'collect', what: 'sun' })),
    })).toBe(30_000);
    expect(toolRpcTimeoutMs('pvz_queue', PVZ_DEFAULTS)).toBe(30_000);
    expect(toolRpcTimeoutMs('pvz_stop', PVZ_DEFAULTS)).toBe(45_000);
    expect(toolRpcTimeoutMs('pvz_stop', {
      actionTimeoutMs: 30_000, cursorDurationMs: [90, 220],
    })).toBe(70_000);
  });

  it('旧 引擎子进程 留下的延迟渲染票据不能读取新代状态', async () => {
    const { inner, host } = makeProxy();
    const sent: unknown[] = [];
    const child = fakeChild(sent);
    inner.child = child;
    inner.generation = 7;
    inner.handleNote({ kind: 'arm-deferred', type: 'pvz.board.snapshot' }, child, 7);
    expect(host.deferred).toHaveLength(1);

    inner.generation = 8;
    expect(await host.deferred[0].render()).toBeNull();
    expect(sent).toEqual([]);
  });

  it('同一故障 episode 只通知一次，并在真正恢复后再通知一次', async () => {
    const { proxy, inner, host } = makeProxy();
    inner.child = fakeChild([]);
    inner.ready = true;
    inner.launchRequested = true;
    inner.onExit(1);
    inner.onExit(1);
    expect(host.events.filter(({ event }) => event.type === 'pvz.lifecycle')).toHaveLength(1);

    await inner.handleHostRequest({
      kind: 'push',
      evt: {
        ts: new Date().toISOString(), source: 'pvz', type: 'pvz.connected',
        text: '[PvZ] 已连接测试版本。', senderKey: 'pvz',
      },
      opts: { trigger: 'flush' },
    });
    expect(host.events.filter(({ event }) => event.type === 'pvz.connected')).toHaveLength(0);

    await inner.finishRecoveryEpisode();
    expect(host.events.filter(({ event }) => event.type === 'pvz.connected')).toHaveLength(1);
    expect(host.events.at(-1)?.event.text).toContain('引擎子进程 已恢复');
    await proxy.stop();
  });

  it('正常任务终态核销登记，引擎子进程 退出只给未完成任务发送一次未验真终态', async () => {
    const { proxy, inner, host } = makeProxy();
    const sent: Array<Record<string, unknown>> = [];
    const child = fakeChild(sent);
    inner.child = child;
    inner.generation = 7;
    inner.ready = true;
    inner.launchRequested = true;

    await acceptTask({ proxy, inner, host, child, sent, generation: 7, taskId: 7_000_001 });
    await acceptTask({ proxy, inner, host, child, sent, generation: 7, taskId: 7_000_002 });
    expect([...inner.outstandingTasks.keys()]).toEqual([7_000_001, 7_000_002]);

    const terminal: HostRequest = {
      kind: 'push',
      evt: {
        ts: new Date().toISOString(), source: 'pvz', type: 'pvz.task',
        text: '任务#7000001完成:阳光已收集', senderKey: 'pvz.task.7000001',
      },
      opts: { trigger: 'flush' },
    };
    await inner.handleHostRequest(terminal);
    await inner.handleHostRequest(terminal);
    expect([...inner.outstandingTasks.keys()]).toEqual([7_000_002]);

    inner.onExit(1);
    inner.onExit(1);
    const terminalEvents = host.events.filter(({ event }) => event.type === 'pvz.task');
    expect(terminalEvents).toHaveLength(2);
    expect(terminalEvents.filter(({ event }) => event.senderKey === 'pvz.task.7000001')).toHaveLength(1);
    expect(terminalEvents.filter(({ event }) => event.senderKey === 'pvz.task.7000002')).toHaveLength(1);
    expect(terminalEvents.at(-1)?.event.text).toContain('未验真: 引擎子进程 退出(1)');
    expect(terminalEvents.at(-1)?.event.meta).toMatchObject({
      taskId: 7_000_002, engineGeneration: 7, terminal: 'unverified',
    });
    expect(inner.outstandingTasks.size).toBe(0);
    await proxy.stop();
  });

  it('任务在受理 RPC 前已经完成时不重新登记为悬空任务', async () => {
    const { proxy, inner, host } = makeProxy();
    const sent: Array<Record<string, unknown>> = [];
    const child = fakeChild(sent);
    inner.child = child;
    inner.generation = 9;

    const tool = proxy.tools().find(({ name }) => name === 'pvz_do')!;
    const pending = tool.handler({ steps: [{ skill: 'collect', what: 'sun' }] }, {
      role: 'test', log: host.log,
    });
    await inner.handleHostRequest({
      kind: 'push',
      evt: {
        ts: new Date().toISOString(), source: 'pvz', type: 'pvz.task',
        text: '任务#9000001完成:阳光已收集', senderKey: 'pvz.task.9000001',
      },
      opts: { trigger: 'flush' },
    });
    const request = sent.at(-1) as { t: 'req'; id: number };
    await inner.onMessage({
      t: 'rep', id: request.id, ok: true,
      value: '任务#9000001 已受理:收集可见阳光。\n[PvZ队列] 执行中',
    }, child, 9);
    await pending;

    expect(inner.outstandingTasks.size).toBe(0);
    inner.onExit(1);
    expect(host.events.filter(({ event }) => event.type === 'pvz.task')).toHaveLength(1);
    await proxy.stop();
  });

  it('父进程入队 RPC 超时时主动要求 引擎子进程 执行停止栅栏', async () => {
    vi.useFakeTimers();
    const { inner } = makeProxy();
    const sent: Array<Record<string, unknown>> = [];
    const child = fakeChild(sent) as ChildProcess;
    inner.child = child;
    inner.generation = 3;
    const pending = inner.rpcBound(child, 3, {
      kind: 'tool', name: 'pvz_do', args: { steps: [] }, role: 'test', callId: null, round: null,
    }, 10);
    const rejected = expect(pending).rejects.toThrow('未回执 tool');
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    expect(sent).toEqual([
      expect.objectContaining({ t: 'req' }),
      { t: 'cast', cast: { kind: 'cancel-action' } },
    ]);
  });

  it('pvz_stop 超时不递归触发第二次停止', async () => {
    vi.useFakeTimers();
    const { inner } = makeProxy();
    const sent: Array<Record<string, unknown>> = [];
    const child = fakeChild(sent) as ChildProcess;
    inner.child = child;
    inner.generation = 3;
    const pending = inner.rpcBound(child, 3, {
      kind: 'tool', name: 'pvz_stop', args: {}, role: 'test', callId: null, round: null,
    }, 10);
    const rejected = expect(pending).rejects.toThrow('未回执 tool');
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    expect(sent).toEqual([expect.objectContaining({ t: 'req' })]);
  });
});
