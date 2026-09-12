import { PvzWorld } from './world.ts';
import { createIpcLogger } from 'cortico/core/ipc-logger.ts';
import { withAnchors } from 'cortico/core/log-context.ts';
import { toolCallContextFromRequest } from './engine-ipc.ts';
import type {
  ChildToMain,
  EngineInit,
  EngineRequest,
  HostRequest,
  MainToChild,
} from './engine-ipc.ts';
import type {
  EventEnvelope,
  EventStoreReader,
  WorldHost,
  Logger,
  DeferredRendered,
} from 'cortico/core/types.ts';

function send(message: ChildToMain): void {
  process.send?.(message);
}

const makeLogger = (area: string): Logger => createIpcLogger((note) => send({ t: 'note', note }), area);

const unavailable = (name: string): never => {
  throw new Error(`${name} 在 PvZ 引擎子进程 宿主中不可用`);
};

const store: EventStoreReader = {
  get: () => unavailable('store.get'),
  latestCursor: () => unavailable('store.latestCursor'),
  range: () => unavailable('store.range'),
  around: () => unavailable('store.around'),
  grep: () => unavailable('store.grep'),
};

const log = makeLogger('');
// 渲染回调过进程边界只带文本:子进程侧的投递成文事件不带附件。
const textRender = (render: () => DeferredRendered | null | Promise<DeferredRendered | null>) =>
  async (): Promise<string | null> => {
    const out = await render();
    return out === null || typeof out === 'string' ? out : out.text;
  };
const deferredRenders = new Map<string, {
  id: number;
  render: () => Promise<string | null>;
}>();
let nextRenderId = 1;
let nextHostId = 1;
const pendingHost = new Map<number, {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}>();

function hostRpc(req: HostRequest, timeoutMs = 10_000): Promise<unknown> {
  const id = nextHostId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHost.delete(id);
      reject(new Error(`主进程未回执 PvZ 宿主调用 ${req.kind}`));
    }, timeoutMs);
    timer.unref?.();
    pendingHost.set(id, { resolve, reject, timer });
    send({ t: 'hreq', id, req });
  });
}

const host: WorldHost = {
  // 附件随记录过界要走字节序列化,子进程侧不推带附件的事件(帧字节走 photo-frame 回执)。
  pushEvent: (event, opts) => hostRpc({ kind: 'push', evt: event as Parameters<typeof host.pushEvent>[0] & { blobs?: undefined }, opts }) as Promise<EventEnvelope>,
  pushDeferred: (event, opts) => {
    const renderId = nextRenderId++;
    deferredRenders.set(event.type, { id: renderId, render: textRender(event.render) });
    send({
      t: 'note',
      note: {
        kind: 'arm-deferred',
        type: event.type,
        renderId,
        ...(event.senderKey !== undefined ? { senderKey: event.senderKey } : {}),
        ...(event.meta !== undefined ? { meta: event.meta } : {}),
        ...(event.tags !== undefined ? { tags: event.tags } : {}),
        ...(opts?.trigger !== undefined ? { trigger: opts.trigger } : {}),
      },
    });
  },
  store,
  drainPendingEvents: () => Promise.resolve([]),
  modelFacts: {
    model: () => unavailable('modelFacts.model'),
    accepts: () => unavailable('modelFacts.accepts'),
    contextWindow: () => unavailable('modelFacts.contextWindow'),
  },
  blob: () => unavailable('blob'),
  reportUsage: () => undefined,
  log,
};

let mod: PvzWorld | null = null;
let cfg: EngineInit['cfg'] | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let lastStatus = '';

function applyCfg(target: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(next)) {
    const current = target[key];
    if (value && typeof value === 'object' && !Array.isArray(value)
      && current && typeof current === 'object' && !Array.isArray(current)) {
      applyCfg(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

function pushStatus(): void {
  if (!mod) return;
  const decl = mod.console();
  const note = {
    kind: 'status' as const,
    decl: { lamps: decl.lamps, badges: decl.badges, links: decl.links },
  };
  const key = JSON.stringify(note);
  if (key === lastStatus) return;
  lastStatus = key;
  send({ t: 'note', note });
}

async function handleRequest(request: EngineRequest): Promise<unknown> {
  if (request.kind === 'init') {
    if (mod) throw new Error('PvZ 引擎子进程 已初始化');
    cfg = request.init.cfg;
    mod = new PvzWorld({
      cfg,
      timezone: request.init.timezone,
      botName: request.init.botName,
      taskIdBase: request.init.taskIdBase,
      ownedProcess: request.init.ownedProcess,
      ownerToken: request.init.ownerToken,
      ...(request.init.recoveryIdentity
        ? { recoveryIdentity: request.init.recoveryIdentity }
        : {}),
      ownershipFile: request.init.ownershipFile,
      onOwnership: (ownership) => {
        send({ t: 'note', note: { kind: 'ownership', ...ownership } });
      },
      onPrelaunchFailure: (error) => {
        send({ t: 'note', note: { kind: 'prelaunch-failure', error: error.message } });
      },
      onTransportFailure: (error) => {
        log.error('PvZ 原生传输断开，引擎子进程 将退出并由主进程重启', { error: error.message });
        exitPreservingGame(1);
      },
    });
    await mod.start(host);
    statusTimer = setInterval(pushStatus, 1000);
    statusTimer.unref?.();
    pushStatus();
    const ownership = mod.ownershipIdentity;
    if (!ownership || ownership.phase !== 'resumed') {
      throw new Error('PvZ 引擎子进程 启动后没有完整的目标进程所有权身份');
    }
    return ownership;
  }
  if (request.kind === 'shutdown') {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
    await mod?.stop();
    mod = null;
    setImmediate(() => process.exit(0));
    return null;
  }
  if (request.kind === 'render-deferred') {
    if (request.renderId === undefined) return null;
    const entry = deferredRenders.get(request.type);
    if (!entry || entry.id !== request.renderId) return null;
    deferredRenders.delete(request.type);
    return await entry.render();
  }
  if (!mod) throw new Error('PvZ 引擎子进程 尚未初始化');
  if (request.kind === 'handoff-snapshot') return await mod.handoffSnapshot();
  if (request.kind === 'photo-frame') return await mod.photoFrame();
  const tool = mod.tools().find((candidate) => candidate.name === request.name);
  if (!tool) throw new Error(`未知 PvZ 工具 ${request.name}`);
  const ctx = toolCallContextFromRequest(request);
  return await withAnchors({ sess: ctx.role, ...(ctx.callId ? { call: ctx.callId } : {}), ...(ctx.round !== undefined ? { round: ctx.round } : {}) }, () => tool.handler(request.args, {
    ...ctx,
    log,
  }));
}

process.on('message', (message: MainToChild) => {
  if (message.t === 'req') {
    void Promise.resolve(handleRequest(message.req)).then(
      (value) => send({ t: 'rep', id: message.id, ok: true, value }),
      (error: unknown) => send({
        t: 'rep', id: message.id, ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }
  if (message.t === 'hrep') {
    const pending = pendingHost.get(message.id);
    if (!pending) return;
    pendingHost.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error ?? 'PvZ 宿主调用失败'));
    return;
  }
  if (message.cast.kind === 'config' && cfg) {
    const nativeBefore = JSON.stringify({
      pollHz: cfg.pollHz,
      cursorDurationMs: cfg.cursorDurationMs,
    });
    applyCfg(cfg as unknown as Record<string, unknown>, message.cast.cfg as unknown as Record<string, unknown>);
    const nativeAfter = JSON.stringify({
      pollHz: cfg.pollHz,
      cursorDurationMs: cfg.cursorDurationMs,
    });
    if (mod && nativeBefore !== nativeAfter) {
      void mod.configureNative().catch((error: unknown) => {
        log.warn('PvZ 原生运行参数更新失败', { error: String(error) });
      });
    }
    return;
  }
  if (message.cast.kind === 'cancel-action' && mod) {
    const stop = mod.tools().find((candidate) => candidate.name === 'pvz_stop');
    void stop?.handler({}, { role: 'system', log }).catch((error: unknown) => {
      log.warn('父进程死线触发的 PvZ 停止失败', { error: String(error) });
    });
  }
});

function exitPreservingGame(code: number): void {
  mod = null;
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
  process.exit(code);
}

process.on('disconnect', () => exitPreservingGame(0));
process.on('uncaughtException', (error) => {
  log.emit('error', 'PvZ 引擎子进程 未捕获异常', { event: 'uncaught-exception', err: error });
  exitPreservingGame(1);
});
process.on('unhandledRejection', (reason) => {
  log.emit('error', 'PvZ 引擎子进程 Promise 拒绝', { event: 'unhandled-rejection', err: reason });
  exitPreservingGame(1);
});
