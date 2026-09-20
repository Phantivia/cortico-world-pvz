import { afterEach, describe, expect, it, vi } from 'vitest';
import { PvzExecutor, renderPvzQueue, type PvzTaskReport } from '../src/executor.ts';
import { parsePvzDo, type PvzDoStep } from '../src/skills.ts';
import { afterTimers, boardState, callTool, FakePvzTransport, snapshot, startWorld } from './helpers.ts';
import { parsePvzArm, PvzTriggerTable } from '../src/triggers.ts';

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
  it('fires two packet rescues as new drops arrive and resolves enemies after pickup', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', mode: 58, menu: [], board: boardState() }));
    let nextPlantId = 100;
    transport.actionHandler = (action, fake) => {
      if (action.kind === 'collect') {
        fake.nativeResult = { outcome: 'executed', effect: 'collectibles_collected' };
        fake.publish(draft => {
          const board = draft.board!;
          board.collectibles = [];
          board.cursor = { kind: 'usable_seed', heldType: 17, logicalX: 300, logicalY: 200 };
          board.zombies[0]!.column = 3;
          board.zombies[0]!.columnPosition = 2.8;
          board.allowedSpecialActions = ['launch'];
          board.special = { phase: 'packet_held', settled: true, targets: [1, 2, 3, 4].map(column => ({
            action: 'launch', kind: 'cell', id: null, slot: null, row: 2, column,
          })) };
        });
      } else if (action.kind === 'special' && action.action === 'launch') {
        fake.nativeResult = { outcome: 'executed', effect: 'usable_seed_consumed' };
        fake.publish(draft => {
          const board = draft.board!;
          board.plants = [{ id: nextPlantId++, type: 17, name: 'squash', row: action.row!, column: action.column!,
            phase: 'idle', condition: 'intact', sleeping: false, squished: false, layers: [] }];
          board.cursor = { kind: 'normal', heldType: null, logicalX: 100, logicalY: 100 };
          board.allowedSpecialActions = [];
          board.special = null;
        });
      }
    };
    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_arm', {
        when: { all: [{ collectible: { kind: 'usable_seed', plant: 'squash' } }, { zombie: { row: 2, maxColumn: 5 } }] },
        steps: [{ skill: 'collect', what: 'usable_seed', plant: 'squash' },
          { skill: 'special', action: 'launch', placement: { row: 2, aheadOf: 'nearest_hostile', minGap: 1 } }],
        queue: 'append', maxFirings: 2,
      })).toContain('已武装');
      expect(transport.state.board!.plants).toEqual([]);
      for (const id of [1, 2]) {
        transport.publish(draft => {
          draft.board!.collectibles = [{ id, kind: 'usable_seed', containedType: 17, containedName: 'squash', x: 300, y: 200, row: 2, column: 4 }];
          draft.board!.zombies = [{ id, type: 18, name: 'pogo', row: 2, column: 5, columnPosition: 4.6,
            xBand: 'mid', speedCellsPerSecond: 0.5, phase: 'pogo_bouncing', condition: 'intact',
            armor: 'none', shield: 'none', hypnotized: false, slowed: false, immobilized: false }];
          draft.board!.plants = [];
        });
        await afterTimers(180);
        expect(transport.state.board!.plants.map(plant => [plant.name, plant.row, plant.column])).toEqual([['squash', 2, 2]]);
        expect(transport.state.board!.collectibles).toEqual([]);
      }
      expect(host.events.filter(({ event }) => event.type === 'pvz.trigger' && event.text.includes('打响'))).toHaveLength(2);
    } finally { await world.stop(); }
  });

  it('waits for later packets without spending firings or consuming another trigger reservation', async () => {
    const card = { slot: 0, type: 14, name: 'ice_shroom', imitates: null, cost: null, ready: true,
      affordable: true, cooldown: 'ready' as const, cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0,
      x: 150, y: 40 };
    const transport = new FakePvzTransport(snapshot({ screen: 'board', mode: 35, menu: [],
      board: boardState({ background: 5, cards: [],
        boss: { phase: 'boss_aiming', immobilized: false, projectile: null },
      }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'plant') return;
      fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
      fake.publish(draft => {
        draft.board!.cards = draft.board!.cards.filter(item => item.slot !== action.slot)
          .map((item, slot) => ({ ...item, slot }));
        draft.board!.boss!.immobilized = true;
      });
    };
    const { world, host } = await startWorld(transport);
    const steps = [{ skill: 'plant', plant: 'ice_shroom', row: 2, column: 3 }];
    try {
      const response = await callTool(world, 'pvz_arm', {
        when: { boss: { vulnerable: true, immobilized: false } },
        steps, maxFirings: 2, waitForCards: true,
      });
      expect(response).toContain('缺卡等待');
      await afterTimers(30);
      expect(await callTool(world, 'pvz_queue')).toContain('剩余2/2次');
      expect(host.events.some(({ event }) => event.type === 'pvz.trigger')).toBe(false);

      transport.publish(draft => { draft.board!.cards = [{ ...card, ready: false }]; });
      await afterTimers(30);
      expect(transport.state.board!.boss!.immobilized).toBe(false);
      expect(await callTool(world, 'pvz_arm', { when: { sun: { min: 9000 } }, steps }))
        .toContain('已武装');
      transport.publish(draft => { draft.board!.cards[0]!.ready = true; });
      await afterTimers(30);
      expect(transport.state.board!.boss!.immobilized).toBe(false);
      expect(await callTool(world, 'pvz_queue')).toContain('剩余2/2次');
      expect(await callTool(world, 'pvz_observe')).toContain('寒冰菇：可新排0张（已安排1张）');

      for (const remaining of [1, 0]) {
        transport.publish(draft => { draft.board!.boss!.immobilized = false; });
        await afterTimers(30);
        expect(transport.state.board!.cards).toHaveLength(1);
        transport.publish(draft => { draft.board!.cards.push({ ...card, slot: 1 }); });
        await afterTimers(150);
        expect(transport.state.board!.boss!.immobilized).toBe(true);
        expect(transport.state.board!.cards).toHaveLength(1);
        expect(await callTool(world, 'pvz_queue')).toContain('寒冰菇：可新排0张（已安排1张）');
        if (remaining) expect(await callTool(world, 'pvz_queue')).toContain('剩余1/2次');
      }
      expect(host.events.filter(({ event }) => event.type === 'pvz.trigger' && event.text.includes('打响')))
        .toHaveLength(2);
      expect(await callTool(world, 'pvz_queue')).not.toContain('缺卡等待');
      transport.publish(draft => {
        draft.board!.boss!.immobilized = false;
        draft.board!.cards.push({ ...card, slot: 1 });
      });
      await afterTimers(30);
      expect(transport.state.board!.cards).toHaveLength(2);
    } finally { await world.stop(); }
  });

  it('does not spend a scarce packet twice when waiting triggers become eligible together', async () => {
    const card = { slot: 0, type: 14, name: 'ice_shroom', imitates: null, cost: null, ready: true,
      affordable: true, cooldown: 'ready' as const, cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0,
      x: 150, y: 40 };
    const transport = new FakePvzTransport(snapshot({ screen: 'board', mode: 35, menu: [],
      board: boardState({ cards: [] }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'plant') return;
      fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
      fake.publish(draft => { draft.board!.cards = []; });
    };
    const { world, host } = await startWorld(transport);
    try {
      for (const row of [2, 3]) await callTool(world, 'pvz_arm', {
        when: { sun: { min: 0 } }, waitForCards: true,
        steps: [{ skill: 'plant', plant: 'ice_shroom', row, column: 2 }],
      });
      transport.publish(draft => { draft.board!.cards = [card]; });
      await afterTimers(150);
      expect(host.events.filter(({ event }) => event.type === 'pvz.trigger' && event.text.includes('打响')))
        .toHaveLength(1);
      expect(await callTool(world, 'pvz_queue')).toContain('缺卡等待');
      transport.publish(draft => { draft.screen = 'defeat'; draft.board = null; });
      await afterTimers(30);
      expect(await callTool(world, 'pvz_queue')).not.toContain('待触发');
      expect(host.events.some(({ event }) => event.type === 'pvz.trigger' && event.text.includes('随关卡结束撤掉')))
        .toBe(true);
    } finally { await world.stop(); }
  });

  it('accepts only explicit boolean card waiting and immediate planting steps', async () => {
    const args = { when: { sun: { min: 0 } }, steps: [{ ...plant, when: 'now' }] };
    expect(parsePvzArm(args).waitForCards).toBe(false);
    expect(parsePvzArm({ ...args, waitForCards: true }).waitForCards).toBe(true);
    for (const waitForCards of [null, 1, 'true']) {
      expect(() => parsePvzArm({ ...args, waitForCards })).toThrow('waitForCards');
    }
    for (const steps of [[plant], [collect], [{ skill: 'shovel', row: 2, column: 3 }]]) {
      expect(() => parsePvzArm({ ...args, steps, waitForCards: true })).toThrow('when:now');
    }
    const transport = new FakePvzTransport(snapshot({ screen: 'board', board: boardState({
      cards: [{ slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100, ready: true,
        affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0,
        x: 150, y: 40 }],
    }) }));
    const { world } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_arm', { ...args, waitForCards: true })).toContain('只用于传送带');
    } finally { await world.stop(); }
  });

  it('counters two later iceballs in their observed rows and skips a vanished or different projectile', async () => {
    const card = { slot: 0, type: 20, name: 'jalapeno', imitates: null, cost: null, ready: true,
      affordable: true, cooldown: 'ready' as const, cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0,
      x: 150, y: 40 };
    const transport = new FakePvzTransport(snapshot({ screen: 'board', mode: 35, menu: [],
      board: boardState({ background: 5, boss: { phase: 'boss_idle', immobilized: false, projectile: null },
        cards: [card, { ...card, slot: 1 }, { ...card, slot: 2 }],
        plants: [2, 5].map(row => ({ id: row, type: 33, name: 'flower_pot', row, column: row === 2 ? 1 : 3,
          condition: 'intact', sleeping: false, squished: false, layers: [] })),
      }),
    }));
    const burnedRows: number[] = [];
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'plant' || !('column' in action)) return;
      expect(action.row).toBe(fake.state.board!.boss!.projectile!.row);
      burnedRows.push(action.row);
      fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
      fake.publish(draft => {
        draft.board!.cards = draft.board!.cards.filter(item => item.slot !== action.slot)
          .map((item, slot) => ({ ...item, slot }));
        draft.board!.boss!.projectile = null;
      });
    };
    const { world, host } = await startWorld(transport);
    const step = { skill: 'plant', plant: 'jalapeno', row: { bossProjectile: 'iceball' },
      column: { emptyPot: 'nearest_house' } };
    try {
      await callTool(world, 'pvz_arm', { when: { bossProjectile: { kind: 'iceball' } },
        steps: [step], maxFirings: 2 });
      for (const row of [5, 2]) {
        transport.publish(draft => { draft.board!.boss!.projectile = { kind: 'iceball', row, columnPosition: 6 }; });
        await afterTimers(150);
        expect(transport.state.board!.boss!.projectile).toBeNull();
      }
      expect(burnedRows).toEqual([5, 2]);
      expect(transport.state.board!.cards).toHaveLength(1);
      await callTool(world, 'pvz_do', { steps: [step] });
      await afterTimers(30);
      transport.publish(draft => { draft.board!.boss!.projectile = { kind: 'fireball', row: 2, columnPosition: 5 }; });
      await callTool(world, 'pvz_do', { steps: [step] });
      await afterTimers(30);
      expect(transport.state.board!.cards).toHaveLength(1);
      expect(transport.state.board!.boss!.projectile?.kind).toBe('fireball');
      expect(host.events.filter(({ event }) => event.type === 'pvz.task' && event.text.includes('当前没有可见冰球')))
        .toHaveLength(2);
    } finally { await world.stop(); }
  });

  it.each(['boss', 'nearby zombie', 'unprotected zombie'])('uses two packets across two %s thaws and leaves the third unused', async source => {
    const card = { slot: 0, type: 14, name: 'ice_shroom', imitates: null, cost: null, ready: true,
      affordable: true, cooldown: 'ready' as const, cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0,
      x: 150, y: 40 };
    const transport = new FakePvzTransport(snapshot({ screen: 'board', mode: 35, menu: [],
      board: boardState({ background: 5,
        boss: { phase: source === 'boss' ? 'boss_aiming' : 'boss_idle', immobilized: true, projectile: null },
        zombies: [{ id: 7, type: 0, name: 'zombie', row: 3, column: 4, columnPosition: 3.8,
          xBand: 'near', speedCellsPerSecond: 0, phase: 'walking', condition: 'intact',
          armor: 'none', shield: 'none', hypnotized: false, slowed: true, immobilized: true }],
        cards: [card, { ...card, slot: 1 }, { ...card, slot: 2 }],
      }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'plant') return;
      fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
      fake.publish(draft => {
        draft.board!.cards = draft.board!.cards.filter(item => item.slot !== action.slot)
          .map((item, slot) => ({ ...item, slot }));
        draft.board!.boss!.immobilized = true;
        draft.board!.zombies[0]!.immobilized = true;
      });
    };
    const { world, host } = await startWorld(transport);
    try {
      const when = source === 'boss' ? { boss: { vulnerable: true, immobilized: false } }
        : { zombie: { row: [2, 3], maxColumn: 4, immobilized: false,
          ...(source === 'unprotected zombie' ? { hasUsableMower: false } : {}) } };
      const thaw = () => transport.publish(draft => {
        if (source === 'boss') draft.board!.boss!.immobilized = false;
        else draft.board!.zombies[0]!.immobilized = false;
      });
      const args = { when,
        steps: [{ skill: 'plant', plant: 'ice_shroom', row: 2, column: 3 }], maxFirings: 4 };
      expect(await callTool(world, 'pvz_arm', args)).toContain('此刻有 3 张，这次要 4 张');
      expect(await callTool(world, 'pvz_observe')).toContain('寒冰菇：可新排3张（已安排0张）');
      expect(await callTool(world, 'pvz_arm', { ...args, maxFirings: 2 })).toContain('剩余2/2次');
      expect(await world.handoffSnapshot()).toContain('寒冰菇：可新排1张（已安排2张）');
      expect((await world.photoFrame()).text).toContain('寒冰菇：可新排1张（已安排2张）');
      for (const remaining of [2, 1]) {
        thaw();
        if (source === 'unprotected zombie' && remaining === 2) {
          await afterTimers(30);
          expect(transport.state.board!.cards).toHaveLength(3);
          transport.publish(draft => { draft.board!.mowers.find(mower => mower.row === 3)!.state = 'squished'; });
        }
        await afterTimers(150);
        expect(transport.state.board!.cards).toHaveLength(remaining);
        expect(transport.state.board!.boss!.immobilized).toBe(true);
        expect(await callTool(world, 'pvz_observe'))
          .toContain(`寒冰菇：可新排1张（已安排${remaining - 1}张）`);
        transport.publish(() => {});
        await afterTimers(30);
        expect(transport.state.board!.cards).toHaveLength(remaining);
      }
      thaw();
      await afterTimers(30);
      expect(transport.state.board!.cards).toHaveLength(1);
      expect(await callTool(world, 'pvz_queue')).not.toContain('待触发');
      expect(host.events.filter(({ event }) => event.type === 'pvz.trigger'))
        .toHaveLength(2);
      expect(await callTool(world, 'pvz_arm', { ...args,
        when: { sun: { min: 9000 } }, maxFirings: 1 })).toContain('已武装');
      expect(await callTool(world, 'pvz_queue')).toContain('寒冰菇：可新排0张（已安排1张）');
      await callTool(world, 'pvz_stop');
      expect(await callTool(world, 'pvz_observe')).toContain('寒冰菇：可新排1张（已安排0张）');
    } finally { await world.stop(); }
  });

  it('keeps a repeated condition latched across true and unknown observations and cancels it on a new run', () => {
    const state = snapshot({ screen: 'board', board: boardState({ sun: 100 }) });
    let fires = 0;
    const table = new PvzTriggerTable({ snapshot: () => state, nextId: () => 1,
      fire: () => String(++fires), report: () => {} });
    table.arm({ sun: { min: 50 } }, [collect], 'append', null, 3);
    table.evaluate(state);
    table.evaluate(null);
    table.evaluate(state);
    expect(fires).toBe(1);
    state.board!.sun = 25; table.evaluate(state);
    state.board!.sun = 100; table.evaluate(state);
    expect(fires).toBe(2);
    state.board!.runId += 1; table.evaluate(state);
    expect(table.list()).toEqual([]);
    expect(fires).toBe(2);
  });

  it.each([0, 17, 1.5, null, '2'])('rejects invalid maxFirings %j', maxFirings => {
    expect(() => parsePvzArm({ when: { sun: { min: 50 } }, steps: [collect], maxFirings }))
      .toThrow('maxFirings');
  });

  it('executes one chosen action when an exposed boss thaws, with no repeated response', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', mode: 35, menu: [],
      board: boardState({ background: 5, boss: { phase: 'boss_aiming', immobilized: true, projectile: null },
        cards: [{ slot: 0, type: 14, name: 'ice_shroom', imitates: null, cost: null, ready: true,
          affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0,
          x: 150, y: 40 }],
      }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'plant') return;
      fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
      fake.publish(draft => { draft.board!.cards = []; draft.board!.boss!.immobilized = true; });
    };
    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_arm', {
        when: { boss: { vulnerable: true, immobilized: false } },
        steps: [{ skill: 'plant', plant: 'ice_shroom', row: 2, column: 3 }],
      })).toContain('已武装');
      await afterTimers(30);
      expect(transport.state.board!.cards).toHaveLength(1);
      transport.publish(draft => { draft.board!.boss!.immobilized = false; });
      await afterTimers(150);
      expect(transport.state.board!.cards).toHaveLength(0);
      expect(host.events.some(({ event }) => event.type === 'pvz.task' && event.text.includes('完成'))).toBe(true);
      transport.publish(draft => { draft.board!.boss!.immobilized = false; });
      await afterTimers(30);
      expect(transport.commands.filter(action => action.kind === 'plant')).toHaveLength(1);
    } finally { await world.stop(); }
  });
  it('可见火球触发一次冰菇种植，未吐球和后续火球不会重复消耗卡片', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', mode: 35, menu: [],
      board: boardState({ background: 5, boss: { phase: 'boss_spitting', immobilized: false, projectile: null },
        cards: [{ slot: 0, type: 14, name: 'ice_shroom', imitates: null, cost: null, ready: true,
          affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0,
          x: 150, y: 40 }],
      }),
    }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'plant') return;
      fake.nativeResult = { outcome: 'executed', effect: 'card_consumed' };
      fake.publish(draft => { draft.board!.cards = []; draft.board!.boss!.projectile = null; });
    };
    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_arm', {
        when: { bossProjectile: { kind: 'fireball' } },
        steps: [{ skill: 'plant', plant: 'ice_shroom', row: 2, column: 3 }],
      })).toContain('已武装');
      await afterTimers(30);
      expect(transport.state.board!.cards).toHaveLength(1);
      transport.publish(draft => {
        draft.board!.boss!.projectile = { kind: 'fireball', row: 5, columnPosition: 6.6 };
      });
      await afterTimers(150);
      expect(transport.state.board!.cards).toHaveLength(0);
      expect(host.events.some(({ event }) => event.type === 'pvz.task' && event.text.includes('完成'))).toBe(true);
      const count = transport.commands.filter(action => action.kind === 'plant').length;
      transport.publish(draft => {
        draft.board!.boss!.projectile = { kind: 'fireball', row: 1, columnPosition: 6.6 };
      });
      await afterTimers(30);
      expect(transport.commands.filter(action => action.kind === 'plant')).toHaveLength(count);
    } finally { await world.stop(); }
  });
  it('只在指定植物种子出现时拾取该包，保留其他种子', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', menu: [], board: boardState() }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'collect') return;
      const picked = fake.state.board!.collectibles.find(item => action.ids.includes(item.id))!;
      fake.nativeResult = { outcome: 'executed', effect: 'collectibles_collected' };
      fake.publish(draft => {
        draft.board!.collectibles = draft.board!.collectibles.filter(item => !action.ids.includes(item.id));
        draft.board!.cursor = { kind: 'usable_seed', heldType: picked.containedType!, logicalX: 300, logicalY: 200 };
      });
    };
    const { world } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_arm', {
        when: { collectible: { kind: 'usable_seed', plant: 'peashooter' } },
        steps: [{ skill: 'collect', what: 'usable_seed', plant: 'peashooter' }],
      })).toContain('已武装');
      transport.publish(draft => { draft.board!.collectibles = [
        { id: 1, kind: 'usable_seed', containedType: 16, x: 200, y: 200, row: 2, column: 3 },
      ]; });
      await afterTimers(40);
      expect(transport.state.board!.cursor.kind).toBe('normal');
      transport.publish(draft => { draft.board!.collectibles.push(
        { id: 2, kind: 'usable_seed', containedType: 0, x: 300, y: 200, row: 2, column: 4 },
      ); });
      await afterTimers(150);
      expect(transport.state.board!.cursor.heldType).toBe(0);
      expect(transport.state.board!.collectibles.map(item => item.containedType)).toEqual([16]);
    } finally { await world.stop(); }
  });

  it('种子包出现后触发一次拾取并保持手持，后续新包不会重复触发', async () => {
    const transport = new FakePvzTransport(snapshot({ screen: 'board', menu: [], board: boardState() }));
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'collect') return;
      fake.nativeResult = { outcome: 'executed', effect: 'collectibles_collected' };
      fake.publish((draft) => {
        draft.board!.collectibles = draft.board!.collectibles.filter((item) => !action.ids.includes(item.id));
        draft.board!.cursor = { kind: 'usable_seed', heldType: 0, logicalX: 300, logicalY: 200 };
      });
    };
    const { world, host } = await startWorld(transport);
    try {
      const receipt = await callTool(world, 'pvz_arm', {
        when: { collectible: { kind: 'usable_seed' } },
        queue: 'append', steps: [{ skill: 'collect', what: 'usable_seed', until: 'once' }],
      });
      expect(receipt).toContain('已武装');
      transport.publish((draft) => { draft.board!.collectibles = [
        { id: 7, kind: 'usable_seed', containedType: 0, x: 300, y: 200, row: 2, column: 4 },
      ]; });
      await afterTimers(150);
      expect(transport.state.board!.cursor.kind).toBe('usable_seed');
      expect(transport.state.board!.collectibles).toEqual([]);
      transport.publish((draft) => { draft.board!.collectibles.push(
        { id: 8, kind: 'usable_seed', containedType: 1, x: 400, y: 200, row: 2, column: 5 },
      ); });
      await afterTimers(40);
      expect(transport.state.board!.collectibles.map((item) => item.id)).toEqual([8]);
      expect(host.events.filter(({ event }) => event.type === 'pvz.trigger')).toHaveLength(1);
    } finally { await world.stop(); }
  });

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
      expect(await callTool(world, 'pvz_arm', arm({ expiresInMs: 1000 }))).toContain('1秒后撤掉剩余次数');
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
