// Self-contained main-world UI for Antigravity Project Radar.
module.exports = function installAgRadarWidget() {
  if (window.__agRadarInstalled) return;
  if (!document.documentElement) {
    document.addEventListener('DOMContentLoaded', installAgRadarWidget, { once: true });
    return;
  }
  if (!window.agRadarHost) return;
  window.__agRadarInstalled = true;

  const report = (stage, details = {}) => window.agRadarHost?.report?.({ stage, ...details });
  report('boot', { hostFound: true });

  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const HOST_CSS_ID = 'ag-radar-host-css';
  const POPOVER_ID = 'ag-radar-popover-host';
  const BADGE_ATTR = 'data-ag-radar-badge';
  const GLOBAL_ATTR = 'data-ag-radar-global';

  const detectLocale = () => {
    try {
      const saved = localStorage.getItem('ag-pulse-language');
      if (saved === 'en' || saved === 'zh-CN' || saved === 'zh-TW') return saved;
    } catch {}
    const nav = String(navigator.language || '');
    if (/^zh\b/i.test(nav)) return /tw|hk|mo|hant/i.test(nav) ? 'zh-TW' : 'zh-CN';
    return 'en';
  };

  const DICT = {
    'zh-CN': {
      globalTitle: '跨项目并行任务',
      running: '运行中',
      waiting: '待确认',
      done: '刚完成',
      error: '异常',
      clearDone: '清除已读',
      dismiss: '标为已读',
      empty: '暂无活跃或未读完成任务',
      unassigned: '未归属项目',
      subagents: n => `+${n} 子任务`,
      justNow: '刚刚',
      ago: t => `${t}前`,
      globalAria: (r, w, d) => `并行任务：${r} 运行中，${w} 待确认，${d} 刚完成`,
      badgeAria: (name, r, w, d) => `${name}：${r} 运行中，${w} 待确认，${d} 刚完成`,
      offline: '连接暂不可用',
    },
    'zh-TW': {
      globalTitle: '跨專案並行任務',
      running: '執行中',
      waiting: '待確認',
      done: '剛完成',
      error: '異常',
      clearDone: '清除已讀',
      dismiss: '標為已讀',
      empty: '暫無活躍或未讀完成任務',
      unassigned: '未歸屬專案',
      subagents: n => `+${n} 子任務`,
      justNow: '剛剛',
      ago: t => `${t}前`,
      globalAria: (r, w, d) => `並行任務：${r} 執行中，${w} 待確認，${d} 剛完成`,
      badgeAria: (name, r, w, d) => `${name}：${r} 執行中，${w} 待確認，${d} 剛完成`,
      offline: '連線暫時無法使用',
    },
    en: {
      globalTitle: 'Parallel Tasks',
      running: 'Running',
      waiting: 'Needs input',
      done: 'Done',
      error: 'Error',
      clearDone: 'Clear done',
      dismiss: 'Dismiss',
      empty: 'No active or unread tasks',
      unassigned: 'Other conversations',
      subagents: n => `+${n} subagent${n > 1 ? 's' : ''}`,
      justNow: 'just now',
      ago: t => `${t} ago`,
      globalAria: (r, w, d) => `Parallel tasks: ${r} running, ${w} waiting, ${d} done`,
      badgeAria: (name, r, w, d) => `${name}: ${r} running, ${w} waiting, ${d} done`,
      offline: 'Radar offline',
    },
  };

  let locale = detectLocale();
  const str = key => (DICT[locale] || DICT.en)[key];

  const formatDuration = ms => {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const zh = locale !== 'en';
    if (sec < 60) return `${sec}${zh ? '秒' : 's'}`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (min < 60) return remSec ? `${min}${zh ? '分' : 'm '}${remSec}${zh ? '秒' : 's'}` : `${min}${zh ? '分' : 'm'}`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return `${hr}${zh ? '小时' : 'h '}${remMin}${zh ? '分' : 'm'}`;
  };

  const formatClockTime = ts => {
    if (!Number.isFinite(ts)) return '';
    const date = new Date(ts);
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
    return sameDay ? hm : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`;
  };

  const escapeHtml = value => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  const theme = window.__agRadarThemeFactory ? window.__agRadarThemeFactory() : null;
  let themeController = null;
  let disposed = false;
  let latestSnapshot = { connection: 'waiting', items: [], totals: { running: 0, waiting: 0, done: 0, error: 0 } };
  let knownProjectLabels = new Map();
  let knownDropIds = new Map();
  let domConvProject = new Map();

  let popoverHost = null;
  let popoverRoot = null;
  let popoverState = { open: false, pinned: false, mode: null, projectLabel: null, anchorEl: null };
  let hoverOpenTimer = null;
  let hoverCloseTimer = null;
  let syncFrame = null;
  let fetchInFlight = null;
  let lastFetchAt = 0;

  const currentConversationId = () => {
    const match = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    return match && GUID.test(match[1]) ? match[1].toLowerCase() : null;
  };

  const ensureHostCss = () => {
    if (document.getElementById(HOST_CSS_ID)) return;
    const style = document.createElement('style');
    style.id = HOST_CSS_ID;
    style.textContent = `
      .ag-radar-badge-slot {
        position: absolute;
        right: 6px;
        top: 50%;
        transform: translate3d(0, -50%, 0);
        z-index: 3;
        display: inline-flex;
        align-items: center;
        pointer-events: auto;
      }
      .group\\/header[data-ag-radar-has-badge="true"] > div.absolute.right-1 {
        transition: transform 150ms cubic-bezier(0.32, 0.72, 0, 1), opacity 150ms ease;
        transform: translate3d(calc(-1 * (var(--ag-radar-w, 34px) + 6px)), 0, 0);
      }
      .ag-radar-global-slot {
        display: inline-flex;
        align-items: center;
        margin-left: 4px;
        flex-shrink: 0;
      }
      @media (prefers-reduced-motion: reduce) {
        .group\\/header[data-ag-radar-has-badge="true"] > div.absolute.right-1 { transition: none; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  };

  const SHARED_PILL_CSS = `
    :host {
      font-family: var(--radar-font, system-ui, sans-serif);
      color: var(--radar-foreground);
      line-height: 1;
    }
    * { box-sizing: border-box; }
    .pills {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      background: var(--radar-sidebar);
      border-radius: 999px;
      padding: 1px;
    }
    .pill {
      appearance: none;
      border: 1px solid var(--radar-border);
      background: var(--radar-sidebar);
      color: var(--radar-foreground);
      border-radius: 999px;
      height: 18px;
      padding: 0 5px;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-family: var(--radar-mono, ui-monospace, monospace);
      font-size: 10.5px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      outline: none;
      transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
    }
    .pill:hover {
      background: var(--radar-hover);
    }
    .pill:focus-visible {
      outline: 2px solid var(--radar-accent);
      outline-offset: 1px;
    }
    .pill.is-running {
      color: var(--radar-accent);
      background: var(--radar-accent-bg);
      border-color: var(--radar-accent-border);
    }
    .pill.is-waiting, .pill.is-attention {
      color: var(--radar-warning);
      background: var(--radar-warning-bg);
      border-color: var(--radar-warning-border);
    }
    .pill.is-error {
      color: var(--radar-danger);
      background: var(--radar-danger-bg);
      border-color: var(--radar-danger-border);
    }
    .pill.is-done {
      color: var(--radar-success);
      background: var(--radar-success-bg);
      border-color: var(--radar-success-border);
    }
    .spin {
      width: 10px;
      height: 10px;
      animation: radar-spin 0.9s linear infinite;
      flex-shrink: 0;
    }
    .icon {
      width: 10px;
      height: 10px;
      flex-shrink: 0;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      flex-shrink: 0;
    }
    @keyframes radar-spin {
      to { transform: rotate(360deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      .spin { animation: none; }
    }
  `;

  const POPOVER_CSS = `
    :host {
      position: fixed;
      inset: 0;
      z-index: 2147483000;
      pointer-events: none;
      font-family: var(--radar-font, system-ui, sans-serif);
      color: var(--radar-foreground);
    }
    * { box-sizing: border-box; }
    .popover {
      position: fixed;
      width: 324px;
      max-width: calc(100vw - 24px);
      max-height: min(420px, calc(100vh - 24px));
      display: flex;
      flex-direction: column;
      background: var(--radar-card);
      color: var(--radar-foreground);
      border: 1px solid var(--radar-border);
      border-radius: 10px;
      box-shadow: var(--radar-shadow);
      pointer-events: auto;
      overflow: hidden;
      opacity: 0;
      transform: translateX(-4px);
      transition: opacity 130ms ease, transform 130ms cubic-bezier(0.32, 0.72, 0, 1);
    }
    .popover.open {
      opacity: 1;
      transform: translateX(0);
    }
    .popover[hidden] {
      display: none;
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 9px 12px;
      border-bottom: 1px solid var(--radar-border);
      background: var(--radar-card);
    }
    .head-title {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      font-size: 13px;
      font-weight: 500;
      letter-spacing: -0.01em;
      color: var(--radar-foreground);
    }
    .head-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .head-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .action-btn {
      appearance: none;
      border: 1px solid transparent;
      background: transparent;
      color: var(--radar-muted);
      border-radius: 6px;
      padding: 3px 7px;
      font-size: 11.5px;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      transition: background-color 120ms ease, color 120ms ease;
    }
    .action-btn:hover {
      background: var(--radar-hover);
      color: var(--radar-foreground);
    }
    .action-btn:focus-visible {
      outline: 2px solid var(--radar-accent);
      outline-offset: 1px;
    }
    .body {
      overflow-y: auto;
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      scrollbar-width: thin;
      scrollbar-color: var(--radar-border) transparent;
    }
    .body::-webkit-scrollbar {
      width: 6px;
    }
    .body::-webkit-scrollbar-track {
      background: transparent;
    }
    .body::-webkit-scrollbar-thumb {
      background: var(--radar-border);
      border-radius: 999px;
    }
    .group-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--radar-muted);
      padding: 6px 7px 3px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 7px 8px;
      border-radius: 7px;
      cursor: pointer;
      border: 1px solid transparent;
      background: transparent;
      width: 100%;
      text-align: left;
      color: inherit;
      font-family: inherit;
      transition: background-color 110ms ease;
      position: relative;
    }
    .row:hover {
      background: var(--radar-hover);
    }
    .row:focus-visible {
      outline: 2px solid var(--radar-accent);
      outline-offset: -1px;
    }
    .glyph {
      width: 14px;
      height: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 2px;
      flex-shrink: 0;
    }
    .glyph.running { color: var(--radar-accent); }
    .glyph.waiting { color: var(--radar-warning); }
    .glyph.error { color: var(--radar-danger); }
    .glyph.done { color: var(--radar-success); }
    .spin {
      width: 12px;
      height: 12px;
      animation: radar-spin 0.9s linear infinite;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
    }
    .row-main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .row-title {
      font-size: 12.5px;
      font-weight: 450;
      line-height: 1.38;
      color: var(--radar-secondary-fg, var(--radar-foreground));
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
    }
    .row:hover .row-title {
      color: var(--radar-foreground);
    }
    .row-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: var(--radar-mono, ui-monospace, monospace);
      font-size: 11px;
      color: var(--radar-muted);
    }
    .tag {
      font-weight: 600;
    }
    .tag.running { color: var(--radar-accent); }
    .tag.waiting { color: var(--radar-warning); }
    .tag.error { color: var(--radar-danger); }
    .tag.done { color: var(--radar-success); }
    .dismiss {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--radar-muted);
      width: 20px;
      height: 20px;
      border-radius: 5px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      opacity: 0;
      flex-shrink: 0;
      transition: opacity 110ms ease, background-color 110ms ease, color 110ms ease;
    }
    .row:hover .dismiss, .dismiss:focus-visible {
      opacity: 1;
    }
    .dismiss:hover {
      background: var(--radar-card);
      color: var(--radar-foreground);
    }
    .empty {
      padding: 20px 12px;
      text-align: center;
      font-size: 12px;
      color: var(--radar-muted);
    }
    @keyframes radar-spin {
      to { transform: rotate(360deg); }
    }
  `;

  const SPINNER_SVG = `<svg class="spin" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-opacity="0.24" stroke-width="2"/><path d="M8 2.5A5.5 5.5 0 0 1 13.5 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  const CHECK_SVG = `<svg class="icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5L6.5 11.5L12.5 4.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const CLOSE_SVG = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

  const collectSidebarProjects = () => {
    const headers = document.querySelectorAll('[data-testid="project-header"]');
    const convMap = new Map();
    for (const btn of headers) {
      const label = btn.getAttribute('data-project-label');
      if (!label) continue;
      knownProjectLabels.set(label.toLowerCase(), label);
      const section = btn.closest('[data-sidebar-section-drop-id]');
      const dropId = section?.getAttribute('data-sidebar-section-drop-id') || null;
      if (dropId) knownDropIds.set(label, dropId);
      if (section && btn.getAttribute('aria-expanded') === 'true') {
        for (const a of section.querySelectorAll('a[href*="/c/"]')) {
          const m = a.getAttribute('href')?.match(/\/c\/([0-9a-f-]{36})/i);
          if (m && GUID.test(m[1])) convMap.set(m[1].toLowerCase(), label);
        }
      }
    }
    domConvProject = convMap;
  };

  const resolveItemProject = item => {
    const domHit = domConvProject.get(item.id);
    if (domHit) return domHit;
    for (const name of item.folderNames || []) {
      const hit = knownProjectLabels.get(String(name).toLowerCase());
      if (hit) return hit;
    }
    for (const repo of item.repoNames || []) {
      const hit = knownProjectLabels.get(String(repo).toLowerCase());
      if (hit) return hit;
    }
    return null;
  };

  const groupItemsByProject = items => {
    const byProject = new Map();
    const unassigned = [];
    for (const item of items || []) {
      const project = resolveItemProject(item);
      if (project) {
        if (!byProject.has(project)) byProject.set(project, []);
        byProject.get(project).push(item);
      } else {
        unassigned.push(item);
      }
    }
    return { byProject, unassigned };
  };

  const summarizeItems = items => {
    const counts = { running: 0, waiting: 0, done: 0, error: 0 };
    for (const item of items || []) {
      if (Object.hasOwn(counts, item.state)) counts[item.state]++;
    }
    return counts;
  };

  let cachedRouter = null;
  const findAppRouter = () => {
    if (cachedRouter && typeof cachedRouter.navigate === 'function') return cachedRouter;
    const anchor = document.querySelector('[data-testid="new-conversation-button"], [role="navigation"][aria-label="Sidebar"]');
    if (!anchor) return null;
    const fiberKey = Object.keys(anchor).find(k => k.startsWith('__reactFiber'));
    if (!fiberKey) return null;
    let fiber = anchor[fiberKey];
    for (let i = 0; i < 240 && fiber; i++) {
      const val = fiber.memoizedProps?.value;
      if (val && typeof val === 'object' && typeof val.navigate === 'function' && typeof val.buildLocation === 'function') {
        cachedRouter = val;
        return val;
      }
      fiber = fiber.return;
    }
    return null;
  };

  const navigateToConversation = (id, projectLabel) => {
    const existing = document.querySelector(`a[href="/c/${id}"], a[href^="/c/${id}?"]`);
    if (existing) {
      existing.click();
      return;
    }
    const dropId = projectLabel ? knownDropIds.get(projectLabel) : null;
    const router = findAppRouter();
    if (router) {
      try {
        void router.navigate({
          to: `/c/${id}`,
          ...(dropId ? { search: { project: dropId } } : {}),
        });
        return;
      } catch {}
    }
    const href = `/c/${id}${dropId ? `?project=${encodeURIComponent(dropId)}` : ''}`;
    history.pushState({}, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  const markItemsRead = async input => {
    try {
      const next = await window.agRadarHost.markRead(input);
      if (next && Array.isArray(next.items)) {
        latestSnapshot = next;
        renderAll();
      }
    } catch {}
  };

  const ensurePopover = () => {
    if (popoverHost && popoverHost.isConnected) return;
    popoverHost = document.createElement('div');
    popoverHost.id = POPOVER_ID;
    popoverRoot = popoverHost.attachShadow({ mode: 'open' });
    popoverRoot.innerHTML = `<style>${theme ? theme.shadowCss() : ''}${POPOVER_CSS}</style><div class="popover" hidden role="dialog" aria-label="Project Radar"></div>`;
    const pop = popoverRoot.querySelector('.popover');
    pop.addEventListener('pointerenter', () => { clearTimeout(hoverCloseTimer); });
    pop.addEventListener('pointerleave', () => {
      if (!popoverState.pinned) schedulePopoverClose();
    });
    document.documentElement.appendChild(popoverHost);
    themeController?.update();
  };

  const positionPopover = anchorEl => {
    const pop = popoverRoot?.querySelector('.popover');
    if (!pop || !anchorEl?.isConnected) return;
    const rect = anchorEl.getBoundingClientRect();
    const sidebar = anchorEl.closest('[role="navigation"][aria-label="Sidebar"]');
    const sidebarRect = sidebar?.getBoundingClientRect();
    const left = Math.min(window.innerWidth - 336, Math.max(12, (sidebarRect ? sidebarRect.right : rect.right) + 8));
    pop.style.left = `${Math.round(left)}px`;
    const estHeight = Math.min(420, pop.scrollHeight || 260);
    const top = Math.min(window.innerHeight - estHeight - 12, Math.max(12, rect.top - 6));
    pop.style.top = `${Math.round(top)}px`;
  };

  const renderTaskRow = (item, projectLabel) => {
    const stateLabel = str(item.state);
    const glyph = item.state === 'running'
      ? SPINNER_SVG
      : item.state === 'done'
        ? CHECK_SVG
        : `<span class="dot"></span>`;
    let timeHtml = '';
    if (item.state === 'running') {
      const startTs = Number.isFinite(item.startedAt) ? item.startedAt : (Number.isFinite(item.modifiedAt) ? item.modifiedAt : Date.now());
      timeHtml = `<span data-live-start="${startTs}">${escapeHtml(formatDuration(Date.now() - startTs))}</span>`;
    } else if (item.state === 'waiting') {
      const t = formatClockTime(item.modifiedAt || item.startedAt);
      if (t) timeHtml = `<span>${escapeHtml(t)}</span>`;
    } else {
      const t = formatClockTime(item.completedAt || item.modifiedAt);
      if (t) timeHtml = `<span>${escapeHtml(t)}</span>`;
    }
    const sub = item.runningSubagents > 0 ? `<span>${escapeHtml(str('subagents')(item.runningSubagents))}</span>` : '';
    const canDismiss = item.state === 'done' || item.state === 'error';
    return `
      <div class="row" role="button" tabindex="0" data-conv-id="${escapeHtml(item.id)}" data-project-name="${escapeHtml(projectLabel || '')}" data-state="${escapeHtml(item.state)}">
        <span class="glyph ${escapeHtml(item.state)}">${glyph}</span>
        <span class="row-main">
          <span class="row-title">${escapeHtml(item.title)}</span>
          <span class="row-meta">
            <span class="tag ${escapeHtml(item.state)}">${escapeHtml(stateLabel)}</span>
            ${timeHtml}
            ${sub}
          </span>
        </span>
        ${canDismiss ? `<button type="button" class="dismiss" data-dismiss-id="${escapeHtml(item.id)}" title="${escapeHtml(str('dismiss'))}" aria-label="${escapeHtml(str('dismiss'))}">${CLOSE_SVG}</button>` : ''}
      </div>
    `;
  };

  const updateLiveDurations = () => {
    if (!popoverState.open || !popoverRoot) return;
    const now = Date.now();
    for (const el of popoverRoot.querySelectorAll('[data-live-start]')) {
      const start = Number(el.dataset.liveStart);
      if (!Number.isFinite(start)) continue;
      const next = formatDuration(now - start);
      if (el.textContent !== next) el.textContent = next;
    }
  };

  const renderPopover = () => {
    if (!popoverState.open) return;
    ensurePopover();
    const pop = popoverRoot.querySelector('.popover');
    const { byProject, unassigned } = groupItemsByProject(latestSnapshot.items);
    const isProject = popoverState.mode === 'project' && popoverState.projectLabel;
    const title = isProject ? popoverState.projectLabel : str('globalTitle');
    const items = isProject ? (byProject.get(popoverState.projectLabel) || []) : (latestSnapshot.items || []);
    const clearIds = items.filter(it => it.state === 'done' || it.state === 'error').map(it => it.id);

    const alreadyOpen = !pop.hidden && pop.classList.contains('open');
    const contentSig = JSON.stringify([
      popoverState.mode,
      popoverState.projectLabel,
      locale,
      items.map(it => [it.id, it.state, it.title, it.runningSubagents, it.startedAt, it.completedAt, it.modifiedAt]),
    ]);
    if (alreadyOpen && pop.dataset.contentSig === contentSig) {
      updateLiveDurations();
      positionPopover(popoverState.anchorEl);
      return;
    }
    pop.dataset.contentSig = contentSig;

    let bodyHtml = '';
    if (!items.length) {
      bodyHtml = `<div class="empty">${escapeHtml(str('empty'))}</div>`;
    } else if (isProject) {
      bodyHtml = items.map(it => renderTaskRow(it, popoverState.projectLabel)).join('');
    } else {
      const groups = [...byProject.entries()];
      if (unassigned.length) groups.push([null, unassigned]);
      bodyHtml = groups.map(([proj, list]) => `
        <div class="group-label"><span>${escapeHtml(proj || str('unassigned'))}</span><span>${list.length}</span></div>
        ${list.map(it => renderTaskRow(it, proj)).join('')}
      `).join('');
    }

    const prevScroll = pop.querySelector('.body')?.scrollTop || 0;

    pop.innerHTML = `
      <div class="head">
        <div class="head-title"><span class="head-name">${escapeHtml(title)}</span></div>
        <div class="head-actions">
          ${clearIds.length ? `<button type="button" class="action-btn" data-clear-done="true">${escapeHtml(str('clearDone'))}</button>` : ''}
        </div>
      </div>
      <div class="body">${bodyHtml}</div>
    `;

    const nextBody = pop.querySelector('.body');
    if (alreadyOpen && nextBody && prevScroll > 0) nextBody.scrollTop = prevScroll;

    pop.querySelector('[data-clear-done]')?.addEventListener('click', e => {
      e.stopPropagation();
      void markItemsRead(isProject ? { conversationIds: clearIds } : { all: true });
      if (items.length === clearIds.length) closePopover();
    });

    for (const btn of pop.querySelectorAll('[data-dismiss-id]')) {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = btn.getAttribute('data-dismiss-id');
        if (id) void markItemsRead({ conversationId: id });
      });
    }

    for (const row of pop.querySelectorAll('.row[data-conv-id]')) {
      const activate = () => {
        const id = row.getAttribute('data-conv-id');
        const proj = row.getAttribute('data-project-name') || null;
        const st = row.getAttribute('data-state');
        if (!id) return;
        navigateToConversation(id, proj);
        if (st === 'done' || st === 'error') void markItemsRead({ conversationId: id });
        closePopover();
      };
      row.addEventListener('click', activate);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });
    }

    const wasHidden = pop.hidden;
    pop.hidden = false;
    positionPopover(popoverState.anchorEl);
    if (wasHidden) requestAnimationFrame(() => pop.classList.add('open'));
    else pop.classList.add('open');
  };

  const openPopover = ({ mode, projectLabel = null, anchorEl, pinned = false }) => {
    clearTimeout(hoverOpenTimer);
    clearTimeout(hoverCloseTimer);
    popoverState = { open: true, pinned, mode, projectLabel, anchorEl };
    renderPopover();
  };

  const closePopover = () => {
    clearTimeout(hoverOpenTimer);
    clearTimeout(hoverCloseTimer);
    popoverState = { open: false, pinned: false, mode: null, projectLabel: null, anchorEl: null };
    const pop = popoverRoot?.querySelector('.popover');
    if (pop) {
      delete pop.dataset.contentSig;
      pop.classList.remove('open');
      pop.hidden = true;
    }
  };

  const schedulePopoverClose = () => {
    clearTimeout(hoverCloseTimer);
    hoverCloseTimer = setTimeout(() => {
      if (!popoverState.pinned) closePopover();
    }, 220);
  };

  const buildPillsMarkup = (counts, ariaLabel) => {
    const chips = [];
    const attention = counts.waiting + counts.error;
    if (attention > 0) {
      const cls = counts.error > 0 && counts.waiting === 0 ? 'is-error' : 'is-waiting';
      chips.push(`<button type="button" class="pill ${cls}" aria-label="${escapeHtml(ariaLabel)}"><span class="dot"></span><span>${attention}</span></button>`);
    }
    if (counts.running > 0) {
      chips.push(`<button type="button" class="pill is-running" aria-label="${escapeHtml(ariaLabel)}">${SPINNER_SVG}<span>${counts.running}</span></button>`);
    }
    if (counts.done > 0 && chips.length < 2) {
      chips.push(`<button type="button" class="pill is-done" aria-label="${escapeHtml(ariaLabel)}">${CHECK_SVG}<span>${counts.done}</span></button>`);
    }
    return `<style>${theme ? theme.shadowCss() : ''}${SHARED_PILL_CSS}</style><span class="pills">${chips.join('')}</span>`;
  };

  const mountPillSlot = (slot, counts, mode, projectLabel, ariaLabel) => {
    const total = counts.running + counts.waiting + counts.done + counts.error;
    if (!total) {
      if (slot.isConnected) slot.remove();
      return;
    }
    if (!slot.shadowRoot) {
      slot.attachShadow({ mode: 'open' });
      slot.addEventListener('pointerenter', () => {
        clearTimeout(hoverCloseTimer);
        if (popoverState.open && popoverState.pinned) return;
        hoverOpenTimer = setTimeout(() => {
          openPopover({ mode, projectLabel, anchorEl: slot, pinned: false });
        }, 160);
      });
      slot.addEventListener('pointerleave', () => {
        clearTimeout(hoverOpenTimer);
        if (!popoverState.pinned) schedulePopoverClose();
      });
      slot.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        if (popoverState.open && popoverState.pinned && popoverState.mode === mode && popoverState.projectLabel === projectLabel) {
          closePopover();
        } else {
          openPopover({ mode, projectLabel, anchorEl: slot, pinned: true });
        }
      });
    }
    const sig = `${counts.running}:${counts.waiting}:${counts.error}:${counts.done}:${locale}`;
    if (slot.dataset.radarSig !== sig) {
      slot.dataset.radarSig = sig;
      slot.shadowRoot.innerHTML = buildPillsMarkup(counts, ariaLabel);
    }
  };

  const renderProjectBadges = byProject => {
    const headers = document.querySelectorAll('[data-testid="project-header"]');
    for (const btn of headers) {
      const label = btn.getAttribute('data-project-label');
      const group = btn.closest('.group\\/header') || btn.parentElement?.parentElement;
      if (!label || !group) continue;
      let slot = [...group.children].find(ch => ch.hasAttribute?.(BADGE_ATTR));
      const items = byProject.get(label) || [];
      const counts = summarizeItems(items);
      const total = counts.running + counts.waiting + counts.done + counts.error;
      if (!total) {
        if (slot) slot.remove();
        group.removeAttribute('data-ag-radar-has-badge');
        group.style.removeProperty('--ag-radar-w');
        continue;
      }
      if (!slot) {
        slot = document.createElement('span');
        slot.setAttribute(BADGE_ATTR, 'true');
        slot.className = 'ag-radar-badge-slot';
        group.appendChild(slot);
      }
      mountPillSlot(slot, counts, 'project', label, str('badgeAria')(label, counts.running, counts.waiting + counts.error, counts.done));
      group.setAttribute('data-ag-radar-has-badge', 'true');
      const width = Math.ceil(slot.getBoundingClientRect().width);
      if (width > 0) group.style.setProperty('--ag-radar-w', `${width}px`);
    }
  };

  const renderGlobalPill = totals => {
    const addBtn = document.querySelector('[data-testid="sidebar-add-project-button"]');
    const projectsText = addBtn ? null : [...document.querySelectorAll('span.truncate')].find(s => s.textContent?.trim() === 'Projects');
    const sectionHeader = (addBtn || projectsText)?.closest('.group\\/section-header');
    if (!sectionHeader) return;
    let slot = [...sectionHeader.children].find(ch => ch.hasAttribute?.(GLOBAL_ATTR));
    const total = totals.running + totals.waiting + totals.done + totals.error;
    if (!total) {
      if (slot) slot.remove();
      return;
    }
    if (!slot) {
      slot = document.createElement('span');
      slot.setAttribute(GLOBAL_ATTR, 'true');
      slot.className = 'ag-radar-global-slot';
      sectionHeader.appendChild(slot);
    } else if (sectionHeader.lastElementChild !== slot) {
      sectionHeader.appendChild(slot);
    }
    mountPillSlot(slot, totals, 'global', null, str('globalAria')(totals.running, totals.waiting + totals.error, totals.done));
  };

  const allShadowTargets = () => [
    popoverHost,
    ...document.querySelectorAll(`[${BADGE_ATTR}], [${GLOBAL_ATTR}]`),
  ].filter(Boolean);

  const renderAll = () => {
    if (disposed) return;
    ensureHostCss();
    collectSidebarProjects();
    const { byProject } = groupItemsByProject(latestSnapshot.items);
    renderProjectBadges(byProject);
    renderGlobalPill(latestSnapshot.totals || { running: 0, waiting: 0, done: 0, error: 0 });
    themeController?.update();
    if (popoverState.open) {
      if (!popoverState.anchorEl?.isConnected) closePopover();
      else renderPopover();
    }
  };

  const scheduleRender = () => {
    if (disposed || syncFrame !== null) return;
    syncFrame = requestAnimationFrame(() => {
      syncFrame = null;
      renderAll();
    });
  };

  const refresh = async (force = false) => {
    if (disposed || fetchInFlight) return fetchInFlight;
    lastFetchAt = Date.now();
    fetchInFlight = (async () => {
      try {
        const res = await window.agRadarHost.getRadar({
          activeConversationId: currentConversationId(),
          focused: document.visibilityState === 'visible' && document.hasFocus(),
          force,
        });
        if (disposed || !res) return;
        if (res.enabled === false) {
          latestSnapshot = { connection: 'disabled', items: [], totals: { running: 0, waiting: 0, done: 0, error: 0 } };
          closePopover();
        } else {
          latestSnapshot = res;
          if (res.theme) themeController?.setHostTheme(res.theme);
        }
        renderAll();
      } catch {}
    })().finally(() => {
      fetchInFlight = null;
    });
    return fetchInFlight;
  };

  if (theme) themeController = theme.attach(allShadowTargets);

  const observer = new MutationObserver(records => {
    for (const r of records) {
      if (r.target?.closest?.(`#${POPOVER_ID}, [${BADGE_ATTR}], [${GLOBAL_ATTR}]`)) continue;
      if ([...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === 1 && (n.hasAttribute?.(BADGE_ATTR) || n.hasAttribute?.(GLOBAL_ATTR) || n.id === POPOVER_ID))) continue;
      scheduleRender();
      break;
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-expanded', 'data-project-label'],
  });

  const onKey = e => { if (e.key === 'Escape') closePopover(); };
  const onPointerDown = e => {
    if (!popoverState.open) return;
    const path = e.composedPath();
    if (popoverHost && path.includes(popoverHost)) return;
    if (popoverState.anchorEl && path.includes(popoverState.anchorEl)) return;
    closePopover();
  };
  const onFocusOrVis = () => { void refresh(true); };

  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('focus', onFocusOrVis);
  document.addEventListener('visibilitychange', onFocusOrVis);

  const pollId = setInterval(() => {
    updateLiveDurations();
    const gap = document.hidden ? 6000 : 1800;
    if (Date.now() - lastFetchAt >= gap) void refresh();
  }, 1000);

  window.__agRadarDispose = () => {
    disposed = true;
    clearInterval(pollId);
    clearTimeout(hoverOpenTimer);
    clearTimeout(hoverCloseTimer);
    if (syncFrame !== null) cancelAnimationFrame(syncFrame);
    observer.disconnect();
    themeController?.dispose();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('focus', onFocusOrVis);
    document.removeEventListener('visibilitychange', onFocusOrVis);
    closePopover();
    popoverHost?.remove();
    document.getElementById(HOST_CSS_ID)?.remove();
    for (const el of document.querySelectorAll('[data-ag-radar-has-badge]')) {
      el.removeAttribute('data-ag-radar-has-badge');
      el.style.removeProperty('--ag-radar-w');
    }
    for (const el of document.querySelectorAll(`[${BADGE_ATTR}], [${GLOBAL_ATTR}]`)) el.remove();
    window.__agRadarInstalled = false;
    delete window.__agRadarDispose;
  };

  renderAll();
  report('mounted', { sidebarFound: Boolean(document.querySelector('[role="navigation"][aria-label="Sidebar"]')) });
  void refresh(true);
};
