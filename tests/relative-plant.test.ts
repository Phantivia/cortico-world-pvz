import { describe, expect, it } from 'vitest';
import { parseNativeMessage } from '../src/protocol.ts';
import { PvzRuntime, verifyAction } from '../src/runtime.ts';
import { parsePvzDo } from '../src/skills.ts';
import { boardState, callTool, FakePvzTransport, snapshot, startWorld } from './helpers.ts';

function initial() {
  return snapshot({ screen: 'board', board: boardState({ cards: [{
    slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
    ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 100,
    cooldownRemainingSeconds: 0, x: 80, y: 40,
  }] }) });
}
const action = { kind: 'plant' as const, slot: 0, row: 2, aheadOf: { minGap: 2 } };
const placement = { row: 2, column: 4, targetId: 8, runId: 1 };

describe('relative plant admission and actual-cell verification', () => {
  it('validates relative locations and refuses per-step conditions, which belong to pvz_arm', () => {
    const base = { skill: 'plant', plant: 'wall_nut', row: 3,
      column: { aheadOf: 'nearest_hostile', minGap: 0 } };
    expect(parsePvzDo([base])).toMatchObject({ steps: [{ ...base, when: 'now' }] });
    for (const column of [{ ...base.column, minGap: -1 }, { ...base.column, minGap: 1.5 },
      { ...base.column, minGap: 9 }, { ...base.column, column: 4 }]) {
      expect(parsePvzDo([{ ...base, column }])).toHaveProperty('error');
    }
    const conditional = parsePvzDo([{ ...base, startWhen: { zombie: { row: 3 } } }]);
    expect(conditional).toHaveProperty('error');
    expect((conditional as { error: string }).error).toContain('pvz_arm');
    expect(parsePvzDo([{ ...base, expiresInMs: 8000 }])).toHaveProperty('error');
  });

  it('accepts only a new expected plant in the actual committed cell and bound run', () => {
    const before = initial();
    const after = structuredClone(before);
    after.revision++;
    after.board!.plants = [{ id: 101, type: 0, name: 'peashooter', row: 2, column: 4,
      condition: 'intact', sleeping: false, squished: false, layers: ['main'] }];
    expect(verifyAction(action, before, after, [], 'card_consumed', placement)).toContain('第2排第4列的植物层已变化');
    expect(verifyAction(action, before, after, [], 'card_consumed')).toBeNull();
    expect(verifyAction(action, before, after, [], 'card_consumed', { ...placement, column: 5 })).toBeNull();
    expect(verifyAction(action, before, after, [], 'card_consumed', { ...placement, runId: 2 })).toBeNull();
    after.board!.plants = [];
    after.board!.cards[0]!.ready = false;
    expect(verifyAction(action, before, after, [], 'card_consumed', placement)).toBeNull();
  });

  it('does not promote card consumption to relative placement success at timeout', async () => {
    const transport = new FakePvzTransport(initial());
    transport.actionHandler = action => {
      transport.nativeResult = action.kind === 'plant'
        ? { outcome: 'executed', effect: 'card_consumed', placement }
        : { outcome: 'executed' };
    };
    const runtime = new PvzRuntime(transport, () => 20);
    await runtime.start();
    try {
      expect((await runtime.act(action)).status).toBe('unverified');
      expect(transport.commands.at(-1)?.kind).toBe('cancel');
    } finally { await runtime.stop(); }
  });

  it('passes the relative intent to native and reports the actual cell after a newer snapshot', async () => {
    const transport = new FakePvzTransport(initial());
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'plant' || !('aheadOf' in action)) return;
      fake.nativeResult = { outcome: 'executed', effect: 'card_consumed', placement };
      fake.publish(draft => {
        draft.board!.plants.push({ id: 101, type: 0, name: 'peashooter', row: placement.row, column: placement.column,
          condition: 'intact', sleeping: false, squished: false, layers: ['main'] });
        draft.board!.cards[0]!.ready = false;
      });
    };
    const { world, host } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_do', { steps: [{
        skill: 'plant', plant: 'peashooter', row: 2, column: { aheadOf: 'nearest_hostile', minGap: 2 },
      }] });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(transport.commands[0]).toEqual(action);
      const result = host.events.find(item => item.event.type === 'pvz.task');
      expect(result?.event.text).toContain('豌豆射手 已种在第2排第4列');
      expect(result?.event.meta).toMatchObject({ terminal: 'done' });
    } finally { await world.stop(); }
  });

  it('checks placement fields at the native message boundary', () => {
    const result = { type: 'result', protocol: 2, id: 'placement', revision: 10,
      outcome: 'executed', effect: 'card_consumed', placement };
    expect(parseNativeMessage(JSON.stringify(result))).toMatchObject({ placement });
    for (const invalid of [{ ...placement, column: 0 }, { ...placement, runId: -1 }, { ...placement, extra: true }]) {
      expect(() => parseNativeMessage(JSON.stringify({ ...result, placement: invalid }))).toThrow();
    }
  });
});
