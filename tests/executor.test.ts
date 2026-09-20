import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PvzExecutor,
  renderPvzQueue,
  type PvzReservedCard,
  type PvzStepResult,
  type PvzTaskReport,
} from '../src/executor.ts';
import {
  parsePvzDo,
  parsePvzQueueMode,
  type PvzDoStep,
} from '../src/skills.ts';
import {
  PVZ_TOOL_DECLS,
  renderWhackSkillQueueCall,
  WHACK_SKILL_QUEUE_LENGTH,
} from '../src/tools.ts';
import type { PvzSnapshot } from '../src/protocol.ts';
import { boardState, snapshot } from './helpers.ts';

function parsed(raw: unknown[]): PvzDoStep[] {
  const result = parsePvzDo(raw);
  if ('error' in result) throw new Error(result.error);
  return result.steps;
}

it('种子拾取植物名规范化并拒绝无关资源的植物选择器', () => {
  expect(parsed([{ skill: 'collect', what: 'usable_seed', plant: '荷叶' }])).toEqual([
    { skill: 'collect', what: 'usable_seed', plant: 'lily_pad', until: 'once' },
  ]);
  expect(parsePvzDo([{ skill: 'collect', what: 'coins', plant: '荷叶' }])).toHaveProperty('error');
  expect(parsePvzDo([{ skill: 'collect', what: 'usable_seed', plant: 'unknown' }])).toHaveProperty('error');
});

it('launch 接受排内方向选择器并拒绝混用固定格或其他动作', () => {
  const step = { skill: 'special', action: 'launch', placement: { row: 3, edge: 'farthest_house' } };
  expect(parsed([step])).toEqual([step]);
  for (const invalid of [
    { ...step, at: { row: 3, column: 9 } },
    { ...step, action: 'drop_brain' },
    ...[0, 7, 1.5, '3'].map(row => ({ ...step, placement: { ...step.placement, row } })),
    { ...step, placement: { row: 3, edge: 'any' } },
  ]) expect(parsePvzDo([invalid])).toHaveProperty('error');
});

it('launch parses relative packet placement and rejects mixed or incomplete selectors', () => {
  const step = { skill: 'special', action: 'launch', placement: { row: 2, aheadOf: 'nearest_hostile', minGap: 1 } };
  expect(parsed([step])).toEqual([step]);
  for (const placement of [
    { row: 2, aheadOf: 'nearest_hostile' },
    { ...step.placement, edge: 'nearest_house' },
    { ...step.placement, aheadOf: 'any' },
    ...[-1, 9, 0.5, '1'].map(minGap => ({ ...step.placement, minGap })),
  ]) expect(parsePvzDo([{ ...step, placement }])).toHaveProperty('error');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function idSequence() {
  let id = 0;
  return () => ++id;
}

const done = (text: string): PvzStepResult => ({ outcome: 'done', text });

describe('pvz_do semantic parser', () => {
  it('reports unrecognized string plant names without calling them numeric selectors', () => {
    for (const name of ['lilypad', 'snowpea', 'cherrybomb', 'wallnut']) {
      expect(parsePvzDo([{ skill: 'choose_seeds', seeds: ['sunflower', name] }])).toEqual({
        error: `第 1 步 seeds 无法识别植物名 "${name}"；请使用当前可选卡片列出的名称`,
      });
    }
  });

  it('keeps numbers and numeric strings rejected with the numeric selector explanation', () => {
    for (const name of [0, 16, '0', '16', ' 16 ']) {
      expect(parsePvzDo([{ skill: 'choose_seeds', seeds: [name] }])).toEqual({
        error: '第 1 步 seeds 禁止数字植物名，必须写当前可选卡片的名称',
      });
    }
  });

  it('reports empty names as unrecognized rather than numeric', () => {
    for (const name of ['', '  ']) {
      expect(parsePvzDo([{ skill: 'choose_seeds', seeds: [name] }])).toEqual({
        error: `第 1 步 seeds 无法识别植物名 ${JSON.stringify(name)}；请使用当前可选卡片列出的名称`,
      });
    }
  });

  it('retains existing canonical, Chinese and imitater names without adding aliases', () => {
    expect(parsePvzDo([{ skill: 'choose_seeds', seeds: [
      'lily_pad', '寒冰射手', 'cherry_bomb', '坚果', { plant: 'imitater', imitates: 'sunflower' },
    ], confirm: true }])).toEqual({ steps: [{
      skill: 'choose_seeds', mode: 'replace', confirm: true,
      seeds: ['lily_pad', 'snow_pea', 'cherry_bomb', 'wall_nut', { plant: 'imitater', imitates: 'sunflower' }],
    }] });
  });

  it('normalizes every first-milestone semantic step without exposing native ids or slots', () => {
    expect(parsePvzQueueMode(undefined)).toEqual({ mode: 'replace' });
    expect(parsePvzQueueMode('append')).toEqual({ mode: 'append' });
    expect(parsePvzQueueMode('later')).toEqual({ error: 'queue 只认 replace/append/now(不写 = replace)' });

    const result = parsePvzDo([
      { skill: 'menu', action: 'adventure' },
      { skill: 'profile_create', name: 'Alice' },
      { skill: 'choose_seeds', seeds: ['Sunflower', { plant: 'Imitater', imitates: 'Wall-Nut' }] },
      { skill: 'plant', plant: 'Snow Pea', row: 2, column: 3 },
      { skill: 'shovel', row: 2, column: 3 },
      { skill: 'collect', what: 'resources', until: 'visible_clear' },
      {
        skill: 'special', action: 'place_zombie',
        at: { row: 2, column: 1 }, to: { row: 4, column: 8 }, card: 'buckethead_zombie',
        target: { kind: 'zombie', name: 'gargantuar', at: { row: 4, column: 8 } },
      },
      { skill: 'interact', target: 'store_buy_fertilizer' },
      { skill: 'visual_click', x: 400, y: 300 },
    ]);
    if ('error' in result) throw new Error(result.error);
    expect(result.steps).toHaveLength(9);
    expect(result.steps[6]).toMatchObject({ card: 'buckethead_zombie' });
    expect(result.steps.slice(0, 4)).toEqual([
      { skill: 'menu', action: 'adventure' },
      { skill: 'profile_create', name: 'Alice' },
      {
        skill: 'choose_seeds', mode: 'replace', confirm: false,
        seeds: ['sunflower', { plant: 'imitater', imitates: 'wall_nut' }],
      },
      { skill: 'plant', plant: 'snow_pea', row: 2, column: 3, when: 'now' },
    ]);
    expect(parsed([{
      skill: 'plant',
      plant: { plant: 'Imitater', imitates: 'Peashooter' },
      row: 1,
      column: 2,
      when: 'ready',
    }])).toEqual([{
      skill: 'plant',
      plant: { plant: 'imitater', imitates: 'peashooter' },
      row: 1,
      column: 2,
      when: 'ready',
    }]);
    expect(parsed([{
      skill: 'special', action: 'whack',
      targets: [
        { kind: 'zombie', at: { row: 2, column: 3 } },
        { kind: 'zombie', name: 'conehead', at: { row: 4, column: 6 } },
      ],
    }])).toEqual([{
      skill: 'special', action: 'whack',
      targets: [
        { kind: 'zombie', at: { row: 2, column: 3 } },
        { kind: 'zombie', name: 'conehead', at: { row: 4, column: 6 } },
      ],
    }]);
    expect(parsed([{
      skill: 'special', action: 'whack',
      target: { kind: 'zombie', at: { row: 1, column: 2 } },
    }])).toEqual([{
      skill: 'special', action: 'whack',
      targets: [{ kind: 'zombie', at: { row: 1, column: 2 } }],
    }]);
    expect(parsed([{
      skill: 'special', action: 'whack',
      targets: [{ kind: 'zombie', scope: 'all_visible' }],
    }])).toEqual([{
      skill: 'special', action: 'whack',
      targets: [{ kind: 'zombie', scope: 'all_visible' }],
    }]);
    expect(parsed([{
      skill: 'special', action: 'whack',
      target: { kind: 'zombie', scope: 'all_visible' },
    }])).toEqual([{
      skill: 'special', action: 'whack',
      targets: [{ kind: 'zombie', scope: 'all_visible' }],
    }]);
  });

  it.each([
    [{ skill: 'plant', plant: 0, row: 1, column: 1 }],
    [{ skill: 'plant', plant: '0', row: 1, column: 1 }],
    [{ skill: 'plant', plant: 'pea_shooter', row: 1, column: 1 }],
    [{ skill: 'plant', card: { slot: 0 }, row: 1, column: 1 }],
    [{ skill: 'choose_seeds', seeds: [0] }],
    [{ skill: 'choose_seeds', seeds: ['wallnut'] }],
    [{ skill: 'collect', ids: [12] }],
    [{ skill: 'collect', what: 'usable_seed', until: 'visible_clear' }],
    [{ skill: 'special', action: 'bowling', slot: 0, at: { row: 1, column: 1 } }],
    [{ skill: 'special', action: 'whack', targetId: 42 }],
    [{ skill: 'special', action: 'whack', target: 'nearest_zombie' }],
    [{ skill: 'special', action: 'whack', target: { kind: 'cell', at: { row: 1, column: 1 } } }],
    [{ skill: 'special', action: 'whack' }],
    [{ skill: 'special', action: 'whack', until: 'visible_clear' }],
    [{ skill: 'special', action: 'whack', until: 'level_end' }],
    [{ skill: 'special', action: 'bowling', until: 'level_end' }],
    [{
      skill: 'special', action: 'whack',
      target: { kind: 'zombie', at: { row: 1, column: 1 } },
      targets: [{ kind: 'zombie', at: { row: 2, column: 1 } }],
    }],
    [{ skill: 'special', action: 'whack', targets: [] }],
    [{ skill: 'special', action: 'whack', at: { row: 1, column: 1 }, targets: [
      { kind: 'zombie', at: { row: 1, column: 1 } },
    ] }],
    [{ skill: 'special', action: 'whack', targets: [
      { kind: 'plant', at: { row: 1, column: 1 } },
    ] }],
    [{ skill: 'special', action: 'whack', targets: [
      { kind: 'zombie', at: { row: 1, column: 1 } },
      { kind: 'zombie', at: { row: 1, column: 1 } },
    ] }],
    [{ skill: 'special', action: 'whack', targets: [
      { kind: 'zombie', row: 1, count: 1 },
    ] }],
    [{ skill: 'special', action: 'whack', targets: [
      { kind: 'zombie', scope: 'all_visible' },
      { kind: 'zombie', at: { row: 2, column: 4 } },
    ] }],
    [{ skill: 'special', action: 'whack', targets: [
      { kind: 'zombie', scope: 'all_visible' },
      { kind: 'zombie', scope: 'all_visible' },
    ] }],
    [{ skill: 'special', action: 'break_vase', target: {
      kind: 'zombie', scope: 'all_visible',
    } }],
    [{ skill: 'special', action: 'break_vase', targets: [
      { kind: 'grid_item', at: { row: 1, column: 1 } },
    ] }],
  ])('rejects opaque native selectors: %j', (step) => {
    const result = parsePvzDo([step]);
    expect(result).toHaveProperty('error');
  });

  it('rejects Whack-a-Zombie batches beyond the finite target limit', () => {
    const targets = Array.from({ length: 33 }, (_, index) => ({
      kind: 'zombie', at: { row: index % 6 + 1, column: index % 9 + 1 },
    }));
    expect(parsePvzDo([{ skill: 'special', action: 'whack', targets }]))
      .toEqual({ error: '第 1 步 targets 必须是 1–32 个语义目标' });
  });

  it('accepts the localized special-action name shown in snapshots', () => {
    expect(parsePvzDo([{
      skill: 'special', action: '锤击',
      targets: [{ kind: 'zombie', scope: 'all_visible' }],
    }])).toEqual({
      steps: [{
        skill: 'special', action: 'whack',
        targets: [{ kind: 'zombie', scope: 'all_visible' }],
      }],
    });
  });

  it('publishes the finite multi-skill Whack queue contract without a level watcher field', () => {
    const tool = PVZ_TOOL_DECLS.find((candidate) => candidate.name === 'pvz_do')!;
    const parameters = tool.parameters as Record<string, unknown>;
    const properties = parameters.properties as Record<string, Record<string, unknown>>;
    const steps = properties.steps;
    const items = steps.items as { oneOf: Array<Record<string, unknown>> };
    const special = items.oneOf.find((entry) => {
      const fields = entry.properties as Record<string, { enum?: string[] }>;
      return fields.skill?.enum?.includes('special');
    })!;
    const fields = special.properties as Record<string, Record<string, unknown>>;

    expect(fields.targets).toMatchObject({ type: 'array', minItems: 1, maxItems: 1 });
    expect(JSON.stringify(fields.target)).toContain('all_visible');
    expect(JSON.stringify(fields.targets.items)).toContain('all_visible');
    expect(fields).not.toHaveProperty('until');
    expect((properties.queue as { enum: string[] }).enum).toEqual(['replace', 'append', 'now']);
  });

  it('提示词和工具说明不混入其他 World 或重复的跨 World 契约', () => {
    const prompt = readFileSync(new URL('../src/ENV_PROMPT.md', import.meta.url), 'utf8');
    const descriptions = PVZ_TOOL_DECLS.map((tool) => tool.description).join('\n');
    expect(`${prompt}\n${descriptions}`).not.toMatch(/mc_do|vtuber_act|minecraft|bilibili|terminal/i);
  });

  it('formats initial and prefetched Whack queues with exactly six finite skills', () => {
    const initial = renderWhackSkillQueueCall();
    const append = renderWhackSkillQueueCall('append');

    expect(initial.match(/skill:"special"/g)).toHaveLength(WHACK_SKILL_QUEUE_LENGTH);
    expect(append.match(/skill:"special"/g)).toHaveLength(WHACK_SKILL_QUEUE_LENGTH);
    expect(initial).not.toContain('queue:');
    expect(append).toContain('pvz_do({queue:"append",steps:[');
    expect(initial).not.toContain('until');
    expect(append).not.toContain('until');
  });

  it('同步规范化档案名并在任务入队前拒绝控制字符', () => {
    expect(parsePvzDo([{ skill: 'profile_create', name: '  Alice  ' }])).toEqual({
      steps: [{ skill: 'profile_create', name: 'Alice' }],
    });
    expect(parsePvzDo([{ skill: 'profile_create', name: 'Bad\nName' }]))
      .toEqual({ error: '第 1 步 name 不能包含控制字符' });
  });

  it('rejects two differently configured imitater cards in one seed request', () => {
    expect(parsePvzDo([{
      skill: 'choose_seeds',
      seeds: [
        { plant: 'imitater', imitates: 'peashooter' },
        { plant: 'imitater', imitates: 'wall_nut' },
      ],
    }])).toEqual({ error: '第 1 步 seeds 只能选择一张 imitater' });
  });
});

describe('PvzExecutor queue', () => {
  it('returns acceptance before the asynchronously delivered terminal report', async () => {
    const gate = deferred<PvzStepResult>();
    const reports: PvzTaskReport[] = [];
    const executor = new PvzExecutor({
      snapshot: () => snapshot(),
      execute: () => gate.promise,
      cancelNative: async () => {},
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });

    const receipt = executor.submit(parsed([{ skill: 'menu', action: 'adventure' }]));

    expect(receipt).toContain('任务#1 已受理');
    expect(receipt).toContain('[PvZ队列] 正在做任务#1');
    expect(reports).toEqual([]);
    gate.resolve(done('进入冒险模式'));
    await waitUntil(() => reports.length === 1);
    expect(reports[0]).toMatchObject({ kind: 'done', taskId: 1 });
  });

  it('a mower-resolved target yields one Whack step while later independent steps still run', async () => {
    const reports: PvzTaskReport[] = [];
    const executed: number[] = [];
    const executor = new PvzExecutor({
      snapshot: () => snapshot(),
      execute: async (step, context) => {
        if (step.skill !== 'special' || step.action !== 'whack') throw new Error('unexpected step');
        executed.push(context.stepIndex);
        return context.stepIndex === 0
          ? { outcome: 'yield', text: '目标在绑定前已被割草机解决' }
          : done(`第 ${context.stepIndex + 1} 批命中`);
      },
      cancelNative: async () => {},
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });

    executor.submit(parsed([
      { skill: 'special', action: 'whack', targets: [{ kind: 'zombie', scope: 'all_visible' }] },
      { skill: 'special', action: 'whack', targets: [{ kind: 'zombie', scope: 'all_visible' }] },
      { skill: 'special', action: 'whack', targets: [{ kind: 'zombie', scope: 'all_visible' }] },
    ]));

    await waitUntil(() => reports.length === 1);
    expect(executed).toEqual([0, 1, 2]);
    expect(reports[0]).toMatchObject({ kind: 'partial', taskId: 1 });
    expect(reports[0]?.text).toContain('目标在绑定前已被割草机解决');
    expect(reports[0]?.text).toContain('第 3 批命中');
    expect(reports[0]?.steps.map((step) => step.outcome)).toEqual(['yield', 'done', 'done']);
  });

  it('a target that naturally leaves a native batch is partial and later independent steps still run', async () => {
    const reports: PvzTaskReport[] = [];
    const executed: number[] = [];
    const executor = new PvzExecutor({
      snapshot: () => snapshot(),
      execute: async (step, context) => {
        if (step.skill !== 'special' || step.action !== 'whack') throw new Error('unexpected step');
        executed.push(context.stepIndex);
        return context.stepIndex === 0
          ? { outcome: 'partial', text: '确认命中 1/2；1 个目标在执行前已自然离开' }
          : done(`第 ${context.stepIndex + 1} 批命中`);
      },
      cancelNative: async () => {},
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });

    executor.submit(parsed([
      { skill: 'special', action: 'whack', targets: [{ kind: 'zombie', scope: 'all_visible' }] },
      { skill: 'special', action: 'whack', targets: [{ kind: 'zombie', scope: 'all_visible' }] },
    ]));

    await waitUntil(() => reports.length === 1);
    expect(executed).toEqual([0, 1]);
    expect(reports[0]).toMatchObject({ kind: 'partial', taskId: 1 });
    expect(reports[0]?.steps.map((step) => step.outcome)).toEqual(['partial', 'done']);
    expect(reports[0]?.text).toContain('第 2 批命中');
  });

  it.each([
    ['blocked', '种植所需卡片不存在'],
    ['unverified', '动作是否落地无法确认'],
  ] as const)('%s remains a task barrier and does not run dependent tail steps', async (outcome, text) => {
    const reports: PvzTaskReport[] = [];
    const executed: number[] = [];
    const executor = new PvzExecutor({
      snapshot: () => snapshot(),
      execute: async (_step, context) => {
        executed.push(context.stepIndex);
        return context.stepIndex === 0 ? { outcome, text } : done('must not run');
      },
      cancelNative: async () => {},
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });

    executor.submit(parsed([
      { skill: 'plant', plant: 'peashooter', row: 2, column: 3 },
      { skill: 'shovel', row: 2, column: 3 },
    ]));

    await waitUntil(() => reports.length === 1);
    expect(executed).toEqual([0]);
    expect(reports[0]).toMatchObject({ kind: outcome, taskId: 1 });
    expect(reports[0]?.steps).toHaveLength(1);
  });

  it('replace keeps the running task, cancels waiting work, and installs one successor', async () => {
    const first = deferred<PvzStepResult>();
    const reports: PvzTaskReport[] = [];
    const executed: string[] = [];
    const executor = new PvzExecutor({
      snapshot: () => snapshot(),
      execute: async (step) => {
        if (step.skill !== 'menu') throw new Error('unexpected step');
        executed.push(step.action);
        return step.action === 'first' ? first.promise : done(step.action);
      },
      cancelNative: async () => {},
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });
    executor.submit(parsed([{ skill: 'menu', action: 'first' }]));
    executor.submit(parsed([{ skill: 'menu', action: 'discarded' }]), 'append');

    const receipt = executor.submit(parsed([{ skill: 'menu', action: 'replacement' }]));

    expect(receipt).toContain('撤掉等待中的 任务#2');
    expect(executor.status().running?.taskId).toBe(1);
    expect(executor.status().waiting.map((task) => task.taskId)).toEqual([3]);
    expect(reports.map((report) => [report.taskId, report.kind])).toEqual([[2, 'cancelled']]);
    first.resolve(done('first'));
    await waitUntil(() => reports.length === 3);
    expect(executed).toEqual(['first', 'replacement']);
    expect(reports.map((report) => report.taskId)).toEqual([2, 1, 3]);
  });

  it('replace states that a running multi-step task continues before its successor', async () => {
    const first = deferred<PvzStepResult>();
    const executed: string[] = [];
    const executor = new PvzExecutor({
      snapshot: () => snapshot(),
      execute: async (step) => {
        if (step.skill !== 'menu') throw new Error('unexpected step');
        executed.push(step.action);
        return step.action === 'first' ? first.promise : done(step.action);
      },
      cancelNative: async () => {},
      report: () => {},
      nextId: idSequence(),
    });
    executor.submit(parsed([
      { skill: 'menu', action: 'first' },
      { skill: 'menu', action: 'remaining' },
    ]));

    const receipt = executor.submit(parsed([{ skill: 'menu', action: 'replacement' }]));

    expect(receipt).toContain('任务#1仍会继续整项任务（当前第 1/2 步）');
    expect(receipt).toContain('新任务#2排在其后');
    expect(receipt).toContain('若必须立即改动作，用 queue:now');
    first.resolve(done('first'));
    await waitUntil(() => executed.length === 3);
    expect(executed).toEqual(['first', 'remaining', 'replacement']);
  });

  it('append preserves FIFO order', async () => {
    const first = deferred<PvzStepResult>();
    const executed: string[] = [];
    const reports: PvzTaskReport[] = [];
    const executor = new PvzExecutor({
      snapshot: () => snapshot(),
      execute: async (step) => {
        if (step.skill !== 'menu') throw new Error('unexpected step');
        executed.push(step.action);
        return step.action === 'first' ? first.promise : done(step.action);
      },
      cancelNative: async () => {},
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });
    executor.submit(parsed([{ skill: 'menu', action: 'first' }]));
    executor.submit(parsed([{ skill: 'menu', action: 'second' }]), 'append');
    executor.submit(parsed([{ skill: 'menu', action: 'third' }]), 'append');

    first.resolve(done('first'));
    await waitUntil(() => reports.length === 3);
    expect(executed).toEqual(['first', 'second', 'third']);
    expect(reports.map((report) => report.taskId)).toEqual([1, 2, 3]);
  });

  it('now reports the interrupted task once and waits for native cancellation before running at the head', async () => {
    const first = deferred<PvzStepResult>();
    const nativeCancel = deferred<void>();
    const reports: PvzTaskReport[] = [];
    const executed: string[] = [];
    const executor = new PvzExecutor({
      snapshot: () => snapshot(),
      execute: async (step) => {
        if (step.skill !== 'menu') throw new Error('unexpected step');
        executed.push(step.action);
        return step.action === 'first' ? first.promise : done(step.action);
      },
      cancelNative: () => nativeCancel.promise,
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });
    executor.submit(parsed([{ skill: 'menu', action: 'first' }]));
    await waitUntil(() => executed.length === 1);
    executor.submit(parsed([{ skill: 'menu', action: 'second' }]), 'append');

    const receipt = executor.submit(parsed([{ skill: 'menu', action: 'urgent' }]), 'now');

    expect(receipt).toContain('叫停了任务#1');
    expect(reports).toEqual([]);
    expect(executor.status().waiting.map((task) => task.taskId)).toEqual([3, 2]);
    expect(executor.status().hold).toContain('释放原生输入');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(executed).toEqual(['first']);

    nativeCancel.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(executed).toEqual(['first']);
    expect(reports).toEqual([]);
    expect(executor.status().hold).toContain('等待被取消的执行退出');
    first.resolve(done('late first'));
    await waitUntil(() => reports.length === 3);
    expect(executed).toEqual(['first', 'urgent', 'second']);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(reports.filter((report) => report.taskId === 1)).toHaveLength(1);
  });

  it('keeps queued work on hold when native cancellation fails', async () => {
    const first = deferred<PvzStepResult>();
    const executed: string[] = [];
    const reports: PvzTaskReport[] = [];
    let cancellations = 0;
    const executor = new PvzExecutor({
      snapshot: () => snapshot(),
      execute: async (step) => {
        if (step.skill !== 'menu') throw new Error('unexpected step');
        executed.push(step.action);
        return step.action === 'first' ? first.promise : done(step.action);
      },
      cancelNative: async () => {
        cancellations += 1;
        if (cancellations === 1) throw new Error('cancel ack lost');
      },
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });
    executor.submit(parsed([{ skill: 'menu', action: 'first' }]));
    await waitUntil(() => executed.length === 1);
    executor.submit(parsed([{ skill: 'menu', action: 'urgent' }]), 'now');
    await waitUntil(() => executor.status().hold?.includes('cancel ack lost') === true);

    first.resolve(done('late first'));
    await waitUntil(() => reports.some((report) => report.taskId === 1));
    expect(executed).toEqual(['first']);
    expect(executor.status().waiting.map((task) => task.taskId)).toEqual([2]);
    expect(executor.status().hold).toContain('原生输入取消失败');
    expect(reports.find((report) => report.taskId === 1)?.kind).toBe('unverified');

    await executor.stopAndWait('retry release');
    expect(cancellations).toBe(2);
    expect(executor.status().hold).toBeNull();
    expect(reports.find((report) => report.taskId === 2)?.kind).toBe('cancelled');
  });

  it('parks conditional plants without blocking other work and wakes from fresh card state', async () => {
    let current: PvzSnapshot = snapshot({
      screen: 'board',
      menu: [],
      board: boardState({
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: false, affordable: false, cooldown: 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
      }),
    });
    const reports: PvzTaskReport[] = [];
    const executed: string[] = [];
    const reservedCards: Array<PvzReservedCard | null> = [];
    const executor = new PvzExecutor({
      snapshot: () => current,
      execute: async (step, context) => {
        executed.push(step.skill);
        reservedCards.push(context.reservedCard);
        return done(step.skill);
      },
      cancelNative: async () => {},
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });

    executor.submit(parsed([{
      skill: 'plant', plant: 'peashooter', row: 2, column: 3, when: 'ready_and_affordable',
    }]));
    const parked = executor.status();
    expect(parked.running).toBeNull();
    expect(parked.reservations).toEqual([{
      taskId: 1,
      plant: 'peashooter',
      at: { row: 2, column: 3 },
      waitingFor: 'ready_and_affordable',
      reservedCard: { card: '豌豆射手', forStep: null },
      followingSteps: [],
    }]);
    expect(renderPvzQueue(parked))
      .toContain('任务#1 把 豌豆射手 种在第2排第3列，等冷却并阳光足够；占用卡 豌豆射手');

    executor.submit(parsed([{ skill: 'menu', action: 'pause' }]), 'append');
    await waitUntil(() => reports.some((report) => report.taskId === 2));
    expect(executed).toEqual(['menu']);

    current = structuredClone(current);
    current.board!.cards[0].ready = true;
    current.board!.cards[0].affordable = false;
    expect(executor.wake()).toBe(0);
    current.board!.cards[0].affordable = true;
    expect(executor.wake()).toBe(1);
    await waitUntil(() => reports.some((report) => report.taskId === 1));
    expect(executed).toEqual(['menu', 'plant']);
    expect(reservedCards).toEqual([
      null,
      { mode: 0, runId: 1, plant: 'peashooter', slot: 0, type: 0, imitates: null },
    ]);

    current.board!.cards[0].affordable = false;
    executor.submit(parsed([{
      skill: 'plant', plant: 'peashooter', row: 3, column: 3, when: 'ready',
    }]), 'append');
    await waitUntil(() => reports.some((report) => report.taskId === 3));
    expect(executor.status().reservations).toEqual([]);
  });

  it('准入期绑好的卡标明它属于哪一步，不挂在当前步骤旁边', async () => {
    const current = snapshot({
      screen: 'board',
      menu: [],
      board: boardState({
        cards: [
          {
            slot: 0, type: 3, name: 'wallnut', imitates: null, cost: 50,
            ready: true, affordable: true, cooldown: 'ready',
            cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0, x: 80, y: 40,
          },
          {
            slot: 1, type: 1, name: 'sunflower', imitates: null, cost: 50,
            ready: false, affordable: true, cooldown: 'long',
            cooldownRemainingPercent: 0, cooldownRemainingSeconds: 7.3, x: 133, y: 40,
          },
        ],
      }),
    });
    const held = deferred<PvzStepResult>();
    let queued = '';
    const executor = new PvzExecutor({
      snapshot: () => current,
      execute: async () => {
        queued = renderPvzQueue(executor.status());
        return held.promise;
      },
      cancelNative: async () => {},
      report: () => {},
      nextId: idSequence(),
    });

    const [nut, sunflower] = parsed([
      { skill: 'plant', plant: 'wall_nut', row: 6, column: 3 },
      { skill: 'plant', plant: 'sunflower', row: 1, column: 1, when: 'ready' },
    ]) as [PvzDoStep, Extract<PvzDoStep, { skill: 'plant' }>];
    // 准入期给条件种植钉的卡,和 world 提交时钉的是同一份。
    const bound: PvzDoStep = Object.assign({}, sunflower, {
      binding: { mode: 0, runId: 1, slot: 1, type: 1, imitates: null, name: 'sunflower' },
    });
    executor.submit([nut, bound]);
    await waitUntil(() => queued !== '');

    expect(queued).toContain('第 1/2 步:把 坚果 种在第6排第3列');
    expect(queued).toContain('占用卡 向日葵（留给第 2 步）');
    held.resolve(done('planted'));
    executor.stop();
  });

  it('selects a ready and affordable duplicate for immediate planting before a lower unavailable slot', () => {
    const current = snapshot({
      screen: 'board', menu: [],
      board: boardState({
        cards: [
          {
            slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
            ready: false, affordable: true, cooldown: 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
          },
          {
            slot: 1, type: 0, name: 'peashooter', imitates: null, cost: 100,
            ready: true, affordable: true, cooldown: 'ready', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 133, y: 40,
          },
        ],
      }),
    });
    const executor = new PvzExecutor({
      snapshot: () => current,
      execute: async () => done('unexpected'),
      cancelNative: async () => {},
      report: () => {},
      nextId: idSequence(),
    });

    expect(executor.selectUnreservedCard('peashooter')).toMatchObject({ slot: 1 });
  });

  it.each([
    {
      when: 'ready' as const,
      lower: { ready: false, affordable: true },
      higher: { ready: true, affordable: false },
    },
    {
      when: 'ready_and_affordable' as const,
      lower: { ready: true, affordable: false },
      higher: { ready: true, affordable: true },
    },
  ])('binds the duplicate satisfying $when instead of a lower unavailable slot', async ({ when, lower, higher }) => {
    const current = snapshot({
      screen: 'board', menu: [],
      board: boardState({
        cards: [
          {
            slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
            ...lower, cooldown: lower.ready ? 'ready' : 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
          },
          {
            slot: 1, type: 0, name: 'peashooter', imitates: null, cost: 100,
            ...higher, cooldown: higher.ready ? 'ready' : 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 133, y: 40,
          },
        ],
      }),
    });
    const reports: PvzTaskReport[] = [];
    const slots: number[] = [];
    const executor = new PvzExecutor({
      snapshot: () => current,
      execute: async (_step, context) => {
        slots.push(context.reservedCard!.slot);
        return done('planted');
      },
      cancelNative: async () => {},
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });

    executor.submit(parsed([{
      skill: 'plant', plant: 'peashooter', row: 2, column: 3, when,
    }]));

    await waitUntil(() => reports.length === 1);
    expect(slots).toEqual([1]);
    expect(reports[0]).toMatchObject({ kind: 'done' });
    expect(executor.status().reservations).toEqual([]);
  });

  it('blocks a conditional plant when the current board has no matching card', async () => {
    const reports: PvzTaskReport[] = [];
    let executions = 0;
    const executor = new PvzExecutor({
      snapshot: () => snapshot({
        screen: 'board', menu: [], board: boardState({ cards: [] }),
      }),
      execute: async () => {
        executions += 1;
        return done('unexpected');
      },
      cancelNative: async () => {},
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });

    const receipt = executor.submit(parsed([{
      skill: 'plant', plant: 'peashooter', row: 2, column: 3, when: 'ready',
    }]));

    expect(receipt).toContain('任务#1 已受理');
    expect(reports).toEqual([]);
    expect(executor.status().reservations).toEqual([]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0]).toMatchObject({
      taskId: 1,
      kind: 'blocked',
      steps: [{ outcome: 'blocked', text: '当前棋盘没有 豌豆射手 卡片' }],
    });
    expect(executions).toBe(0);
  });

  it('keeps the chosen conditional planting after a hostile passes and executes when ready', async () => {
    let current = snapshot({
      screen: 'board', menu: [],
      board: boardState({
        cards: [{
          slot: 0, type: 4, name: 'potato_mine', imitates: null, cost: 25,
          ready: false, affordable: true, cooldown: 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        zombies: [{
          id: 7, type: 2, name: 'pole_vaulting_zombie', row: 5, column: 4, columnPosition: 4,
          xBand: 'mid', speedCellsPerSecond: 0.0, speed: 'fast', phase: 'walking', condition: 'intact',
          armor: 'none', shield: 'none', hypnotized: false, slowed: false,
          immobilized: false,
        }],
      }),
    });
    const reports: PvzTaskReport[] = [];
    const reservationsAtReport: number[] = [];
    let executions = 0;
    let executor: PvzExecutor;
    executor = new PvzExecutor({
      snapshot: () => current,
      execute: async () => {
        executions += 1;
        return done('planted');
      },
      cancelNative: async () => {},
      report: (report) => {
        reports.push(report);
        reservationsAtReport.push(executor.status().reservations.length);
      },
      nextId: idSequence(),
    });

    executor.submit(parsed([{
      skill: 'plant', plant: 'potato_mine', row: 5, column: 3,
      when: 'ready_and_affordable',
    }]));
    expect(executor.status().reservations).toHaveLength(1);

    current = structuredClone(current);
    current.board!.zombies[0]!.column = 2;
    expect(executor.wake()).toBe(0);

    expect(reports).toHaveLength(0);
    expect(executor.status().reservations).toHaveLength(1);
    expect(executions).toBe(0);
    current.board!.cards[0]!.ready = true;
    expect(executor.wake()).toBe(1);
    await waitUntil(() => reports.length === 1);
    expect(reports[0]).toMatchObject({ taskId: 1, kind: 'done' });
    expect(executor.status().reservations).toEqual([]);
    expect(reservationsAtReport).toEqual([0]);
    expect(executions).toBe(1);
  });

  it('does not infer a passed threat while entity disclosure is dark', () => {
    const current = snapshot({
      screen: 'board', menu: [],
      board: boardState({
        disclosure: { entitiesVisible: false, phase: 'dark' },
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: false, affordable: true, cooldown: 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
        zombies: [{
          id: 9, type: 0, name: 'zombie', row: 2, column: 1, columnPosition: 1,
          xBand: 'lawn', speedCellsPerSecond: 0.0, speed: 'normal', phase: 'walking', condition: 'intact',
          armor: 'none', shield: 'none', hypnotized: false, slowed: false,
          immobilized: false,
        }],
      }),
    });
    const reports: PvzTaskReport[] = [];
    const executor = new PvzExecutor({
      snapshot: () => current,
      execute: async () => done('unexpected'),
      cancelNative: async () => {},
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });

    executor.submit(parsed([{
      skill: 'plant', plant: 'peashooter', row: 2, column: 3, when: 'ready',
    }]));

    expect(executor.status().reservations).toHaveLength(1);
    expect(reports).toEqual([]);
  });

  it('allows only one conditional task to own a concrete card at a time', () => {
    const current = snapshot({
      screen: 'board', menu: [],
      board: boardState({
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: false, affordable: true, cooldown: 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
      }),
    });
    const reports: PvzTaskReport[] = [];
    const executor = new PvzExecutor({
      snapshot: () => current,
      execute: async () => done('unexpected'),
      cancelNative: async () => {},
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });
    executor.submit(parsed([{
      skill: 'plant', plant: 'peashooter', row: 2, column: 3, when: 'ready',
    }]));
    executor.submit(parsed([{
      skill: 'plant', plant: 'peashooter', row: 3, column: 3, when: 'ready',
    }]), 'append');

    expect(executor.status().reservations.map((reservation) => reservation.taskId)).toEqual([1, 2]);
    expect(executor.status().reservations.map((reservation) => reservation.reservedCard.card))
      .toEqual(['豌豆射手', '豌豆射手']);
    expect(executor.selectUnreservedCard('peashooter')).toBeNull();
    executor.stop();
    expect(reports).toHaveLength(2);
  });

  it('binds duplicate conditional cards independently and executes both', async () => {
    let current = snapshot({
      screen: 'board', menu: [],
      board: boardState({
        cards: [0, 1].map((slot) => ({
          slot, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: false, affordable: true, cooldown: 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80 + slot * 50, y: 40,
        })),
      }),
    });
    const reports: PvzTaskReport[] = [];
    const slots: number[] = [];
    const executor = new PvzExecutor({
      snapshot: () => current,
      execute: async (_step, context) => {
        slots.push(context.reservedCard!.slot);
        return done('planted');
      },
      cancelNative: async () => {},
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });
    executor.submit(parsed([{
      skill: 'plant', plant: 'peashooter', row: 2, column: 3, when: 'ready',
    }]));
    executor.submit(parsed([{
      skill: 'plant', plant: 'peashooter', row: 3, column: 3, when: 'ready',
    }]), 'append');

    expect(executor.status().reservations.map((reservation) => reservation.reservedCard.card))
      .toEqual(['豌豆射手 #1', '豌豆射手 #2']);
    current = structuredClone(current);
    for (const card of current.board!.cards) card.ready = true;
    expect(executor.wake()).toBe(2);
    await waitUntil(() => reports.length === 2);
    expect(slots).toEqual([0, 1]);
    expect(reports.map((report) => report.kind)).toEqual(['done', 'done']);
  });

  it.each([
    {
      boundary: 'mode',
      mutate: (draft: PvzSnapshot) => { draft.mode += 1; },
    },
    {
      boundary: 'runId',
      mutate: (draft: PvzSnapshot) => { draft.board!.runId += 1; },
    },
    {
      boundary: 'card identity',
      mutate: (draft: PvzSnapshot) => { draft.board!.cards[0]!.slot = 1; },
    },
  ])('blocks a parked plant once its bound $boundary changes', ({ mutate }) => {
    let current = snapshot({
      screen: 'board', menu: [],
      board: boardState({
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: false, affordable: true, cooldown: 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
      }),
    });
    const reports: PvzTaskReport[] = [];
    let executions = 0;
    const executor = new PvzExecutor({
      snapshot: () => current,
      execute: async () => {
        executions += 1;
        return done('unexpected');
      },
      cancelNative: async () => {},
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });
    executor.submit(parsed([{
      skill: 'plant', plant: 'peashooter', row: 2, column: 3, when: 'ready',
    }]));
    expect(executor.status().reservations).toHaveLength(1);

    current = structuredClone(current);
    mutate(current);
    expect(executor.wake()).toBe(0);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ taskId: 1, kind: 'blocked' });
    expect(reports[0]!.text).toContain('绑定已过期');
    expect(executor.status().reservations).toEqual([]);
    executor.wake();
    expect(reports).toHaveLength(1);
    expect(executions).toBe(0);
  });

  it('a blocked task does not clear the later queue', async () => {
    const reports: PvzTaskReport[] = [];
    const executed: string[] = [];
    const executor = new PvzExecutor({
      snapshot: () => snapshot(),
      execute: async (step) => {
        if (step.skill !== 'menu') throw new Error('unexpected step');
        executed.push(step.action);
        return step.action === 'blocked'
          ? { outcome: 'blocked', text: '当前菜单没有这个操作' }
          : done(step.action);
      },
      cancelNative: async () => {},
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });
    executor.submit(parsed([{ skill: 'menu', action: 'blocked' }]));
    executor.submit(parsed([{ skill: 'menu', action: 'later' }]), 'append');

    await waitUntil(() => reports.length === 2);
    expect(reports.map((report) => [report.taskId, report.kind])).toEqual([
      [1, 'blocked'], [2, 'done'],
    ]);
    expect(executed).toEqual(['blocked', 'later']);
  });

  it('stop gives running, queued, and parked tasks one terminal report each', async () => {
    const active = deferred<PvzStepResult>();
    const reports: PvzTaskReport[] = [];
    let cancels = 0;
    const current = snapshot({
      screen: 'board', menu: [],
      board: boardState({
        cards: [{
          slot: 0, type: 0, name: 'peashooter', imitates: null, cost: 100,
          ready: false, affordable: false, cooldown: 'long', cooldownRemainingPercent: 0, cooldownRemainingSeconds: 0.0, x: 80, y: 40,
        }],
      }),
    });
    const executor = new PvzExecutor({
      snapshot: () => current,
      execute: (step) => step.skill === 'menu' ? active.promise : Promise.resolve(done(step.skill)),
      cancelNative: async () => { cancels += 1; },
      report: (report) => reports.push(report),
      nextId: idSequence(),
    });
    executor.submit(parsed([{
      skill: 'plant', plant: 'peashooter', row: 2, column: 3, when: 'ready',
    }]));
    executor.submit(parsed([{ skill: 'menu', action: 'active' }]), 'append');
    await waitUntil(() => executor.status().running?.taskId === 2);
    executor.submit(parsed([{ skill: 'menu', action: 'queued' }]), 'append');

    const stopping = executor.stopAndWait();

    expect(reports.map((report) => [report.taskId, report.kind]).sort()).toEqual([
      [1, 'cancelled'], [3, 'cancelled'],
    ]);
    active.resolve(done('late'));
    const receipt = await stopping;
    expect(receipt).toContain('任务#2');
    expect(reports.map((report) => [report.taskId, report.kind]).sort()).toEqual([
      [1, 'cancelled'], [2, 'cancelled'], [3, 'cancelled'],
    ]);
    expect(cancels).toBe(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(reports).toHaveLength(3);
    expect(executor.status()).toMatchObject({ running: null, waiting: [], reservations: [] });
  });
});
