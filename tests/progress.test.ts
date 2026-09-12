import { describe, expect, it } from 'vitest';
import {
  profileProgressed, progressAdvanced, progressIdentity, renderProgress,
} from '../src/progress.ts';
import { boardState, snapshot } from './helpers.ts';

describe('PvZ 可见关卡进度方向', () => {
  it('档案提交只在同一可见玩家身份内比较，并保留冒险周回边界', () => {
    const finalLevel = snapshot({
      profile: {
        ...snapshot().profile!, name: 'Alice', adventureLevel: 50, adventureCompletions: 0,
      },
    });
    const nextLoop = structuredClone(finalLevel);
    nextLoop.revision += 1;
    nextLoop.profile!.adventureLevel = 1;
    nextLoop.profile!.adventureCompletions = 1;
    expect(profileProgressed(finalLevel, nextLoop)).toBe(true);
    expect(progressIdentity(nextLoop).profileName).toBe('Alice');

    const switched = structuredClone(finalLevel);
    switched.revision += 1;
    switched.profile = {
      ...switched.profile!, name: 'Bob', adventureLevel: 50, adventureCompletions: 9,
      minigamesUnlocked: true, puzzleUnlocked: true, survivalUnlocked: true,
    };
    expect(profileProgressed(finalLevel, switched)).toBe(false);

    const regressed = structuredClone(finalLevel);
    regressed.revision += 1;
    regressed.profile!.adventureLevel = 49;
    expect(profileProgressed(finalLevel, regressed)).toBe(false);
  });

  it('把剩余花瓶减少视为推进，但不把普通波数倒退视为推进', () => {
    const vaseBefore = snapshot({
      screen: 'board',
      board: boardState({
        progress: { kind: 'vases', current: 12, target: null, stage: null, label: '剩余 12 个花瓶' },
      }),
    });
    const vaseAfter = structuredClone(vaseBefore);
    vaseAfter.revision += 1;
    vaseAfter.board!.progress = {
      kind: 'vases', current: 11, target: null, stage: null, label: '剩余 11 个花瓶',
    };
    expect(progressAdvanced(vaseBefore, vaseAfter)).toBe(true);

    const wavesAfter = structuredClone(vaseBefore);
    vaseBefore.board!.progress = { kind: 'flags', current: 3, target: 10, stage: null, label: 'Flag 3/10' };
    wavesAfter.board!.progress = { kind: 'flags', current: 2, target: 10, stage: null, label: 'Flag 2/10' };
    expect(progressAdvanced(vaseBefore, wavesAfter)).toBe(false);
  });

  it('阶段编号增长独立于阶段内计数', () => {
    const before = snapshot({
      screen: 'board',
      board: boardState({
        progress: {
          kind: 'survival_stage', current: 5, target: 10, stage: 1, label: '生存阶段 1',
        },
      }),
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.board!.progress = {
      kind: 'survival_stage', current: 0, target: 10, stage: 2, label: '生存阶段 2',
    };
    expect(progressAdvanced(before, after)).toBe(true);
  });

  it('不把 Slot Machine 的内部计数当作可见阶段进度', () => {
    const before = snapshot({
      screen: 'board', mode: 18,
      board: boardState({
        progress: {
          kind: 'sun_goal', current: 500, target: 2000, stage: null, label: '500/2000 sun',
        },
      }),
    });
    const after = structuredClone(before);
    after.revision += 1;
    after.board!.progress.stage = 99;

    expect(progressAdvanced(before, after)).toBe(false);
  });

  it('Boss 血条只在首次显现和每 10% 里程碑推进', () => {
    const incoming = snapshot({
      screen: 'board', mode: 35,
      board: boardState({
        progress: { kind: 'boss', current: null, target: 100, stage: null, label: 'Boss progress unavailable' },
      }),
    });
    const visible = structuredClone(incoming);
    visible.revision += 1;
    visible.board!.progress = {
      kind: 'boss', current: 0, target: 100, stage: null, label: 'Boss damage 0/100',
    };
    expect(progressAdvanced(incoming, visible)).toBe(true);

    const chipped = structuredClone(visible);
    chipped.revision += 1;
    chipped.board!.progress = {
      kind: 'boss', current: 9, target: 100, stage: null, label: 'Boss damage 9/100',
    };
    expect(progressAdvanced(visible, chipped)).toBe(false);

    const milestone = structuredClone(chipped);
    milestone.revision += 1;
    milestone.board!.progress = {
      kind: 'boss', current: 10, target: 100, stage: null, label: 'Boss damage 10/100',
    };
    expect(progressAdvanced(chipped, milestone)).toBe(true);
  });
});

describe('PvZ 进度只说旗子', () => {
  it('关卡进度按已过几面旗说，波次留在植入件里面', () => {
    expect(renderProgress({
      kind: 'flags', current: 1, target: 2, stage: null, label: 'Flag 1/2',
    })).toBe('1/2 面旗');
    expect(renderProgress({
      kind: 'flags', current: 3, target: null, stage: 4, label: 'Survival endless stage 4, flag 3',
    })).toBe('第 4 阶段·已过 3 面旗');
    expect(renderProgress({
      kind: 'boss', current: 50, target: 100, stage: null, label: 'Boss 50%',
    })).toBe('僵王进度 50%');
  });

  it('每过一面旗算一次推进，旗与旗之间不再逐波报', () => {
    const before = snapshot({
      screen: 'board',
      board: boardState({
        progress: { kind: 'flags', current: 0, target: 2, stage: null, label: 'Flag 0/2' },
      }),
    });
    const same = structuredClone(before);
    same.revision += 1;
    expect(progressAdvanced(before, same)).toBe(false);

    const passed = structuredClone(before);
    passed.revision += 1;
    passed.board!.progress = {
      kind: 'flags', current: 1, target: 2, stage: null, label: 'Flag 1/2',
    };
    expect(progressAdvanced(before, passed)).toBe(true);
  });
});
