import { describe, expect, it } from 'vitest';
import {
  mechanicsForCard,
  PVZ_CARD_MECHANICS,
} from '../src/card-mechanics.ts';
import { PLANT_NAMES } from '../src/names.ts';

describe('PvZ 卡片机制目录', () => {
  it('完整覆盖每个规范植物名并给出可决策的语义维度', () => {
    expect(Object.keys(PVZ_CARD_MECHANICS)).toEqual([...PLANT_NAMES]);
    for (const mechanics of Object.values(PVZ_CARD_MECHANICS)) {
      expect(mechanics.roles.length).toBeGreaterThan(0);
      expect(mechanics.effect).not.toBe('');
      expect(mechanics.area).not.toBe('');
      expect(mechanics.trigger).not.toBe('');
      expect(mechanics.delay).not.toBe('');
      expect(mechanics.lifetime).not.toBe('');
    }
  });

  it('模仿者卡继承被模仿植物的机制，未指定目标时保留自身机制', () => {
    expect(mechanicsForCard({ type: 48, imitates: 2 }))
      .toBe(PVZ_CARD_MECHANICS.cherry_bomb);
    expect(mechanicsForCard({ type: 48, imitates: null }))
      .toBe(PVZ_CARD_MECHANICS.imitater);
    expect(mechanicsForCard({ type: 60, imitates: null })).toBeNull();
  });
});
