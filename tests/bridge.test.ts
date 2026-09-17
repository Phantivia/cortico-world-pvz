import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { PvzNativeBridge } from '../src/bridge.ts';
import { SUPPORTED_PVZ_PROFILE } from '../src/fingerprint.ts';
import { PVZ_NATIVE_PROTOCOL } from '../src/protocol.ts';
import { afterTimers, snapshot } from './helpers.ts';

it('握手身份未齐全时不发送动作，身份齐全后同一连接可正常使用', async () => {
  const bridge = new PvzNativeBridge({
    executable: '', launch: true, attachPid: null, shutdownOnStop: false,
    buildDir: '', pollHz: 15, cursorDurationMs: [90, 220],
  });
  const inner = bridge as unknown as {
    listen(path: string): Promise<void>;
    teardown(): Promise<void>;
    onInjectorStdout(chunk: string): void;
    expectedOwnerToken: string;
    artifactDirValue: string;
    socket: Socket | null;
    preHandshakeSnapshot: unknown;
  };
  const artifactDir = resolve('scratch', 'b'.repeat(64));
  const ownerToken = 'a'.repeat(32);
  inner.expectedOwnerToken = ownerToken;
  inner.artifactDirValue = artifactDir;
  const pipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\pvz-bridge-test-${randomUUID()}`
    : join(tmpdir(), `pvz-${randomUUID()}.sock`);
  await inner.listen(pipe);
  const peer = connect(pipe);
  await once(peer, 'connect');
  const commands: string[] = [];
  peer.on('data', (bytes) => {
    for (const line of String(bytes).trim().split('\n')) {
      const command = JSON.parse(line);
      commands.push(command.action.kind);
      peer.write(JSON.stringify({ type: 'ack', protocol: PVZ_NATIVE_PROTOCOL, id: command.id, accepted: true }) + '\n');
    }
  });
  try {
    const hello = {
      type: 'hello', protocol: PVZ_NATIVE_PROTOCOL, pid: 42, architecture: 'x86',
      profile: SUPPORTED_PVZ_PROFILE.id,
      executableSha256: SUPPORTED_PVZ_PROFILE.executable.sha256,
      executableVersion: '1.2.0.1073', ownerToken, supported: true,
    };
    peer.write(JSON.stringify(hello) + '\n' + JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: snapshot(),
    }) + '\n');
    const deadline = Date.now() + 2000;
    while (!inner.preHandshakeSnapshot && Date.now() < deadline) await afterTimers(1);
    expect(inner.preHandshakeSnapshot).not.toBeNull();
    await expect(bridge.command({ kind: 'snapshot' }, 100)).rejects.toThrow('握手尚未完成');
    await expect(bridge.capture(100)).rejects.toThrow('握手尚未完成');
    expect(commands).toEqual([]);
    inner.onInjectorStdout(JSON.stringify({
      ok: true, mode: 'launch', phase: 'resumed', pid: 42, ownerToken,
      creationTime: '0'.repeat(16), primaryThreadId: null, artifactDir,
    }) + '\n');
    expect((await bridge.command({ kind: 'snapshot' })).accepted).toBe(true);
    expect(commands).toEqual(['snapshot']);
  } finally {
    peer.destroy();
    await inner.teardown();
  }
});
