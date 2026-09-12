const TERMINAL_COLLECTIBLE_KINDS = new Set([
  'seed_packet',
  'trophy',
  'shovel',
  'almanac',
  'car_keys',
  'vase',
  'watering_can',
  'taco',
  'note',
  'money_bag',
  'present',
  'diamond_bag',
  'silver_sunflower',
  'gold_sunflower',
  'award_chocolate',
  'minigames_present',
  'puzzle_present',
  'survival_present',
  'potted_plant',
  'chocolate',
]);

const SUN_KINDS = new Set(['sun', 'small_sun', 'large_sun']);

export function isTerminalCollectible(kind: string): boolean {
  return TERMINAL_COLLECTIBLE_KINDS.has(kind);
}

export function isSunCollectible(kind: string): boolean {
  return SUN_KINDS.has(kind);
}
