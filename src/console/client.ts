import type {
  ConsoleClientBundle,
  ConsolePanelContext,
  ConsolePanel,
} from 'cortico/web/shared/client-panel.ts';

interface PvzGameState {
  phase: 'stopped' | 'starting' | 'running' | 'recovering' | 'error';
  detail: string | null;
  pid: number | null;
  stoppable: boolean;
}

const PHASE_LABEL: Record<PvzGameState['phase'], string> = {
  stopped: '未启动',
  starting: '启动中',
  running: '运行中',
  recovering: '恢复中',
  error: '启动失败',
};

const gamePanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    const { root, ui } = ctx;
    const card = ui.sheet({
      title: '植物大战僵尸',
      en: 'game',
      desc: '由 worlds-pvz 启动游戏并连接植入件。手动关掉游戏窗口后 World 停在未启动，不会自己把它拉回来。',
    });
    const stateBox = ui.h('div');
    const message = ui.msgline('');
    const stop = ui.button('停止', { variant: 'danger' });
    const start = ui.button('启动游戏', { variant: 'primary' });
    const actions = ui.actions();
    actions.append(ui.h('span', 'grow'), stop, start);
    card.body.append(stateBox, message, actions);
    root.appendChild(card.el);

    let state: PvzGameState | null = null;
    /** 有动作在飞的时候两个键都不能按,也不让轮询把它们重新点亮。 */
    let busy = false;

    const render = (next: PvzGameState): void => {
      if (ctx.signal.aborted) return;
      state = next;
      const active = next.phase === 'running';
      const pending = next.phase === 'starting' || next.phase === 'recovering';
      stateBox.replaceChildren(ui.kv([
        { k: '状态', v: ui.pill(PHASE_LABEL[next.phase], active ? 'on' : 'off') },
        { k: '进程', v: next.pid === null ? '—' : `PID ${next.pid}` },
        { k: '说明', v: next.detail ?? '—' },
      ]));
      start.disabled = busy || active || pending;
      start.textContent = next.phase === 'error' ? '重新启动' : '启动游戏';
      stop.disabled = busy || !next.stoppable;
    };

    const refresh = async (): Promise<void> => {
      try {
        render(await ctx.invoke<PvzGameState>('state'));
      } catch (error) {
        if (!ctx.signal.aborted) message.textContent = `状态读取失败:${errorText(error)}`;
      }
    };

    const act = (method: 'start' | 'stop', working: string, done: string): void => {
      busy = true;
      start.disabled = true;
      stop.disabled = true;
      message.textContent = working;
      void ctx.invoke<PvzGameState>(method).then(
        async (next) => {
          busy = false;
          render(next);
          message.textContent = method === 'start'
            ? (next.phase === 'running' ? done : '')
            : done;
          await ctx.refresh();
        },
        async (error: unknown) => {
          busy = false;
          message.textContent = `${method === 'start' ? '启动' : '停止'}失败:${errorText(error)}`;
          await refresh();
          await ctx.refresh();
        },
      );
    };

    start.addEventListener('click', () => {
      if (state?.phase === 'running') return;
      act('start', '正在启动…', '游戏已连接');
    }, { signal: ctx.signal });

    stop.addEventListener('click', () => {
      act('stop', '正在停止…', '已停止');
    }, { signal: ctx.signal });

    void refresh();
    ctx.interval(() => { if (!busy) void refresh(); }, 1000);
  },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const bundle: ConsoleClientBundle = { panels: { game: gamePanel } };

export default bundle;
