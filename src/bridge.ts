import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { normalizePvzExecutablePath } from './config.ts';
import { ensurePvzNativeArtifacts, loadPvzNativeArtifacts } from './native-build.ts';
import { SUPPORTED_PVZ_PROFILE, verifyPvzInstallation } from './fingerprint.ts';
import type { PvzOwnershipIdentity } from './engine-ipc.ts';
import {
  parseNativeMessage,
  PVZ_NATIVE_PROTOCOL,
  type PvzCommand,
  type PvzCommandContext,
  type PvzHello,
  type PvzNativeAck,
  type PvzNativeAction,
  type PvzNativeFrame,
  type PvzNativeLog,
  type PvzNativeResult,
  type PvzSnapshot,
} from './protocol.ts';

export interface PvzBridgeOptions {
  executable: string;
  launch: boolean;
  attachPid: number | null;
  shutdownOnStop: boolean;
  buildDir: string;
  pollHz: number;
  cursorDurationMs: [number, number];
  ownerToken?: string;
  recoveryIdentity?: PvzOwnershipIdentity;
  ownershipFile?: string;
}

export interface PvzBridgeEvents {
  prelaunchFailure: [Error];
  ownership: [PvzOwnershipIdentity];
  hello: [PvzHello];
  snapshot: [PvzSnapshot];
  result: [PvzNativeResult];
  log: [PvzNativeLog];
  disconnect: [Error | null];
}

interface Pending<T> {
  resolve(value: T): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PvzTransport {
  readonly artifactDir: string | null;
  on<K extends keyof PvzBridgeEvents>(event: K, listener: (...args: PvzBridgeEvents[K]) => void): this;
  start(): Promise<PvzHello>;
  stop(): Promise<void>;
  command(
    action: PvzNativeAction,
    timeoutMs?: number,
    id?: string,
    context?: PvzCommandContext,
  ): Promise<PvzNativeAck>;
  capture(timeoutMs?: number): Promise<PvzNativeFrame>;
}

export class PvzNativeBridge extends EventEmitter implements PvzTransport {
  private static readonly MAX_LINE_BYTES = 8 * 1024 * 1024;
  private server: Server | null = null;
  private socket: Socket | null = null;
  private injector: ChildProcess | null = null;
  private pipeName = '';
  private accepting = false;
  private socketState: { socket: Socket; buffer: string; decoder: StringDecoder } | null = null;
  private helloValue: PvzHello | null = null;
  private helloWaiter: Pending<PvzHello> | null = null;
  private injectorIdentity: PvzOwnershipIdentity | null = null;
  private injectorIdentityWaiter: Pending<PvzOwnershipIdentity> | null = null;
  private injectorStdout = '';
  private injectorStderr = '';
  private expectedOwnerToken = '';
  private artifactDirValue: string | null = null;
  private startupError: Error | null = null;
  private pendingHello: PvzHello | null = null;
  private preHandshakeSnapshot: PvzSnapshot | null = null;
  private readonly pendingAcks = new Map<string, Pending<PvzNativeAck>>();
  private readonly pendingFrames = new Map<string, Pending<PvzNativeFrame>>();
  private readonly nativeResults = new Map<string, PvzNativeResult>();
  private stopped = false;

  constructor(private readonly options: PvzBridgeOptions) {
    super();
  }

  override on<K extends keyof PvzBridgeEvents>(event: K, listener: (...args: PvzBridgeEvents[K]) => void): this {
    return super.on(event, listener);
  }

  get artifactDir(): string | null {
    return this.artifactDirValue;
  }

  async start(): Promise<PvzHello> {
    if (this.server || this.injector) throw new Error('PvZ 原生桥已经启动');
    this.stopped = false;
    this.startupError = null;
    const configuredExecutable = normalizePvzExecutablePath(this.options.executable);
    const executable = configuredExecutable ? resolve(configuredExecutable) : '';
    try {
      if (this.options.launch && (!executable || !existsSync(executable))) {
        throw new Error(`找不到 PlantsVsZombies.exe: ${executable || '(未配置)'}`);
      }
      if (!this.options.launch && this.options.attachPid === null) {
        throw new Error('附加模式需要 worlds.pvz.attachPid');
      }
      if (!this.options.launch && !this.options.recoveryIdentity) {
        throw new Error('附加仅用于恢复由 worlds-pvz 托管且持有完整所有权身份的游戏进程');
      }
      if (!this.options.launch && this.options.recoveryIdentity?.pid !== this.options.attachPid) {
        throw new Error('附加 PID 与 PvZ 所有权记录不一致');
      }
      if (this.options.launch) await verifyPvzInstallation(executable);
      const artifacts = this.options.recoveryIdentity
        ? loadPvzNativeArtifacts(this.options.recoveryIdentity.artifactDir)
        : await ensurePvzNativeArtifacts(this.options.buildDir);
      this.artifactDirValue = artifacts.outputDir;
      this.expectedOwnerToken = this.options.recoveryIdentity?.ownerToken
        ?? this.options.ownerToken
        ?? randomBytes(16).toString('hex');
      this.pipeName = `\\\\.\\pipe\\cortico-pvz-${process.pid}-${randomUUID()}`;
      await this.listen(this.pipeName);

      const args = [
        '--dll', artifacts.implant,
        '--pipe', this.pipeName,
        '--poll-hz', String(this.options.pollHz),
        '--cursor-min-ms', String(this.options.cursorDurationMs[0]),
        '--cursor-max-ms', String(this.options.cursorDurationMs[1]),
      ];
      if (this.options.launch) {
        args.push('--exe', executable);
      } else {
        args.push(...recoveryInjectorArgs(this.options.recoveryIdentity!));
      }
      args.push('--owner-token', this.expectedOwnerToken);
      if (this.options.ownershipFile) args.push('--ownership-file', this.options.ownershipFile);

      this.injector = spawn(artifacts.injector, args, {
        cwd: executable ? dirname(executable) : process.cwd(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CORTICO_PVZ_PIPE: this.pipeName },
      });
      this.injector.stdout?.on('data', (chunk) => this.onInjectorStdout(String(chunk)));
      this.injector.stderr?.on('data', (chunk) => this.onInjectorStderr(String(chunk)));
      this.injector.once('error', (error) => {
        this.failHello(error);
        this.failInjectorIdentity(error);
      });
      this.injector.once('exit', (code) => {
        if (code !== 0) {
          const failure = new Error(`PvZ 注入器退出(${String(code)})`);
          this.failHello(failure);
          this.failInjectorIdentity(failure);
        }
      });
      this.injector.once('close', (code) => {
        this.flushInjectorLogs();
        if (this.injectorIdentity?.phase !== 'resumed') {
          this.failInjectorIdentity(new Error(`PvZ 注入器未交付目标身份(${String(code)})`));
        }
      });

      const [hello, identity] = await Promise.all([
        this.waitHello(20_000),
        this.waitInjectorIdentity(20_000),
      ]);
      this.validateIdentity(hello, identity);
      return hello;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const failedBeforeInjector = this.injector === null;
      await this.teardown();
      if (failedBeforeInjector) this.emit('prelaunchFailure', failure);
      throw failure;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const identity = this.injectorIdentity;
    let commandFailure: Error | null = null;
    if (this.socket && !this.socket.destroyed) {
      try {
        const id = randomUUID();
        const ack = await this.command(
          this.options.shutdownOnStop ? { kind: 'shutdown' } : { kind: 'detach' },
          2500,
          id,
        );
        if (!ack.accepted) throw new Error(ack.reason ?? '植入件拒绝停机动作');
        const result = await this.waitForResult(id, 5000);
        if (result.outcome !== 'executed') {
          throw new Error(result.reason ?? `植入件停机结果: ${result.outcome}`);
        }
      } catch (error) {
        commandFailure = error instanceof Error ? error : new Error(String(error));
      }
    } else if (this.options.shutdownOnStop) {
      commandFailure = new Error('PvZ 植入件已断开，无法请求目标游戏退出');
    }
    await this.teardown();
    if (!this.options.shutdownOnStop) return;
    if (!identity) {
      throw commandFailure ?? new Error('PvZ 原生桥没有经过验证的目标进程身份');
    }
    const exited = await waitForOwnedProcessExit(identity.pid, identity.creationTime, 5000);
    if (!exited) {
      throw commandFailure ?? new Error('自有 PvZ 进程未在停机死线内退出');
    }
  }

  command(
    action: PvzNativeAction,
    timeoutMs = 5000,
    id = randomUUID(),
    context: PvzCommandContext = {},
  ): Promise<PvzNativeAck> {
    return this.sendCommand(id, action, timeoutMs, context);
  }

  private sendCommand(
    id: string,
    action: PvzNativeAction,
    timeoutMs: number,
    context: PvzCommandContext = {},
  ): Promise<PvzNativeAck> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error('PvZ 植入件未连接'));
    if (!this.helloValue) return Promise.reject(new Error('PvZ 植入件握手尚未完成'));
    const command: PvzCommand = {
      type: 'command', protocol: PVZ_NATIVE_PROTOCOL, id, action,
      ...context,
    };
    return new Promise((resolveAck, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id);
        reject(new Error(`植入件 ${timeoutMs / 1000}s 未确认动作 ${action.kind}`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingAcks.set(id, { resolve: resolveAck, reject, timer });
      socket.write(`${JSON.stringify(command)}\n`, (error) => {
        if (!error) return;
        const pending = this.pendingAcks.get(id);
        if (!pending) return;
        this.pendingAcks.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  async capture(timeoutMs = 10_000): Promise<PvzNativeFrame> {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error('PvZ 植入件未连接');
    if (!this.helloValue) throw new Error('PvZ 植入件握手尚未完成');
    const id = randomUUID();
    const command: PvzCommand = {
      type: 'command', protocol: PVZ_NATIVE_PROTOCOL, id, action: { kind: 'capture' },
    };
    const frame = new Promise<PvzNativeFrame>((resolveFrame, reject) => {
      const timer = setTimeout(() => {
        this.pendingFrames.delete(id);
        reject(new Error(`植入件 ${timeoutMs / 1000}s 未返回画面`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingFrames.set(id, { resolve: resolveFrame, reject, timer });
    });
    const ack = this.sendCommand(id, command.action, Math.min(timeoutMs, 5000));
    let accepted: PvzNativeAck;
    try {
      accepted = await ack;
    } catch (error) {
      const pending = this.pendingFrames.get(id);
      if (pending) {
        this.pendingFrames.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return await frame;
    }
    if (!accepted.accepted) {
      const pending = this.pendingFrames.get(id);
      if (pending) {
        this.pendingFrames.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error(accepted.reason ?? '植入件拒绝截图'));
      }
      return await frame;
    }
    let result: PvzNativeResult;
    try {
      result = await this.waitForResult(id, timeoutMs);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const pending = this.pendingFrames.get(id);
      if (pending) {
        this.pendingFrames.delete(id);
        clearTimeout(pending.timer);
        pending.reject(failure);
      }
      await frame.catch(() => undefined);
      throw failure;
    }
    if (result.outcome !== 'executed') {
      const failure = new Error(result.reason ?? `植入件截图结果: ${result.outcome}`);
      const pending = this.pendingFrames.get(id);
      if (pending) {
        this.pendingFrames.delete(id);
        clearTimeout(pending.timer);
        pending.reject(failure);
      }
      await frame.catch(() => undefined);
      throw failure;
    }
    return await frame;
  }

  private listen(pipeName: string): Promise<void> {
    return new Promise((resolveListen, reject) => {
      this.accepting = true;
      const server = createServer((socket) => this.accept(socket));
      this.server = server;
      server.once('error', reject);
      server.listen(pipeName, () => {
        server.removeListener('error', reject);
        resolveListen();
      });
    });
  }

  private accept(socket: Socket): void {
    if (!this.accepting) {
      socket.destroy();
      return;
    }
    if (this.socket && !this.socket.destroyed) {
      socket.destroy(new Error('worlds-pvz 只接受一个植入件连接'));
      return;
    }
    this.socket = socket;
    const state = { socket, buffer: '', decoder: new StringDecoder('utf8') };
    this.socketState = state;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(state, state.decoder.write(chunk)));
    socket.on('error', (error) => this.onDisconnect(socket, error));
    socket.on('close', () => this.onDisconnect(socket, null));
  }

  private onData(
    state: { socket: Socket; buffer: string; decoder: StringDecoder },
    chunk: string,
  ): void {
    if (this.socketState !== state || this.socket !== state.socket) return;
    state.buffer += chunk;
    if (Buffer.byteLength(state.buffer, 'utf8') > PvzNativeBridge.MAX_LINE_BYTES) {
      state.socket.destroy(new Error('PvZ 植入件消息超过 8MiB 上限'));
      return;
    }
    for (;;) {
      const newline = state.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = state.buffer.slice(0, newline).trim();
      state.buffer = state.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = parseNativeMessage(line);
        if (message.type === 'hello') {
          if (this.pendingHello || this.helloValue) throw new Error('植入件重复发送 hello');
          this.validateHello(message);
          this.pendingHello = message;
          this.completeHandshakeIfReady();
        } else if (message.type === 'snapshot') {
          if (!this.pendingHello && !this.helloValue) throw new Error('植入件首条消息必须是 hello');
          if (!this.helloValue) {
            this.preHandshakeSnapshot = message.snapshot;
            continue;
          }
          this.emit('snapshot', message.snapshot);
        } else if (message.type === 'ack') {
          if (!this.helloValue) throw new Error('植入件在握手完成前发送 ack');
          const pending = this.pendingAcks.get(message.id);
          if (pending) {
            this.pendingAcks.delete(message.id);
            clearTimeout(pending.timer);
            pending.resolve(message);
          }
        } else if (message.type === 'result') {
          if (!this.helloValue) throw new Error('植入件在握手完成前发送 result');
          this.nativeResults.set(message.id, message);
          if (this.nativeResults.size > 512) {
            const oldest = this.nativeResults.keys().next().value as string | undefined;
            if (oldest) this.nativeResults.delete(oldest);
          }
          this.emit('result', message);
        } else if (message.type === 'frame') {
          if (!this.helloValue) throw new Error('植入件在握手完成前发送 frame');
          const pending = this.pendingFrames.get(message.id);
          if (pending) {
            this.pendingFrames.delete(message.id);
            clearTimeout(pending.timer);
            pending.resolve(message);
          }
        } else {
          if (!this.helloValue) throw new Error('植入件在握手完成前发送 log');
          this.emit('log', message);
        }
      } catch (error) {
        this.emit('log', {
          type: 'log', protocol: PVZ_NATIVE_PROTOCOL, level: 'error',
          message: `植入件消息无效: ${error instanceof Error ? error.message : String(error)}`,
        });
        state.socket.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private waitHello(timeoutMs: number): Promise<PvzHello> {
    if (this.helloValue) return Promise.resolve(this.helloValue);
    if (this.startupError) return Promise.reject(this.startupError);
    return new Promise((resolveHello, reject) => {
      const timer = setTimeout(() => {
        this.helloWaiter = null;
        reject(new Error(`PvZ 植入件 ${timeoutMs / 1000}s 未握手`));
      }, timeoutMs);
      timer.unref?.();
      this.helloWaiter = { resolve: resolveHello, reject, timer };
    });
  }

  private waitInjectorIdentity(timeoutMs: number): Promise<PvzOwnershipIdentity> {
    if (this.injectorIdentity?.phase === 'resumed') return Promise.resolve(this.injectorIdentity);
    if (this.startupError) return Promise.reject(this.startupError);
    return new Promise((resolveIdentity, reject) => {
      const timer = setTimeout(() => {
        this.injectorIdentityWaiter = null;
        reject(new Error(`PvZ 注入器 ${timeoutMs / 1000}s 未交付目标身份`));
      }, timeoutMs);
      timer.unref?.();
      this.injectorIdentityWaiter = { resolve: resolveIdentity, reject, timer };
    });
  }

  private waitForResult(id: string, timeoutMs: number): Promise<PvzNativeResult> {
    const current = this.nativeResults.get(id);
    if (current) return Promise.resolve(current);
    return new Promise((resolveResult, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.removeListener('result', onResult);
        this.removeListener('disconnect', onDisconnect);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`植入件 ${timeoutMs / 1000}s 未返回执行结果`));
      }, timeoutMs);
      timer.unref?.();
      const onResult = (result: PvzNativeResult): void => {
        if (result.id !== id) return;
        cleanup();
        resolveResult(result);
      };
      const onDisconnect = (error: Error | null): void => {
        cleanup();
        reject(error ?? new Error('PvZ 植入件在等待执行结果时断开'));
      };
      this.on('result', onResult);
      this.once('disconnect', onDisconnect);
      const raced = this.nativeResults.get(id);
      if (raced) onResult(raced);
    });
  }

  private onInjectorStdout(chunk: string): void {
    this.injectorStdout += chunk;
    for (;;) {
      const newline = this.injectorStdout.indexOf('\n');
      if (newline < 0) return;
      const line = this.injectorStdout.slice(0, newline).trim();
      this.injectorStdout = this.injectorStdout.slice(newline + 1);
      if (!line) continue;
      const identity = parseInjectorIdentity(line);
      if (identity) {
        this.acceptInjectorIdentity(identity);
      }
      if (!identity) this.emitInjectorLog('info', line);
    }
  }

  private onInjectorStderr(chunk: string): void {
    this.injectorStderr += chunk;
    for (;;) {
      const newline = this.injectorStderr.indexOf('\n');
      if (newline < 0) return;
      const line = this.injectorStderr.slice(0, newline).trim();
      this.injectorStderr = this.injectorStderr.slice(newline + 1);
      if (line) this.emitInjectorLog('warn', line);
    }
  }

  private flushInjectorLogs(): void {
    const stdout = this.injectorStdout.trim();
    this.injectorStdout = '';
    if (stdout) {
      const identity = parseInjectorIdentity(stdout);
      if (identity) this.acceptInjectorIdentity(identity);
      else this.emitInjectorLog('info', stdout);
    }
    const stderr = this.injectorStderr.trim();
    this.injectorStderr = '';
    if (stderr) this.emitInjectorLog('warn', stderr);
  }

  private emitInjectorLog(level: 'info' | 'warn', message: string): void {
    this.emit('log', {
      type: 'log', protocol: PVZ_NATIVE_PROTOCOL, level,
      message: redactOwnerToken(message, this.expectedOwnerToken),
    });
  }

  private acceptInjectorIdentity(identity: PvzOwnershipIdentity): void {
    if (this.injectorIdentity) {
      const transition = this.injectorIdentity.phase === 'suspended' && identity.phase === 'resumed'
        && sameInjectorProcess(this.injectorIdentity, identity);
      if (!transition && JSON.stringify(this.injectorIdentity) !== JSON.stringify(identity)) {
        const failure = new Error('注入器重复交付了不同的目标身份');
        this.failHello(failure);
        this.failInjectorIdentity(failure);
        this.socket?.destroy(failure);
        return;
      }
      if (!transition) return;
    }
    try {
      this.validateInjectorIdentity(identity);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failHello(failure);
      this.failInjectorIdentity(failure);
      this.socket?.destroy(failure);
      return;
    }
    this.injectorIdentity = identity;
    this.emit('ownership', identity);
    if (identity.phase !== 'resumed') return;
    const waiter = this.injectorIdentityWaiter;
    this.injectorIdentityWaiter = null;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(identity);
    }
    try {
      this.completeHandshakeIfReady();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failHello(failure);
      this.socket?.destroy(failure);
    }
  }

  private validateHello(hello: PvzHello): void {
    if (hello.executableSha256.toLowerCase() !== SUPPORTED_PVZ_PROFILE.executable.sha256
      || hello.profile !== SUPPORTED_PVZ_PROFILE.id || !hello.supported) {
      throw new Error('植入件握手与已验证的 PvZ 构建身份不一致');
    }
    if (hello.ownerToken !== this.expectedOwnerToken) {
      throw new Error('植入件握手的所有权令牌与本次启动不一致');
    }
    const recovery = this.options.recoveryIdentity;
    if (!this.options.launch && (!recovery || hello.pid !== recovery.pid
      || hello.ownerToken !== recovery.ownerToken)) {
      throw new Error('恢复连接的 PvZ 进程身份或所有权令牌不一致');
    }
  }

  private validateInjectorIdentity(identity: PvzOwnershipIdentity): void {
    const expectedMode = this.options.launch ? 'launch' : 'attach';
    if (identity.mode !== expectedMode || identity.ownerToken !== this.expectedOwnerToken
      || resolve(identity.artifactDir).toLowerCase() !== resolve(this.artifactDirValue ?? '').toLowerCase()) {
      throw new Error('注入器交付的目标身份与本次启动不一致');
    }
    const recovery = this.options.recoveryIdentity;
    if (!this.options.launch && (!recovery || identity.pid !== recovery.pid
      || identity.creationTime !== recovery.creationTime
      || (recovery.phase === 'suspended' && identity.primaryThreadId !== recovery.primaryThreadId))) {
      throw new Error('注入器交付的进程创建时间或恢复线程与所有权记录不一致');
    }
  }

  private validateIdentity(hello: PvzHello, identity: PvzOwnershipIdentity): void {
    const expectedMode = this.options.launch ? 'launch' : 'attach';
    if (identity.phase !== 'resumed' || identity.mode !== expectedMode || identity.pid !== hello.pid
      || identity.ownerToken !== hello.ownerToken) {
      throw new Error('注入器交付的目标身份与植入件握手不一致');
    }
  }

  private completeHandshakeIfReady(): void {
    if (this.helloValue || !this.pendingHello || this.injectorIdentity?.phase !== 'resumed') return;
    this.validateIdentity(this.pendingHello, this.injectorIdentity);
    const hello = this.pendingHello;
    this.pendingHello = null;
    this.helloValue = hello;
    const waiter = this.helloWaiter;
    this.helloWaiter = null;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(hello);
    }
    this.emit('hello', hello);
    const snapshot = this.preHandshakeSnapshot;
    this.preHandshakeSnapshot = null;
    if (snapshot) this.emit('snapshot', snapshot);
  }

  private failHello(error: Error): void {
    if (!this.helloValue) this.startupError ??= error;
    const waiter = this.helloWaiter;
    this.helloWaiter = null;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  private failInjectorIdentity(error: Error): void {
    if (this.injectorIdentity?.phase !== 'resumed') this.startupError ??= error;
    const waiter = this.injectorIdentityWaiter;
    this.injectorIdentityWaiter = null;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  private onDisconnect(source: Socket, error: Error | null): void {
    if (this.socket !== source) return;
    this.socket = null;
    this.socketState = null;
    this.failHello(error ?? new Error('PvZ 植入件握手前断开'));
    this.rejectAll(error ?? new Error('PvZ 植入件连接已关闭'));
    this.emit('disconnect', error);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pendingAcks.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingAcks.clear();
    for (const pending of this.pendingFrames.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingFrames.clear();
  }

  private async teardown(): Promise<void> {
    this.accepting = false;
    const socket = this.socket;
    this.socket = null;
    this.socketState = null;
    socket?.destroy();
    await new Promise<void>((resolveClose) => {
      if (!this.server?.listening) return resolveClose();
      this.server.close(() => resolveClose());
    });
    this.server = null;
    if (this.injector && this.injector.exitCode === null) this.injector.kill();
    this.injector = null;
    this.rejectAll(new Error('PvZ 原生桥已停止'));
    this.failHello(new Error('PvZ 原生桥已停止'));
    this.failInjectorIdentity(new Error('PvZ 原生桥已停止'));
    this.helloValue = null;
    this.pendingHello = null;
    this.preHandshakeSnapshot = null;
    this.injectorIdentity = null;
    this.injectorStdout = '';
    this.injectorStderr = '';
    this.expectedOwnerToken = '';
    this.artifactDirValue = null;
    this.nativeResults.clear();
    this.pipeName = '';
  }
}

export function recoveryInjectorArgs(identity: PvzOwnershipIdentity): string[] {
  const args = ['--pid', String(identity.pid), '--creation-time', identity.creationTime];
  if (identity.phase !== 'suspended') return args;
  if (identity.primaryThreadId === null) {
    throw new Error('暂停态 PvZ 所有权记录缺少主线程 ID');
  }
  args.push('--resume-thread', String(identity.primaryThreadId));
  return args;
}

function parseInjectorIdentity(line: string): PvzOwnershipIdentity | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.ok !== true || !['launch', 'attach'].includes(String(value.mode))
      || !['suspended', 'resumed'].includes(String(value.phase))
      || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
      || !/^[0-9a-f]{32}$/.test(String(value.ownerToken))
      || !/^[0-9a-f]{16}$/.test(String(value.creationTime))
      || !(value.primaryThreadId === null
        || (Number.isSafeInteger(value.primaryThreadId) && Number(value.primaryThreadId) > 0))
      || typeof value.artifactDir !== 'string' || !isAbsolute(value.artifactDir)
      || !/^[0-9a-f]{64}$/.test(basename(value.artifactDir))) return null;
    if (value.phase === 'suspended' && value.primaryThreadId === null) return null;
    return {
      mode: value.mode as PvzOwnershipIdentity['mode'],
      phase: value.phase as PvzOwnershipIdentity['phase'],
      pid: Number(value.pid),
      ownerToken: String(value.ownerToken),
      creationTime: String(value.creationTime),
      primaryThreadId: value.primaryThreadId === null ? null : Number(value.primaryThreadId),
      artifactDir: resolve(value.artifactDir),
    };
  } catch {
    return null;
  }
}

function sameInjectorProcess(a: PvzOwnershipIdentity, b: PvzOwnershipIdentity): boolean {
  return a.mode === b.mode
    && a.pid === b.pid
    && a.ownerToken === b.ownerToken
    && a.creationTime === b.creationTime
    && a.primaryThreadId === b.primaryThreadId
    && resolve(a.artifactDir).toLowerCase() === resolve(b.artifactDir).toLowerCase();
}

function redactOwnerToken(value: string, expected = ''): string {
  const known = expected ? value.replaceAll(expected, '[redacted]') : value;
  return known.replace(/("ownerToken"\s*:\s*")[0-9a-f]{32}(\")/gi, '$1[redacted]$2');
}

async function waitForOwnedProcessExit(
  pid: number,
  creationTime: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await readWindowsProcessCreationTime(pid);
    if (current === null || current !== creationTime) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

export function readWindowsProcessCreationTime(pid: number): Promise<string | null> {
  const windowsDir = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const powershell = resolve(windowsDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if ($null -eq $p) { 'missing'; exit 0 }",
    "$v = [Convert]::ToString($p.StartTime.ToFileTimeUtc(), 16).PadLeft(16, '0')",
    '$v.ToLowerInvariant()',
  ].join('; ');
  return new Promise((resolveTime, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 2000);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const value = stdout.trim().toLowerCase();
      if (code !== 0) {
        reject(new Error(`无法核验 PvZ 进程创建时间: ${stderr.trim() || `PowerShell ${String(code)}`}`));
      } else if (value === 'missing') {
        resolveTime(null);
      } else if (/^[0-9a-f]{16}$/.test(value)) {
        resolveTime(value);
      } else {
        reject(new Error('无法核验 PvZ 进程创建时间: 返回值格式无效'));
      }
    });
  });
}
