import { PLANT_NAMES, plantName } from './names.ts';
import type { PvzCard } from './protocol.ts';

export type PvzPlantName = (typeof PLANT_NAMES)[number];

export interface PvzCardMechanics {
  readonly roles: readonly string[];
  readonly effect: string;
  readonly area: string;
  readonly trigger: string;
  readonly delay: string;
  readonly lifetime: 'persistent' | 'single_use' | 'inherited';
}

export const PVZ_CARD_MECHANICS = {
  peashooter: {
    roles: ['sustained_damage'], effect: 'projectile_damage', area: 'forward_lane',
    trigger: 'automatic', delay: 'repeating', lifetime: 'persistent',
  },
  sunflower: {
    roles: ['economy'], effect: 'generate_sun', area: 'self',
    trigger: 'automatic', delay: 'periodic', lifetime: 'persistent',
  },
  cherry_bomb: {
    roles: ['burst_damage'], effect: 'massive_damage', area: 'centered_3x3',
    trigger: 'after_placement', delay: 'short', lifetime: 'single_use',
  },
  wall_nut: {
    roles: ['defense'], effect: 'block_zombies', area: 'self_cell',
    trigger: 'passive', delay: 'none', lifetime: 'persistent',
  },
  potato_mine: {
    roles: ['trap_damage'], effect: 'massive_contact_damage', area: 'self_cell',
    trigger: 'proximity_after_arming', delay: 'long_arming', lifetime: 'single_use',
  },
  snow_pea: {
    roles: ['sustained_damage', 'control'], effect: 'projectile_damage_and_slow',
    area: 'forward_lane', trigger: 'automatic', delay: 'repeating', lifetime: 'persistent',
  },
  chomper: {
    roles: ['close_damage'], effect: 'devour_one_zombie', area: 'short_forward_reach',
    trigger: 'proximity', delay: 'bite_then_long_digest', lifetime: 'persistent',
  },
  repeater: {
    roles: ['sustained_damage'], effect: 'double_projectile_damage', area: 'forward_lane',
    trigger: 'automatic', delay: 'repeating', lifetime: 'persistent',
  },
  puff_shroom: {
    roles: ['sustained_damage'], effect: 'short_range_projectile_damage',
    area: 'short_forward_lane', trigger: 'automatic_when_awake', delay: 'repeating',
    lifetime: 'persistent',
  },
  sun_shroom: {
    roles: ['economy'], effect: 'generate_sun_and_grow', area: 'self',
    trigger: 'automatic_when_awake', delay: 'periodic', lifetime: 'persistent',
  },
  fume_shroom: {
    roles: ['sustained_damage', 'piercing'], effect: 'piercing_fume_damage',
    area: 'short_forward_lane', trigger: 'automatic_when_awake', delay: 'repeating',
    lifetime: 'persistent',
  },
  grave_buster: {
    roles: ['terrain_removal'], effect: 'remove_grave', area: 'target_grave',
    trigger: 'after_placement', delay: 'short_channel', lifetime: 'single_use',
  },
  hypno_shroom: {
    roles: ['control'], effect: 'hypnotize_biting_zombie', area: 'self_cell',
    trigger: 'on_bitten_when_awake', delay: 'none', lifetime: 'single_use',
  },
  scaredy_shroom: {
    roles: ['sustained_damage'], effect: 'projectile_damage_and_hide_from_nearby_zombies',
    area: 'forward_lane', trigger: 'automatic_when_safe_and_awake', delay: 'repeating',
    lifetime: 'persistent',
  },
  ice_shroom: {
    roles: ['control', 'burst_support'], effect: 'freeze_then_slow_zombies',
    area: 'whole_board', trigger: 'after_placement_when_awake', delay: 'short',
    lifetime: 'single_use',
  },
  doom_shroom: {
    roles: ['burst_damage', 'terrain_change'], effect: 'massive_damage_and_leave_crater',
    area: 'large_centered_area', trigger: 'after_placement_when_awake', delay: 'short',
    lifetime: 'single_use',
  },
  lily_pad: {
    roles: ['platform'], effect: 'support_plant_on_water', area: 'self_cell',
    trigger: 'after_placement', delay: 'none', lifetime: 'persistent',
  },
  squash: {
    roles: ['burst_damage'], effect: 'crush_nearby_zombies', area: 'short_forward_area',
    trigger: 'proximity', delay: 'short', lifetime: 'single_use',
  },
  threepeater: {
    roles: ['sustained_damage'], effect: 'projectile_damage_in_three_lanes',
    area: 'three_adjacent_forward_lanes', trigger: 'automatic', delay: 'repeating',
    lifetime: 'persistent',
  },
  tangle_kelp: {
    roles: ['trap_damage'], effect: 'drag_one_water_zombie_under', area: 'self_cell',
    trigger: 'proximity_in_water', delay: 'short', lifetime: 'single_use',
  },
  jalapeno: {
    roles: ['burst_damage', 'terrain_control'], effect: 'damage_row_and_remove_ice_trails',
    area: 'whole_row', trigger: 'after_placement', delay: 'short', lifetime: 'single_use',
  },
  spikeweed: {
    roles: ['ground_damage', 'vehicle_counter'], effect: 'contact_damage_and_pop_tires',
    area: 'self_cell', trigger: 'enemy_overlap', delay: 'repeating_contact',
    lifetime: 'persistent',
  },
  torchwood: {
    roles: ['damage_support'], effect: 'convert_passing_peas_to_fire',
    area: 'crossing_projectiles', trigger: 'projectile_crosses_cell', delay: 'none',
    lifetime: 'persistent',
  },
  tall_nut: {
    roles: ['defense'], effect: 'high_health_block_and_stop_vaulting', area: 'self_cell',
    trigger: 'passive', delay: 'none', lifetime: 'persistent',
  },
  sea_shroom: {
    roles: ['sustained_damage'], effect: 'short_range_projectile_damage',
    area: 'short_forward_lane_in_water', trigger: 'automatic_when_awake', delay: 'repeating',
    lifetime: 'persistent',
  },
  plantern: {
    roles: ['visibility_support'], effect: 'reveal_fog', area: 'nearby_area',
    trigger: 'passive', delay: 'none', lifetime: 'persistent',
  },
  cactus: {
    roles: ['sustained_damage', 'anti_air'], effect: 'projectile_damage_and_counter_balloon',
    area: 'forward_lane', trigger: 'automatic', delay: 'repeating', lifetime: 'persistent',
  },
  blover: {
    roles: ['control', 'visibility_support'], effect: 'remove_balloon_zombies_and_clear_fog',
    area: 'whole_board', trigger: 'after_placement', delay: 'short', lifetime: 'single_use',
  },
  split_pea: {
    roles: ['sustained_damage'], effect: 'forward_single_and_backward_double_projectiles',
    area: 'forward_and_backward_lane', trigger: 'automatic', delay: 'repeating',
    lifetime: 'persistent',
  },
  starfruit: {
    roles: ['multi_direction_damage'], effect: 'projectile_damage_in_five_directions',
    area: 'five_rays', trigger: 'automatic', delay: 'repeating', lifetime: 'persistent',
  },
  pumpkin: {
    roles: ['defense'], effect: 'shield_plant_in_same_cell', area: 'self_cell_overlay',
    trigger: 'passive', delay: 'none', lifetime: 'persistent',
  },
  magnet_shroom: {
    roles: ['control'], effect: 'remove_metal_equipment', area: 'nearby_area',
    trigger: 'automatic_when_awake', delay: 'periodic_recharge', lifetime: 'persistent',
  },
  cabbage_pult: {
    roles: ['sustained_damage'], effect: 'lobbed_projectile_damage', area: 'forward_lane',
    trigger: 'automatic', delay: 'repeating', lifetime: 'persistent',
  },
  flower_pot: {
    roles: ['platform'], effect: 'support_plant_on_roof', area: 'self_cell',
    trigger: 'after_placement', delay: 'none', lifetime: 'persistent',
  },
  kernel_pult: {
    roles: ['sustained_damage', 'control'], effect: 'lobbed_damage_or_butter_stun',
    area: 'forward_lane', trigger: 'automatic', delay: 'repeating_random_effect',
    lifetime: 'persistent',
  },
  coffee_bean: {
    roles: ['activation_support'], effect: 'wake_sleeping_mushroom',
    area: 'target_sleeping_mushroom', trigger: 'after_placement', delay: 'short',
    lifetime: 'single_use',
  },
  garlic: {
    roles: ['lane_control', 'defense'], effect: 'redirect_biting_zombie_to_adjacent_lane',
    area: 'self_cell', trigger: 'on_bitten', delay: 'none', lifetime: 'persistent',
  },
  umbrella_leaf: {
    roles: ['defense_support'], effect: 'deflect_bungee_and_catapult', area: 'nearby_area',
    trigger: 'reactive', delay: 'none', lifetime: 'persistent',
  },
  marigold: {
    roles: ['economy'], effect: 'generate_coins', area: 'self',
    trigger: 'automatic', delay: 'periodic', lifetime: 'persistent',
  },
  melon_pult: {
    roles: ['sustained_damage', 'area_damage'], effect: 'heavy_lobbed_damage_with_splash',
    area: 'target_and_nearby', trigger: 'automatic', delay: 'repeating',
    lifetime: 'persistent',
  },
  gatling_pea: {
    roles: ['sustained_damage'], effect: 'four_projectile_damage', area: 'forward_lane',
    trigger: 'automatic', delay: 'repeating', lifetime: 'persistent',
  },
  twin_sunflower: {
    roles: ['economy'], effect: 'generate_two_sun', area: 'self',
    trigger: 'automatic', delay: 'periodic', lifetime: 'persistent',
  },
  gloom_shroom: {
    roles: ['area_damage', 'piercing'], effect: 'piercing_damage_around_self',
    area: 'centered_nearby_area', trigger: 'automatic_when_awake', delay: 'repeating',
    lifetime: 'persistent',
  },
  cattail: {
    roles: ['homing_damage', 'anti_air'], effect: 'homing_projectile_damage',
    area: 'any_lane_visible_target', trigger: 'automatic', delay: 'repeating',
    lifetime: 'persistent',
  },
  winter_melon: {
    roles: ['sustained_damage', 'area_damage', 'control'],
    effect: 'heavy_splash_damage_and_slow', area: 'target_and_nearby',
    trigger: 'automatic', delay: 'repeating', lifetime: 'persistent',
  },
  gold_magnet: {
    roles: ['economy', 'collection'], effect: 'collect_coins_and_diamonds',
    area: 'board_collectibles', trigger: 'automatic', delay: 'periodic_recharge',
    lifetime: 'persistent',
  },
  spikerock: {
    roles: ['ground_damage', 'vehicle_counter'],
    effect: 'strong_contact_damage_pop_tires_and_endure_vehicle_hits', area: 'self_cell',
    trigger: 'enemy_overlap', delay: 'repeating_contact', lifetime: 'persistent',
  },
  cob_cannon: {
    roles: ['burst_damage'], effect: 'player_targeted_massive_area_damage',
    area: 'centered_large_area', trigger: 'manual_when_loaded', delay: 'long_reload',
    lifetime: 'persistent',
  },
  imitater: {
    roles: ['copy'], effect: 'inherit_selected_plant_mechanics', area: 'inherited',
    trigger: 'after_placement', delay: 'short_morph_then_inherited', lifetime: 'inherited',
  },
  explod_o_nut: {
    roles: ['rolling_burst_damage'], effect: 'rolling_contact_explosion',
    area: 'rolling_lane_then_centered_area', trigger: 'launched_from_conveyor',
    delay: 'on_contact', lifetime: 'single_use',
  },
  giant_wall_nut: {
    roles: ['rolling_damage'], effect: 'crush_zombies_while_rolling', area: 'rolling_lane',
    trigger: 'launched_from_conveyor', delay: 'continuous_while_rolling',
    lifetime: 'single_use',
  },
  sprout: {
    roles: ['garden_growth'], effect: 'grow_into_garden_plant', area: 'garden_pot',
    trigger: 'care_progression', delay: 'long_growth', lifetime: 'persistent',
  },
  leftpeater: {
    roles: ['sustained_damage'], effect: 'double_projectile_damage_toward_house',
    area: 'backward_lane', trigger: 'automatic', delay: 'repeating', lifetime: 'persistent',
  },
} as const satisfies Readonly<Record<PvzPlantName, PvzCardMechanics>>;

export function mechanicsForCard(
  card: Pick<PvzCard, 'type' | 'imitates'>,
): PvzCardMechanics | null {
  const effectiveName = plantName(card.imitates ?? card.type);
  return Object.prototype.hasOwnProperty.call(PVZ_CARD_MECHANICS, effectiveName)
    ? PVZ_CARD_MECHANICS[effectiveName as PvzPlantName]
    : null;
}
