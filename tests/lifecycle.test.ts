import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorldHost } from 'cortico/core/types.ts';
import { PvzNativeBridge, recoveryInjectorArgs } from '../src/bridge.ts';
import { PVZ_DEFAULTS, type PvzConfigSection } from '../src/config.ts';
import type {
  EngineInit,
  MainToChild,
  PvzOwnershipIdentity,
} from '../src/engine-ipc.ts';
import { ownershipPathForExecutable, PvzWorldProxy } from '../src/proxy.ts';
import { FakePvzHost } from './helpers.ts';

class FakeEngine extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  killed = false;
  readonly initRequests: EngineInit[] = [];

  constructor(
    private readonly identityForInit: (init: EngineInit) => PvzOwnershipIdentity,
    private readonly shutdownError: string | null = null,
  ) {
    super();
  }

  send(message: MainToChild): boolean {
    if (message.t !== 'req') return true;
    if (message.req.kind === 'init') {
      this.initRequests.push(message.req.init);
      const identity = this.identityForInit(message.req.init);
      queueMicrotask(() => {
        this.emit('message', { t: 'note', note: { kind: 'ownership', ...identity } });
        this.emit('message', { t: 'rep', id: message.id, ok: true, value: identity });
      });
      return true;
    }
    if (message.req.kind === 'shutdown') {
      queueMicrotask(() => {
        this.emit('message', this.shutdownError
          ? { t: 'rep', id: message.id, ok: false, error: this.shutdownError }
          : { t: 'rep', id: message.id, ok: true, value: null });
        this.exit(0);
      });
      return true;
    }
    return true;
  }

  kill(): boolean {
    this.killed = true;
    this.exit(1);
    return true;
  }

  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.connected = false;
    this.emit('exit', code);
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

let lifecycleDirectory = '';

beforeEach(() => {
  const scratch = join(process.cwd(), 'scratch');
  mkdirSync(scratch, { recursive: true });
  lifecycleDirectory = mkdtempSync(join(scratch, 'worlds-pvz-lifecycle-'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(lifecycleDirectory, { recursive: true, force: true });
});

function config(closeOnStop = false): PvzConfigSection {
  return {
    ...structuredClone(PVZ_DEFAULTS),
    enabled: true,
    executable: join(lifecycleDirectory, 'PlantsVsZombies.exe'),
    closeOnStop,
  };
}

function identity(
  init: EngineInit,
  mode: 'launch' | 'attach' = init.recoveryIdentity ? 'attach' : 'launch',
): PvzOwnershipIdentity {
  return {
    mode,
    phase: 'resumed',
    pid: init.recoveryIdentity?.pid ?? 4242,
    ownerToken: init.ownerToken,
    creationTime: init.recoveryIdentity?.creationTime ?? '01db000000000001',
    primaryThreadId: init.recoveryIdentity
      ? (init.recoveryIdentity.phase === 'suspended' ? init.recoveryIdentity.primaryThreadId : null)
      : 313,
    artifactDir: init.recoveryIdentity?.artifactDir ?? join(lifecycleDirectory, 'a'.repeat(64)),
  };
}

function host(): FakePvzHost {
  return new FakePvzHost();
}

async function mount(proxy: PvzWorldProxy, targetHost = host()): Promise<FakePvzHost> {
  await proxy.start(targetHost as unknown as WorldHost);
  return targetHost;
}

async function launch(proxy: PvzWorldProxy): Promise<unknown> {
  return proxy.console().invoke!('game', 'start', []);
}

async function mountAndLaunch(proxy: PvzWorldProxy, targetHost = host()): Promise<FakePvzHost> {
  await mount(proxy, targetHost);
  await launch(proxy);
  return targetHost;
}

const liveProcess = async (pid: number): Promise<string | null> => (
  pid === 5150 ? '01db000000000008' : '01db000000000001'
);

describe('PvZ 持久进程所有权', () => {
  it('挂载后保持静止，控制台启动才创建 引擎子进程 并投递说明', async () => {
    const cfg = config();
    const engine = new FakeEngine(identity);
    const targetHost = host();
    let forks = 0;
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => '7'.repeat(32),
      engineFactory: () => { forks += 1; return engine.asChild(); },
    });

    await mount(proxy, targetHost);
    expect(forks).toBe(0);
    expect(await proxy.console().invoke!('game', 'state', [])).toEqual({
      phase: 'stopped', detail: '未启动，不会连接植入件', pid: null, stoppable: false,
    });
    expect(targetHost.events).toEqual([]);

    await launch(proxy);
    expect(forks).toBe(1);
    expect(targetHost.events[0]).toMatchObject({
      event: {
        type: 'pvz.lifecycle', origin: 'internal',
        text: expect.stringContaining('操作员正在启动游戏'),
      },
      options: { trigger: 'flush' },
    });
    expect(await proxy.console().invoke!('game', 'state', [])).toMatchObject({
      phase: 'running', pid: 4242,
    });
    await proxy.stop();
  });

  it('带首尾双引号的游戏路径使用同一所有权记录并向 引擎子进程 传递规范路径', async () => {
    const cfg = config();
    const executable = cfg.executable;
    cfg.executable = `"${executable}"`;
    const engine = new FakeEngine(identity);
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => '8'.repeat(32),
      engineFactory: () => engine.asChild(),
    });

    expect(ownershipPathForExecutable(cfg.executable, lifecycleDirectory))
      .toBe(ownershipPathForExecutable(executable, lifecycleDirectory));
    await mountAndLaunch(proxy);
    expect(engine.initRequests[0].cfg.executable).toBe(executable);
    await proxy.stop();
  });

  it('在 fork 引擎子进程 前原子建立稳定 starting 记录，并在成功后保留完整身份', async () => {
    const cfg = config();
    const leasePath = ownershipPathForExecutable(cfg.executable, lifecycleDirectory);
    let observedStarting: Record<string, unknown> | null = null;
    const engine = new FakeEngine(identity);
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => '1'.repeat(32),
      engineFactory: () => {
        observedStarting = JSON.parse(readFileSync(leasePath, 'utf8')) as Record<string, unknown>;
        return engine.asChild();
      },
    });

    await mountAndLaunch(proxy);

    expect(observedStarting).toMatchObject({
      state: 'starting',
      ownerToken: '1'.repeat(32),
      executable: cfg.executable,
    });
    expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toMatchObject({
      ok: true,
      phase: 'resumed',
      pid: 4242,
      creationTime: '01db000000000001',
    });
    expect(engine.initRequests[0].taskIdBase).toBe(1_000_000);
    await proxy.stop();
    expect(existsSync(leasePath)).toBe(true);
  });

  it('新主进程从同一 executable lease 恢复现有游戏而不再次 launch', async () => {
    const cfg = config();
    const firstEngine = new FakeEngine(identity);
    const first = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      engineFactory: () => firstEngine.asChild(),
      ownerTokenFactory: () => '2'.repeat(32),
    });
    await mountAndLaunch(first);
    await first.stop();

    const secondEngine = new FakeEngine(identity);
    const second = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      engineFactory: () => secondEngine.asChild(),
      processCreationTimeReader: liveProcess,
    });
    await mountAndLaunch(second);

    expect(secondEngine.initRequests).toHaveLength(1);
    expect(secondEngine.initRequests[0].cfg).toMatchObject({ launch: false, attachPid: 4242 });
    expect(secondEngine.initRequests[0].recoveryIdentity).toMatchObject({
      pid: 4242,
      ownerToken: '2'.repeat(32),
      creationTime: '01db000000000001',
    });
    await second.stop();
  });

  it('未交付身份的 starting lease 阻止并发代理再 fork', async () => {
    const cfg = config();
    let forks = 0;
    const unresolved = new FakeEngine(identity);
    unresolved.send = () => true;
    const first = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => '3'.repeat(32),
      targetProcessStateReader: async () => 'unknown',
      engineFactory: () => { forks += 1; return unresolved.asChild(); },
    });
    await mount(first);
    const firstStart = launch(first);
    await Promise.resolve();

    const second = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      engineFactory: () => { forks += 1; return new FakeEngine(identity).asChild(); },
    });
    await mount(second);
    await expect(launch(second)).rejects.toThrow('启动事务');
    expect(forks).toBe(1);

    unresolved.exit(1);
    await expect(firstStart).rejects.toThrow('引擎子进程 已退出');
    expect(existsSync(ownershipPathForExecutable(cfg.executable, lifecycleDirectory))).toBe(true);
  });

  it('有明确 prelaunch 证据的首次失败会 CAS 回收 starting lease 并允许重试', async () => {
    const cfg = config();
    const leasePath = ownershipPathForExecutable(cfg.executable, lifecycleDirectory);
    const failed = new FakeEngine(identity);
    failed.send = (message: MainToChild): boolean => {
      if (message.t === 'req' && message.req.kind === 'init') {
        queueMicrotask(() => {
          failed.emit('message', {
            t: 'note', note: { kind: 'prelaunch-failure', error: 'fingerprint mismatch' },
          });
          failed.emit('message', {
            t: 'rep', id: message.id, ok: false, error: 'fingerprint mismatch',
          });
        });
      }
      return true;
    };
    const recovered = new FakeEngine(identity);
    let forks = 0;
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => 'e'.repeat(32),
      engineFactory: () => {
        forks += 1;
        return (forks === 1 ? failed : recovered).asChild();
      },
    });

    await mount(proxy);
    await expect(launch(proxy))
      .rejects.toThrow('fingerprint mismatch');
    expect(existsSync(leasePath)).toBe(false);

    await launch(proxy);
    expect(forks).toBe(2);
    expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toMatchObject({
      ok: true, phase: 'resumed', ownerToken: 'e'.repeat(32),
    });
    await proxy.stop();
  });

  it('injector 创建后的启动失败只在精确目标进程已消失时回收 starting lease', async () => {
    const cfg = config(true);
    const leasePath = ownershipPathForExecutable(cfg.executable, lifecycleDirectory);
    const failed = new FakeEngine(identity);
    failed.send = (message: MainToChild): boolean => {
      if (message.t === 'req' && message.req.kind === 'init') {
        queueMicrotask(() => failed.emit('message', {
          t: 'rep', id: message.id, ok: false, error: 'injector failed after launch',
        }));
      }
      return true;
    };
    const recovered = new FakeEngine(identity);
    const probed: string[] = [];
    let forks = 0;
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => '0'.repeat(32),
      targetProcessStateReader: async (executable) => {
        probed.push(executable);
        return 'absent';
      },
      engineFactory: () => {
        forks += 1;
        return (forks === 1 ? failed : recovered).asChild();
      },
    });

    await mount(proxy);
    await expect(launch(proxy))
      .rejects.toThrow('injector failed after launch');
    expect(probed).toEqual([cfg.executable]);
    expect(existsSync(leasePath)).toBe(false);

    await launch(proxy);
    expect(forks).toBe(2);
    expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toMatchObject({
      ok: true, phase: 'resumed', ownerToken: '0'.repeat(32),
    });
    await proxy.stop();
  });

  it('injector 创建后的启动失败在目标进程仍存活时保留 starting lease', async () => {
    const cfg = config(true);
    const leasePath = ownershipPathForExecutable(cfg.executable, lifecycleDirectory);
    const failed = new FakeEngine(identity);
    failed.send = (message: MainToChild): boolean => {
      if (message.t === 'req' && message.req.kind === 'init') {
        queueMicrotask(() => failed.emit('message', {
          t: 'rep', id: message.id, ok: false, error: 'identity delivery failed',
        }));
      }
      return true;
    };
    let forks = 0;
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => 'a'.repeat(32),
      targetProcessStateReader: async () => 'present',
      engineFactory: () => { forks += 1; return failed.asChild(); },
    });

    await mount(proxy);
    await expect(launch(proxy))
      .rejects.toThrow('identity delivery failed');
    expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toMatchObject({
      state: 'starting', ownerToken: 'a'.repeat(32), executable: cfg.executable,
    });
    await expect(launch(proxy)).rejects.toThrow('启动事务');
    expect(forks).toBe(1);
  });

  it('启动失败清理不会删除被其他 manager 改写的 starting lease', async () => {
    const cfg = config(true);
    const leasePath = ownershipPathForExecutable(cfg.executable, lifecycleDirectory);
    const failed = new FakeEngine(identity);
    failed.send = (message: MainToChild): boolean => {
      if (message.t === 'req' && message.req.kind === 'init') {
        queueMicrotask(() => {
          const replacement = {
            ...JSON.parse(readFileSync(leasePath, 'utf8')) as Record<string, unknown>,
            ownerToken: 'c'.repeat(32),
            managerPid: process.pid + 1,
          };
          writeFileSync(leasePath, JSON.stringify(replacement));
          failed.emit('message', {
            t: 'rep', id: message.id, ok: false, error: 'ownership changed',
          });
        });
      }
      return true;
    };
    let probes = 0;
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => 'b'.repeat(32),
      targetProcessStateReader: async () => { probes += 1; return 'absent'; },
      engineFactory: () => failed.asChild(),
    });

    await mount(proxy);
    await expect(launch(proxy)).rejects.toThrow('ownership changed');
    expect(probes).toBe(0);
    expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toMatchObject({
      state: 'starting', ownerToken: 'c'.repeat(32), managerPid: process.pid + 1,
    });
  });

  it('引擎子进程 尚未创建时的同步失败会回收本次 starting lease', async () => {
    const cfg = config();
    const leasePath = ownershipPathForExecutable(cfg.executable, lifecycleDirectory);
    const recovered = new FakeEngine(identity);
    let forks = 0;
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => 'f'.repeat(32),
      engineFactory: () => {
        forks += 1;
        if (forks === 1) throw new Error('fork unavailable');
        return recovered.asChild();
      },
    });

    await mount(proxy);
    await expect(launch(proxy)).rejects.toThrow('fork unavailable');
    expect(existsSync(leasePath)).toBe(false);

    await launch(proxy);
    expect(forks).toBe(2);
    expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toMatchObject({
      ok: true, phase: 'resumed', ownerToken: 'f'.repeat(32),
    });
    await proxy.stop();
  });

  it('引擎子进程 异常退出后只按 lease 附加恢复，不重新启动游戏', async () => {
    vi.useFakeTimers();
    const cfg = config();
    const sidecars: FakeEngine[] = [];
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => '4'.repeat(32),
      processCreationTimeReader: liveProcess,
      engineFactory: () => {
        const engine = new FakeEngine(identity);
        sidecars.push(engine);
        return engine.asChild();
      },
    });
    await mountAndLaunch(proxy);

    sidecars[0].exit(1);
    await vi.advanceTimersByTimeAsync(3001);

    expect(sidecars).toHaveLength(2);
    expect(sidecars.map((engine) => engine.initRequests[0].taskIdBase))
      .toEqual([1_000_000, 2_000_000]);
    expect(sidecars[1].initRequests[0].cfg.launch).toBe(false);
    expect(sidecars[1].initRequests[0].recoveryIdentity?.pid).toBe(4242);
    await proxy.stop();
  });

  it('游戏进程已被人关掉时不重启，回收 lease 并停回未启动', async () => {
    vi.useFakeTimers();
    const cfg = config(true);
    const leasePath = ownershipPathForExecutable(cfg.executable, lifecycleDirectory);
    const sidecars: FakeEngine[] = [];
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => 'a'.repeat(32),
      processCreationTimeReader: async () => null,
      engineFactory: () => {
        const engine = new FakeEngine(identity);
        sidecars.push(engine);
        return engine.asChild();
      },
    });
    const targetHost = await mountAndLaunch(proxy);

    sidecars[0].exit(1);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(sidecars).toHaveLength(1);
    expect(existsSync(leasePath)).toBe(false);
    expect(await proxy.console().invoke!('game', 'state', [])).toMatchObject({
      phase: 'stopped', stoppable: false,
    });
    expect(targetHost.events.map(({ event }) => event.text))
      .toContainEqual(expect.stringContaining('游戏进程已经退出'));
    await proxy.stop();
  });

  it('游戏还活着但 引擎子进程 反复起不来时按上限停手', async () => {
    vi.useFakeTimers();
    const cfg = config();
    let forks = 0;
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => 'b'.repeat(32),
      processCreationTimeReader: liveProcess,
      engineFactory: () => {
        forks += 1;
        const engine = new FakeEngine(identity);
        // 第一份正常交付身份，之后每一份都在 init 之前就死掉
        if (forks > 1) queueMicrotask(() => engine.exit(1));
        return engine.asChild();
      },
    });
    const targetHost = await mountAndLaunch(proxy);
    (proxy as unknown as { child: { exit(code: number): void } | null }).child?.exit(1);

    await vi.advanceTimersByTimeAsync(600_000);

    // 首次 + 预算内 4 次重启，之后不再 fork
    expect(forks).toBe(5);
    expect(await proxy.console().invoke!('game', 'state', [])).toMatchObject({ phase: 'error' });
    expect(targetHost.events.map(({ event }) => event.text))
      .toContainEqual(expect.stringContaining('恢复失败，已停手'));
    await proxy.stop();
  });

  it('控制台停止关掉游戏并回收 lease，之后还能重新启动', async () => {
    const cfg = config(true);
    const leasePath = ownershipPathForExecutable(cfg.executable, lifecycleDirectory);
    let forks = 0;
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => `${forks}`.repeat(32),
      engineFactory: () => { forks += 1; return new FakeEngine(identity).asChild(); },
    });
    const targetHost = await mountAndLaunch(proxy);
    expect(existsSync(leasePath)).toBe(true);

    expect(await proxy.console().invoke!('game', 'stop', [])).toMatchObject({
      phase: 'stopped', detail: '操作员已停止：游戏已退出', stoppable: false,
    });
    expect(existsSync(leasePath)).toBe(false);
    expect(targetHost.events.map(({ event }) => event.text))
      .toContainEqual(expect.stringContaining('操作员已停止游戏'));

    await launch(proxy);
    expect(forks).toBe(2);
    expect(await proxy.console().invoke!('game', 'state', [])).toMatchObject({ phase: 'running' });
    await proxy.stop();
  });

  it('停机未确认时保留 lease 并向调用方报告失败', async () => {
    const cfg = config(true);
    const leasePath = ownershipPathForExecutable(cfg.executable, lifecycleDirectory);
    const engine = new FakeEngine(identity, 'game still running');
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => '5'.repeat(32),
      engineFactory: () => engine.asChild(),
    });
    await mountAndLaunch(proxy);

    await expect(proxy.stop()).rejects.toThrow('game still running');
    expect(existsSync(leasePath)).toBe(true);
  });

  it('停机已由 引擎子进程 确认目标身份退出后删除 lease', async () => {
    const cfg = config(true);
    const leasePath = ownershipPathForExecutable(cfg.executable, lifecycleDirectory);
    const engine = new FakeEngine(identity);
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => '6'.repeat(32),
      engineFactory: () => engine.asChild(),
    });
    await mountAndLaunch(proxy);

    await proxy.stop();
    expect(existsSync(leasePath)).toBe(false);
  });

  it('引擎子进程 丢失且创建身份已消失时停机只回收 stale lease，不启动替身游戏', async () => {
    const cfg = config(true);
    const leasePath = ownershipPathForExecutable(cfg.executable, lifecycleDirectory);
    let forks = 0;
    const engine = new FakeEngine(identity);
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => 'd'.repeat(32),
      processCreationTimeReader: async () => null,
      engineFactory: () => { forks += 1; return engine.asChild(); },
    });
    await mountAndLaunch(proxy);
    engine.exit(1);

    await proxy.stop();
    expect(forks).toBe(1);
    expect(existsSync(leasePath)).toBe(false);
  });

  it('停机期间 lease 身份被替换时拒绝删除新记录', async () => {
    const cfg = config(true);
    const leasePath = ownershipPathForExecutable(cfg.executable, lifecycleDirectory);
    const engine = new FakeEngine(identity);
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => '9'.repeat(32),
      engineFactory: () => engine.asChild(),
    });
    await mountAndLaunch(proxy);
    const replacement = {
      ...JSON.parse(readFileSync(leasePath, 'utf8')) as Record<string, unknown>,
      ownerToken: 'a'.repeat(32),
    };
    writeFileSync(leasePath, JSON.stringify(replacement));

    await expect(proxy.stop()).rejects.toThrow('其他进程改写');
    expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toMatchObject({
      ownerToken: 'a'.repeat(32),
    });
  });

  it('暂停态 lease 的恢复参数绑定创建时间并只恢复记录中的主线程', () => {
    const suspended: PvzOwnershipIdentity = {
      mode: 'launch',
      phase: 'suspended',
      pid: 99,
      ownerToken: '7'.repeat(32),
      creationTime: '01db000000000007',
      primaryThreadId: 123,
      artifactDir: join(lifecycleDirectory, 'b'.repeat(64)),
    };
    expect(recoveryInjectorArgs(suspended)).toEqual([
      '--pid', '99',
      '--creation-time', '01db000000000007',
      '--resume-thread', '123',
    ]);
    expect(recoveryInjectorArgs({ ...suspended, phase: 'resumed' })).toEqual([
      '--pid', '99',
      '--creation-time', '01db000000000007',
    ]);
  });

  it('既有 suspended native lease 会直接进入恢复而不创建 starting 记录', async () => {
    const cfg = config();
    const leasePath = ownershipPathForExecutable(cfg.executable, lifecycleDirectory);
    const suspended: PvzOwnershipIdentity = {
      mode: 'launch',
      phase: 'suspended',
      pid: 5150,
      ownerToken: '8'.repeat(32),
      creationTime: '01db000000000008',
      primaryThreadId: 321,
      artifactDir: join(lifecycleDirectory, 'c'.repeat(64)),
    };
    writeFileSync(leasePath, JSON.stringify({ ok: true, ...suspended }));
    const engine = new FakeEngine((init) => ({
      ...identity(init),
      pid: suspended.pid,
      ownerToken: suspended.ownerToken,
      creationTime: suspended.creationTime,
      artifactDir: suspended.artifactDir,
    }));
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      engineFactory: () => engine.asChild(),
      processCreationTimeReader: liveProcess,
    });

    await mountAndLaunch(proxy);
    expect(engine.initRequests[0].recoveryIdentity).toEqual(suspended);
    expect(engine.initRequests[0].cfg.launch).toBe(false);
    await proxy.stop();
  });

  it('PID 已复用且创建时间不匹配时，条件回收 stale lease 后才允许新 launch', async () => {
    const cfg = config();
    const leasePath = ownershipPathForExecutable(cfg.executable, lifecycleDirectory);
    const stale: PvzOwnershipIdentity = {
      mode: 'launch',
      phase: 'resumed',
      pid: 6161,
      ownerToken: 'b'.repeat(32),
      creationTime: '01db000000000009',
      primaryThreadId: 777,
      artifactDir: join(lifecycleDirectory, 'd'.repeat(64)),
    };
    writeFileSync(leasePath, JSON.stringify({ ok: true, ...stale }));
    const engine = new FakeEngine(identity);
    const proxy = new PvzWorldProxy({
      cfg,
      ownershipDirectory: lifecycleDirectory,
      ownerTokenFactory: () => 'c'.repeat(32),
      processCreationTimeReader: async () => '01db00000000ffff',
      engineFactory: () => engine.asChild(),
    });

    await mountAndLaunch(proxy);
    expect(engine.initRequests[0].recoveryIdentity).toBeNull();
    expect(engine.initRequests[0].cfg.launch).toBe(true);
    expect(engine.initRequests[0].ownerToken).toBe('c'.repeat(32));
    await proxy.stop();
  });
});

describe('PvZ 引擎子进程 进程故障边界', () => {
  it('启动前配置失败会显式报告 prelaunch failure', async () => {
    const bridge = new PvzNativeBridge({
      executable: join(lifecycleDirectory, 'missing.exe'),
      launch: true,
      attachPid: null,
      shutdownOnStop: false,
      buildDir: join(lifecycleDirectory, 'native-build'),
      pollHz: 15,
      cursorDurationMs: [80, 160],
    });
    const failures: Error[] = [];
    bridge.on('prelaunchFailure', (error) => failures.push(error));

    await expect(bridge.start()).rejects.toThrow('找不到 PlantsVsZombies.exe');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain('missing.exe');
  });

  it('注入器日志中的当前 owner token 与 JSON token 字段均被遮蔽', () => {
    const token = 'e'.repeat(32);
    const bridge = new PvzNativeBridge({
      executable: '',
      launch: true,
      attachPid: null,
      shutdownOnStop: false,
      buildDir: lifecycleDirectory,
      pollHz: 15,
      cursorDurationMs: [90, 220],
    });
    const inner = bridge as unknown as {
      expectedOwnerToken: string;
      onInjectorStderr(chunk: string): void;
    };
    inner.expectedOwnerToken = token;
    const messages: string[] = [];
    bridge.on('log', (entry) => messages.push(entry.message));

    inner.onInjectorStderr(`token=${token} {"ownerToken":"${'f'.repeat(32)}"}\n`);

    expect(messages).toEqual([
      'token=[redacted] {"ownerToken":"[redacted]"}',
    ]);
  });

  it('未处理的 Promise 拒绝以失败码退出，由主进程恢复持久 lease', async () => {
    const entry = new URL('../src/engine-child.ts', import.meta.url).href;
    const script = `await import(${JSON.stringify(entry)}); Promise.reject(new Error('lifecycle-test')); setTimeout(() => {}, 10000);`;
    const child = spawn(process.execPath, [
      '--import', 'tsx',
      '--input-type=module',
      '--eval', script,
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const code = await new Promise<number | null>((resolveExit, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`引擎子进程 未按故障策略退出: ${stderr}`));
      }, 5000);
      child.once('error', reject);
      child.once('exit', (exitCode) => {
        clearTimeout(timer);
        resolveExit(exitCode);
      });
    });
    expect(code).toBe(1);
  });
});
