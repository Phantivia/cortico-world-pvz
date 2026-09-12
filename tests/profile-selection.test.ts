import { describe, expect, it } from 'vitest';
import { parseNativeMessage, PVZ_NATIVE_PROTOCOL, type PvzSnapshot } from '../src/protocol.ts';
import { renderSnapshot } from '../src/render.ts';
import { verifyAction } from '../src/runtime.ts';
import { resolveSemanticMenuAction } from '../src/semantic.ts';
import { callTool, FakePvzTransport, snapshot, startWorld } from './helpers.ts';

function profileDialog(selected = 'Birch', names = ['Birch', 'LongerName', '春杉']): PvzSnapshot {
  const state = snapshot();
  return snapshot({
    screen: 'dialog',
    profile: { ...state.profile!, name: 'Birch' },
    menu: [
      ...names.map((name, index) => ({
        id: `profile:${name}`, label: name, enabled: true,
        x: 350, y: 180 + index * 24,
        state: name === selected ? 'selected' as const : null, record: null,
      })),
      { id: 'profile_create', label: 'Create profile', enabled: true, x: 350, y: 252, state: null, record: null },
      { id: 'confirm', label: 'Confirm profile', enabled: true, x: 260, y: 500, state: null, record: null },
      { id: 'cancel', label: 'Cancel', enabled: true, x: 450, y: 500, state: null, record: null },
    ],
    dialog: { id: 290001, hasPrimary: true, hasSecondary: true, primaryLabel: 'Confirm profile', secondaryLabel: 'Cancel' },
  });
}

function selectedSnapshot(name: string): PvzSnapshot {
  return { ...profileDialog(name), revision: 2 };
}

function confirmedSnapshot(name: string): PvzSnapshot {
  const state = snapshot();
  return snapshot({ revision: 3, profile: { ...state.profile!, name } });
}

describe('PvZ visible profile selection', () => {
  it('carries real names and pending selection through protocol parsing and rendering', () => {
    const message = parseNativeMessage(JSON.stringify({
      type: 'snapshot', protocol: PVZ_NATIVE_PROTOCOL, snapshot: profileDialog('春杉'),
    }));
    expect(message.type).toBe('snapshot');
    if (message.type !== 'snapshot') throw new Error('expected snapshot');
    const rendered = renderSnapshot(message.snapshot);
    expect(rendered).toContain('profile:春杉[春杉](已选中，待确认)');
    expect(rendered).toContain('profile:LongerName');
    expect(rendered).toContain('confirm[Confirm profile]');
  });

  it('preserves case, punctuation and Unicode when resolving a visible profile identity', () => {
    const names = ['A-B', 'A_B', 'a-b', 'A B', '春杉'];
    const state = profileDialog('A-B', names);
    for (const name of names) {
      expect(resolveSemanticMenuAction(state, `profile:${name}`).label).toBe(name);
    }
    for (const target of ['profile:A b', 'profile:missing', 'PROFILE:A-B', 'A-B']) {
      expect(() => resolveSemanticMenuAction(state, target)).toThrow();
    }
  });

  it('verifies row selection separately from changing the active profile', () => {
    const before = profileDialog();
    const after = selectedSnapshot('LongerName');
    expect(after.profile!.name).toBe('Birch');
    expect(verifyAction({ kind: 'menu', target: 'profile:LongerName' }, before, after))
      .toEqual(['档案 LongerName 已选中，等待 confirm 确认']);
    expect(verifyAction({ kind: 'menu', target: 'profile:LongerName' }, before, selectedSnapshot('春杉'))).toBeNull();
    expect(verifyAction({ kind: 'menu', target: 'profile:LongerName' }, before, confirmedSnapshot('LongerName'))).toBeNull();
    expect(verifyAction({ kind: 'menu', target: 'profile:missing' }, before, after)).toBeNull();
  });

  it('requires the chosen profile to become active after confirmation closes the dialog', () => {
    const before = selectedSnapshot('LongerName');
    const action = { kind: 'menu', target: 'confirm' } as const;
    expect(verifyAction(action, before, confirmedSnapshot('Birch'))).toBeNull();
    expect(verifyAction(action, before, { ...before, revision: 3, profile: confirmedSnapshot('LongerName').profile })).toBeNull();
    expect(verifyAction(action, before, confirmedSnapshot('LongerName'))).toEqual(['当前档案已确认：LongerName']);
    expect(verifyAction(action, profileDialog(), confirmedSnapshot('Birch'))).toEqual(['当前档案已确认：Birch']);
    const disabled = structuredClone(before);
    disabled.menu.find(item => item.id === 'confirm')!.enabled = false;
    expect(verifyAction(action, disabled, confirmedSnapshot('LongerName'))).toBeNull();
  });

  it('runs selection and confirmation in order with a fresh read for each step', async () => {
    const transport = new FakePvzTransport(profileDialog());
    const reads: number[] = [];
    transport.actionHandler = (action, fake) => {
      if (action.kind !== 'menu') return { accepted: false, reason: 'only semantic menus are supported' };
      reads.push(fake.snapshotRequests);
      if (action.target.startsWith('profile:')) {
        if (!fake.state.menu.some(item => item.id === action.target && item.enabled)) {
          return { accepted: false, reason: 'profile is no longer visible' };
        }
        fake.publish(draft => {
          for (const item of draft.menu) {
            if (item.id.startsWith('profile:')) item.state = item.id === action.target ? 'selected' : null;
          }
          draft.inputControl.menuContext += 1;
        });
      } else if (action.target === 'confirm') {
        const selected = fake.state.menu.find(item => item.id.startsWith('profile:') && item.state === 'selected');
        if (!selected) return { accepted: false, reason: 'no selected profile' };
        fake.publish(draft => {
          draft.profile!.name = selected.label;
          draft.screen = 'main_menu';
          draft.dialog = null;
          draft.menu = snapshot().menu;
          draft.inputControl.menuContext += 1;
        });
      }
    };
    const { world, host } = await startWorld(transport);
    try {
      expect(await callTool(world, 'pvz_do', { steps: [
        { skill: 'menu', action: 'profile:LongerName' },
        { skill: 'menu', action: 'confirm' },
      ] })).toContain('已受理');
      await expect.poll(async () => callTool(world, 'pvz_queue')).toContain('任务#1完成');
      expect(transport.state.profile!.name).toBe('LongerName');
      expect(transport.state.dialog).toBeNull();
      expect(transport.commands).toEqual([
        { kind: 'menu', target: 'profile:LongerName' },
        { kind: 'menu', target: 'confirm' },
      ]);
      expect(reads[1]).toBeGreaterThan(reads[0]!);
      expect(host.events.find(({ event }) => event.type === 'pvz.task')!.event.text).toContain('档案 LongerName:');
    } finally { await world.stop(); }
  });

  it('keeps compatibility clicks blocked for a recognized profile dialog even after a glance', async () => {
    const transport = new FakePvzTransport(profileDialog());
    const { world } = await startWorld(transport);
    try {
      await callTool(world, 'pvz_glance');
      await callTool(world, 'pvz_do', { steps: [{ skill: 'visual_click', x: 350, y: 204 }] });
      await expect.poll(async () => callTool(world, 'pvz_queue')).toContain('视觉坐标点击只用于没有语义控件的未知兼容界面');
      expect(transport.commands.some(action => action.kind === 'visual_click')).toBe(false);
      expect(transport.state.profile!.name).toBe('Birch');
      expect(transport.state.dialog).not.toBeNull();
    } finally { await world.stop(); }
  });
});
