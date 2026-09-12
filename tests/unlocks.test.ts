import { describe, expect, it } from 'vitest';
import type { PvzProfileProgress, PvzSeedChoice } from '../src/protocol.ts';
import {
  adventureSeedCount,
  progressFilteredSeedChoices,
  seedAllowedByPublicProgress,
} from '../src/unlocks.ts';

const profile = (level: number, completions = 0): PvzProfileProgress => ({
  name: 'test',
  adventureLevel: level,
  adventureCompletions: completions,
  coins: 0,
  minigamesUnlocked: false,
  puzzleUnlocked: false,
  survivalUnlocked: false,
});

const choice = (id: number): PvzSeedChoice => ({
  id,
  name: `seed_${id}`,
  state: 'chooser',
  bankSlot: null,
  imitates: null,
  recommended: false,
  fixed: false,
  x: 0,
  y: 0,
});

describe('PvZ 档案植物解锁', () => {
  it.each([
    [1, 1],
    [5, 4],
    [8, 7],
    [10, 8],
    [50, 40],
  ])('冒险进度 %i 公开 %i 种基础植物', (level, count) => {
    expect(adventureSeedCount(level)).toBe(count);
  });

  it('首次冒险在观察和动作包装层都排除未来植物', () => {
    const current = profile(8);
    expect(seedAllowedByPublicProgress(current, 6)).toBe(true);
    expect(seedAllowedByPublicProgress(current, 7)).toBe(false);
    expect(progressFilteredSeedChoices(current, [choice(0), choice(6), choice(7), choice(48)])
      .map((item) => item.id)).toEqual([0, 6]);
  });

  it('通关后把商店植物的最终判定留给原生档案购买状态', () => {
    expect(progressFilteredSeedChoices(profile(1, 1), [choice(39), choice(40), choice(48)])
      .map((item) => item.id)).toEqual([39, 40, 48]);
  });
});
