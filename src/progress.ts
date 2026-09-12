import type { PvzSnapshot, PvzVisibleProgress } from './protocol.ts';

export interface PvzProgressIdentity {
  profileName: string | null;
  mode: number;
  level: number | null;
  adventureLevel: number | null;
  adventureCompletions: number | null;
}

export function progressIdentity(snapshot: PvzSnapshot): PvzProgressIdentity {
  return {
    profileName: snapshot.profile?.name ?? null,
    mode: snapshot.mode,
    level: snapshot.board?.level ?? null,
    adventureLevel: snapshot.profile?.adventureLevel ?? null,
    adventureCompletions: snapshot.profile?.adventureCompletions ?? null,
  };
}

export function progressAdvanced(before: PvzSnapshot, after: PvzSnapshot): boolean {
  const a = before.board?.progress;
  const b = after.board?.progress;
  if (!a || !b || a.kind !== b.kind) return false;
  const staged = new Set<PvzVisibleProgress['kind']>([
    'flags', 'survival_stage', 'vases', 'brains', 'setup',
  ]);
  if (staged.has(b.kind) && b.stage !== null && (a.stage === null || b.stage > a.stage)) return true;
  if (b.kind === 'vases' && b.current !== null && a.current !== null && b.current < a.current) {
    return true;
  }
  if (b.kind === 'targets') return false;
  if (b.kind === 'boss') {
    if (b.current === null || b.target === null || b.target === 0) return false;
    if (a.current === null || a.target === null || a.target === 0) return true;
    return Math.floor(b.current * 10 / b.target) > Math.floor(a.current * 10 / a.target);
  }
  if (b.current !== null && (a.current === null || b.current > a.current)) return true;
  return false;
}

/**
 * 关卡进度条上人看得见的那一行。
 *
 * 植入件的 label 是英文调试串(`Flag 1/2`、`Matches 12/75`),不是给她读的;能按语义
 * 说清的档位在这儿说清,说不清的才退回原串。
 */
export function renderProgress(progress: PvzVisibleProgress | null | undefined): string {
  if (!progress) return '当前画面没有关卡进度条。';
  const stage = progress.stage === null ? '' : `第 ${progress.stage} 阶段·`;
  const of = (unit: string): string => progress.target === null
    ? `${stage}已过 ${progress.current} ${unit}`
    : `${stage}${progress.current}/${progress.target} ${unit}`;
  if (progress.kind === 'flags') {
    return progress.current === null ? `${stage}进度条上还没过旗子` : of('面旗');
  }
  if (progress.kind === 'survival_stage') return of('轮');
  if (progress.kind === 'sun_goal') return of('阳光');
  if (progress.kind === 'score') return of('分');
  if (progress.kind === 'stars') return of('颗星');
  if (progress.kind === 'brains') return of('个脑子');
  if (progress.kind === 'vases') return `${stage}还剩 ${progress.current} 个罐子`;
  if (progress.kind === 'targets') return `还剩 ${progress.current} 个目标`;
  if (progress.kind === 'boss') {
    return progress.current === null ? '僵王血条读不到' : `僵王进度 ${progress.current}%`;
  }
  if (progress.kind === 'setup') return `${stage}布阵中`;
  if (progress.kind === 'complete') return '本关已结束';
  return progress.label || '当前画面没有关卡进度条。';
}

export function profileProgressed(before: PvzSnapshot, after: PvzSnapshot): boolean {
  const a = before.profile;
  const b = after.profile;
  if (!a || !b || a.name !== b.name) return false;
  return b.adventureCompletions > a.adventureCompletions
    || b.adventureLevel > a.adventureLevel
    || (!a.minigamesUnlocked && b.minigamesUnlocked)
    || (!a.puzzleUnlocked && b.puzzleUnlocked)
    || (!a.survivalUnlocked && b.survivalUnlocked);
}
