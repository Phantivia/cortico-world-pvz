import { afterEach, describe, expect, it, vi } from 'vitest';
import { boardState, FakePvzTransport, shovelTutorialBoard, snapshot } from './helpers.ts';
import { PvzRuntime, verifyAction, type PvzActionReceipt } from '../src/runtime.ts';
import {
  PVZ_NATIVE_PROTOCOL,
  type PvzNativeAction,
  type PvzPlant,
  type PvzSnapshot,
} from '../src/protocol.ts';
import { PVZ_NATIVE_TERMINAL_RESULT_BUDGET_MS } from '../src/timing.ts';

const runtimes: PvzRuntime[] = [];

it.each([true, false])('选卡动画落定后才确认选择变化（原先选中=%s）', (selected) => {
  const before = snapshot({ screen: 'seed_picker', seedPicker: {
    capacity: 6, selected: selected ? [29] : [], ready: false, previewZombies: [],
    choices: [{ id: 29, name: 'starfruit', state: selected ? 'selected' : 'chooser',
      bankSlot: selected ? 0 : null, imitates: null, recommended: true, fixed: false, x: 100, y: 150 }],
  } });
  const after = structuredClone(before);
  after.revision++;
  after.seedPicker!.selected = selected ? [] : [29];
  after.seedPicker!.choices[0]!.state = 'moving';
  expect(verifyAction({ kind: 'choose_seed', seed: 29 }, before, after)).toBeNull();
  after.revision++;
  after.seedPicker!.choices[0]!.state = selected ? 'chooser' : 'selected';
  expect(verifyAction({ kind: 'choose_seed', seed: 29 }, before, after)).not.toBeNull();
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  vi.useRealTimers();
});

async function runtimeWith(
  transport: FakePvzTransport,
  timeoutMs = 40,
  nativeResultBudgetMs = timeoutMs,
): Promise<PvzRuntime> {
  const runtime = new PvzRuntime(transport, () => timeoutMs, nativeResultBudgetMs);
  runtimes.push(runtime);
  await runtime.start();
  return runtime;
}

function whackBatchSnapshot(): PvzSnapshot {
  return snapshot({
    screen: 'board', mode: 30, modeName: 'whack_a_zombie', modeKind: 'minigame',
    board: boardState({
      allowedSpecialActions: ['whack'],
      zombies: [41, 42].map((id, index) => ({
        id, type: index ? 2 : 0, name: index ? 'conehead_zombie' : 'zombie',
        row: index + 1, column: 3, columnPosition: 3, xBand: 'near' as const, speedCellsPerSecond: 0.0,
        condition: 'intact' as const, armor: index ? 'intact' as const : 'none' as const,
        shield: 'none' as const, hypnotized: false, slowed: false, immobilized: false,
      })),
      special: {
        phase: 'active', settled: true,
        targets: [41, 42].map((id, index) => ({
          action: 'whack', kind: 'zombie' as const, id,
          slot: null, row: index + 1, column: 3,
        })),
      },
    }),
  });
}

describe('PvZ 动作验真', () => {
  it('原生动作在 5s 给出 executed 后仍等待同动作的 r+1 状态栅栏', async () => {
    vi.useFakeTimers();
    const transport = new FakePvzTransport(snapshot({
      screen: 'dialog',
      profile: null,
      menu: [{
        id: 'profile_create', label: 'Create', enabled: true,
        x: 400, y: 300, state: null, record: null,
      }],
      dialog: {
        id: 30, hasPrimary: true, hasSecondary: false,
        primaryLabel: 'OK', secondaryLabel: null,
      },
    }));
    transport.nativeResult = null;
    const command = transport.command.bind(transport);
    transport.command = async (action, timeoutMs, requestedId, context) => {
      const ack = await command(action, timeoutMs, requestedId, context);
      if (action.kind !== 'profile_create') return ack;
      setTimeout(() => {
        transport.emit('result', {
          type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: ack.id,
          revision: transport.state.revision, outcome: 'executed', effect: 'profile_created',
        });
        setTimeout(() => transport.publish((draft) => {
          draft.screen = 'main_menu';
          draft.profile = {
            name: action.name,
            adventureLevel: 1, adventureCompletions: 0, coins: 0,
            minigamesUnlocked: false, puzzleUnlocked: false, survivalUnlocked: false,
          };
          draft.menu = [{
            id: 'adventure', label: 'Adventure', enabled: true,
            x: 400, y: 340, state: null, record: null,
          }];
          draft.dialog = null;
          draft.inputControl.menuContext += 1;
        }), 50);
      }, 5000);
      return ack;
    };
    const runtime = await runtimeWith(transport, 100, 15_000);

    const pending = runtime.act(
      { kind: 'profile_create', name: 'CortiV' },
      100,
    );
    await vi.advanceTimersByTimeAsync(5100);
    const receipt = await pending;

    expect(receipt.status).toBe('verified');
    expect(receipt.evidence).toEqual(['本地玩家档案已创建并进入下一界面']);
    expect(transport.commands).toEqual([{ kind: 'profile_create', name: 'CortiV' }]);
  });

  it('17s 特殊动作仍在原生 terminal-result 包络内并等待状态栅栏', async () => {
    vi.useFakeTimers();
    const transport = new FakePvzTransport(snapshot({
      screen: 'board', mode: 43, modeName: 'zen_garden', modeKind: 'zen_garden',
      board: boardState({
        plants: [plant(80, 0)],
        allowedSpecialActions: ['zen_water'],
        special: {
          phase: 'care', settled: true,
          targets: [{
            action: 'zen_water', kind: 'plant', id: 80,
            slot: null, row: 2, column: 3,
          }],
        },
      }),
    }));
    transport.nativeResult = null;
    const command = transport.command.bind(transport);
    transport.command = async (action, timeoutMs, requestedId, context) => {
      const ack = await command(action, timeoutMs, requestedId, context);
      if (action.kind !== 'special') return ack;
      setTimeout(() => {
        transport.emit('result', {
          type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: ack.id,
          revision: transport.state.revision, outcome: 'executed', effect: 'zen_care_applied',
        });
        setTimeout(() => transport.publish(() => undefined), 50);
      }, 17_000);
      return ack;
    };
    const runtime = await runtimeWith(
      transport,
      100,
      PVZ_NATIVE_TERMINAL_RESULT_BUDGET_MS,
    );
    const action = { kind: 'special', action: 'zen_water', targetId: 80 } as const;

    const pending = runtime.act(action, 100);
    await vi.advanceTimersByTimeAsync(17_100);
    const receipt = await pending;

    expect(receipt.status).toBe('verified');
    expect(receipt.evidence).toEqual(['zen_water 已应用到可见植物 80']);
    expect(transport.commands).toEqual([action]);
  });

  it('批量收集用按光标规模扩展的原生结果包络', async () => {
    vi.useFakeTimers();
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      board: boardState({
        collectibles: [
          { id: 9, kind: 'sun', x: 300, y: 200, row: 2, column: 3 },
          { id: 10, kind: 'coin', x: 360, y: 220, row: 2, column: 4 },
        ],
      }),
    }));
    transport.nativeResult = null;
    const command = transport.command.bind(transport);
    transport.command = async (action, timeoutMs, requestedId, context) => {
      const ack = await command(action, timeoutMs, requestedId, context);
      if (action.kind !== 'collect') return ack;
      setTimeout(() => {
        transport.emit('result', {
          type: 'result', protocol: PVZ_NATIVE_PROTOCOL, id: ack.id,
          revision: transport.state.revision, outcome: 'executed', effect: 'collectibles_collected',
        });
        setTimeout(() => transport.publish((draft) => {
          draft.board!.collectibles = [];
        }), 10);
      }, 80);
      return ack;
    };
    const runtime = await runtimeWith(transport, 30, 20);
    const action: PvzNativeAction = { kind: 'collect', ids: [9, 10] };

    const pending = runtime.act(action, 100);
    await vi.advanceTimersByTimeAsync(100);
    const receipt = await pending;

    expect(receipt.status).toBe('verified');
    expect(receipt.evidence).toEqual(['目标掉落物已确认收取: 9,10']);
    expect(transport.commands).toEqual([action]);
  });

  it('批量收集保留逐目标确认与点击前消失计数', async () => {
    const batch = {
      requested: 2, attempted: 1, released: 1, verified: 1, stale: 1, scopeStopped: false,
    };
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      board: boardState({
        collectibles: [
          { id: 9, kind: 'sun', x: 300, y: 200, row: 2, column: 3 },
          { id: 10, kind: 'sun', x: 360, y: 220, row: 2, column: 4 },
        ],
      }),
    }));
    transport.nativeResult = {
      outcome: 'executed', effect: 'collectibles_collected', batch,
    };
    transport.actionHandler = (action, current) => {
      if (action.kind !== 'collect') return;
      current.publish((draft) => {
        draft.board!.collectibles = [];
        draft.board!.sun += 25;
      });
    };
    const runtime = await runtimeWith(transport, 30);

    const receipt = await runtime.act({ kind: 'collect', ids: [9, 10] });

    expect(receipt.status).toBe('verified');
    expect(receipt.batch).toEqual(batch);
    expect(receipt.evidence).toEqual([
      '植入件已确认收取 1/2 个目标；1 个目标在点击前已消失',
    ]);
  });

  it('批量收集按植入件的因果回执验真,不倒回去补发 cancel', async () => {
    const batch = {
      requested: 2, attempted: 2, released: 2, verified: 1, stale: 0, scopeStopped: false,
    };
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      board: boardState({
        collectibles: [
          { id: 9, kind: 'sun', x: 300, y: 200, row: 2, column: 3 },
          { id: 10, kind: 'sun', x: 360, y: 220, row: 2, column: 4 },
        ],
      }),
    }));
    transport.nativeResult = {
      outcome: 'executed', effect: 'collectibles_collected', batch,
    };
    transport.actionHandler = (action, current) => {
      if (action.kind === 'cancel') {
        current.nativeResult = { outcome: 'executed' };
        return;
      }
      if (action.kind !== 'collect') return;
      current.publish((draft) => {
        draft.board!.collectibles = [];
        draft.board!.sun += 25;
      });
    };
    const runtime = await runtimeWith(transport, 15);

    const receipt = await runtime.act({ kind: 'collect', ids: [9, 10] });

    expect(receipt.status).toBe('verified');
    expect(receipt.batch).toEqual(batch);
    expect(receipt.evidence).toContain('目标掉落物已经被收走');
    expect(transport.commands.map((action) => action.kind)).toEqual(['collect']);
  });

  it('已验证的锤击批次透传原生计数', async () => {
    const batch = {
      requested: 2, attempted: 2, released: 2, verified: 1, stale: 0, scopeStopped: false,
    };
    const transport = new FakePvzTransport(whackBatchSnapshot());
    transport.nativeResult = {
      outcome: 'executed', effect: 'target_changed', reason: 'verified 1/2 targets', batch,
    };
    transport.actionHandler = (action, current) => {
      if (action.kind !== 'special' || action.action !== 'whack') return;
      current.publish((draft) => {
        draft.board!.zombies = draft.board!.zombies.filter((zombie) => zombie.id !== 42);
        draft.board!.special!.targets = draft.board!.special!.targets
          .filter((target) => target.id !== 42);
      });
    };
    const runtime = await runtimeWith(transport, 30);

    const receipt = await runtime.act({ kind: 'special', action: 'whack', targetIds: [42, 41] });

    expect(receipt.status).toBe('verified');
    expect(receipt.batch).toEqual(batch);
    expect(receipt.evidence).toContain('verified 1/2 targets');
  });

  it('锤击命中未跨越可见耐久档位时仍以原生受击证据验真', async () => {
    const batch = {
      requested: 2, attempted: 2, released: 2, verified: 2, stale: 0, scopeStopped: false,
    };
    const transport = new FakePvzTransport(whackBatchSnapshot());
    transport.nativeResult = {
      outcome: 'executed', effect: 'target_changed', batch,
    };
    const runtime = await runtimeWith(transport, 30);

    const receipt = await runtime.act({
      kind: 'special', action: 'whack', targetIds: [42, 41],
    });

    expect(receipt.status).toBe('verified');
    expect(receipt.batch).toEqual(batch);
    expect(receipt.evidence).toEqual([
      '植入件已确认锤击受击 2/2',
    ]);
    expect(receipt.state).toMatchObject({
      棋盘状态: {
        僵尸: expect.arrayContaining([
          expect.stringContaining('路障僵尸在第2排第3列'),
        ]),
      },
    });
    expect(transport.commands).toEqual([{
      kind: 'special', action: 'whack', targetIds: [42, 41],
    }]);
  });

  it('快照没比出变化的锤击批次按原生因果验真,计数照旧透传', async () => {
    const batch = {
      requested: 2, attempted: 1, released: 1, verified: 0, stale: 1, scopeStopped: true,
    };
    const transport = new FakePvzTransport(whackBatchSnapshot());
    transport.nativeResult = { outcome: 'executed', effect: 'target_changed', batch };
    transport.actionHandler = (action, current) => {
      if (action.kind === 'cancel') current.nativeResult = { outcome: 'executed' };
    };
    const runtime = await runtimeWith(transport, 15);

    const receipt = await runtime.act(
      { kind: 'special', action: 'whack', targetIds: [42, 41] },
      20,
    );

    expect(receipt.status).toBe('verified');
    expect(receipt.batch).toEqual(batch);
    expect(receipt.evidence).toContain('被锤的目标出现了受击变化');
    expect(transport.commands.map((action) => action.kind)).toEqual(['special']);
  });

  it.each([
    ['rejected', 'rejected'],
    ['cancelled', 'unverified'],
  ] as const)('原生 %s 的锤击批次也透传计数', async (outcome, status) => {
    const batch = {
      requested: 2, attempted: 0, released: 0, verified: 0, stale: 1, scopeStopped: true,
    };
    const transport = new FakePvzTransport(whackBatchSnapshot());
    transport.nativeResult = { outcome, batch };
    const runtime = await runtimeWith(transport, 20);

    const receipt = await runtime.act({ kind: 'special', action: 'whack', targetIds: [42, 41] });

    expect(receipt.status).toBe(status);
    expect(receipt.batch).toEqual(batch);
  });

  it('accepted ACK 只代表受理，没有状态证据时回 unverified', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    const runtime = await runtimeWith(transport, 20);

    const receipt = await runtime.act({ kind: 'plant', slot: 0, row: 2, column: 3 });

    expect(receipt).toMatchObject({
      actionId: expect.any(String),
      status: 'unverified',
      beforeRevision: 1,
      afterRevision: expect.any(Number),
    });
    expect(receipt.evidence.join('')).toContain('没有独立状态证据');
    expect(receipt.evidence.join('')).toContain('释放内部光标');
    expect(transport.commands).toEqual([
      { kind: 'plant', slot: 0, row: 2, column: 3 },
      { kind: 'cancel' },
    ]);
  });

  it('植入件拒绝直接形成 rejected 回执', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    transport.actionHandler = () => ({ accepted: false, reason: '目标格被占用' });
    const runtime = await runtimeWith(transport);

    const receipt = await runtime.act({ kind: 'plant', slot: 0, row: 2, column: 3 });

    expect(receipt.status).toBe('rejected');
    expect(receipt.afterRevision).toBe(1);
    expect(receipt.evidence).toEqual(['目标格被占用']);
  });

  it('有状态变化但没有 executed result 时不会验真', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      board: boardState({
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
      }),
    }));
    transport.actionHandler = (action, current) => {
      if (action.kind === 'plant') {
        current.nativeResult = null;
        current.publish((draft) => {
          draft.board!.plants.push(plant(8, 0));
        });
      } else if (action.kind === 'cancel') {
        current.nativeResult = { outcome: 'executed' };
      }
    };
    const runtime = await runtimeWith(transport, 30);

    const receipt = await runtime.act({ kind: 'plant', slot: 0, row: 2, column: 3 });

    expect(receipt.status).toBe('unverified');
    expect(receipt.evidence.join('')).toContain('没有独立状态证据');
    expect(transport.commands.map((action) => action.kind)).toEqual(['plant', 'cancel']);
  });

  it('执行阶段 rejected 结果不会被同时到达的状态变化覆盖', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      board: boardState({
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
      }),
    }));
    transport.actionHandler = (action, current) => {
      if (action.kind === 'plant') {
        current.nativeResult = { outcome: 'rejected', reason: '游戏拒绝落点' };
        current.publish((draft) => {
          draft.board!.plants.push(plant(8, 0));
        });
      } else if (action.kind === 'cancel') {
        current.nativeResult = { outcome: 'executed' };
      }
    };
    const runtime = await runtimeWith(transport, 50);

    const receipt = await runtime.act({ kind: 'plant', slot: 0, row: 2, column: 3 });

    expect(receipt.status).toBe('rejected');
    expect(receipt.evidence).toContain('游戏拒绝落点');
    expect(transport.commands).toEqual([{ kind: 'plant', slot: 0, row: 2, column: 3 }]);
  });

  it('cancelled 即使邻近状态碰巧匹配也不会被当成已验真', async () => {
    const initial = snapshot({
      screen: 'board',
      board: boardState({
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
      }),
    });
    const stale = new FakePvzTransport(initial);
    stale.actionHandler = (action, current) => {
      if (action.kind === 'plant') {
        current.nativeResult = { outcome: 'cancelled', reason: 'relative planting was cancelled' };
        current.publish((draft) => {
          draft.board!.plants.push(plant(8, 0));
        }, 5);
      } else if (action.kind === 'cancel') {
        current.nativeResult = { outcome: 'executed' };
      }
    };
    const staleRuntime = await runtimeWith(stale, 40);
    expect((await staleRuntime.act({ kind: 'plant', slot: 0, row: 2, column: 3 })).status)
      .toBe('rejected');

    const partial = new FakePvzTransport(initial);
    partial.actionHandler = (action, current) => {
      if (action.kind === 'plant') {
        current.nativeResult = { outcome: 'cancelled', reason: 'relative planting was cancelled' };
        setTimeout(() => current.publish((draft) => {
          draft.board!.plants.push(plant(9, 0));
        }), 5);
      }
    };
    const partialRuntime = await runtimeWith(partial, 80);
    const receipt = await partialRuntime.act({ kind: 'plant', slot: 0, row: 2, column: 3 });
    expect(receipt.status).toBe('rejected');
    expect(partial.commands).toHaveLength(1);
  });

  it('带原因的中止是确定失败，只有原生自己说效果确证不了才算未验真', async () => {
    const initial = snapshot({
      screen: 'board',
      board: boardState({
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0,
          cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
      }),
    });
    const receiptFor = async (
      result: { outcome: 'cancelled'; reason?: string },
    ): Promise<PvzActionReceipt> => {
      const transport = new FakePvzTransport(initial);
      transport.actionHandler = (action, current) => {
        if (action.kind === 'plant') current.nativeResult = result;
        else if (action.kind === 'cancel') current.nativeResult = { outcome: 'executed' };
      };
      const runtime = await runtimeWith(transport, 40);
      return runtime.act({ kind: 'plant', slot: 0, row: 2, column: 3 });
    };

    const spent = await receiptFor({
      outcome: 'cancelled', reason: 'relative planting seed packet was already spent',
    });
    expect(spent.status).toBe('rejected');

    const unknown = await receiptFor({
      outcome: 'cancelled', reason: 'relative planting click result is unknown',
    });
    expect(unknown.status).toBe('unverified');

    const silent = await receiptFor({ outcome: 'cancelled' });
    expect(silent.status).toBe('unverified');
    expect(silent.evidence).toContain('植入件中止了这一步，但没有给出原因');
  });

  it('cancelled 回执后仅在同一棋盘仍持有内部光标时安全取消', async () => {
    const initial = snapshot({
      screen: 'board',
      board: boardState({
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
      }),
    });
    const transport = new FakePvzTransport(initial);
    transport.actionHandler = (action, current) => {
      if (action.kind === 'plant') {
        current.nativeResult = {
          outcome: 'cancelled', reason: 'relative planting cursor movement was interrupted',
        };
        current.publish((draft) => {
          draft.board!.cursor = {
            kind: 'plant', heldType: 0, logicalX: 300, logicalY: 200,
          };
        });
      } else if (action.kind === 'cancel') {
        current.nativeResult = { outcome: 'executed' };
      }
    };
    const runtime = await runtimeWith(transport, 80);

    const receipt = await runtime.act({ kind: 'plant', slot: 0, row: 2, column: 3 });
    expect(receipt.status).toBe('rejected');
    expect(receipt.evidence.join('')).toContain('已清空动作队列并释放内部光标');
    expect(transport.commands).toEqual([
      { kind: 'plant', slot: 0, row: 2, column: 3 },
      { kind: 'cancel' },
    ]);
    expect(transport.state.board!.cursor.kind).toBe('normal');
  });

  it('ACK 死线无法判定是否送达时保留预分配 action id 并返回 unverified', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    const command = transport.command.bind(transport);
    let submittedId = '';
    let first = true;
    transport.command = async (action, timeoutMs, requestedId) => {
      if (first) {
        first = false;
        submittedId = requestedId ?? '';
        throw new Error('ACK timeout');
      }
      return await command(action, timeoutMs, requestedId);
    };
    const runtime = await runtimeWith(transport);

    const receipt = await runtime.act({ kind: 'shovel', row: 1, column: 1 });

    expect(receipt).toMatchObject({ actionId: submittedId, status: 'unverified' });
    expect(submittedId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.evidence.join('')).toContain('是否送达未知');
    expect(receipt.evidence.join('')).toContain('释放内部光标');
    expect(transport.commands).toEqual([{ kind: 'cancel' }]);
  });

  it('忽略同 revision 与无关 revision，等到该动作的目标状态变化', async () => {
    const initial = snapshot({
      screen: 'board',
      board: boardState({
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
      }),
    });
    const transport = new FakePvzTransport(initial);
    const runtime = await runtimeWith(transport, 100);

    const pending = runtime.act({ kind: 'plant', slot: 0, row: 2, column: 3 });
    expect(transport.commandContexts[0]).toEqual({
      inputEpoch: 0,
      menuContext: 0,
      expectedCardType: 0,
      expectedCardImitates: null,
    });
    transport.emitRaw({
      ...structuredClone(initial),
      board: boardState({
        ...initial.board!,
        plants: [{
          id: 8, type: 0, name: 'peashooter', row: 2, column: 3,
          condition: 'intact', sleeping: false, squished: false, layers: [],
        }],
      }),
    });
    transport.publish((draft) => {
      draft.board!.sun = 175;
    }, 2);
    transport.publish((draft) => {
      draft.board!.plants.push({
        id: 8, type: 0, name: 'peashooter', row: 2, column: 3,
        condition: 'intact', sleeping: false, squished: false, layers: [],
      });
    }, 5);

    const receipt = await pending;
    expect(receipt).toMatchObject({
      status: 'verified', beforeRevision: 1, afterRevision: expect.any(Number),
    });
    expect(receipt.afterRevision).toBeGreaterThan(1);
    expect(receipt.evidence).toEqual(['第2排第3列的植物层已变化']);
  });

  it('不同动作只接受各自的可见证据', async () => {
    const initial = snapshot({
      screen: 'board',
      board: boardState({
        cursor: { kind: 'usable_seed', heldType: 0, logicalX: 200, logicalY: 100 },
        plants: [{
          id: 1, type: 0, name: 'peashooter', row: 1, column: 1,
          condition: 'intact', sleeping: false, squished: false, layers: [],
        }],
        collectibles: [{ id: 9, kind: 'sun', x: 300, y: 200, row: 2, column: 3 }],
      }),
    });
    const transport = new FakePvzTransport(initial);
    const runtime = await runtimeWith(transport, 100);

    let pending = runtime.act({ kind: 'shovel', row: 1, column: 1 });
    transport.publish((draft) => {
      draft.board!.collectibles = [];
    });
    transport.publish((draft) => {
      draft.board!.plants = [];
    }, 3);
    expect((await pending).evidence).toEqual(['第1排第1列的植物层已减少或改变']);

    pending = runtime.act({ kind: 'cancel' });
    transport.publish((draft) => {
      draft.board!.sun += 25;
    });
    transport.publish((draft) => {
      draft.board!.cursor = { kind: 'normal', heldType: null, logicalX: 200, logicalY: 100 };
      draft.inputControl.epoch += 1;
    }, 3);
    expect((await pending).evidence).toEqual(['动作队列已清空，游戏内部光标已释放持有物']);
  });

  it.each(['main_menu', 'seed_picker', 'dialog', 'award'] as const)(
    '%s 没有棋盘时以输入代次和空队列验真 cancel',
    async (screen) => {
      const transport = new FakePvzTransport(snapshot({
        screen,
        board: null,
        ...(screen === 'seed_picker' ? {
          seedPicker: {
            capacity: 1,
            selected: [],
            choices: [],
            previewZombies: [],
            ready: false,
          },
        } : {}),
      }));
      const runtime = await runtimeWith(transport);

      const receipt = await runtime.act({ kind: 'cancel' });

      expect(receipt.status).toBe('verified');
      expect(receipt.evidence).toEqual(['动作队列已清空且输入控制代次已推进']);
    },
  );

  it('棋盘仍持有内部光标时不把空队列误认成释放成功', () => {
    const before = snapshot({
      screen: 'board',
      board: boardState(),
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.inputControl.epoch += 1;
    after.board!.cursor = {
      kind: 'usable_seed', heldType: 0, logicalX: 200, logicalY: 100,
    };

    expect(verifyAction({ kind: 'cancel' }, before, after)).toBeNull();
  });

  it('锤击模式常驻锤子光标不阻塞已清空输入队列的取消验真', () => {
    const before = snapshot({
      screen: 'board',
      board: boardState({
        cursor: {
          kind: 'hammer', heldType: null, logicalX: 400, logicalY: 300,
        },
        allowedSpecialActions: ['whack'],
      }),
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.inputControl.epoch += 1;

    expect(verifyAction({ kind: 'cancel' }, before, after)).toEqual([
      '动作队列已清空且输入控制代次已推进',
    ]);
  });

  it('非锤击模式的锤子光标仍被视为未释放的持有物', () => {
    const before = snapshot({
      screen: 'board',
      board: boardState({
        cursor: {
          kind: 'hammer', heldType: null, logicalX: 400, logicalY: 300,
        },
      }),
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.inputControl.epoch += 1;

    expect(verifyAction({ kind: 'cancel' }, before, after)).toBeNull();
  });

  it('丢弃低 revision 与重复 revision，只发布单调前进的状态', async () => {
    const initial = snapshot({
      revision: 5,
      screen: 'board',
      board: boardState({ sun: 100 }),
    });
    const transport = new FakePvzTransport(initial);
    const runtime = await runtimeWith(transport);
    const published: Array<{ revision: number; before: number | null }> = [];
    runtime.on('snapshot', (after, before) => {
      published.push({ revision: after.revision, before: before?.revision ?? null });
    });

    transport.emitRaw({ ...structuredClone(initial), revision: 4, board: boardState({ sun: 999 }) });
    transport.emitRaw({ ...structuredClone(initial), revision: 5, board: boardState({ sun: 888 }) });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runtime.snapshot?.revision).toBe(5);
    expect(runtime.snapshot?.board?.sun).toBe(100);
    expect(published).toEqual([]);

    transport.emitRaw({ ...structuredClone(initial), revision: 6, board: boardState({ sun: 125 }) });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runtime.snapshot?.board?.sun).toBe(125);
    expect(published).toEqual([{ revision: 6, before: 5 }]);
  });

  it('首快照等待在 disconnect 时立即失败', async () => {
    const transport = new FakePvzTransport();
    transport.emitInitialOnStart = false;
    const runtime = new PvzRuntime(transport, () => 5000);
    runtimes.push(runtime);
    const failure = new Error('pipe closed before snapshot');

    const pending = runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    transport.emit('disconnect', failure);

    const outcome = await Promise.race([
      pending.then(() => 'resolved', (error: Error) => error.message),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 200)),
    ]);
    expect(outcome).toBe(failure.message);
  });

  it('动作验真在断开时报告 unverified，不用失效缓存声称已经释放光标', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState() }));
    const runtime = await runtimeWith(transport, 5000);
    const failure = new Error('pipe closed during action');

    const pending = runtime.act({ kind: 'plant', slot: 0, row: 2, column: 3 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    transport.emit('disconnect', failure);

    const outcome = await Promise.race([
      pending,
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 200)),
    ]);
    expect(outcome).not.toBe('still waiting');
    expect(outcome).toMatchObject({ status: 'unverified', beforeRevision: 1 });
    const evidence = typeof outcome === 'string' ? outcome : outcome.evidence.join('');
    expect(evidence).toContain(failure.message);
    expect(evidence).toContain('取消请求未获回执');
    expect(evidence).not.toContain('已清空动作队列并释放内部光标');
    expect(transport.commands).toEqual([
      { kind: 'plant', slot: 0, row: 2, column: 3 },
    ]);
  });
});

function plant(
  id: number,
  type: number,
  overrides: Partial<PvzPlant> = {},
): PvzPlant {
  return {
    id,
    type,
    name: type === 0 ? 'peashooter' : type === 1 ? 'sunflower' : 'wall_nut',
    row: 2,
    column: 3,
    condition: 'intact',
    sleeping: false,
    squished: false,
    layers: [],
    ...overrides,
  };
}

function nextSnapshot(
  before: PvzSnapshot,
  change: (draft: PvzSnapshot) => void,
): PvzSnapshot {
  const after = structuredClone(before);
  after.revision += 1;
  change(after);
  return after;
}

describe('PvZ 目标专属验真', () => {
  it.each([
    { label: '首档', beforeProfile: null },
    {
      label: '已有档案后的第二档',
      beforeProfile: {
        name: 'Player',
        adventureLevel: 8, adventureCompletions: 0, coins: 1250,
        minigamesUnlocked: true, puzzleUnlocked: false, survivalUnlocked: false,
      },
    },
  ] satisfies Array<{ label: string; beforeProfile: PvzSnapshot['profile'] }>)(
    '$label创建要求可见创建对话、原生因果回执和主菜单新档案',
    ({ beforeProfile }) => {
      const action = { kind: 'profile_create', name: 'CortiV' } as const;
      const before = snapshot({
        screen: 'dialog',
        profile: beforeProfile,
        menu: [{
          id: 'profile_create', label: 'Create', enabled: true,
          x: 400, y: 300, state: null, record: null,
        }],
        dialog: {
          id: 30, hasPrimary: true, hasSecondary: false,
          primaryLabel: 'OK', secondaryLabel: null,
        },
      });
      const after = nextSnapshot(before, (draft) => {
        draft.screen = 'main_menu';
        draft.profile = {
          name: action.name,
          adventureLevel: 1, adventureCompletions: 0, coins: 0,
          minigamesUnlocked: false, puzzleUnlocked: false, survivalUnlocked: false,
        };
        draft.menu = [{
          id: 'adventure', label: 'Adventure', enabled: true,
          x: 400, y: 340, state: null, record: null,
        }];
        draft.dialog = null;
        draft.inputControl.menuContext += 1;
      });
      expect(verifyAction(action, before, after)).toBeNull();
      expect(verifyAction(action, before, after, [], 'profile_created'))
        .toEqual(['本地玩家档案已创建并进入下一界面']);
      expect(verifyAction(action, before, nextSnapshot(after, (draft) => {
        draft.profile!.name = 'WrongProfile';
      }), [], 'profile_created')).toBeNull();
      expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
        draft.profile = after.profile;
        draft.inputControl.menuContext += 1;
      }), [], 'profile_created')).toBeNull();
    },
  );

  it('plant 不把目标格中别的植物变化或单独的资源变化当成种植成功', () => {
    const before = snapshot({
      screen: 'board',
      board: boardState({
        sun: 150,
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        plants: [plant(1, 1)],
      }),
    });
    const action = { kind: 'plant', slot: 0, row: 2, column: 3 } as const;

    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.board!.plants = [plant(2, 3)];
    }))).toBeNull();
    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.board!.plants[0].condition = 'damaged';
    }))).toBeNull();
    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.board!.cards[0].ready = false;
      draft.board!.cards[0].cooldown = 'long';
    }))).toBeNull();
    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.board!.sun -= 100;
    }))).toBeNull();
    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.board!.sun -= 100;
      draft.board!.cards[0].ready = false;
      draft.board!.plants.push(plant(3, 0, { row: 1, column: 1 }));
    }))).toBeNull();

    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.board!.plants.push(plant(3, 0));
    }))).toEqual(['第2排第3列的植物层已变化']);
  });

  it('advance 接受原生菜单语义代次变化，即使可见按钮表面不变', () => {
    const before = snapshot({
      screen: 'award',
      menu: [{ id: 'advance', label: 'Continue', enabled: true, x: 400, y: 500, state: null, record: null }],
    });
    const after = nextSnapshot(before, (draft) => {
      draft.inputControl.menuContext += 1;
    });

    expect(verifyAction({ kind: 'menu', target: 'advance' }, before, after))
      .toEqual(['当前标题、奖励或对话步骤已推进']);
  });

  it('place_zombie 只接受目标格新实体，不把错格投放与资源消耗当成成功', () => {
    const before = snapshot({
      screen: 'board', mode: 61,
      board: boardState({
        sun: 150,
        cards: [{
          slot: 0, type: 0, name: 'zombie', imitates: null, cost: 50,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        allowedSpecialActions: ['place_zombie'],
        special: {
          phase: 'ready', settled: true,
          targets: [
            { action: 'place_zombie', kind: 'card', id: null, slot: 0, row: null, column: null },
            { action: 'place_zombie', kind: 'cell', id: null, slot: 0, row: 2, column: 8 },
          ],
        },
      }),
    });
    const action = { kind: 'special', action: 'place_zombie', slot: 0, row: 2, column: 8 } as const;
    const wrongCell = nextSnapshot(before, (draft) => {
      draft.board!.sun -= 50;
      draft.board!.cards[0].ready = false;
      draft.board!.zombies.push({
        id: 42, type: 0, name: 'zombie', row: 2, column: 7, columnPosition: 7, xBand: 'far', speedCellsPerSecond: 0.0,
        condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
        slowed: false, immobilized: false,
      });
    });
    expect(verifyAction(action, before, wrongCell)).toBeNull();

    const exactCell = nextSnapshot(before, (draft) => {
      draft.board!.zombies.push({
        id: 43, type: 0, name: 'zombie', row: 2, column: 8, columnPosition: 8, xBand: 'far', speedCellsPerSecond: 0.0,
        condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
        slowed: false, immobilized: false,
      });
    });
    expect(verifyAction(action, before, exactCell))
      .toEqual(['已在第2排第8列放下僵尸卡']);
  });

  it('shovel 只接受目标格植物占用层数减少', () => {
    const before = snapshot({
      screen: 'board',
      board: boardState({ plants: [plant(1, 0, { layers: ['pumpkin'] })] }),
    });
    const action = { kind: 'shovel', row: 2, column: 3 } as const;

    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.board!.plants = [plant(2, 1, { layers: ['pumpkin'] })];
    }))).toBeNull();
    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.board!.plants[0].condition = 'critical';
    }))).toBeNull();
    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.board!.plants.push(plant(2, 1));
    }))).toBeNull();

    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.board!.plants[0].layers = [];
    }))).toEqual(['第2排第3列的植物层已减少或改变']);
  });

  it('最后一次教程铲除以原生移除证据和 1-5 对话转场验真', () => {
    const before = snapshot({
      screen: 'board', scene: 2, mode: 0, menu: [],
      board: shovelTutorialBoard('keep_digging', [{ row: 2, column: 3 }]),
    });
    const action = { kind: 'shovel', row: 2, column: 3 } as const;
    const after = nextSnapshot(before, (draft) => {
      draft.screen = 'dialog';
      draft.scene = 2;
      draft.board = null;
      draft.menu = [{
        id: 'advance', label: 'Continue Dave dialogue', enabled: true,
        x: 400, y: 300, state: null, record: null,
      }];
      draft.dialog = {
        id: 2410, hasPrimary: true, hasSecondary: false,
        primaryLabel: 'Continue', secondaryLabel: null,
      };
      draft.inputControl.menuContext += 1;
    });

    expect(verifyAction(action, before, after)).toBeNull();
    expect(verifyAction(action, before, after, [], 'shovel_applied')).toEqual([
      '第2排第3列的最后一株教程植物已铲除，教程对话已继续',
    ]);

    const unrelated = structuredClone(after);
    unrelated.mode = 17;
    expect(verifyAction(action, before, unrelated, [], 'shovel_applied')).toBeNull();
  });

  it('menu 忽略目标仍在时的无关 screen、dialog 与棋盘状态变化', () => {
    const before = snapshot({
      screen: 'main_menu',
      menu: [{ id: 'adventure', label: 'Adventure', enabled: true, x: 400, y: 340, state: null, record: null }],
    });
    const action = { kind: 'menu', target: 'adventure' } as const;

    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.screen = 'dialog';
      draft.dialog = {
        id: 99,
        hasPrimary: true,
        hasSecondary: false,
        primaryLabel: 'OK',
        secondaryLabel: null,
      };
    }))).toBeNull();

    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.screen = 'seed_picker';
      draft.menu = [];
    }))).toEqual(['菜单目标 adventure 已离开当前交互状态']);
  });

  it('menu 接受主菜单整排置灰:目标还在列表里但已不可点', () => {
    const item = (
      id: string, label: string, enabled: boolean,
      state: PvzSnapshot['menu'][number]['state'] = null,
    ): PvzSnapshot['menu'][number] => ({ id, label, enabled, x: 400, y: 340, state, record: null });
    const before = snapshot({
      screen: 'main_menu',
      menu: [
        item('adventure', 'Adventure', true),
        item('minigame', 'Mini-games', true),
        item('puzzle', 'Puzzle', false, 'locked'),
        item('change_user', 'Change user', true),
      ],
    });
    const action = { kind: 'menu', target: 'adventure' } as const;

    // 关卡要过十几秒才载出来;点中的当下只有这一排按钮被置灰,minigame 直接不再列出。
    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.menu = [
        item('adventure', 'Adventure', false),
        item('puzzle', 'Puzzle', false, 'locked'),
        item('change_user', 'Change user', false),
      ];
    }))).toEqual(['菜单目标 adventure 已离开当前交互状态']);

    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.menu[1] = item('minigame', 'Mini-games', false);
    }))).toBeNull();

    const alreadyDisabled = snapshot({
      screen: 'main_menu',
      menu: [item('adventure', 'Adventure', false)],
    });
    expect(verifyAction(action, alreadyDisabled, nextSnapshot(alreadyDisabled, (draft) => {
      draft.menu = [];
    }))).toBeNull();
  });

  it('interact 同样接受目标被置灰,不接受别处的界面变化', () => {
    const before = snapshot({
      screen: 'main_menu',
      menu: [
        { id: 'almanac', label: 'Almanac', enabled: true, x: 700, y: 520, state: null, record: null },
        { id: 'options', label: 'Options', enabled: true, x: 620, y: 520, state: null, record: null },
      ],
    });
    const action = { kind: 'interact', target: 'almanac' } as const;

    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.menu[0].enabled = false;
    }))).toEqual(['交互目标 almanac 已完成并离开当前状态']);

    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.menu[1].enabled = false;
      draft.inputControl.menuContext += 1;
    }))).toBeNull();
  });

  it.each(['restart', 'main_menu'] as const)('%s 打开对应确认框后保留确认步骤', (target) => {
    const before = snapshot({
      screen: 'dialog',
      menu: [{ id: target, label: target, enabled: true, x: 400, y: 400, state: null, record: null }],
      dialog: null,
      board: boardState({ paused: true }),
    });
    const confirmation = nextSnapshot(before, (draft) => {
      draft.dialog = {
        id: 42, hasPrimary: true, hasSecondary: true,
        primaryLabel: target, secondaryLabel: 'cancel',
      };
    });
    const action = { kind: 'menu', target } as const;
    expect(verifyAction(action, before, confirmation))
      .toEqual([`${target} 已打开确认对话，等待确认`]);
    expect(verifyAction(action, confirmation, nextSnapshot(confirmation, () => {}))).toBeNull();
    expect(verifyAction(action, before, nextSnapshot(confirmation, (draft) => {
      draft.dialog!.primaryLabel = 'confirm';
    }))).toBeNull();
  });

  it('restart 结束确认步骤要求新的关卡运行', () => {
    const before = snapshot({
      screen: 'defeat',
      menu: [{ id: 'restart', label: 'Restart', enabled: true, x: 400, y: 400, state: null, record: null }],
      board: boardState({ runId: 4 }),
    });
    const action = { kind: 'menu', target: 'restart' } as const;
    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.board!.progress.current = 0;
    }))).toBeNull();
    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.screen = 'board';
      draft.menu = [];
      draft.board!.runId = 5;
    }))).toEqual(['当前关卡已重新载入']);
  });

  it('collect 只认请求中的掉落物消失，不认无关阳光或档案自增', () => {
    const before = snapshot({
      screen: 'board',
      profile: {
        name: 'Player',
        adventureLevel: 1,
        adventureCompletions: 0,
        coins: 10,
        minigamesUnlocked: false,
        puzzleUnlocked: false,
        survivalUnlocked: false,
      },
      board: boardState({
        sun: 100,
        collectibles: [{ id: 9, kind: 'sun', x: 300, y: 200, row: 2, column: 3 }],
      }),
    });
    const action: PvzNativeAction = { kind: 'collect', ids: [9] };

    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.board!.sun += 50;
      draft.profile!.coins += 10;
    }))).toBeNull();
    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.board!.collectibles = [];
    }))).toBeNull();
    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.board!.collectibles = [];
    }), [], 'collectibles_collected')).toEqual(['目标掉落物已确认收取: 9']);
  });

  it.each([
    'mode_selector', 'seed_picker', 'main_menu', 'credits', 'award', 'dialog',
  ] as const)('终局奖励收取在胜利身份关联时接受推进到 %s', (screen) => {
    const before = snapshot({
      screen: 'board',
      lastRun: { resultId: 3, runId: 1, mode: 0, level: 1, outcome: 'won' },
      board: boardState({
        collectibles: [{ id: 12, kind: 'trophy', x: 400, y: 300, row: null, column: null }],
      }),
    });
    const after = nextSnapshot(before, (draft) => {
      draft.screen = screen;
      draft.board = null;
    });
    const action: PvzNativeAction = { kind: 'collect', ids: [12] };

    expect(verifyAction(action, before, after)).toBeNull();
    expect(verifyAction(action, before, after, [], 'collectibles_collected'))
      .toEqual([`目标掉落物已确认收取并推进到 ${screen}: 12`]);
  });

  it('同一棋盘上的对话叠层不能替代掉落物收取证据', () => {
    const before = snapshot({
      screen: 'board',
      lastRun: { resultId: 3, runId: 8, mode: 0, level: 4, outcome: 'won' },
      board: boardState({
        runId: 8,
        level: 4,
        collectibles: [{ id: 12, kind: 'trophy', x: 400, y: 300, row: null, column: null }],
      }),
    });
    const dialogOverlay = nextSnapshot(before, (draft) => {
      draft.screen = 'dialog';
      draft.dialog = {
        id: 1,
        hasPrimary: true,
        hasSecondary: false,
        primaryLabel: 'Continue',
        secondaryLabel: null,
      };
    });

    expect(verifyAction(
      { kind: 'collect', ids: [12] }, before, dialogOverlay, [], 'collectibles_collected',
    )).toBeNull();

    const nextRun = nextSnapshot(before, (draft) => {
      draft.screen = 'seed_picker';
      draft.board!.runId = 9;
      draft.board!.level = 5;
      draft.board!.collectibles = [];
    });
    expect(verifyAction(
      { kind: 'collect', ids: [12] }, before, nextRun, [], 'collectibles_collected',
    )).toEqual(['目标掉落物已确认收取并推进到 seed_picker: 12']);
  });

  it('普通换屏或不匹配的终局结果不能形成收集成功证据', () => {
    const before = snapshot({
      screen: 'board',
      board: boardState({
        runId: 8, level: 4,
        collectibles: [
          { id: 9, kind: 'sun', x: 300, y: 200, row: 2, column: 3 },
          { id: 12, kind: 'trophy', x: 400, y: 300, row: null, column: null },
        ],
      }),
    });
    const noResult = nextSnapshot(before, (draft) => {
      draft.screen = 'award';
      draft.board = null;
    });
    expect(verifyAction(
      { kind: 'collect', ids: [9] }, before, noResult, [], 'collectibles_collected',
    )).toBeNull();
    expect(verifyAction(
      { kind: 'collect', ids: [12] }, before, noResult, [], 'collectibles_collected',
    )).toBeNull();

    const wrongRun = nextSnapshot(before, (draft) => {
      draft.screen = 'award';
      draft.lastRun = { resultId: 1, runId: 7, mode: 0, level: 4, outcome: 'won' };
      draft.board = null;
    });
    expect(verifyAction(
      { kind: 'collect', ids: [12] }, before, wrongRun, [], 'collectibles_collected',
    )).toBeNull();

    const newlyWon = nextSnapshot(before, (draft) => {
      draft.screen = 'award';
      draft.lastRun = { resultId: 1, runId: 8, mode: 0, level: 4, outcome: 'won' };
      draft.board = null;
    });
    expect(verifyAction(
      { kind: 'collect', ids: [12] }, before, newlyWon, [], 'collectibles_collected',
    )).toEqual(['目标掉落物已确认收取并推进到 award: 12']);
  });

  it('棋盘切换和黑暗披露不会形成实体消失证据', () => {
    const before = snapshot({
      screen: 'board',
      board: boardState({
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        plants: [plant(1, 0)],
        collectibles: [{ id: 9, kind: 'sun', x: 300, y: 200, row: 2, column: 3 }],
        gridItems: [{ id: 7, kind: 'vase', row: 2, column: 3 }],
        allowedSpecialActions: ['break_vase'],
        special: {
          phase: 'ready', settled: true,
          targets: [{
            action: 'break_vase', kind: 'grid_item', id: 7, slot: null, row: 2, column: 3,
          }],
        },
      }),
    });
    const changedRun = nextSnapshot(before, (draft) => {
      draft.board!.runId += 1;
      draft.board!.plants = [];
      draft.board!.collectibles = [];
      draft.board!.gridItems = [];
      draft.board!.allowedSpecialActions = [];
      draft.board!.special = null;
    });
    const dark = nextSnapshot(before, (draft) => {
      draft.board!.disclosure = { entitiesVisible: false, phase: 'dark' };
      draft.board!.plants = [];
      draft.board!.collectibles = [];
      draft.board!.gridItems = [];
      draft.board!.allowedSpecialActions = [];
      draft.board!.special = null;
    });

    expect(verifyAction({ kind: 'plant', slot: 0, row: 2, column: 3 }, before, changedRun)).toBeNull();
    expect(verifyAction({ kind: 'shovel', row: 2, column: 3 }, before, changedRun)).toBeNull();
    expect(verifyAction({ kind: 'collect', ids: [9] }, before, dark)).toBeNull();
    expect(verifyAction({
      kind: 'special', action: 'break_vase', targetId: 7, row: 2, column: 3,
    }, before, dark)).toBeNull();
  });

  it('特殊动作不把传送带轮换、自然退场或持有物过期当成命中', () => {
    const bowling = snapshot({
      screen: 'board', mode: 17,
      board: boardState({
        cards: [{
          slot: 0, type: 3, name: 'wall_nut', imitates: null, cost: null,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        allowedSpecialActions: ['bowling'],
        special: {
          phase: 'ready', settled: true,
          targets: [
            { action: 'bowling', kind: 'card', id: null, slot: 0, row: null, column: null },
            { action: 'bowling', kind: 'cell', id: null, slot: null, row: 2, column: 3 },
          ],
        },
      }),
    });
    expect(verifyAction({
      kind: 'special', action: 'bowling', slot: 0, row: 2, column: 3,
    }, bowling, nextSnapshot(bowling, (draft) => {
      draft.board!.cards[0].type = 1;
      draft.board!.cards[0].name = 'sunflower';
    }))).toBeNull();

    const whack = snapshot({
      screen: 'board', mode: 30,
      board: boardState({
        zombies: [{
          id: 41, type: 0, name: 'zombie', row: 3, column: 5, columnPosition: 5, xBand: 'lawn', speedCellsPerSecond: 0.0,
          condition: 'intact', armor: 'none', shield: 'none', hypnotized: false,
          slowed: false, immobilized: false,
        }],
        allowedSpecialActions: ['whack'],
        special: {
          phase: 'ready', settled: true,
          targets: [{
            action: 'whack', kind: 'zombie', id: 41, slot: null, row: 3, column: 5,
          }],
        },
      }),
    });
    expect(verifyAction({
      kind: 'special', action: 'whack', targetId: 41, row: 3, column: 5,
    }, whack, nextSnapshot(whack, (draft) => {
      draft.board!.zombies = [];
      draft.board!.allowedSpecialActions = [];
      draft.board!.special = null;
    }))).toBeNull();
    expect(verifyAction({
      kind: 'special', action: 'whack', targetId: 41, row: 3, column: 5,
    }, whack, nextSnapshot(whack, (draft) => {
      draft.board!.zombies = [];
      draft.board!.allowedSpecialActions = [];
      draft.board!.special = null;
    }), [], 'target_changed')).toEqual(['第3排第5列的目标僵尸状态已变化']);

    const whackBatch = structuredClone(whack);
    whackBatch.board!.zombies.push({
      id: 42, type: 2, name: 'conehead_zombie', row: 1, column: 3, columnPosition: 3, xBand: 'near', speedCellsPerSecond: 0.0,
      condition: 'intact', armor: 'intact', shield: 'none', hypnotized: false,
      slowed: false, immobilized: false,
    });
    whackBatch.board!.special!.targets.push({
      action: 'whack', kind: 'zombie', id: 42, slot: null, row: 1, column: 3,
    });
    expect(verifyAction({
      kind: 'special', action: 'whack', targetIds: [42, 41],
    }, whackBatch, nextSnapshot(whackBatch, (draft) => {
      draft.board!.zombies = draft.board!.zombies.filter((zombie) => zombie.id !== 42);
      draft.board!.special!.targets = draft.board!.special!.targets
        .filter((target) => target.id !== 42);
    }), [], 'target_changed')).toEqual([
      '当前锤击批次观察到 1/2 个目标状态变化',
    ]);

    const raining = snapshot({
      screen: 'board', mode: 19,
      board: boardState({
        cursor: { kind: 'usable_seed', heldType: 0, logicalX: 200, logicalY: 100 },
        allowedSpecialActions: ['launch'],
        special: {
          phase: 'packet_held', settled: true,
          targets: [{
            action: 'launch', kind: 'cell', id: null, slot: null, row: 2, column: 3,
          }],
        },
      }),
    });
    expect(verifyAction({
      kind: 'special', action: 'launch', row: 2, column: 3,
    }, raining, nextSnapshot(raining, (draft) => {
      draft.board!.cursor = { kind: 'normal', heldType: null, logicalX: 200, logicalY: 100 };
      draft.board!.allowedSpecialActions = [];
      draft.board!.special = null;
    }))).toBeNull();
  });

  it('冒险 1-5 坚果保龄球只接受原生已验证的发射，卡槽自然轮换不算成功', () => {
    const before = snapshot({
      screen: 'board', scene: 3, mode: 0,
      board: boardState({
        level: 5,
        cards: [{
          slot: 0, type: 3, name: 'wall_nut', imitates: null, cost: null,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        allowedSpecialActions: ['bowling'],
        special: {
          phase: 'ready', settled: true,
          targets: [
            { action: 'bowling', kind: 'card', id: null, slot: 0, row: null, column: null },
            { action: 'bowling', kind: 'cell', id: null, slot: null, row: 3, column: 2 },
          ],
        },
      }),
    });
    const rotated = nextSnapshot(before, (draft) => {
      draft.board!.cards[0] = {
        slot: 0, type: 4, name: 'potato_mine', imitates: null, cost: null,
        ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
      };
    });
    const action = {
      kind: 'special', action: 'bowling', slot: 0, row: 3, column: 2,
    } as const;

    expect(verifyAction(action, before, rotated)).toBeNull();
    expect(verifyAction(action, before, rotated, [], 'card_consumed')).toBeNull();
    expect(verifyAction(action, before, rotated, [], 'bowling_launched'))
      .toEqual(['bowling 后目标卡槽或滚动坚果状态已变化']);
  });

  it('冒险 1-10 传送带种植按可见落点验真并保持零阳光语义', () => {
    const before = snapshot({
      screen: 'board', scene: 3, mode: 0,
      board: boardState({
        level: 10,
        sun: 0,
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: null,
          ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
      }),
    });
    const placed = nextSnapshot(before, (draft) => {
      draft.board!.plants.push(plant(100, 0, { row: 4, column: 2 }));
      draft.board!.cards[0] = {
        slot: 0, type: 1, name: 'sunflower', imitates: null, cost: null,
        ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
      };
    });

    expect(verifyAction({ kind: 'plant', slot: 0, row: 4, column: 2 }, before, placed,
      [], 'card_consumed')).toEqual(['第4排第2列的植物层已变化']);
    expect(before.board?.sun).toBe(0);
    expect(before.board?.cards[0]?.cost).toBeNull();
  });

  it('雾中 usable-seed 只在原生因果回执与光标释放同时成立时验真', () => {
    const board = boardState({
      fog: { active: true, visibilityRule: 'rendered_fog' },
      cursor: { kind: 'usable_seed', heldType: 0, logicalX: 200, logicalY: 100 },
      allowedSpecialActions: ['launch'],
      special: {
        phase: 'held_seed', settled: true,
        targets: [{
          action: 'launch', kind: 'cell', id: null, slot: null, row: 2, column: 8,
        }],
      },
    });
    const cell = board.cells.find((item) => item.row === 2 && item.column === 8)!;
    cell.playable = null;
    cell.blocker = 'fog_hidden';
    cell.base = 'unknown';
    const before = snapshot({ screen: 'board', mode: 51, board });
    const after = nextSnapshot(before, (draft) => {
      draft.board!.cursor = { kind: 'normal', heldType: null, logicalX: 300, logicalY: 200 };
      draft.board!.allowedSpecialActions = [];
      draft.board!.special = null;
    });
    const action = { kind: 'special', action: 'launch', row: 2, column: 8 } as const;

    expect(verifyAction(action, before, after)).toBeNull();
    expect(verifyAction(action, before, after, [], 'usable_seed_consumed'))
      .toEqual(['已把可用植物包用在雾里的第2排第8列（那一格里有什么仍然看不见）']);

    const wrongCell = nextSnapshot(before, (draft) => {
      draft.board!.cursor = { kind: 'normal', heldType: null, logicalX: 300, logicalY: 200 };
      draft.board!.plants.push(plant(88, 0, { row: 3, column: 3 }));
    });
    expect(verifyAction(action, before, wrongCell, [wrongCell], 'usable_seed_consumed')).toBeNull();
  });

  it.each([
    'zen_water',
    'zen_fertilize',
    'zen_bug_spray',
    'zen_phonograph',
    'zen_chocolate',
  ])('%s 仅凭专属因果回执验证动作前存在的可见植物目标', (careAction) => {
    const before = snapshot({
      screen: 'board', mode: 43, modeName: 'zen_garden', modeKind: 'zen_garden',
      board: boardState({
        plants: [plant(80, 0)],
        allowedSpecialActions: [careAction],
        special: {
          phase: 'care', settled: true,
          targets: [{
            action: careAction, kind: 'plant', id: 80, slot: null, row: 2, column: 3,
          }],
        },
      }),
    });
    const after = nextSnapshot(before, () => undefined);
    const action = { kind: 'special', action: careAction, targetId: 80 } as const;

    expect(verifyAction(action, before, after)).toBeNull();
    expect(verifyAction(action, before, after, [], 'target_changed')).toBeNull();
    expect(verifyAction(action, before, after, [], 'zen_care_applied'))
      .toEqual([`${careAction} 已应用到可见植物 80`]);
    expect(verifyAction({ ...action, targetId: 81 }, before, after, [], 'zen_care_applied'))
      .toBeNull();
  });

  it('zen_next_garden 在同棋盘运行早退前验证原生因果与公开花园切换', () => {
    const before = snapshot({
      screen: 'board', mode: 43, modeName: 'zen_garden', modeKind: 'zen_garden',
      board: boardState({
        runId: 4, background: 7,
        allowedSpecialActions: ['zen_next_garden'],
        special: {
          phase: 'care', settled: true,
          targets: [{
            action: 'zen_next_garden', kind: 'cell', id: null, slot: null,
            row: null, column: null,
          }],
        },
      }),
    });
    const changed = nextSnapshot(before, (draft) => {
      draft.board!.runId = 5;
      draft.board!.background = 6;
    });
    const action = { kind: 'special', action: 'zen_next_garden' } as const;

    expect(verifyAction(action, before, changed)).toBeNull();
    expect(verifyAction(action, before, changed, [], 'garden_changed'))
      .toEqual(['禅境花园已切换到新的公开棋盘状态']);
    expect(verifyAction(action, before, nextSnapshot(before, () => undefined), [], 'garden_changed'))
      .toBeNull();
    expect(verifyAction(action, before, nextSnapshot(before, (draft) => {
      draft.screen = 'award';
      draft.board = null;
    }), [], 'garden_changed')).toBeNull();

    const cellOnly = structuredClone(before);
    cellOnly.board!.special!.targets[0].row = 2;
    cellOnly.board!.special!.targets[0].column = 3;
    expect(verifyAction(action, cellOnly, changed, [], 'garden_changed')).toBeNull();
  });

  it('tree_feed 只用合法全局目标和专属因果回执验真', () => {
    const before = snapshot({
      screen: 'board', mode: 50, modeName: 'tree_of_wisdom', modeKind: 'tree_of_wisdom',
      board: boardState({
        background: 6,
        allowedSpecialActions: ['tree_feed'],
        special: {
          phase: 'tree', settled: true,
          targets: [{
            action: 'tree_feed', kind: 'cell', id: null, slot: null,
            row: null, column: null,
          }],
        },
      }),
    });
    const after = nextSnapshot(before, () => undefined);
    const action = { kind: 'special', action: 'tree_feed' } as const;

    expect(verifyAction(action, before, after)).toBeNull();
    expect(verifyAction(action, before, after, [], 'garden_changed')).toBeNull();
    const evidence = verifyAction(action, before, after, [], 'tree_fed');
    expect(evidence).toEqual(['智慧树已完成一次喂养']);
    expect(evidence!.join('')).not.toMatch(/height|树高/i);

    const cellOnly = structuredClone(before);
    cellOnly.board!.special!.targets[0].row = 1;
    cellOnly.board!.special!.targets[0].column = 1;
    expect(verifyAction(action, cellOnly, after, [], 'tree_fed')).toBeNull();
  });
});

describe('PvZ 版本拒绝', () => {
  it('握手声明未知版本时停止传输并拒绝启动', async () => {
    const transport = new FakePvzTransport(snapshot({
      executable: {
        sha256: 'unknown', version: '9.9.9', profile: 'unknown-build', supported: false,
      },
    }));
    transport.helloSupported = false;
    transport.helloReason = 'SHA-256 不在受支持清单';
    const runtime = new PvzRuntime(transport, () => 20);

    await expect(runtime.start()).rejects.toThrow('PvZ 版本不受支持');
    expect(transport.stopped).toBe(true);
  });

  it('握手与首快照的版本支持状态不一致时拒绝启动', async () => {
    const transport = new FakePvzTransport(snapshot({
      screen: 'board',
      executable: {
        sha256: 'unknown', version: '9.9.9', profile: 'unknown-build', supported: false,
      },
      board: boardState(),
    }));
    const runtime = new PvzRuntime(transport, () => 20);
    runtimes.push(runtime);

    await expect(runtime.start()).rejects.toThrow('首快照的可执行文件身份');
    expect(transport.commands).toEqual([]);
    expect(transport.stopped).toBe(true);
  });
});
