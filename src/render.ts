import {
  cellText,
  modeName,
  plantDisplayName,
  plantDisplayNameOf,
  plantTypeOf,
  rowText,
  specialActionDisplayName,
  zombieDisplayNameOf,
} from './names.ts';
import { renderProgress } from './progress.ts';
import { mechanicsForCard } from './card-mechanics.ts';
import {
  windowPresentationFault,
  type PvzBoardState,
  type PvzCard,
  type PvzSeedChoice,
  type PvzSnapshot,
} from './protocol.ts';
import {
  describeSemanticTargets,
  localizedCardDisplay,
  semanticMenuTarget,
  bossHeadVulnerable,
  emptyFlowerPotCells,
} from './semantic.ts';
import { progressFilteredSeedChoices } from './unlocks.ts';

const META_PROGRESS_SCREENS = new Set<PvzSnapshot['screen']>([
  'main_menu',
  'mode_selector',
  'seed_picker',
]);

function showsMetaProgress(snapshot: PvzSnapshot): boolean {
  return META_PROGRESS_SCREENS.has(snapshot.screen);
}

function seedIdentity(name: string, imitates: number | null): string {
  if (imitates !== null) return `模仿者(${plantDisplayName(imitates)})`;
  const type = plantTypeOf(name);
  return type === null ? name : plantDisplayName(type);
}

/** 卡片可用性只说此刻挡着它的那一件事:冷却没到报剩余秒数;到了只报能不能买。 */
function cardAvailability(card: PvzBoardState['cards'][number]): string {
  const price = card.cost === null ? '' : `${card.cost}阳光/`;
  if (!card.ready) return `${price}冷却剩${card.cooldownRemainingSeconds.toFixed(1)}秒`;
  return `${price}${card.affordable ? '可用' : '阳光不足'}`;
}

const MECHANIC_DELAYS: Readonly<Record<string, string>> = {
  short: '短暂延时',
  short_channel: '持续施效片刻',
  long_arming: '种下后准备较久',
  bite_then_long_digest: '吞食后消化较久',
  long_reload: '装填较久',
  short_morph_then_inherited: '变身需时',
};

function cardMechanicsFacts(card: Pick<PvzCard, 'type' | 'imitates'>): string[] {
  const mechanics = mechanicsForCard(card);
  if (!mechanics) return [];
  const facts: string[] = [];
  if (card.imitates !== null) {
    const original = mechanicsForCard({ type: card.type, imitates: null });
    const delay = original && MECHANIC_DELAYS[original.delay];
    if (delay) facts.push(delay);
  }
  if (mechanics.trigger.endsWith('_awake')) facts.push('白天入睡，需咖啡豆唤醒');
  if (mechanics.area.startsWith('short_forward')) facts.push('短程');
  if (mechanics.area === 'centered_nearby_area') facts.push('周围近程');
  if (mechanics.area === 'backward_lane') facts.push('只攻击本排列号更小的敌人，应位于敌人右侧');
  if (mechanics.area === 'forward_and_backward_lane') facts.push('同时向前后射击');
  if (mechanics.area === 'three_adjacent_forward_lanes') facts.push('向较大列号射击，覆盖本排和相邻排');
  if (mechanics.area === 'self_cell' && mechanics.trigger === 'enemy_overlap') {
    facts.push('只伤害踩在本格的地面敌人，不阻挡');
    facts.push('同排左邻坚果可把敌人留在地刺上');
  }
  if (mechanics.effect === 'block_zombies') facts.push('阻挡，自身不攻击；同排右邻地刺可伤害啃食者');
  if (mechanics.effect === 'hypnotize_biting_zombie') facts.push('被吃后魅惑咬它的僵尸');
  if (mechanics.effect === 'remove_metal_equipment') facts.push('吸走附近金属装备，自身不攻击');
  if (mechanics.effect === 'convert_passing_peas_to_fire') facts.push('点燃穿过本格的豌豆，自身不攻击');
  if (mechanics.effect === 'high_health_block_and_stop_vaulting') facts.push('阻挡并拦截撑杆跳跃');
  if (mechanics.effect === 'wake_sleeping_mushroom') facts.push('唤醒睡眠蘑菇');
  if (mechanics.effect === 'freeze_then_slow_zombies') facts.push('冻结全场后减速');
  if (mechanics.effect === 'damage_row_and_remove_ice_trails') facts.push('整排伤害并清冰道');
  const delay = MECHANIC_DELAYS[mechanics.delay];
  if (delay) facts.push(delay);
  if (mechanics.lifetime === 'single_use') facts.push('一次性');
  return facts;
}

function renderedBoardCard(board: PvzBoardState, card: PvzCard): string {
  const facts = cardMechanicsFacts(card).filter(fact =>
    ![1, 3, 5].includes(board.background) || fact !== '白天入睡，需咖啡豆唤醒');
  return `${localizedCardDisplay(board, card.slot)}[${cardAvailability(card)}]`
    + (facts.length ? `（${facts.join('；')}）` : '');
}

function seedMechanics(choices: readonly PvzSeedChoice[]): string[] {
  return choices.filter(choice => choice.state !== 'hidden').flatMap(choice => {
    const facts = cardMechanicsFacts({ type: plantTypeOf(choice.name) ?? -1, imitates: choice.imitates });
    return facts.length ? [`${seedIdentity(choice.name, choice.imitates)}（${facts.join('；')}）`] : [];
  });
}

export function conditionLabel(condition: PvzBoardState['plants'][number]['condition']): string {
  return ({ intact: '完好', worn: '轻损', damaged: '受损', critical: '濒毁' })[condition];
}

function armorLabel(condition: PvzBoardState['zombies'][number]['armor']): string {
  if (condition === 'none') return '无';
  if (condition === 'lost') return '已脱落';
  return conditionLabel(condition);
}

function plantPhase(plant: PvzBoardState['plants'][number]): string {
  if (plant.squished) return '被压扁';
  if (plant.sleeping) return '睡眠';
  const phase = plant.phase ?? 'unknown';
  if (phase === 'active' || phase === 'ready') return '生效中';
  if (phase.startsWith('potato_mine_')) {
    if (phase.endsWith('armed')) return '已准备';
    if (phase.endsWith('triggered')) return '已触发';
    return '准备中';
  }
  if (phase.startsWith('sun_shroom_')) {
    if (phase.endsWith('small')) return '幼小';
    if (phase.endsWith('growing')) return '成长中';
    return '成熟';
  }
  if (phase.includes('digest')) return '消化中';
  if (phase.includes('hiding') || phase.includes('lowering')) return '躲藏中';
  if (phase.includes('recharging') || phase.includes('loading')) return '装填中';
  if (phase.includes('firing') || phase.includes('attacking')) return '攻击中';
  if (phase === 'unknown') return '状态未知';
  return '动作中';
}

function zombieFlags(zombie: PvzBoardState['zombies'][number]): string[] {
  return [
    zombie.hypnotized ? '被魅惑' : null,
    zombie.slowed ? '减速' : null,
    zombie.immobilized ? '定身' : null,
  ].filter((flag): flag is string => flag !== null);
}

/** 完好的本体、没有的护甲与盾牌不写:一场里几千条僵尸描述,缺省态占字不占信息。 */
function zombieFacts(zombie: PvzBoardState['zombies'][number]): string {
  const aquarium = zombie.phase?.startsWith('zombiquarium_') ?? false;
  const direction = aquarium ? '游动' : zombie.speed === 'stationary' ? '静止'
    : zombie.speed === 'retreating' ? '离开房子'
      : zombie.speed === 'airborne' ? '空中移动'
        : '向房子';
  const phase = zombiePhaseLabel(zombie.phase);
  const activity = zombie.eating && phase === '行进' ? '啃食中' : phase;
  const parts = [`${zombie.speedCellsPerSecond.toFixed(2)}格/秒·${direction}`, activity];
  if (zombie.eating && activity !== '啃食中' && activity !== '进食') parts.push('啃食中');
  if (aquarium && zombie.condition === 'worn') parts.push('饥饿（身体变绿）');
  else if (zombie.condition !== 'intact') parts.push(`本体${conditionLabel(zombie.condition)}`);
  if (zombie.armor !== 'none') parts.push(`护甲${armorLabel(zombie.armor)}`);
  if (zombie.shield !== 'none') parts.push(`盾牌${armorLabel(zombie.shield)}`);
  parts.push(...zombieFlags(zombie));
  return `（${parts.join('，')}）`;
}

function zombieDescription(zombie: PvzBoardState['zombies'][number]): string {
  return `${zombieDisplayNameOf(zombie.type, zombie.name)}在${cellText(zombie.row, zombie.columnPosition)}`
    + zombieFacts(zombie);
}

/** 格里的僵尸:排由所在行给出,只写名字、小数列与状态。 */
function zombieCellDescription(zombie: PvzBoardState['zombies'][number]): string {
  return `${zombieDisplayNameOf(zombie.type, zombie.name)}${zombie.columnPosition.toFixed(1)}列${zombieFacts(zombie)}`;
}

export function zombiePhaseLabel(phase: string | undefined): string {
  if (!phase || phase === 'unknown') return '状态未知';
  if (phase === 'zombiquarium_accelerating') return '加速游动';
  if (phase === 'zombiquarium_drifting') return '漂游';
  if (phase === 'zombiquarium_turning') return '转向';
  if (phase === 'zombiquarium_biting') return '进食';
  if (phase === 'walking') return '行进';
  if (phase === 'dying') return '倒下中';
  if (phase === 'burned') return '烧毁中';
  if (phase === 'mowed') return '被割草机清除中';
  if (phase.includes('eating') || phase.includes('biting')) return '啃食中';
  if (phase.includes('rising')) return '出现中';
  if (phase.startsWith('dancer_')) return '舞蹈动作中';
  if (phase.startsWith('bungee_')) return '蹦极动作中';
  if (phase.startsWith('digger_')) return phase.includes('retreating') ? '向右撤退' : '矿工动作中';
  if (phase === 'pole_vault_ready') return '持杆，可跳跃';
  if (phase === 'pole_vaulting') return '正在撑杆跳跃';
  if (phase === 'pole_vault_spent') return '已丢杆，不能再跳';
  if (phase.startsWith('snorkel_')) return '潜水动作中';
  if (phase.startsWith('dolphin_')) return '海豚动作中';
  if (phase.startsWith('pogo_')) return '跳跃中';
  if (phase.startsWith('balloon_')) return '气球动作中';
  const bossPhase = ({
    boss_entering: '僵王入场', boss_idle: '僵王等待', boss_spawning: '投放僵尸',
    boss_stomping: '踩踏', boss_bungees_entering: '召来蹦极僵尸',
    boss_bungees_dropping: '蹦极僵尸下降', boss_bungees_leaving: '蹦极僵尸离开',
    boss_dropping_rv: '抛掷房车', boss_head_entering: '头部伸入棋盘',
    boss_aiming: '头部瞄准', boss_recovering: '头部恢复中',
    boss_spitting: '吐出冰火球', boss_head_leaving: '头部收回',
  } as Record<string, string>)[phase];
  if (bossPhase) return bossPhase;
  if (phase.includes('throwing') || phase.includes('launching')) return '投掷中';
  if (phase.includes('smashing') || phase.includes('stomping')) return '砸击中';
  return '动作中';
}

function backgroundName(background: number): string {
  return [
    '白天', '夜晚', '泳池', '夜间泳池', '屋顶', '夜间屋顶', '蘑菇园', '温室',
    '僵尸水族馆', '智慧树',
  ][background] ?? '未知';
}

function screenLabel(screen: PvzSnapshot['screen']): string {
  return ({
    loading: '载入', main_menu: '主菜单', seed_picker: '选卡', board: '棋盘',
    defeat: '失败', award: '奖励', credits: '制作人员', mode_selector: '模式选择',
    dialog: '对话框', unknown: '未知',
  })[screen];
}

function modeDisplay(snapshot: PvzSnapshot): string {
  const exact: Record<string, string> = {
    adventure: '冒险', wall_nut_bowling: '坚果保龄球', wall_nut_bowling_2: '坚果保龄球二',
    whack_a_zombie: '锤僵尸', seeing_stars: '种星星', last_stand: '坚守阵地',
    zom_botany: '植物僵尸', slot_machine: '拉霸机', its_raining_seeds: '种子雨',
    beghouled: '宝石迷阵', invisighoul: '隐形食脑者', zombiquarium: '僵尸水族馆',
    beghouled_twist: '宝石迷阵转转看', big_trouble_little_zombie: '小僵尸大麻烦',
    portal_combat: '传送门之战', column_like_you_see_em: '植物列阵',
    bobsled_bonanza: '雪橇区', zombie_nimble_zombie_quick: '僵尸快跑',
    zom_botany_2: '植物僵尸2', pogo_party: '跳跳舞会', dr_zomboss_revenge: '僵王博士的复仇',
    vasebreaker_1: '砸罐子', i_zombie_1: '我是僵尸', zen_garden: '禅境花园',
    tree_of_wisdom: '智慧树',
  };
  if (exact[snapshot.modeName]) return exact[snapshot.modeName]!;
  return ({
    adventure: '冒险', survival: '生存', minigame: '小游戏', vasebreaker: '砸罐子',
    i_zombie: '我是僵尸', zen_garden: '禅境花园', tree_of_wisdom: '智慧树', other: '其他模式',
  })[snapshot.modeKind];
}

function menuAnnotation(action: PvzSnapshot['menu'][number]): string {
  if (action.state === 'selected') return '(已选中，待确认)';
  if (action.state === 'completed') return '(已完成)';
  if (action.state === 'locked') return '(锁定)';
  if (action.state === 'unaffordable') {
    return action.record === null ? '(金币不足)' : `(价格 ${action.record}/金币不足)`;
  }
  if (action.state === 'sold_out') return '(已售罄)';
  if (action.id.startsWith('store_buy_') && action.record !== null) return `(价格 ${action.record})`;
  return action.record === null ? '' : `(纪录 ${action.record})`;
}

function renderedMenuAction(action: PvzSnapshot['menu'][number]): string {
  const target = semanticMenuTarget(action);
  const text = action.label === 'Continue Dave dialogue' ? '继续戴夫对话' : action.label;
  const label = target === text ? '' : `[${text}]`;
  const annotation = menuAnnotation(action) || (action.enabled ? '' : '(锁定)');
  return `${target}${label}${annotation}`;
}

function sortedByCell<T extends { row: number; column: number }>(items: T[]): T[] {
  return [...items].sort((left, right) =>
    left.row - right.row || left.column - right.column);
}

function terrainLabel(terrain: PvzBoardState['cells'][number]['terrain']): string {
  return ({ lawn: '草地', water: '水面', roof: '屋顶', unavailable: '不可用地格' })[terrain];
}

function gridItemLabel(kind: string): string {
  return ({
    gravestone: '墓碑', crater: '弹坑', ladder: '梯子', round_portal: '圆形传送门',
    square_portal: '方形传送门', i_zombie_brain: '脑子', vase: '花瓶',
    zen_tool: '禅境工具', stinky: '蜗牛', rake: '耙子',
  } as Record<string, string>)[kind] ?? '可见格子物件';
}

export function gridItemDescription(item: PvzBoardState['gridItems'][number]): string {
  if (item.kind !== 'vase') return gridItemLabel(item.kind);
  const facts: string[] = [];
  if (item.visibleHint === 'plant') facts.push('绿色植物罐');
  else if (item.visibleHint === 'zombie') facts.push('僵尸标记');
  const content = item.revealedContent;
  if (content) {
    const name = content.kind === 'sun' ? `阳光×${content.count}`
      : content.kind === 'plant' ? plantDisplayNameOf(content.type, content.name)
        : zombieDisplayNameOf(content.type, content.name);
    facts.push(`透视：${name}`);
  } else if (!facts.length) facts.push('内容未知');
  return `花瓶（${facts.join('；')}）`;
}

export function blockerLabel(blocker: string): string {
  return ({
    requires_lily_pad: '需要荷叶', requires_flower_pot: '需要花盆', occupied: '已占用',
    gravestone: '墓碑占用', crater: '弹坑占用', ice_trail: '冰道', shovel_tutorial_target: '教程目标',
    shovel_tutorial_locked: '教程锁定',
  } as Record<string, string>)[blocker] ?? '受阻';
}

/** 植物只在偏离缺省态(完好、生效中)时带括号说明;`extra` 是格子给它加的说明,如「荷叶上」。 */
function cellPlantLabel(plant: PvzBoardState['plants'][number], extra: readonly string[] = []): string {
  const states: string[] = [];
  if (plant.condition !== 'intact') states.push(conditionLabel(plant.condition));
  const phase = plantPhase(plant);
  if (phase !== '生效中') states.push(phase);
  states.push(...extra);
  const name = plantDisplayNameOf(plant.type, plant.name);
  return states.length ? `${name}（${states.join('，')}）` : name;
}

/** 荷叶与花盆是承载物:自己不占格,格子的空与满看它们上面有没有别的植物。 */
const CARRIER_TYPES: ReadonlyMap<number, string> = new Map([[16, '荷叶'], [33, '花盆']]);
const PUMPKIN_TYPE = 30;

/** 一格的文字。空承载物写「空荷叶」,承载物上的植物写「植物（荷叶上）」,没东西的格按地格说。 */
function boardCellLabel(board: PvzBoardState, row: number, column: number): string {
  const cell = board.cells.find((candidate) =>
    candidate.row === row && candidate.column === column)!;
  if (cell.playable === null) return '雾中未知';
  if (cell.terrain === 'unavailable') return '不可用';
  const plants = sortedByCell(board.plants.filter((plant) =>
    plant.row === row && plant.column === column));
  const carriers = plants.filter((plant) => CARRIER_TYPES.has(plant.type));
  const pumpkins = plants.filter((plant) => plant.type === PUMPKIN_TYPE);
  const others = plants.filter((plant) =>
    !CARRIER_TYPES.has(plant.type) && plant.type !== PUMPKIN_TYPE);
  const items = board.gridItems.filter((item) => item.row === row && item.column === column)
    .map(gridItemDescription);
  const onCarrier = carriers.map((carrier) => `${CARRIER_TYPES.get(carrier.type)}上`);
  const contents = [
    ...others.map((plant) => cellPlantLabel(plant, onCarrier)),
    ...pumpkins.map((plant) => cellPlantLabel(plant)),
    ...items,
  ];
  if (contents.length) return contents.join('+');
  if (carriers.length) {
    return carriers.map((carrier) => {
      const states = carrier.condition === 'intact' ? '' : `（${conditionLabel(carrier.condition)}）`;
      return `空${CARRIER_TYPES.get(carrier.type)}${states}`;
    }).join('+');
  }
  if (cell.blocker === 'requires_lily_pad') return '水';
  if (cell.blocker === 'requires_flower_pot') return '需花盆';
  if (cell.blocker) return blockerLabel(cell.blocker);
  return '空';
}

function semanticBoardMatrix(board: PvzBoardState): string[][] {
  return Array.from({ length: board.rows }, (_, rowIndex) =>
    Array.from({ length: board.columns }, (_, columnIndex) => {
      const row = rowIndex + 1;
      const column = columnIndex + 1;
      const cell = board.cells.find((candidate) =>
        candidate.row === row && candidate.column === column)!;
      if (!board.disclosure.entitiesVisible) return '黑暗未知';
      if (cell.playable === null) return '雾中未知';
      if (cell.terrain === 'unavailable') return '不可用地格';
      const contents = [
        ...sortedByCell(board.plants.filter((plant) =>
          plant.row === row && plant.column === column)).map((plant) => cellPlantLabel(plant)),
        ...board.gridItems.filter((item) => item.row === row && item.column === column)
          .map(gridItemDescription),
      ];
      if (contents.length) return `${terrainLabel(cell.terrain)}·${contents.join('+')}`;
      if (cell.blocker) return `${terrainLabel(cell.terrain)}·${blockerLabel(cell.blocker)}`;
      return `空${terrainLabel(cell.terrain)}`;
    }),
  );
}

/** 僵尸站在游戏判给它的那格(`column`),走进房子或还没上棋盘时夹到边上那格,小数列照写。 */
function zombieCell(board: PvzBoardState, zombie: PvzBoardState['zombies'][number]): number {
  return Math.min(board.columns, Math.max(1, zombie.column));
}

/**
 * 棋盘逐格写出:每格前缀列号,承载物、地格与僵尸都在格里。整排常数长度,位置不靠数格
 * 也不靠对齐;僵尸跟在它脚下那格后面,相对落点的 minGap 从这一格起数。
 */
function boardRowLines(board: PvzBoardState): string[] {
  const size = `${board.rows}排×${board.columns}列`;
  if (!board.disclosure.entitiesVisible) return [`棋盘 ${size} 黑暗中不可见`];
  // 「←后是站在这格的僵尸」这条读法是常量,写在 ENV_PROMPT 里,不按快照份数重复
  const lines = [`棋盘 ${size}（第1列靠房子；格前数字是列号）`];
  for (let row = 1; row <= board.rows; row++) {
    const cells = Array.from({ length: board.columns }, (_, index) => ({
      column: index + 1,
      terrain: board.cells.find((candidate) =>
        candidate.row === row && candidate.column === index + 1)!.terrain,
    }));
    if (cells.every((cell) => cell.terrain === 'unavailable')) {
      lines.push(`${rowText(row)} 不可用`);
      continue;
    }
    const terrain = cells.find((cell) => cell.terrain !== 'unavailable')!.terrain;
    const head = terrain === 'lawn' ? rowText(row) : `${rowText(row)}（${terrainLabel(terrain)}）`;
    const zombies = sortedByCell(board.zombies.filter((zombie) => zombie.row === row));
    const rendered = cells.map(({ column }) => {
      const standing = zombies.filter((zombie) => zombieCell(board, zombie) === column)
        .map(zombieCellDescription);
      return `${column}${boardCellLabel(board, row, column)}${standing.length ? `←${standing.join('、')}` : ''}`;
    });
    lines.push(`${head} ${rendered.join(' ')}`);
  }
  return lines;
}

interface SemanticCollectibleCount {
  kind: string;
  count: number;
}

export function collectibleName(item: PvzBoardState['collectibles'][number]): string {
  const kind = ({
    silver_coin: '银币', gold_coin: '金币', diamond: '钻石', sun: '阳光',
    small_sun: '小阳光', large_sun: '大阳光', seed_packet: '种子包', trophy: '奖杯',
    usable_seed: '可用种子包', chocolate: '巧克力', money_bag: '钱袋', present: '礼盒',
    silver_sunflower: '银向日葵奖杯', gold_sunflower: '金向日葵奖杯',
  } as Record<string, string>)[item.kind] ?? '收集物';
  if (item.kind === 'usable_seed' && item.containedType !== undefined) {
    const facts = cardMechanicsFacts({ type: item.containedType, imitates: null });
    return `${kind}（${[plantDisplayName(item.containedType), ...facts].join('；')}）`;
  }
  return item.containedName ? `${kind}(${item.containedName})` : kind;
}

function collectibleCounts(board: PvzBoardState): SemanticCollectibleCount[] {
  const counts = new Map<string, number>();
  for (const item of board.collectibles) {
    const name = collectibleName(item);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts, ([kind, count]) => ({ kind, count }))
    .sort((left, right) => left.kind.localeCompare(right.kind));
}

function renderCollectibleCounts(board: PvzBoardState): string {
  return collectibleCounts(board).map(({ kind, count }) => `${kind}×${count}`).join(', ') || '无';
}

function compactNumbers(values: number[]): string {
  const sorted = [...new Set(values)].sort((left, right) => left - right);
  const ranges: string[] = [];
  for (let index = 0; index < sorted.length;) {
    const start = sorted[index]!;
    let end = start;
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) {
      index += 1;
      end = sorted[index]!;
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    index += 1;
  }
  return ranges.join(',');
}

function compactTargetDescriptions(descriptions: string[]): string[] {
  const direct: string[] = [];
  const cells = new Map<string, Map<number, number[]>>();
  for (const description of descriptions) {
    const match = /^(.*)在第(\d+)排第(\d+)列$/.exec(description);
    if (!match) {
      direct.push(description);
      continue;
    }
    const [, prefix, rowText, columnText] = match;
    const row = Number(rowText);
    const column = Number(columnText);
    const rows = cells.get(prefix!) ?? new Map<number, number[]>();
    const columns = rows.get(row) ?? [];
    columns.push(column);
    rows.set(row, columns);
    cells.set(prefix!, rows);
  }

  const compacted: string[] = [];
  for (const [prefix, rows] of cells) {
    const rowsByColumns = new Map<string, number[]>();
    for (const [row, columns] of rows) {
      const columnRange = compactNumbers(columns);
      const groupedRows = rowsByColumns.get(columnRange) ?? [];
      groupedRows.push(row);
      rowsByColumns.set(columnRange, groupedRows);
    }
    for (const [columns, groupedRows] of rowsByColumns) {
      compacted.push(`${prefix}在第${compactNumbers(groupedRows)}排第${columns}列`);
    }
  }
  return [...compacted, ...direct];
}

function semanticTargetDescriptions(
  board: PvzBoardState,
  detail: 'summary' | 'full',
  includeObjective = false,
): { descriptions: string[]; remaining: number } {
  if (!board.special) return { descriptions: [], remaining: 0 };
  const actions = [...new Set(board.special.targets.map((target) => target.action))]
    .filter((action) => includeObjective || action !== 'objective_starfruit');
  const all = compactTargetDescriptions(
    actions.flatMap((action) => describeSemanticTargets(board, action)),
  );
  const limit = detail === 'full' ? 200 : 32;
  return {
    descriptions: all.slice(0, limit),
    remaining: Math.max(0, all.length - limit),
  };
}

function renderSemanticTargets(board: PvzBoardState, detail: 'summary' | 'full'): string {
  const { descriptions, remaining } = semanticTargetDescriptions(board, detail);
  return `${descriptions.join(', ')}${remaining ? `, …另 ${remaining} 项` : ''}`;
}

export function mowerName(kind: string): string {
  return ({
    lawn_mower: '割草机', pool_cleaner: '泳池清洁车', roof_cleaner: '屋顶清洁车',
    super_mower: '强化割草机',
  } as Record<string, string>)[kind] ?? '清场车';
}

function renderMowers(board: PvzBoardState): string {
  const ready = board.mowers.filter((mower) => mower.state === 'ready')
    .map((mower) => `${rowText(mower.row)}${mowerName(mower.kind)}待命`);
  const triggered = board.mowers.filter((mower) => mower.state === 'triggered')
    .map((mower) => `${rowText(mower.row)}${mowerName(mower.kind)}已触发`);
  const squished = board.mowers.filter((mower) => mower.state === 'squished')
    .map((mower) => `${rowText(mower.row)}${mowerName(mower.kind)}被压毁`);
  return [...ready, ...triggered, ...squished].join(', ') || '无';
}

function renderBoardCards(board: PvzBoardState): string[] {
  if (!board.cards.length || board.cards.some(card => card.cost !== null)) {
    return board.cards.map(card => renderedBoardCard(board, card));
  }
  const groups = new Map<string, PvzCard[]>();
  for (const card of board.cards) {
    const key = `${card.type}:${card.imitates}`;
    const group = groups.get(key) ?? [];
    group.push(card);
    groups.set(key, group);
  }
  return [...groups.values()].map(cards => {
    const card = cards[0]!;
    const available = cards.filter(card => card.ready && card.affordable).length;
    const facts = cardMechanicsFacts(card).filter(fact =>
      ![1, 3, 5].includes(board.background) || fact !== '白天入睡，需咖啡豆唤醒');
    return `${seedIdentity(card.name, card.imitates)}×${cards.length}张[就绪${available}张]`
      + (facts.length ? `（${facts.join('；')}）` : '');
  });
}

function emptyFlowerPots(board: PvzBoardState): string[] {
  if (!board.disclosure.entitiesVisible || !board.boss) return [];
  const pots = emptyFlowerPotCells(board);
  return [pots.length ? `空花盆落点：${pots.map(pot => cellText(pot.row, pot.column)).join('、')}` : '空花盆落点：无'];
}

export function cursorDescription(cursor: PvzBoardState['cursor']): string {
  const labels: Record<string, string> = {
    normal: '无', plant: '卡片', usable_seed: '可用种子包', glove_plant: '手套中的植物',
    duplicator: '复制工具', wheelbarrow_plant: '推车中的植物', shovel: '铲子', hammer: '锤子',
    cob_cannon_target: '玉米炮瞄准', watering_can: '水壶', fertilizer: '肥料',
    bug_spray: '杀虫剂', phonograph: '唱片机', chocolate: '巧克力', glove: '手套',
    money_sign: '出售工具', wheelbarrow: '推车', tree_food: '树肥',
  };
  const label = labels[cursor.kind] ?? '未知工具';
  if (cursor.kind === 'usable_seed' && cursor.heldType !== null) {
    const facts = cardMechanicsFacts({ type: cursor.heldType, imitates: null });
    return `${label}（${[plantDisplayName(cursor.heldType), ...facts].join('；')}）`;
  }
  return ['plant', 'usable_seed', 'glove_plant', 'wheelbarrow_plant'].includes(cursor.kind)
    ? `${label}（${cursor.heldType === null ? '种类未知' : plantDisplayName(cursor.heldType)}）`
    : label;
}

function shovelTutorialPhase(phase: NonNullable<PvzBoardState['tutorial']>['phase']): string {
  if (phase === 'pickup') return '拿起铲子';
  if (phase === 'dig') return '铲除植物';
  return '继续铲除';
}

export function renderPortals(board: PvzBoardState): string[] {
  if (!board.disclosure.entitiesVisible) return [];
  return ['square_portal', 'round_portal'].flatMap((kind) => {
    const portals = sortedByCell(board.gridItems.filter((item) => item.kind === kind));
    return portals.length ? [`${gridItemLabel(kind)}${portals.length > 2 ? '可见位置' : ''}：${portals.map((item) =>
      item.column > board.columns ? `${rowText(item.row)}右边界` : cellText(item.row, item.column)
    ).join(portals.length === 2 ? ' ↔ ' : '、')}`] : [];
  });
}

export function renderBossProjectile(ball: NonNullable<NonNullable<PvzBoardState['boss']>['projectile']>): string {
  return `${ball.kind === 'fireball' ? '火球' : '冰球'}在${cellText(ball.row, ball.columnPosition)}，向房子滚动`;
}

function renderBoss(board: PvzBoardState): string[] {
  if (!board.disclosure.entitiesVisible || !board.boss) return [];
  return [
    `僵王在棋盘右侧：${zombiePhaseLabel(board.boss.phase)}，头部${bossHeadVulnerable(board.boss.phase) ? '可' : '不可'}受伤${board.boss.immobilized ? '，定身' : ''}`,
    ...(board.boss.projectile ? [renderBossProjectile(board.boss.projectile)] : []),
  ];
}

function compactBoard(snapshot: PvzSnapshot, detail: 'summary' | 'full'): string[] {
  const board = snapshot.board;
  if (!board || snapshot.screen !== 'board') return [];
  if (board.tutorial) {
    return [
      `关卡 ${board.level} · 铲子教程`,
      `阶段 ${shovelTutorialPhase(board.tutorial.phase)} · 剩余 ${board.tutorial.remainingPlants}`,
      ...boardRowLines(board),
    ];
  }
  const entitiesVisible = board.disclosure.entitiesVisible;
  // 坐标朝向是游戏规则,不是这一刻的世界:它写在 ENV_PROMPT 里,每份快照再说一遍
  // 就是把同一条常量按投递次数计费(棋盘行首还带着「第1列靠房子」)。
  const lines = [
    `关卡 ${board.level} · ${modeDisplay(snapshot)} · ${backgroundName(board.background)} · ${board.paused ? '暂停' : '进行中'}`,
    `阳光 ${board.sun} · ${renderProgress(board.progress)}`,
    `卡片 ${renderBoardCards(board).join(' ') || '无'}`,
    `手持 ${cursorDescription(board.cursor)}`,
    ...boardRowLines(board),
    // 僵尸写在棋盘格里;黑暗里棋盘整行不可见,单独说一句
    ...renderPortals(board),
    ...renderBoss(board),
    ...emptyFlowerPots(board),
    ...(entitiesVisible ? [] : ['僵尸 黑暗中不可见']),
    entitiesVisible
      ? `收集物 ${renderCollectibleCounts(board)}`
      : '收集物 黑暗中不可见',
    entitiesVisible
      ? `割草机 ${renderMowers(board)}`
      : '割草机 黑暗中不可见',
  ];
  if (board.fog.visibilityRule === 'invisighoul') lines.push('僵尸隐形，数量与位置未知');
  else if (board.fog.active) lines.push('雾中未知格允许盲放，动态占用未知');
  if (!entitiesVisible) lines.push('黑暗阶段只允许盲放卡片');
  if (board.allowedSpecialActions.length) {
    lines.push(`特殊动作 ${board.allowedSpecialActions.map(specialActionDisplayName).join('、')}`);
  }
  if (board.special) {
    lines.push(`特殊阶段 ${board.special.settled ? '稳定' : '结算中'}`);
    if (entitiesVisible) {
      const objectives = describeSemanticTargets(board, 'objective_starfruit');
      if (objectives.length) lines.push(`种星星剩余目标 ${objectives.join(', ')}`);
      const specialTargets = renderSemanticTargets(board, detail);
      if (specialTargets) lines.push(`特殊目标 ${specialTargets}`);
    } else if (board.special.targets.length) {
      lines.push('特殊目标 黑暗中不可见');
    }
  }
  return lines;
}

function seedPickerLines(snapshot: PvzSnapshot): string[] {
  const picker = snapshot.seedPicker;
  if (!picker) return [];
  const choices = progressFilteredSeedChoices(snapshot.profile, picker.choices);
  const mechanics = seedMechanics(choices);
  const selected = picker.selected.map((internalId) => {
    const choice = choices.find((candidate) => candidate.id === internalId);
    return choice
      ? `${seedIdentity(choice.name, choice.imitates)}${choice.fixed ? '[固定]' : ''}`
      : 'unknown';
  });
  return [
    `选卡 ${selected.length}/${picker.capacity}: ${selected.join(', ') || '尚未选择'}`,
    `可选植物: ${choices.filter((choice) => choice.state !== 'hidden')
      .map((choice) => `${seedIdentity(choice.name, choice.imitates)}${choice.state === 'selected' ? '*' : ''}${choice.fixed ? '[固定]' : ''}`)
      .join(', ') || '无'}`,
    ...(mechanics.length ? [`卡片机制: ${mechanics.join('；')}`] : []),
    ...(picker.previewZombies.length
      ? [`本关预告敌人: ${picker.previewZombies.map((zombie) => zombieDisplayNameOf(zombie.type, zombie.name)).join(', ')}`]
      : []),
    `选卡状态=${picker.ready ? '可以开始' : '尚未就绪'}`,
  ];
}

export function renderSnapshot(snapshot: PvzSnapshot, detail: 'summary' | 'full' = 'summary'): string {
  const lines = [`[PvZ 状态 r${snapshot.revision}] 画面=${screenLabel(snapshot.screen)} 模式=${modeDisplay(snapshot)}`];
  if (!snapshot.executable.supported) lines.push('状态=只读/不受支持');
  const windowFault = windowPresentationFault(snapshot.presentation);
  if (windowFault !== null) lines.push(windowFault);

  const includeMetaProgress = showsMetaProgress(snapshot);
  if (includeMetaProgress && snapshot.profile) {
    lines.push(
      `档案 ${snapshot.profile.name}: 冒险 ${snapshot.profile.adventureLevel}, 通关 ${snapshot.profile.adventureCompletions}, 金币 ${snapshot.profile.coins}`,
      `模式解锁 小游戏=${snapshot.profile.minigamesUnlocked ? '是' : '否'} · 解谜=${snapshot.profile.puzzleUnlocked ? '是' : '否'} · 生存=${snapshot.profile.survivalUnlocked ? '是' : '否'}`,
    );
  }
  if (includeMetaProgress && snapshot.lastRun) {
    lines.push(
      `最近结算 ${snapshot.lastRun.outcome === 'won' ? '胜利' : '失败'}`
      + ` · ${modeName(snapshot.lastRun.mode)} · 关卡 ${snapshot.lastRun.level}`,
    );
  }
  if (snapshot.menu.length) {
    lines.push(`可用菜单动作: ${snapshot.menu.map(renderedMenuAction).join(', ')}`);
  }
  lines.push(...seedPickerLines(snapshot));
  lines.push(...compactBoard(snapshot, detail));

  return lines.join('\n');
}

export function renderTacticalSnapshot(snapshot: PvzSnapshot): string {
  return renderSnapshot(snapshot, 'summary');
}

function compactMenu(snapshot: PvzSnapshot): string[] {
  return snapshot.menu.map(renderedMenuAction);
}

function compactSeedPicker(snapshot: PvzSnapshot): Record<string, unknown> | null {
  const picker = snapshot.seedPicker;
  if (!picker) return null;
  const choices = progressFilteredSeedChoices(snapshot.profile, picker.choices);
  const mechanics = seedMechanics(choices);
  const selected = picker.selected.map((internalId) => {
    const choice = choices.find((candidate) => candidate.id === internalId);
    return choice
      ? `${seedIdentity(choice.name, choice.imitates)}${choice.fixed ? '[固定]' : ''}`
      : 'unknown';
  });
  return {
    容量: picker.capacity,
    已选: selected,
    可选: choices.filter((choice) => choice.state !== 'hidden')
      .map((choice) => `${seedIdentity(choice.name, choice.imitates)}${choice.fixed ? '[固定]' : ''}`),
    ...(mechanics.length ? { 卡片机制: mechanics } : {}),
    敌人预告: picker.previewZombies.map((zombie) => zombieDisplayNameOf(zombie.type, zombie.name)),
    可开始: picker.ready,
  };
}

function compactSpecial(board: PvzBoardState): Record<string, unknown> | null {
  if (!board.special) return null;
  const { descriptions, remaining } = semanticTargetDescriptions(board, 'summary', true);
  return {
    阶段: board.special.settled ? '稳定' : '结算中',
    动作: board.allowedSpecialActions.map(specialActionDisplayName),
    目标: descriptions,
    ...(remaining ? { 其余目标数: remaining } : {}),
  };
}

function semanticBoard(snapshot: PvzSnapshot, board: PvzBoardState): Record<string, unknown> {
  if (board.tutorial) {
    return {
      关卡: board.level,
      模式: '铲子教程',
      阶段: shovelTutorialPhase(board.tutorial.phase),
      剩余目标: board.tutorial.remainingPlants,
      棋盘: semanticBoardMatrix(board),
    };
  }
  const visible = board.disclosure.entitiesVisible;
  return {
    关卡: board.level,
    模式: modeDisplay(snapshot),
    场景: backgroundName(board.background),
    状态: board.paused ? '暂停' : '进行中',
    方向: `第1列靠着房子，第${board.columns}列出怪，僵尸朝列号更小的方向走`,
    阳光: board.sun,
    进度: renderProgress(board.progress),
    棋盘: semanticBoardMatrix(board),
    卡片: renderBoardCards(board),
    ...(renderPortals(board).length ? { 传送门: renderPortals(board) } : {}),
    ...(renderBoss(board).length ? { 僵王: renderBoss(board) } : {}),
    ...(emptyFlowerPots(board).length ? { 空花盆: emptyFlowerPots(board) } : {}),
    手持: cursorDescription(board.cursor),
    僵尸: visible ? sortedByCell(board.zombies).map(zombieDescription) : '黑暗中不可见',
    收集物: visible ? renderCollectibleCounts(board) : '黑暗中不可见',
    割草机: visible ? renderMowers(board) : '黑暗中不可见',
    ...(board.fog.visibilityRule === 'invisighoul'
      ? { 可见性: '僵尸隐形，数量与位置未知' }
      : board.fog.active ? { 雾: '未知格允许盲放' } : {}),
    ...(board.special ? { 特殊: compactSpecial(board) } : {}),
  };
}

export function compactSnapshot(snapshot: PvzSnapshot): Record<string, unknown> {
  const common: Record<string, unknown> = {
    修订: snapshot.revision,
    画面: screenLabel(snapshot.screen),
    模式: modeDisplay(snapshot),
    菜单: compactMenu(snapshot),
  };
  if (snapshot.screen === 'board') {
    return {
      ...common,
      棋盘状态: snapshot.board ? semanticBoard(snapshot, snapshot.board) : null,
    };
  }
  const includeMetaProgress = showsMetaProgress(snapshot);
  return {
    ...common,
    ...(includeMetaProgress && snapshot.profile
      ? {
          档案: {
            名称: snapshot.profile.name,
            冒险关卡: snapshot.profile.adventureLevel,
            通关次数: snapshot.profile.adventureCompletions,
            金币: snapshot.profile.coins,
          },
        }
      : {}),
    ...(includeMetaProgress && snapshot.lastRun
      ? {
          最近结算: {
            结果: snapshot.lastRun.outcome === 'won' ? '胜利' : '失败',
            模式: modeName(snapshot.lastRun.mode),
            关卡: snapshot.lastRun.level,
          },
        }
      : {}),
    ...(snapshot.seedPicker ? { 选卡: compactSeedPicker(snapshot) } : {}),
  };
}
