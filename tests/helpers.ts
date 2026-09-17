import { EventEmitter } from 'node:events';
import type {
  EventEnvelope,
  WorldHost,
  PushOptions,
} from 'cortico/core/types.ts';
import type { PvzTransport } from '../src/bridge.ts';
import { PVZ_DEFAULTS, type PvzConfigSection } from '../src/config.ts';
import { PvzWorld, type PvzWorldOptions } from '../src/world.ts';
import {
  PVZ_NATIVE_PROTOCOL,
  type PvzBoardState,
  type PvzHello,
  type PvzNativeAck,
  type PvzNativeAction,
  type PvzNativeFrame,
  type PvzNativeResult,
  type PvzSnapshot,
} from '../src/protocol.ts';

export function boardState(overrides: Partial<PvzBoardState> = {}): PvzBoardState {
  const rows = overrides.rows ?? 5;
  const columns = overrides.columns ?? 9;
  return {
    runId: 1,
    rows,
    columns,
    level: 1,
    background: 0,
    paused: false,
    sun: 150,
    cursor: { kind: 'normal', heldType: null, logicalX: 0, logicalY: 0 },
    fog: { active: false, visibilityRule: 'none' },
    disclosure: { entitiesVisible: true, phase: 'visible' },
    cells: Array.from({ length: rows }, (_, row) =>
      Array.from({ length: columns }, (_, column) => ({
        row: row + 1,
        column: column + 1,
        terrain: 'lawn' as const,
        playable: true,
        blocker: null,
        base: 'none' as const,
      }))).flat(),
    cards: [],
    plants: [],
    zombies: [],
    boss: null,
    gridItems: [],
    collectibles: [],
    mowers: Array.from({ length: 5 }, (_, row) => ({
      row: row + 1, kind: 'lawn_mower', state: 'ready' as const,
    })),
    progress: { kind: 'flags', current: 0, target: 1, stage: null, label: 'Flag 0/1' },
    tutorial: null,
    allowedSpecialActions: [],
    special: null,
    ...overrides,
  };
}

export function shovelTutorialBoard(
  phase: NonNullable<PvzBoardState['tutorial']>['phase'] = 'keep_digging',
  positions: Array<{ row: number; column: number }> = [{ row: 2, column: 4 }],
): PvzBoardState {
  const targets = new Set(positions.map(({ row, column }) => `${row}:${column}`));
  return boardState({
    level: 5,
    background: 0,
    sun: 0,
    cards: [],
    cells: Array.from({ length: 5 }, (_, row) =>
      Array.from({ length: 9 }, (_, column) => {
        const target = targets.has(`${row + 1}:${column + 1}`);
        return {
          row: row + 1,
          column: column + 1,
          terrain: 'lawn' as const,
          playable: false,
          blocker: target ? 'shovel_tutorial_target' : 'shovel_tutorial_locked',
          base: 'none' as const,
        };
      })).flat(),
    plants: positions.map(({ row, column }, index) => ({
      id: 500 + index,
      type: 0,
      name: 'peashooter',
      row,
      column,
      phase: 'idle',
      condition: 'intact' as const,
      sleeping: false,
      squished: false,
      layers: ['main'],
    })),
    zombies: [],
    gridItems: [],
    collectibles: [],
    mowers: [],
    progress: {
      kind: 'targets', current: positions.length, target: null, stage: null,
      label: `Shovel tutorial: ${positions.length} Peashooters remain`,
    },
    tutorial: {
      kind: 'shovel', phase, remainingPlants: positions.length, allowedActions: ['shovel'],
    },
    allowedSpecialActions: [],
    special: null,
  });
}

export function snapshot(overrides: Partial<PvzSnapshot> = {}): PvzSnapshot {
  return {
    protocol: PVZ_NATIVE_PROTOCOL,
    revision: 1,
    monotonicMs: 16,
    inputControl: { epoch: 0, menuContext: 0, queueDepth: 0, activeActionId: null },
    executable: {
      sha256: '9ba1c9b23ed2b240ad29a54c7b9fd55bcbfac8b7f83ddfac69f7907d7b7198ed',
      version: '1.2.0.1073',
      profile: 'goty-1.2.0.1073-zh',
      supported: true,
    },
    presentation: {
      managed: true, onScreen: true, minimized: false, clientWidth: 800, clientHeight: 600,
    },
    screen: 'main_menu',
    scene: 1,
    mode: 0,
    modeName: 'adventure',
    modeKind: 'adventure',
    profile: {
      name: 'Player',
      adventureLevel: 1,
      adventureCompletions: 0,
      coins: 0,
      minigamesUnlocked: false,
      puzzleUnlocked: false,
      survivalUnlocked: false,
    },
    lastRun: null,
    menu: [{
      id: 'adventure', label: 'Adventure', enabled: true, x: 400, y: 340,
      state: null, record: null,
    }],
    dialog: null,
    seedPicker: null,
    board: null,
    ...overrides,
  };
}

export type ActionHandler = (
  action: PvzNativeAction,
  transport: FakePvzTransport,
) => { accepted: boolean; reason?: string } | void;

export class FakePvzTransport extends EventEmitter implements PvzTransport {
  readonly artifactDir: string | null = null;
  state: PvzSnapshot;
  commands: PvzNativeAction[] = [];
  commandContexts: Array<import('../src/protocol.ts').PvzCommandContext | undefined> = [];
  stopped = false;
  helloSupported = true;
  helloReason: string | undefined;
  emitInitialOnStart = true;
  actionHandler: ActionHandler | null = null;
  nativeResult: Pick<PvzNativeResult, 'outcome' | 'reason' | 'effect' | 'batch' | 'placement'> | null = { outcome: 'executed' };
  nativeResultDelayMs = 0;
  snapshotRequests = 0;
  private commandNumber = 0;

  constructor(initial = snapshot()) {
    super();
    this.state = structuredClone(initial);
  }

  async start(): Promise<PvzHello> {
    if (this.emitInitialOnStart) this.emit('snapshot', structuredClone(this.state));
    return {
      type: 'hello',
      protocol: PVZ_NATIVE_PROTOCOL,
      pid: 4242,
      architecture: 'x86',
      profile: this.state.executable.profile,
      executableSha256: this.state.executable.sha256,
      executableVersion: this.state.executable.version,
      ownerToken: '0123456789abcdef0123456789abcdef',
      supported: this.helloSupported,
      ...(this.helloReason ? { reason: this.helloReason } : {}),
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async command(
    action: PvzNativeAction,
    _timeoutMs?: number,
    requestedId?: string,
    context?: import('../src/protocol.ts').PvzCommandContext,
  ): Promise<PvzNativeAck> {
    if (action.kind === 'snapshot') {
      this.snapshotRequests += 1;
      const id = requestedId!;
      const revision = this.state.revision;
      queueMicrotask(() => {
        this.emit('result', {
          type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id, revision, outcome: 'executed',
        } satisfies PvzNativeResult);
        this.state = { ...this.state, revision: revision + 1, monotonicMs: this.state.monotonicMs + 1 };
        this.emit('snapshot', structuredClone(this.state));
      });
      return { type: 'ack', protocol: PVZ_NATIVE_PROTOCOL, id, accepted: true };
    }
    this.commands.push(structuredClone(action));
    this.commandContexts.push(context ? structuredClone(context) : undefined);
    const id = requestedId ?? `action-${++this.commandNumber}`;
    if (requestedId) this.commandNumber += 1;
    const inputEpochBefore = this.state.inputControl.epoch;
    const result = this.actionHandler?.(action, this);
    const accepted = result?.accepted ?? true;
    if (accepted && action.kind === 'cancel' && this.state.inputControl.epoch === inputEpochBefore) {
      this.publish((draft) => {
        draft.inputControl.epoch += 1;
        draft.inputControl.queueDepth = 0;
        draft.inputControl.activeActionId = null;
        if (draft.board) {
          draft.board.cursor = {
            kind: 'normal', heldType: null,
            logicalX: draft.board.cursor.logicalX,
            logicalY: draft.board.cursor.logicalY,
          };
        }
      });
    }
    if (accepted && this.nativeResult) {
      const nativeResult = structuredClone(this.nativeResult);
      const resultRevision = this.state.revision;
      const emitResult = (): void => {
        this.emit('result', {
          type: 'result',
          protocol: PVZ_NATIVE_PROTOCOL,
          id,
          revision: resultRevision,
          outcome: nativeResult.outcome,
          ...(nativeResult.reason ? { reason: nativeResult.reason } : {}),
          ...(nativeResult.batch ? { batch: nativeResult.batch } : {}),
          ...(nativeResult.effect ? { effect: nativeResult.effect } : {}),
          ...(nativeResult.placement ? { placement: nativeResult.placement } : {}),
        } satisfies PvzNativeResult);
        if (nativeResult.outcome === 'executed' || nativeResult.outcome === 'cancelled') {
          this.publish(() => undefined);
        }
      };
      if (this.nativeResultDelayMs > 0) setTimeout(emitResult, this.nativeResultDelayMs);
      else queueMicrotask(emitResult);
    }
    return {
      type: 'ack',
      protocol: PVZ_NATIVE_PROTOCOL,
      id,
      accepted,
      ...(result?.reason ? { reason: result.reason } : {}),
    };
  }

  async capture(): Promise<PvzNativeFrame> {
    return {
      type: 'frame',
      protocol: PVZ_NATIVE_PROTOCOL,
      id: 'capture-1',
      mime: 'image/png',
      base64: 'iVBORw0KGgo=',
      width: 800,
      height: 600,
    };
  }

  publish(change: (draft: PvzSnapshot) => void, delayMs = 0): PvzSnapshot {
    const next = structuredClone(this.state);
    next.revision += 1;
    next.monotonicMs += 16;
    change(next);
    this.state = next;
    setTimeout(() => this.emit('snapshot', structuredClone(next)), delayMs);
    return next;
  }

  emitRaw(value: PvzSnapshot, delayMs = 0): void {
    setTimeout(() => this.emit('snapshot', structuredClone(value)), delayMs);
  }
}

export class FakePvzHost {
  events: Array<{ event: EventEnvelope; options?: PushOptions }> = [];
  deferred: Array<Parameters<WorldHost['pushDeferred']>[0]> = [];
  deliveryCalls: Array<{
    kind: 'event' | 'deferred';
    type: string;
    trigger?: PushOptions['trigger'];
  }> = [];
  store = {
    get: () => undefined,
    latestCursor: () => 0,
    range: () => [],
    around: () => [],
    grep: () => [],
  } as WorldHost['store'];
  modelFacts = {
    model: () => 'test',
    accepts: () => false,
    contextWindow: () => 128_000,
  };
  blob = (_handle: string): { bytes: Uint8Array; mime: string } | null => null;
  log = makeLogger();

  async pushEvent(
    value: Omit<EventEnvelope, 'cursor' | 'origin' | 'contextDelivery'> & { origin?: EventEnvelope['origin'] },
    options?: PushOptions,
  ): Promise<EventEnvelope> {
    const event = {
      ...value,
      cursor: this.events.length + 1,
      origin: value.origin ?? 'external',
    } as EventEnvelope;
    this.deliveryCalls.push({
      kind: 'event', type: event.type,
      ...(options?.trigger ? { trigger: options.trigger } : {}),
    });
    this.events.push({ event, options });
    return event;
  }

  pushDeferred(
    value: Parameters<WorldHost['pushDeferred']>[0],
    options?: Parameters<WorldHost['pushDeferred']>[1],
  ): void {
    this.deliveryCalls.push({
      kind: 'deferred', type: value.type,
      ...(options?.trigger ? { trigger: options.trigger } : {}),
    });
    this.deferred.push(value);
  }

  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }

  reportUsage(): void {}
}

export async function startWorld(
  transport: FakePvzTransport,
  config: Partial<PvzConfigSection> = {},
  options: Pick<PvzWorldOptions, 'onTransportFailure' | 'taskIdBase'> = {},
): Promise<{ world: PvzWorld; host: FakePvzHost }> {
  const host = new FakePvzHost();
  const cfg = { ...structuredClone(PVZ_DEFAULTS), actionTimeoutMs: 100, ...config };
  const world = new PvzWorld({
    cfg,
    transportFactory: () => transport,
    ...options,
  });
  await world.start(host as unknown as WorldHost);
  // Complete the initial delivery before tests begin a new event window.
  for (const event of host.deferred.splice(0)) await event.render();
  return { world, host };
}

export async function callTool(
  world: PvzWorld,
  name: string,
  args: Record<string, unknown> = {},
  round?: number,
): Promise<string> {
  const tool = world.tools().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  const result = await tool.handler(args, {
    role: 'test',
    log: makeLogger(),
    ...(round === undefined ? {} : { round }),
  });
  return typeof result === 'string' ? result : result.text;
}

export function afterTimers(delayMs = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function makeLogger(): WorldHost['log'] {
  const logger = {
    child: () => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    trace: () => {},
    emit: () => {},
  };
  return logger as WorldHost['log'];
}
