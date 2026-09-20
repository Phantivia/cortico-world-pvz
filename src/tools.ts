import type { ToolDef } from 'cortico/core/types.ts';
import { PVZ_CONDITION_DEFS, PVZ_CONDITION_SCHEMA } from './conditions.ts';

export type PvzToolDeclaration = Omit<ToolDef, 'handler'>;

export const WHACK_SKILL_QUEUE_LENGTH = 6;

const WHACK_ALL_VISIBLE_SKILL = '{skill:"special",action:"whack",targets:[{kind:"zombie",scope:"all_visible"}]}';

export function renderWhackSkillQueueCall(queue: 'replace' | 'append' = 'replace'): string {
  const queueField = queue === 'append' ? 'queue:"append",' : '';
  const steps = Array.from({ length: WHACK_SKILL_QUEUE_LENGTH }, () => WHACK_ALL_VISIBLE_SKILL)
    .join(',');
  return `pvz_do({${queueField}steps:[${steps}]})`;
}

const CELL_PROPERTIES = {
  row: { type: 'integer', minimum: 1, maximum: 6 },
  column: { type: 'integer', minimum: 1, maximum: 9 },
} as const;

const CELL_SCHEMA = {
  type: 'object',
  properties: CELL_PROPERTIES,
  required: ['row', 'column'],
  additionalProperties: false,
} as const;

const SEMANTIC_TARGET_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['plant', 'zombie', 'grid_item', 'collectible'] },
    name: { type: 'string', maxLength: 128 },
    at: CELL_SCHEMA,
  },
  required: ['kind'],
  additionalProperties: false,
} as const;

const WHACK_ALL_VISIBLE_TARGET_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['zombie'] },
    scope: { type: 'string', enum: ['all_visible'] },
  },
  required: ['kind', 'scope'],
  additionalProperties: false,
} as const;

const PVZ_STEP_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        skill: { type: 'string', enum: ['menu'] },
        action: { type: 'string', maxLength: 128 },
      },
      required: ['skill', 'action'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        skill: { type: 'string', enum: ['profile_create'] },
        name: { type: 'string', minLength: 1, maxLength: 12 },
      },
      required: ['skill', 'name'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        skill: { type: 'string', enum: ['choose_seeds'] },
        seeds: {
          type: 'array', minItems: 1, maxItems: 10, uniqueItems: true,
          items: {
            oneOf: [
              { type: 'string', maxLength: 128 },
              {
                type: 'object',
                properties: {
                  plant: { type: 'string', enum: ['imitater'] },
                  imitates: { type: 'string', maxLength: 128 },
                },
                required: ['plant', 'imitates'],
                additionalProperties: false,
              },
            ],
          },
        },
        mode: { type: 'string', enum: ['replace', 'toggle'] },
        confirm: { type: 'boolean' },
      },
      required: ['skill', 'seeds'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        skill: { type: 'string', enum: ['plant'] },
        plant: {
          oneOf: [
            { type: 'string', maxLength: 128 },
            {
              type: 'object',
              properties: {
                plant: { type: 'string', enum: ['imitater'] },
                imitates: { type: 'string', maxLength: 128 },
              },
              required: ['plant', 'imitates'],
              additionalProperties: false,
            },
          ],
        },
        ...CELL_PROPERTIES,
        row: {
          oneOf: [CELL_PROPERTIES.row, {
            type: 'object',
            properties: { bossProjectile: { type: 'string', enum: ['iceball', 'fireball'] } },
            required: ['bossProjectile'], additionalProperties: false,
          }, {
            type: 'object',
            properties: { emptyPot: { type: 'string', enum: ['nearest_house'] } },
            required: ['emptyPot'], additionalProperties: false,
          }],
          description: '排号，或执行时当前可见的指定冰火球所在排。球消失或类型不同则跳过本步。row 与 column 都写 {emptyPot:"nearest_house"} 可跨排选全棋盘最靠房子的可见空盆，同列取排号较小者；适用于寒冰菇等全场效果。没有空盆则跳过。',
        },
        column: {
          oneOf: [CELL_PROPERTIES.column, {
            type: 'object',
            properties: {
              aheadOf: { type: 'string', enum: ['nearest_hostile'] },
              minGap: { type: 'integer', minimum: 0, maximum: 8 },
            },
            required: ['aheadOf', 'minGap'], additionalProperties: false,
          }, {
            type: 'object',
            properties: { emptyPot: { type: 'string', enum: ['nearest_house'] } },
            required: ['emptyPot'], additionalProperties: false,
          }],
          description: '{emptyPot:"nearest_house"} 在本步执行前选 row 范围内最靠房子的可见空花盆；没有就跳过，不补盆，回执给出实际落点。row 是排号时只选该排；row 同样是空盆选择器时跨排选择。'
            + '相对列在真正输入时才锁目标、落子前再重算：minGap 是下限，从该排最近敌对僵尸脚下那格往屋方向数 minGap 格起，取第一个能下这株植物的格，0 即从它脚下那格起（它正在啃的那株所在格不能下，就落到前一格）。'
            + '数到棋盘外夹在第 1 列；目标消失、这排没有能下的格或卡片没准备好时这一步跳过并返回原因，后面的步骤照做；不自动换目标或换排。',
        },
        when: {
          type: 'string', enum: ['now', 'ready', 'ready_and_affordable'],
          description: '缺省 now：卡片不足、没冷却好或阳光不够就跳过这一步，后面的步骤照做。传送带超额的即时种植在受理时标记跳过，不等未来卡片。ready 等待冷却；ready_and_affordable 还等待阳光。等待会保留卡片；队列走到这一步就停下等，后面的步骤在它种下之后才做。等待期间阳光照常由 World 自动收取。',
        },
      },
      required: ['skill', 'plant', 'row', 'column'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { skill: { type: 'string', enum: ['shovel'] }, ...CELL_PROPERTIES },
      required: ['skill', 'row', 'column'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        skill: { type: 'string', enum: ['collect'] },
        what: {
          type: 'string', enum: ['coins', 'resources', 'award', 'usable_seed'],
          description: '阳光不在其中：场上的阳光由 World 自动收取，resources 也不含阳光。',
        },
        until: {
          type: 'string', enum: ['once', 'visible_clear'],
          description: 'visible_clear 持续收集当前可见类别；usable_seed 只允许 once。可在队尾单独拾取，或紧跟 special action:launch 放置；多包已知种子可按 collect、launch 成对连续安排，每次放置验真后才拾取下一包。',
        },
        plant: { type: 'string', description: '仅 usable_seed 可用：指定要拾取的植物名称。省略则拾取任意一包；指定植物当前不可见时不拾取其他种类。' },
      },
      required: ['skill', 'what'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        skill: { type: 'string', enum: ['special'] },
        action: { type: 'string', maxLength: 128,
          description: '使用状态中的特殊动作名，接受中文或规范英文。砸花瓶(break_vase)用 target:{kind:"grid_item",name:"花瓶",at:{row,column}}；放置种子包(launch)用 at:{row,column}。交换(swap)用 at/to 指定相邻格；旋转(twist)用 at 指定完整2×2区域的左上格，顺时针旋转；只有形成三连的移动会结算。购买升级(beghouled_buy)用 card 指定状态中的升级卡名。',
        },
        at: CELL_SCHEMA,
        to: CELL_SCHEMA,
        card: {
          type: 'string', maxLength: 128,
          description: '状态中的卡片语义名。',
        },
        target: { oneOf: [WHACK_ALL_VISIBLE_TARGET_SCHEMA, SEMANTIC_TARGET_SCHEMA] },
        targets: {
          type: 'array', minItems: 1, maxItems: 1,
          items: WHACK_ALL_VISIBLE_TARGET_SCHEMA,
          description: '锤击步骤使用一个 all_visible 选择器，执行时绑定最多 32 个当前可见目标。',
        },
      },
      required: ['skill', 'action'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        skill: { type: 'string', enum: ['interact'] },
        target: { type: 'string', maxLength: 128 },
      },
      required: ['skill', 'target'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        skill: {
          type: 'string', enum: ['visual_click'],
          description: '只用于没有语义菜单或对话框的未知界面；已识别的菜单和对话框走 menu。',
        },
        x: { type: 'integer', minimum: 0, maximum: 799 },
        y: { type: 'integer', minimum: 0, maximum: 599 },
      },
      required: ['skill', 'x', 'y'],
      additionalProperties: false,
    },
  ],
} as const;

export const PVZ_TOOL_DECLS: readonly PvzToolDeclaration[] = [
  {
    name: 'pvz_observe',
    tags: ['read', 'snapshot'],
    description: '读取当前界面、可见棋盘、卡片、资源、关卡进度和任务队列。'
      + '事件已经带上快照时直接用事件里的那份。',
    parameters: {
      type: 'object',
      properties: {
        detail: { type: 'string', enum: ['summary', 'full'] },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'pvz_do',
    tags: ['act'],
    description: '提交一份有序动作队列并返回任务号。每个响应最多调用一次。'
      + '确认选卡、收取奖励、界面交互、画面点击与除投掷坚果、水族馆购买僵尸和投喂以外的特殊动作会改变界面或阶段，'
      + '这类步骤放在队尾，一份队列里只放一个。bowling、buy_snorkel、drop_brain 可以连续多步，每一步都核对当前资源和目标；drop_brain 用 at 指定投喂格，每次花费5阳光，场上最多3个脑子。',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array', minItems: 1, maxItems: 64, items: PVZ_STEP_SCHEMA,
          description: '按顺序执行；前一步受阻或未验真时后面的步骤停下。要等某个事实出现再做的事不写进队列，用 pvz_arm 武装触发器。',
        },
        queue: {
          type: 'string', enum: ['replace', 'append', 'now'],
          description: 'replace 撤掉排队和等待中的任务，当前任务继续；append 保留现有任务并追加；now 中断当前任务并插到队首，其他排队和等待中的任务仍保留。清空整份旧计划用 pvz_stop。'
            + '锤僵尸棋盘上 append 只用来响应预取提示。',
        },
        cancel: {
          type: 'array', maxItems: 64, uniqueItems: true,
          items: { type: 'integer', minimum: 1 },
          description: '同时撤掉这些任务的剩余意图。只改部分计划时配合 queue:"append"；参数或新计划准入失败时不撤旧任务。已结束的任务号无须撤销。',
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'pvz_queue',
    tags: ['read', 'snapshot'],
    description: '读取当前任务、等待任务、卡片保留和最近结果。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'pvz_arm',
    tags: ['act'],
    description: '武装一个触发器：条件成立那一刻把 steps 当一份队列提交。默认一次；maxFirings 指定有限重复次数，每次须先观察到条件为假，再次成真才打响。触发器独立于队列，'
      + '不挡后面的任务。传送带默认预留全部次数的当前卡数；waitForCards:true 改为等可用余卡到达再打响，不提前占卡。'
      + '关卡结束或换棋盘时自动撤掉。撤销用 pvz_stop({triggerId})。',
    parameters: {
      type: 'object',
      $defs: PVZ_CONDITION_DEFS,
      properties: {
        when: { ...PVZ_CONDITION_SCHEMA, description: '打响条件；每份新快照重判，只有真才打响。' },
        steps: {
          type: 'array', minItems: 1, maxItems: 16, items: PVZ_STEP_SCHEMA,
          description: '打响时提交的队列，写法同 pvz_do。',
        },
        queue: {
          type: 'string', enum: ['replace', 'append', 'now'],
          description: '打响时的入队方式，缺省 now：中断当前任务插到队首，其他排队的保留。',
        },
        expiresInMs: {
          type: 'integer', minimum: 1000, maximum: 600_000,
          description: '有效期（毫秒），从武装起算；到期撤掉剩余次数。缺省到本关结束。',
        },
        maxFirings: {
          type: 'integer', minimum: 1, maximum: 16,
          description: '最多触发次数，缺省1。连续为真只触发一次；后续须条件先为假再为真。动作失败也用掉本次次数。',
        },
        waitForCards: {
          type: 'boolean',
          description: '缺省false：传送带在武装时预留全部次数的当前卡。true仅用于传送带、只收when:now的种植步骤：条件为真且这一份步骤的卡已就绪、未被其他任务占用时才提交；缺卡继续等，不消耗次数，也不阻塞队列。可等待未来到达的卡，次数与当前张数无关。落点仍在执行时检查。',
        },
      },
      required: ['when', 'steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'pvz_stop',
    tags: ['act'],
    description: '传 taskId 只撤掉该任务剩余意图；传 triggerId 撤掉一个触发器；都省略则停止并清空所有任务与触发器。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'integer', minimum: 1 }, triggerId: { type: 'integer', minimum: 1 } },
      required: [], additionalProperties: false,
    },
  },
  {
    name: 'pvz_glance',
    tags: ['read'],
    barrierAfter: true,
    description: '截取游戏窗口，用于未知界面和兼容性诊断。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];
