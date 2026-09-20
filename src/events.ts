import { isSunCollectible, isTerminalCollectible } from './collectibles.ts';
import { profileProgressed, progressAdvanced, renderProgress } from './progress.ts';
import {
  bandText,
  cardDisplayNameOf,
  cellText,
  modeName,
  plantDisplayName,
  plantDisplayNameOf,
  plantName,
  rowText,
  zombieDisplayNameOf,
} from './names.ts';
import {
  windowPresentable,
  windowPresentationFault,
  type PvzMenuAction,
  type PvzProfileProgress,
  type PvzSnapshot,
  type PvzSpecialTarget,
  type PvzScreen,
} from './protocol.ts';
import {
  collectibleName,
  conditionLabel,
  cursorDescription,
  mowerName,
  renderSnapshot,
  renderPortals,
  renderTacticalSnapshot,
  zombiePhaseLabel,
  renderBossProjectile,
} from './render.ts';
import { semanticMenuTarget } from './semantic.ts';
import {
  renderWhackSkillQueueCall,
} from './tools.ts';

export interface PvzTrackedEvent {
  type: string;
  text: string;
  urgent: boolean;
  senderKey?: string;
  /** Stable visible semantics for short-window delivery deduplication. */
  routineKey?: string;
}

export function pvzEventTrigger(event: PvzTrackedEvent): 'flush' | 'debounce' | 'piggyback' {
  if (event.urgent) return 'flush';
  if (event.type === 'pvz.collectible.appeared' || event.type === 'pvz.card.ready') return 'piggyback';
  return 'debounce';
}

export interface PvzEventMemory {
  profileName: string | null;
  modeProgress: Map<string, Pick<PvzMenuAction, 'state' | 'record'>>;
  pendingProfileProgress: PvzProfileProgress | null;
  boardBeforeLoading: { mode: number; runId: number; level: number } | null;
}

const LIVESTREAM_CUE = '\n[直播] 用一句不超过 30 个汉字的中文短句口播；不念坐标或内部状态。';
const LIVESTREAM_TERMINAL_CUE = '\n[直播] 用一句不超过 30 个汉字的中文短句口播胜负；按当前状态处理奖励或失败菜单。';

function withLivestreamCue(text: string): string {
  return `${text}${LIVESTREAM_CUE}`;
}

function withTerminalLivestreamCue(text: string): string {
  return `${text}${LIVESTREAM_TERMINAL_CUE}`;
}

function withLevelStartLivestreamCue(text: string, snapshot: PvzSnapshot): string {
  if (!isWhackSnapshot(snapshot)) return `${text}${LIVESTREAM_CUE}`;
  const targets = currentWhackTargets(snapshot);
  const action = targets.length
    ? `当前有 ${targets.length} 个可锤目标。提交 \`${renderWhackSkillQueueCall()}\`。`
    : '当前没有可锤目标；处理可见支援机会或等待新目标。';
  return `${text}\n[PvZ·锤击开局] ${action}${LIVESTREAM_CUE}`;
}

export function createPvzEventMemory(): PvzEventMemory {
  return {
    profileName: null,
    modeProgress: new Map(),
    pendingProfileProgress: null,
    boardBeforeLoading: null,
  };
}

export function trackSnapshot(
  after: PvzSnapshot,
  before: PvzSnapshot | null,
  memory?: PvzEventMemory,
): PvzTrackedEvent[] {
  if (!before) {
    if (memory) {
      memory.profileName = after.profile?.name ?? null;
      memory.modeProgress.clear();
      memory.pendingProfileProgress = null;
      memory.boardBeforeLoading = null;
      if (after.screen === 'mode_selector') {
        for (const item of after.menu.filter((candidate) => candidate.id.startsWith('mode_'))) {
          memory.modeProgress.set(item.id, { state: item.state, record: item.record });
        }
      }
    }
    const whackCue = renderWhackTargetReady(after);
    return [{
      type: 'pvz.connected',
      text: `[PvZ] 已连接 ${after.executable.profile}。\n${whackCue ?? renderSnapshot(after, 'summary')}`,
      urgent: true,
    }];
  }
  const events: PvzTrackedEvent[] = [];
  // 窗口位置或尺寸不满足捕获、输入条件时报告窗口状态，供动作失败时定位原因。
  if (windowPresentable(before.presentation) !== windowPresentable(after.presentation)) {
    const fault = windowPresentationFault(after.presentation);
    events.push({
      type: 'pvz.window.changed',
      text: fault === null
        ? '[PvZ] 游戏窗口已恢复可操作（800×600，整个在一块显示器里）。'
        : `[PvZ] ${fault}`,
      urgent: true,
      senderKey: 'pvz-window',
    });
  }
  const sameRunAcrossScreens = before.mode === after.mode
    && before.board !== null
    && after.board !== null
    && before.board.runId === after.board.runId;
  const sameBoardRun = before.screen === 'board'
    && after.screen === 'board'
    && sameRunAcrossScreens;
  // lastRun 指向当前棋盘 runId 时表示关卡已结算，停止报告实体差分，避免拆场期间的卡片、植物和割草机变化触发通知。
  const runFinished = after.board !== null
    && after.lastRun !== null
    && after.lastRun.runId === after.board.runId;
  const entityContinuity = sameBoardRun
    && !runFinished
    && before.board!.disclosure.entitiesVisible
    && after.board!.disclosure.entitiesVisible;
  const completedRun = newlyCompletedRun(before, after);
  const terminalScreenEvidence = completedRun !== null
    && (completedRun.outcome === 'won' && after.screen === 'award'
      || completedRun.outcome === 'lost' && after.screen === 'defeat');
  if (memory && before.screen === 'board' && after.screen === 'loading' && before.board) {
    memory.boardBeforeLoading = {
      mode: before.mode,
      runId: before.board.runId,
      level: before.board.level,
    };
  }
  const returnedFromTransientLoading = before.screen === 'loading'
    && after.screen === 'board'
    && after.board !== null
    && memory?.boardBeforeLoading?.mode === after.mode
    && memory.boardBeforeLoading.runId === after.board.runId
    && memory.boardBeforeLoading.level === after.board.level;
  if (after.screen !== before.screen) {
    if (after.screen === 'board') {
      const resumedStagedLevel = before.screen === 'seed_picker'
        && sameRunAcrossScreens
        && before.modeKind === 'survival'
        && ((before.board?.progress.stage ?? 0) > 1
          || (before.board?.progress.current ?? 0) > 0);
      if (!returnedFromTransientLoading) {
        events.push(resumedStagedLevel
          ? {
              type: 'pvz.level.stage_resumed',
              text: `[PvZ] 生存阶段换卡完成，继续同一关卡。${after.board?.progress ? ` ${renderProgress(after.board.progress)}` : ''}`,
              urgent: true,
            }
          : sameRunAcrossScreens && before.screen !== 'seed_picker'
            ? {
                type: 'pvz.screen.changed',
                text: '[PvZ] 对话叠层已关闭，继续当前关卡。',
                urgent: false,
              }
            : {
                type: 'pvz.level.started',
                text: withLevelStartLivestreamCue(
                  `[PvZ] 进入关卡。\n${renderSnapshot(after, 'summary')}`,
                  after,
                ),
                urgent: true,
              });
      }
    } else if (after.screen === 'seed_picker') {
      events.push({
        type: 'pvz.seed_picker.opened',
        text: `[PvZ] 进入选卡，请完成选卡并确认。\n${renderSnapshot(after, 'summary')}`,
        urgent: true,
      });
    } else if (!terminalScreenEvidence && after.screen !== 'loading') {
      events.push({
        type: 'pvz.screen.changed',
        text: `[PvZ] 画面 ${before.screen} → ${after.screen}。`,
        urgent: false,
      });
    }
  } else if (after.screen === 'board' && before.board && after.board
    && before.board.runId !== after.board.runId) {
    events.push({
      type: 'pvz.level.restarted',
      text: withLevelStartLivestreamCue(
        `[PvZ] 检测到新的关卡运行。\n${renderSnapshot(after, 'summary')}`,
        after,
      ),
      urgent: true,
    });
  }

  if (memory && after.screen !== 'loading') memory.boardBeforeLoading = null;

  if (completedRun) {
    const evidence = completedRun.outcome === 'won' && after.screen === 'award'
      ? '，已进入奖励画面'
      : completedRun.outcome === 'lost' && after.screen === 'defeat'
        ? '，已进入失败画面'
        : '';
    events.push({
      type: completedRun.outcome === 'won' ? 'pvz.level.won' : 'pvz.level.lost',
      text: withTerminalLivestreamCue(`[PvZ] 关卡${completedRun.outcome === 'won' ? '胜利' : '失败'}（${modeName(completedRun.mode)}，第 ${completedRun.level} 关）${evidence}。`),
      urgent: true,
    });
  }

  if (sameBoardRun
    && before.board!.disclosure.entitiesVisible !== after.board!.disclosure.entitiesVisible) {
    const visible = after.board!.disclosure.entitiesVisible;
    events.push({
      type: 'pvz.visibility.changed',
      text: visible
        ? '[PvZ] 黑暗阶段结束，棋盘重新可见；隐藏期内的实体变化不会补报。'
        : '[PvZ] 棋盘进入黑暗阶段，动态对象暂不可观测；仍可用可见卡槽对静态地格盲投。',
      urgent: visible,
      senderKey: 'pvz-visibility',
    });
  }

  if (after.screen === before.screen) {
    const menuBefore = new Map(before.menu.map((item) => [item.id, item]));
    const newlyEnabled = after.menu.filter((item) => {
      const old = menuBefore.get(item.id);
      return item.enabled && (old === undefined || !old.enabled)
        && !(after.screen === 'board' && item.id === 'pause')
        && !(after.screen === 'mode_selector' && old === undefined);
    });
    if (newlyEnabled.length) {
      events.push({
        type: 'pvz.menu.ready',
        text: `[PvZ] 当前界面有新的可用操作：${newlyEnabled.map(semanticMenuTarget).join(', ')}。`,
        urgent: true,
        senderKey: 'pvz-menu-ready',
        routineKey: `menu:${semanticKey(newlyEnabled.map((item) => item.id))}`,
      });
    }
  }

  const progressedModes = modeProgressChanges(after, before, memory);
  if (progressedModes.length) {
    events.push({
      type: 'pvz.mode.progress',
      text: `[PvZ] 模式进度已更新：${progressedModes.map((item) =>
        `${item.label}${item.record === null ? ' 已完成' : ` 纪录 ${item.record}`}`).join(', ')}。`,
      urgent: true,
      senderKey: 'pvz-mode-progress',
    });
  }

  const profileChanged = before.profile?.name !== after.profile?.name;
  if (profileChanged && memory) memory.pendingProfileProgress = null;
  const committed = !profileChanged && profileProgressed(before, after);
  if (committed && !isMetaMenu(after.screen)) {
    if (memory) memory.pendingProfileProgress = after.profile ? { ...after.profile } : null;
  }
  const pendingCommit = memory?.pendingProfileProgress ?? null;
  if ((committed || pendingCommit !== null) && isMetaMenu(after.screen)) {
    const profile = after.profile ?? pendingCommit;
    events.push({
      type: 'pvz.progress.committed',
      text: `[PvZ] 档案进度已提交：冒险 ${profile?.adventureLevel ?? '?'}，通关 ${profile?.adventureCompletions ?? '?'}；小游戏${profile?.minigamesUnlocked ? '已解锁' : '未解锁'}，解谜${profile?.puzzleUnlocked ? '已解锁' : '未解锁'}，生存${profile?.survivalUnlocked ? '已解锁' : '未解锁'}。`,
      urgent: true,
    });
    if (memory) memory.pendingProfileProgress = null;
  }

  const oldProgress = before.board?.progress;
  const newProgress = after.board?.progress;
  const stagedMode = before.modeKind === 'survival' || before.mode === 31
    || newProgress?.kind === 'vases' || newProgress?.kind === 'brains';
  const stageAdvanced = sameRunAcrossScreens && stagedMode
    && oldProgress?.stage !== null && oldProgress?.stage !== undefined
    && newProgress?.stage !== null && newProgress?.stage !== undefined
    && newProgress.stage > oldProgress.stage;
  if (stageAdvanced) {
    const stageLabel = before.mode === 31 ? 'Last Stand'
      : newProgress.kind === 'vases' ? '花瓶'
        : newProgress.kind === 'brains' ? '食脑者'
          : '生存';
    events.push({
      type: 'pvz.level.stage_completed',
      text: `[PvZ] ${stageLabel}阶段 ${oldProgress.stage} 已完成，进入阶段 ${newProgress.stage}。 ${renderProgress(newProgress)}`,
      urgent: true,
    });
  }
  if (sameBoardRun && newProgress && JSON.stringify(oldProgress) !== JSON.stringify(newProgress)
    && !stageAdvanced
    && (oldProgress?.kind !== newProgress.kind || progressAdvanced(before, after))) {
    events.push({
      type: 'pvz.level.progress',
      text: `[PvZ] ${renderProgress(newProgress)}`,
      urgent: newProgress.kind === 'complete',
      senderKey: 'pvz-progress',
    });
  }

  const oldZombies = new Map((before.board?.zombies ?? []).map((z) => [z.id, z]));
  if (entityContinuity) {
    const boss = after.board!.boss;
    const oldBoss = before.board!.boss;
    if (boss && boss.phase !== oldBoss?.phase) {
      events.push({
        type: 'pvz.boss.phase', text: `[PvZ] ${zombiePhaseLabel(boss.phase)}`,
        urgent: true, senderKey: 'pvz.boss',
      });
    }
    if (boss && oldBoss && boss.immobilized !== oldBoss.immobilized) {
      events.push({ type: 'pvz.boss.immobilized',
        text: `[PvZ] 僵王${boss.immobilized ? '已定身' : '定身已解除'}`,
        urgent: true, senderKey: 'pvz.boss' });
    }
    const ball = boss?.projectile;
    const oldBall = oldBoss?.projectile;
    if (ball && (ball.kind !== oldBall?.kind || ball.row !== oldBall?.row)) {
      events.push({ type: 'pvz.boss.projectile', text: `[PvZ] ${renderBossProjectile(ball)}`,
        urgent: true, senderKey: 'pvz.boss' });
    } else if (boss && oldBall && !ball) {
      events.push({ type: 'pvz.boss.projectile',
        text: `[PvZ] 第${oldBall.row}排${oldBall.kind === 'fireball' ? '火球' : '冰球'}已不在画面中`,
        urgent: true, senderKey: 'pvz.boss' });
    }
  }
  if (entityContinuity) {
    for (let row = 1; row <= after.board!.rows; row++) {
      if ([before, after].some((snapshot) => snapshot.board!.cells.some((cell) =>
        cell.row === row && (cell.blocker === 'fog_hidden' || cell.blocker === 'dark_hidden')))) continue;
      const iceColumns = (snapshot: PvzSnapshot) => snapshot.board!.cells
        .filter((cell) => cell.row === row && cell.blocker === 'ice_trail').map((cell) => cell.column);
      const oldIce = iceColumns(before);
      const newIce = iceColumns(after);
      if (JSON.stringify(oldIce) === JSON.stringify(newIce)) continue;
      events.push({
        type: 'pvz.terrain.ice',
        text: `[PvZ] ${rowText(row)}${newIce.length
          ? `冰道覆盖第${newIce.join('、')}列，不能种植` : '冰道已清除'}`,
        urgent: true,
      });
    }
  }
  if (entityContinuity && after.modeName === 'portal_combat') {
    const portals = renderPortals(after.board!);
    if (JSON.stringify(portals) !== JSON.stringify(renderPortals(before.board!))) {
      events.push({
        type: 'pvz.portals.changed', text: `[PvZ] 传送门变化：${portals.join('；') || '无'}`,
        urgent: true,
      });
    }
    for (const zombie of after.board!.zombies) {
      const old = oldZombies.get(zombie.id);
      if (!old || old.row === zombie.row) continue;
      events.push({
        type: 'pvz.zombie.relocated',
        text: `[PvZ] ${zombieDisplayNameOf(zombie.type, zombie.name)}从${cellText(old.row, old.column)}移到${cellText(zombie.row, zombie.column)}`,
        urgent: true,
      });
    }
  }
  if (entityContinuity && after.modeName === 'zombiquarium') {
    for (const zombie of after.board!.zombies) {
      const old = oldZombies.get(zombie.id);
      if (!old || old.condition === zombie.condition ||
        !zombie.phase?.startsWith('zombiquarium_')) continue;
      events.push({
        type: 'pvz.zombie.hunger',
        text: `[PvZ] ${cellText(zombie.row, zombie.column)}的潜水僵尸${zombie.condition === 'worn'
          ? '饥饿（身体变绿）' : '恢复正常体色'}。`,
        urgent: zombie.condition === 'worn',
        senderKey: 'pvz.zombie',
      });
    }
  }
  const mowerStates = new Map((after.board?.mowers ?? [])
    .map((mower) => [mower.row, mower.state] as const));
  const newlyClose = entityContinuity && after.modeName !== 'zombiquarium' ? (after.board?.zombies ?? []).filter((z) => {
    const old = oldZombies.get(z.id);
    return z.xBand === 'lawn' && old !== undefined && old.xBand !== 'lawn';
  }) : [];
  if (newlyClose.length) {
    events.push({
      type: 'pvz.threat.close',
      text: `[PvZ] 近屋威胁：${newlyClose.map((z) =>
        `${zombieDisplayNameOf(z.type, z.name)}在${cellText(z.row, z.column)}（${mowerStates.get(z.row) === 'ready' ? '这排割草机还在' : mowerStates.get(z.row) === 'triggered' ? '这排割草机正在清路' : '这排没有可用割草机'}）`).join('，')}`,
      urgent: newlyClose.some((z) => mowerStates.get(z.row) === undefined),
      senderKey: 'pvz-threat',
    });
  }

  const newlyVisible = entityContinuity
    ? (after.board?.zombies ?? []).filter((z) => !oldZombies.has(z.id))
    : [];
  if (newlyVisible.length) {
    const urgent = newlyVisible.some((z) => z.xBand === 'lawn' || z.xBand === 'near');
    events.push({
      type: 'pvz.zombie.visible',
      text: `[PvZ] 新出现的可见僵尸：${newlyVisible.map((z) =>
        `${zombieDisplayNameOf(z.type, z.name)}在${cellText(z.row, z.column)}（${bandText(z.xBand)}）`).join('，')}`,
      urgent,
      senderKey: 'pvz-zombie-visible',
      ...(!urgent ? {
        routineKey: `zombie:${semanticKey(newlyVisible.map((z) => `${z.name}:R${z.row}:${z.xBand}`))}`,
      } : {}),
    });
  }

  const bandRank = { lawn: 0, near: 1, mid: 2, far: 3 } as const;
  const approaching = entityContinuity && after.modeName !== 'zombiquarium' ? (after.board?.zombies ?? []).filter((z) => {
    const old = oldZombies.get(z.id);
    return old && z.xBand !== 'lawn' && bandRank[z.xBand] < bandRank[old.xBand];
  }) : [];
  if (approaching.length) {
    const urgent = approaching.some((z) => z.xBand === 'near');
    events.push({
      type: 'pvz.threat.approaching',
      text: `[PvZ] 可见僵尸正在逼近：${approaching.map((z) =>
        `${zombieDisplayNameOf(z.type, z.name)}在${rowText(z.row)}（${bandText(z.xBand)}）`).join('，')}`,
      urgent,
      senderKey: 'pvz-threat-approaching',
      ...(!urgent ? {
        routineKey: `approaching:${semanticKey(approaching.map((z) => `${z.name}:R${z.row}:${z.xBand}`))}`,
      } : {}),
    });
  }

  const oldCollectibles = new Set((before.board?.collectibles ?? []).map((item) => item.id));
  // 阳光不报:它由 World 自己收,模型没有收阳光的动作,报出来只是一条动不了的机会。
  const awardContinuity = sameBoardRun && runFinished && after.lastRun?.outcome === 'won'
    && before.board!.disclosure.entitiesVisible && after.board!.disclosure.entitiesVisible;
  const appearedCollectibles = entityContinuity || awardContinuity
    ? (after.board?.collectibles ?? []).filter((item) =>
      !oldCollectibles.has(item.id) && !isSunCollectible(item.kind)
      && (!runFinished || isTerminalCollectible(item.kind)))
    : [];
  if (appearedCollectibles.length) {
    const ordinaryResources = new Set(['silver_coin', 'gold_coin', 'diamond']);
    const names = appearedCollectibles.map((item) =>
      item.containedName ? `${item.kind}(${item.containedName})` : item.kind);
    const urgent = isWhackSnapshot(after)
      || appearedCollectibles.some((item) => !ordinaryResources.has(item.kind));
    events.push({
      type: 'pvz.collectible.appeared',
      text: `[PvZ] 出现可收集对象：${countBy(appearedCollectibles.map(collectibleName)).join(', ')}${whackSupportCue(after)}`,
      urgent,
      senderKey: 'pvz-collectible',
      ...(!urgent ? { routineKey: `collectible:${semanticKey(names)}` } : {}),
    });
  }

  if (sameBoardRun && !runFinished
    && (before.board!.cursor.kind === 'usable_seed' || after.board!.cursor.kind === 'usable_seed')
    && cursorDescription(before.board!.cursor) !== cursorDescription(after.board!.cursor)) {
    events.push({
      type: 'pvz.cursor.changed',
      text: `[PvZ] 手持 ${cursorDescription(after.board!.cursor)}`,
      urgent: after.board!.cursor.kind === 'usable_seed',
      senderKey: 'pvz.cursor',
    });
  }

  const beforeActions = specialEventState(before);
  const afterActions = specialEventState(after);
  if (sameBoardRun && JSON.stringify(beforeActions) !== JSON.stringify(afterActions)) {
    const becameReady = afterActions.settled === true && beforeActions.settled !== true;
    events.push({
      type: 'pvz.actions.changed',
      text: `[PvZ] 特殊阶段 ${afterActions.phase ?? '无'}；当前动作：${afterActions.allowed.join(', ') || '无'}；目标 ${afterActions.targetCount} 个。`,
      urgent: becameReady,
      senderKey: 'pvz-actions',
    });
  }

  const oldWhackTargets = new Set((before.board?.special?.targets ?? [])
    .filter((target) => target.action === 'whack' && target.id !== null)
    .map((target) => target.id));
  const currentTargets = sameBoardRun ? currentWhackTargets(after) : [];
  const newWhackTargets = currentTargets
    .filter((target) => target.id !== null
      && !oldWhackTargets.has(target.id));
  if (newWhackTargets.length) {
    const text = renderWhackTargetReady(after);
    if (text) {
      events.push({
        type: 'pvz.target.ready',
        text,
        urgent: true,
        senderKey: 'pvz.target',
      });
    }
  }

  const oldMowers = new Map((before.board?.mowers ?? [])
    .map((mower) => [`${mower.row}:${mower.kind}`, mower]));
  const newMowers = new Map((after.board?.mowers ?? [])
    .map((mower) => [`${mower.row}:${mower.kind}`, mower]));
  const usedMowers = entityContinuity ? [...oldMowers].filter(([key, mower]) =>
    mower.state === 'ready' && newMowers.get(key)?.state !== 'ready').map(([, mower]) => mower) : [];
  if (usedMowers.length) {
    events.push({
      type: 'pvz.mower.used',
      text: `[PvZ] 防线触发：${usedMowers.map((mower) => `${rowText(mower.row)}${mowerName(mower.kind)}`).join('、')}`,
      urgent: true,
    });
  }

  const oldCards = new Map((before.board?.cards ?? []).map((card) => [card.slot, card]));
  const nowReady = sameBoardRun
    ? (after.board?.cards ?? []).filter((card) => {
        if (!card.ready || !card.affordable) return false;
        const old = oldCards.get(card.slot);
        return !old || !old.ready || !old.affordable
          || old.type !== card.type || old.imitates !== card.imitates;
      })
    : [];
  if (nowReady.length) {
    const identityArrived = nowReady.some((card) => {
      const old = oldCards.get(card.slot);
      return !old || old.type !== card.type || old.imitates !== card.imitates;
    });
    const names = nowReady.map((card) =>
      card.imitates === null ? card.name : `imitater(${plantName(card.imitates)})`);
    const shown = nowReady.map((card) =>
      card.imitates === null
        ? cardDisplayNameOf(card.type, card.name)
        : `模仿者(${plantDisplayName(card.imitates)})`);
    events.push({
      type: 'pvz.card.ready',
      text: `[PvZ] 卡片可用或已更新：${shown.join(', ')}${whackSupportCue(after)}`,
      urgent: identityArrived || isWhackSnapshot(after),
      senderKey: 'pvz-card-ready',
      ...(!identityArrived ? { routineKey: `card:${semanticKey(names)}` } : {}),
    });
  }

  const conditionRank = { intact: 0, worn: 1, damaged: 2, critical: 3 } as const;
  const oldPlants = new Map((before.board?.plants ?? []).map((plant) => [plant.id, plant]));
  const damagedPlants = entityContinuity ? (after.board?.plants ?? []).filter((plant) => {
    const old = oldPlants.get(plant.id);
    return old && conditionRank[plant.condition] > conditionRank[old.condition];
  }) : [];
  if (damagedPlants.length) {
    events.push({
      type: 'pvz.plant.damaged',
      text: `[PvZ] 植物受损：${damagedPlants.map((plant) =>
        `${plantDisplayNameOf(plant.type, plant.name)}在${cellText(plant.row, plant.column)}（${conditionLabel(plant.condition)}）`).join('，')}`,
      urgent: damagedPlants.some((plant) => plant.condition === 'critical'),
      senderKey: 'pvz-plant-damaged',
    });
  }
  const newPlantIds = new Set((after.board?.plants ?? []).map((plant) => plant.id));
  const bowlingRun = after.mode === 17 || after.mode === 33
    || (after.mode === 0 && after.board?.level === 5);
  const lostPlants = entityContinuity && !bowlingRun
    ? (before.board?.plants ?? []).filter((plant) => {
        if (newPlantIds.has(plant.id)) return false;
        if ((after.board?.plants ?? []).some((candidate) =>
          candidate.row === plant.row && candidate.column === plant.column
          && plantLayerRole(candidate.type) === plantLayerRole(plant.type))) return false;
        const cell = after.board?.cells.find((candidate) =>
          candidate.row === plant.row && candidate.column === plant.column);
        return cell?.playable !== null && cell?.blocker !== 'fog_hidden';
      })
    : [];
  if (lostPlants.length) {
    const selfConsumingTypes = new Set([2, 4, 11, 13, 14, 15, 17, 19, 20, 27, 35]);
    events.push({
      type: 'pvz.plant.lost',
      text: `[PvZ] 可见植物离场：${lostPlants.map((plant) =>
        `${plantDisplayNameOf(plant.type, plant.name)}在${cellText(plant.row, plant.column)}`).join('，')}。`,
      urgent: lostPlants.some((plant) => !selfConsumingTypes.has(plant.type)),
      senderKey: 'pvz-plant-lost',
    });
  }
  const changedLayers = entityContinuity ? (after.board?.plants ?? []).filter((plant) => {
    const old = oldPlants.get(plant.id);
    return old && JSON.stringify(old.layers) !== JSON.stringify(plant.layers);
  }) : [];
  if (changedLayers.length) {
    events.push({
      type: 'pvz.plant.layers_changed',
      text: `[PvZ] 植物叠层变化：${changedLayers.map((plant) =>
        `${plantDisplayNameOf(plant.type, plant.name)}在${cellText(plant.row, plant.column)}（${plant.layers.length ? `叠着 ${plant.layers.join('、')}` : '没有叠层'}）`).join('，')}。`,
      urgent: changedLayers.some((plant) =>
        plant.layers.length < (oldPlants.get(plant.id)?.layers.length ?? 0)),
      senderKey: 'pvz-plant-layers',
    });
  }
  return events;
}

export function isWhackSnapshot(snapshot: PvzSnapshot): boolean {
  if (snapshot.screen !== 'board' || snapshot.board === null) return false;
  return snapshot.board.allowedSpecialActions.includes('whack')
    || snapshot.board.special?.targets.some((target) => target.action === 'whack') === true
    || snapshot.modeName === 'whack_a_zombie'
    || snapshot.mode === 30
    || (snapshot.mode === 0 && snapshot.board.level === 15);
}

function currentWhackTargets(snapshot: PvzSnapshot): PvzSpecialTarget[] {
  return (snapshot.board?.special?.targets ?? [])
    .filter((target) => target.action === 'whack' && target.kind === 'zombie'
      && target.id !== null && target.row !== null && target.column !== null)
    .sort((left, right) => left.column! - right.column!
      || left.row! - right.row!
      || left.id! - right.id!)
    .slice(0, 32);
}

function whackSupportCue(snapshot: PvzSnapshot): string {
  if (!isWhackSnapshot(snapshot)) return '';
  return '\n[PvZ·支援机会] 支援可单独提交；queue:"append" 排在现有任务之后，queue:"now" 中断当前任务。';
}

export function renderWhackTargetReady(snapshot: PvzSnapshot): string | null {
  const targets = currentWhackTargets(snapshot);
  if (!targets.length) return null;
  return `[当前战术快照]\n${renderTacticalSnapshot(snapshot)}\n`
    + `[PvZ·锤击] ${renderWhackProgress(snapshot)}；当前 ${targets.length} 个可锤目标。`
    + `有支援机会时提交普通 queue:"replace" 队列；否则提交 \`${renderWhackSkillQueueCall()}\`。`;
}

export function renderWhackPrefetchCue(
  snapshot: PvzSnapshot,
  sourceTaskId: number,
  phase: 'active' | 'idle' = 'active',
): string | null {
  if (!isWhackSnapshot(snapshot)) return null;
  const state = phase === 'active'
    ? `当前锤击任务#${sourceTaskId}仍在执行，它的后继缓冲位为空`
    : `锤击任务#${sourceTaskId}已经结束，它的后继缓冲位仍为空`;
  return `[当前战术快照]\n${renderTacticalSnapshot(snapshot)}\n`
    + `[PvZ·锤击预取] ${renderWhackProgress(snapshot)}；${state}。`
    + `可用 \`${renderWhackSkillQueueCall('append')}\` 续接；支援、暂停或停止仍可单独操作。`;
}

export function renderWhackTaskState(snapshot: PvzSnapshot): string | null {
  if (!isWhackSnapshot(snapshot)) return null;
  const ready = renderWhackTargetReady(snapshot);
  if (ready) return ready;
  const progress = renderWhackProgress(snapshot);
  return `[当前战术快照]\n${renderTacticalSnapshot(snapshot)}\n`
    + `[PvZ·锤击状态] ${progress}；当前没有可锤目标。处理可见支援机会或等待新目标。`;
}

function renderWhackProgress(snapshot: PvzSnapshot): string {
  return renderProgress(snapshot.board?.progress);
}

function isMetaMenu(screen: PvzScreen): boolean {
  return screen === 'main_menu' || screen === 'mode_selector' || screen === 'seed_picker';
}

function countBy(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => count === 1 ? value : `${value}×${count}`);
}

function semanticKey(values: readonly string[]): string {
  return [...values].sort().join('|');
}

function newlyCompletedRun(before: PvzSnapshot, after: PvzSnapshot): PvzSnapshot['lastRun'] {
  const result = after.lastRun;
  if (!result) return null;
  return !before.lastRun || result.resultId > before.lastRun.resultId ? result : null;
}

function plantLayerRole(type: number): 'base' | 'pumpkin' | 'main' {
  if (type === 16 || type === 33) return 'base';
  if (type === 30) return 'pumpkin';
  return 'main';
}

function modeProgressChanges(
  after: PvzSnapshot,
  before: PvzSnapshot,
  memory?: PvzEventMemory,
): PvzMenuAction[] {
  const profileName = after.profile?.name ?? null;
  const profileChanged = memory
    ? memory.profileName !== profileName
    : before.profile?.name !== after.profile?.name;
  if (profileChanged) memory?.modeProgress.clear();
  if (memory) memory.profileName = profileName;
  if (after.screen !== 'mode_selector') return [];
  const modesBefore = new Map(before.menu
    .filter((item) => item.id.startsWith('mode_'))
    .map((item) => [item.id, item]));
  const progressed: PvzMenuAction[] = [];
  for (const item of after.menu.filter((candidate) => candidate.id.startsWith('mode_'))) {
    const old = profileChanged
      ? undefined
      : memory?.modeProgress.get(item.id) ?? modesBefore.get(item.id);
    if (old && (item.state === 'completed' && old.state !== 'completed'
      || item.record !== null && item.record > (old.record ?? 0))) {
      progressed.push(item);
    }
    memory?.modeProgress.set(item.id, { state: item.state, record: item.record });
  }
  return progressed;
}

function specialEventState(snapshot: PvzSnapshot): {
  allowed: string[];
  phase: string | null;
  settled: boolean | null;
  targetCount: number;
} {
  const board = snapshot.board;
  return {
    allowed: board?.allowedSpecialActions ?? [],
    phase: board?.special?.phase ?? null,
    settled: board?.special?.settled ?? null,
    targetCount: board?.special?.targets.length ?? 0,
  };
}
