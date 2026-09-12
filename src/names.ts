export const PLANT_NAMES = [
  'peashooter', 'sunflower', 'cherry_bomb', 'wall_nut', 'potato_mine', 'snow_pea',
  'chomper', 'repeater', 'puff_shroom', 'sun_shroom', 'fume_shroom', 'grave_buster',
  'hypno_shroom', 'scaredy_shroom', 'ice_shroom', 'doom_shroom', 'lily_pad', 'squash',
  'threepeater', 'tangle_kelp', 'jalapeno', 'spikeweed', 'torchwood', 'tall_nut',
  'sea_shroom', 'plantern', 'cactus', 'blover', 'split_pea', 'starfruit', 'pumpkin',
  'magnet_shroom', 'cabbage_pult', 'flower_pot', 'kernel_pult', 'coffee_bean', 'garlic',
  'umbrella_leaf', 'marigold', 'melon_pult', 'gatling_pea', 'twin_sunflower',
  'gloom_shroom', 'cattail', 'winter_melon', 'gold_magnet', 'spikerock', 'cob_cannon',
  'imitater', 'explod_o_nut', 'giant_wall_nut', 'sprout', 'leftpeater',
] as const;

export const ZOMBIE_NAMES = [
  'zombie', 'flag_zombie', 'conehead', 'pole_vaulting', 'buckethead', 'newspaper',
  'screen_door', 'football', 'dancing', 'backup_dancer', 'ducky_tube', 'snorkel',
  'zomboni', 'bobsled', 'dolphin_rider', 'jack_in_the_box', 'balloon', 'digger',
  'pogo', 'yeti', 'bungee', 'ladder', 'catapult', 'gargantuar', 'imp', 'dr_zomboss',
  'pea_head', 'wall_nut_head', 'jalapeno_head', 'gatling_head', 'squash_head',
  'tall_nut_head', 'giga_gargantuar',
] as const;

export const PLANT_DISPLAY_NAMES = [
  '豌豆射手', '向日葵', '樱桃炸弹', '坚果', '土豆雷', '寒冰射手',
  '大嘴花', '双发射手', '小喷菇', '阳光菇', '大喷菇', '墓碑吞噬者',
  '魅惑菇', '胆小菇', '寒冰菇', '毁灭菇', '荷叶', '窝瓜',
  '三线射手', '缠绕水草', '火爆辣椒', '地刺', '火炬树桩', '高坚果',
  '海蘑菇', '路灯花', '仙人掌', '三叶草', '裂荚射手', '杨桃', '南瓜头',
  '磁力菇', '卷心菜投手', '花盆', '玉米投手', '咖啡豆', '大蒜',
  '叶子保护伞', '金盏花', '西瓜投手', '机枪射手', '双子向日葵',
  '忧郁菇', '香蒲', '冰西瓜', '吸金磁', '地刺王', '玉米加农炮',
  '模仿者', '爆炸坚果', '巨大坚果', '幼苗', '左向豌豆射手',
] as const;

export const ZOMBIE_DISPLAY_NAMES = [
  '普通僵尸', '旗帜僵尸', '路障僵尸', '撑杆僵尸', '铁桶僵尸', '读报僵尸',
  '铁栅门僵尸', '橄榄球僵尸', '舞王僵尸', '伴舞僵尸', '鸭子救生圈僵尸',
  '潜水僵尸', '冰车僵尸', '雪橇僵尸', '海豚骑士僵尸', '小丑僵尸',
  '气球僵尸', '矿工僵尸', '跳跳僵尸', '雪人僵尸', '蹦极僵尸',
  '扶梯僵尸', '投石车僵尸', '巨人僵尸', '小鬼僵尸', '僵王博士',
  '豌豆僵尸', '坚果僵尸', '辣椒僵尸', '机枪僵尸', '窝瓜僵尸',
  '高坚果僵尸', '红眼巨人僵尸',
] as const;

const SPECIAL_ACTION_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  break_vase: '砸花瓶',
  whack: '锤击',
  cob_fire: '玉米炮发射',
  swap: '交换',
  twist: '旋转',
  launch: '发射',
  drop_brain: '放置脑子',
  bowling: '投掷坚果',
  place_zombie: '放置僵尸',
  beghouled_buy: '购买升级',
  spin: '转动老虎机',
  start_onslaught: '开始进攻',
  buy_snorkel: '购买潜水装备',
  buy_trophy: '购买奖杯',
  zen_water: '浇水',
  zen_fertilize: '施肥',
  zen_bug_spray: '喷杀虫剂',
  zen_phonograph: '播放音乐',
  zen_chocolate: '喂巧克力',
  zen_sell: '出售植物',
  zen_next_garden: '切换花园',
  tree_feed: '给智慧树施肥',
  objective_starfruit: '杨桃目标',
});

export function specialActionDisplayName(action: string): string {
  return SPECIAL_ACTION_DISPLAY_NAMES[action] ?? '未知特殊动作';
}

export function specialActionNameOf(value: string): string {
  const original = value.trim();
  const match = Object.entries(SPECIAL_ACTION_DISPLAY_NAMES)
    .find(([, display]) => display === original);
  return match?.[0] ?? original.toLowerCase().replace(/[ -]+/g, '_');
}

export const GAME_MODE_NAMES = [
  'adventure', 'survival_day', 'survival_night', 'survival_pool', 'survival_fog',
  'survival_roof', 'survival_hard_day', 'survival_hard_night', 'survival_hard_pool',
  'survival_hard_fog', 'survival_hard_roof', 'survival_endless_day',
  'survival_endless_night', 'survival_endless_pool', 'survival_endless_fog',
  'survival_endless_roof', 'zom_botany', 'wall_nut_bowling', 'slot_machine',
  'its_raining_seeds', 'beghouled', 'invisighoul', 'seeing_stars', 'zombiquarium',
  'beghouled_twist', 'big_trouble_little_zombie', 'portal_combat',
  'column_like_you_see_em', 'bobsled_bonanza', 'zombie_nimble_zombie_quick',
  'whack_a_zombie', 'last_stand', 'zom_botany_2', 'wall_nut_bowling_2',
  'pogo_party', 'dr_zomboss_revenge', 'limbo_wall_nut_art', 'limbo_sunny_day',
  'limbo_unsodded', 'limbo_big_time', 'limbo_sunflower_art', 'limbo_air_raid',
  'limbo_ice', 'zen_garden', 'limbo_high_gravity', 'limbo_grave_danger',
  'limbo_can_you_dig_it', 'limbo_dark_stormy_night', 'limbo_bungee_blitz',
  'limbo_intro', 'tree_of_wisdom', 'vasebreaker_1', 'vasebreaker_2', 'vasebreaker_3',
  'vasebreaker_4', 'vasebreaker_5', 'vasebreaker_6', 'vasebreaker_7', 'vasebreaker_8',
  'vasebreaker_9', 'vasebreaker_endless', 'i_zombie_1', 'i_zombie_2', 'i_zombie_3',
  'i_zombie_4', 'i_zombie_5', 'i_zombie_6', 'i_zombie_7', 'i_zombie_8', 'i_zombie_9',
  'i_zombie_endless', 'upsell_test', 'intro',
] as const;

export function plantName(type: number): string {
  return PLANT_NAMES[type] ?? `plant_${type}`;
}

export function plantDisplayName(type: number): string {
  return PLANT_DISPLAY_NAMES[type] ?? '未知植物';
}

export function zombieDisplayName(type: number): string {
  return ZOMBIE_DISPLAY_NAMES[type] ?? '未知僵尸';
}

export function cardDisplayName(type: number): string {
  if (type >= 0 && type < PLANT_DISPLAY_NAMES.length) return plantDisplayName(type);
  const special: Record<number, string> = {
    54: '重排', 55: '清除弹坑', 56: '阳光', 57: '钻石',
    58: '潜水僵尸', 59: '奖杯', 60: '普通僵尸', 61: '路障僵尸',
    62: '撑杆僵尸', 63: '铁桶僵尸', 64: '扶梯僵尸', 65: '矿工僵尸',
    66: '蹦极僵尸', 67: '橄榄球僵尸', 68: '气球僵尸', 69: '铁栅门僵尸',
    70: '冰车僵尸', 71: '跳跳僵尸', 72: '舞王僵尸', 73: '巨人僵尸',
    74: '小鬼僵尸',
  };
  return special[type] ?? '未知卡片';
}

export function plantDisplayNameOf(type: number, name: string): string {
  if (type >= 0 && type < PLANT_DISPLAY_NAMES.length) return plantDisplayName(type);
  const namedType = plantTypeOf(name);
  return namedType === null ? '未知植物' : plantDisplayName(namedType);
}

export function zombieTypeOf(value: string): number | null {
  const original = value.trim();
  const display = ZOMBIE_DISPLAY_NAMES.indexOf(original as (typeof ZOMBIE_DISPLAY_NAMES)[number]);
  if (display >= 0) return display;
  const normalized = original.toLowerCase().replace(/[ -]+/g, '_').replace(/_zombie$/, '');
  const type = ZOMBIE_NAMES.indexOf(normalized as (typeof ZOMBIE_NAMES)[number]);
  return type < 0 ? null : type;
}

export function zombieDisplayNameOf(type: number, name: string): string {
  if (type >= 0 && type < ZOMBIE_DISPLAY_NAMES.length) return zombieDisplayName(type);
  const namedType = zombieTypeOf(name);
  return namedType === null ? '未知僵尸' : zombieDisplayName(namedType);
}

export function cardDisplayNameOf(type: number, name: string): string {
  if (type >= 0 && type <= 74) return cardDisplayName(type);
  const plantType = plantTypeOf(name);
  if (plantType !== null) return plantDisplayName(plantType);
  const zombieType = zombieTypeOf(name);
  return zombieType === null ? '未知卡片' : zombieDisplayName(zombieType);
}

export function modeName(mode: number): string {
  return GAME_MODE_NAMES[mode] ?? `mode_${mode}`;
}

export function plantTypeOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < PLANT_NAMES.length) {
    return value;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[ -]+/g, '_');
  if (/^\d+$/.test(normalized)) {
    const numeric = Number(normalized);
    if (numeric < PLANT_NAMES.length) return numeric;
  }
  const idx = PLANT_NAMES.indexOf(normalized as (typeof PLANT_NAMES)[number]);
  if (idx >= 0) return idx;
  const display = PLANT_DISPLAY_NAMES.indexOf(value.trim() as (typeof PLANT_DISPLAY_NAMES)[number]);
  return display < 0 ? null : display;
}

/**
 * 格子的说法。
 *
 * `R4C8` 是坐标编码,不是话。棋盘上的位置对她只有一种说法:第几排、第几列。
 * 僵尸的列位置是连续的,所以列这一侧收一位小数;排永远是整数。
 */
export function cellText(row: number, column: number): string {
  const columnText = Number.isInteger(column) ? String(column) : column.toFixed(1);
  return `第${row}排第${columnText}列`;
}

/** 只说排,不说列(割草机、整行的目标)。 */
export function rowText(row: number): string {
  return `第${row}排`;
}

/** 僵尸离房子还有多远,按画面上看得出的四段远近说。 */
export function bandText(band: 'lawn' | 'near' | 'mid' | 'far'): string {
  return ({ lawn: '已逼到房前', near: '已过半场', mid: '在草坪中段', far: '还在右侧远处' })[band];
}
