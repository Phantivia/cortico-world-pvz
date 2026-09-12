import type { PvzProfileProgress, PvzSeedChoice } from './protocol.ts';

export function adventureSeedCount(level: number): number {
  if (level < 1) return 0;
  const area = Math.floor((level - 1) / 10) + 1;
  const stage = ((level - 1) % 10) + 1;
  let count = (area - 1) * 8 + stage;
  if (stage >= 10) count -= 2;
  else if (stage >= 5) count -= 1;
  return Math.max(0, Math.min(count, 40));
}

export function seedAllowedByPublicProgress(
  profile: PvzProfileProgress | null,
  seed: number,
): boolean {
  if (!profile) return true;
  if (seed < 0 || seed >= 49) return true;
  if (profile.adventureCompletions > 0 || profile.adventureLevel > 50) return true;
  return seed < adventureSeedCount(profile.adventureLevel);
}

export function progressFilteredSeedChoices(
  profile: PvzProfileProgress | null,
  choices: readonly PvzSeedChoice[],
): readonly PvzSeedChoice[] {
  return choices.filter((choice) => seedAllowedByPublicProgress(profile, choice.id));
}
