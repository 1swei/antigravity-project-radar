import { readFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { platformPaths } from '../../compat/platform.mjs';
import { AntigravityClient } from './client.mjs';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UNREAD_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_UNREAD_ITEMS = 200;
const CACHE_TTL_MS = 1200;

export function normalizeId(value) {
  return typeof value === 'string' && GUID.test(value) ? value.toLowerCase() : null;
}

export function extractWorkspaceKeys(summary) {
  const folderNames = [];
  const repoNames = [];
  const workspaces = Array.isArray(summary?.workspaces) ? summary.workspaces : [];
  for (const ws of workspaces) {
    const rawUri = typeof ws?.workspaceFolderAbsoluteUri === 'string' ? ws.workspaceFolderAbsoluteUri : '';
    if (rawUri) {
      let decoded = rawUri;
      try { decoded = decodeURIComponent(rawUri); } catch {}
      const trimmed = decoded.replace(/^file:\/\//i, '').replace(/[\\/]+$/, '');
      const segment = trimmed.split(/[\\/]/).filter(Boolean).pop();
      if (segment && !folderNames.includes(segment)) folderNames.push(segment);
    }
    const repo = typeof ws?.repository?.computedName === 'string' ? ws.repository.computedName.trim() : '';
    if (repo && !repoNames.includes(repo)) repoNames.push(repo);
  }
  return { folderNames, repoNames };
}

export function classifySummary(summary, { childRunning = 0, childWaiting = 0 } = {}) {
  const status = String(summary?.status || '');
  if (/WAITING|APPROVAL|PENDING|CONFIRM|REVIEW_REQUIRED|USER_ACTION/i.test(status) || childWaiting > 0) {
    return 'waiting';
  }
  if (/RUNNING|ACTIVE|IN_PROGRESS|STREAMING|EXECUTING/i.test(status)
    || summary?.hasRunningSubagents === true
    || summary?.hasActiveChildren === true
    || summary?.notFullyIdle === true
    || childRunning > 0) {
    return 'running';
  }
  if (/FAILED|ERROR/i.test(status)) {
    return 'error';
  }
  return 'settled';
}

function isErrorTermination(summary) {
  const status = String(summary?.status || '');
  const reason = String(summary?.latestExecutorTerminationReason || '');
  return /FAILED|ERROR/i.test(status) || /ERROR|FAILED|MAX_TOKEN|MAX_INVOCATIONS|MAX_FORCED/i.test(reason);
}

function isUserCanceled(summary) {
  const status = String(summary?.status || '');
  const reason = String(summary?.latestExecutorTerminationReason || '');
  return /CANCEL/i.test(status) || /USER_CANCELED|USER_CANCELLED/i.test(reason);
}

function resolveRootId(id, summaries) {
  let cursor = id;
  const visited = new Set([id]);
  for (let hop = 0; hop < 8; hop++) {
    const meta = summaries[cursor]?.trajectoryMetadata;
    const next = normalizeId(meta?.rootConversationId) || normalizeId(meta?.parentConversationId);
    if (!next || visited.has(next) || !Object.hasOwn(summaries, next)) break;
    visited.add(next);
    cursor = next;
  }
  return cursor;
}

function parseTimeMs(iso, fallback) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : fallback;
}

export class RadarStore {
  constructor(client = new AntigravityClient(), {
    dataDir = platformPaths().data,
    owns = () => true,
    now = Date.now,
  } = {}) {
    this.client = client;
    this.stateFile = dataDir ? join(dataDir, 'radar-state.json') : null;
    this.owns = owns;
    this.now = now;
    this.loaded = false;
    this.trackedActive = new Map();
    this.unreadDone = new Map();
    this.lastSummaries = {};
    this.lastSyncAt = -Infinity;
    this.lastError = null;
    this.syncPending = null;
    this.persistQueue = Promise.resolve();
    this.persistTimer = null;
    this.pollTimer = null;
    this.lastViewer = { id: null, focused: true, at: 0 };
  }

  async loadState() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.stateFile) return;
    try {
      const raw = JSON.parse((await readFile(this.stateFile, 'utf8')).replace(/^\uFEFF/, ''));
      if (raw?.schema !== 1) return;
      const cutoff = this.now() - MAX_UNREAD_AGE_MS;
      for (const [id, entry] of Object.entries(raw.trackedActive || {})) {
        const norm = normalizeId(id);
        if (!norm || !entry || typeof entry !== 'object') continue;
        this.trackedActive.set(norm, {
          startedAt: Number.isFinite(entry.startedAt) ? entry.startedAt : this.now(),
          lastStatus: String(entry.lastStatus || 'running'),
          title: String(entry.title || 'Untitled'),
          folderNames: Array.isArray(entry.folderNames) ? entry.folderNames.filter(x => typeof x === 'string') : [],
          repoNames: Array.isArray(entry.repoNames) ? entry.repoNames.filter(x => typeof x === 'string') : [],
        });
      }
      for (const [id, entry] of Object.entries(raw.unreadDone || {})) {
        const norm = normalizeId(id);
        if (!norm || !entry || typeof entry !== 'object') continue;
        if (!Number.isFinite(entry.completedAt) || entry.completedAt < cutoff) continue;
        this.unreadDone.set(norm, {
          completedAt: entry.completedAt,
          startedAt: Number.isFinite(entry.startedAt) ? entry.startedAt : entry.completedAt,
          title: String(entry.title || 'Untitled'),
          kind: entry.kind === 'error' ? 'error' : 'done',
          folderNames: Array.isArray(entry.folderNames) ? entry.folderNames.filter(x => typeof x === 'string') : [],
          repoNames: Array.isArray(entry.repoNames) ? entry.repoNames.filter(x => typeof x === 'string') : [],
        });
      }
    } catch {}
  }

  schedulePersist() {
    if (!this.stateFile || !this.owns()) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, 300);
    this.persistTimer.unref?.();
  }

  async persistNow() {
    if (!this.stateFile || !this.owns()) return;
    const payload = JSON.stringify({
      schema: 1,
      trackedActive: Object.fromEntries(this.trackedActive),
      unreadDone: Object.fromEntries(this.unreadDone),
    });
    const op = this.persistQueue.then(async () => {
      if (!this.owns()) return;
      await mkdir(dirname(this.stateFile), { recursive: true });
      const temp = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(payload + '\n', 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, this.stateFile);
      } finally {
        await rm(temp, { force: true });
      }
    });
    this.persistQueue = op.catch(() => {});
    return op.catch(() => {});
  }

  pruneUnread() {
    const cutoff = this.now() - MAX_UNREAD_AGE_MS;
    let changed = false;
    for (const [id, entry] of this.unreadDone) {
      if (entry.completedAt < cutoff) {
        this.unreadDone.delete(id);
        changed = true;
      }
    }
    if (this.unreadDone.size > MAX_UNREAD_ITEMS) {
      const sorted = [...this.unreadDone.entries()].sort((a, b) => a[1].completedAt - b[1].completedAt);
      for (const [id] of sorted.slice(0, this.unreadDone.size - MAX_UNREAD_ITEMS)) {
        this.unreadDone.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  reconcile(summaries, { activeConversationId = null, focused = true } = {}) {
    const now = this.now();
    const normalized = {};
    for (const [rawId, value] of Object.entries(summaries || {})) {
      const id = normalizeId(rawId);
      if (id && value && typeof value === 'object') normalized[id] = value;
    }

    const childCounts = new Map();
    const roots = new Map();
    for (const [id, summary] of Object.entries(normalized)) {
      const rootId = resolveRootId(id, normalized);
      roots.set(id, rootId);
      if (rootId !== id) {
        const state = classifySummary(summary);
        if (state === 'running' || state === 'waiting') {
          const entry = childCounts.get(rootId) || { running: 0, waiting: 0 };
          if (state === 'running') entry.running++;
          if (state === 'waiting') entry.waiting++;
          childCounts.set(rootId, entry);
        }
      }
    }

    let stateChanged = this.pruneUnread();
    const activeItems = [];
    const seenRootIds = new Set();

    for (const [id, summary] of Object.entries(normalized)) {
      if (roots.get(id) !== id) continue;
      seenRootIds.add(id);

      const children = childCounts.get(id) || { running: 0, waiting: 0 };
      const state = classifySummary(summary, { childRunning: children.running, childWaiting: children.waiting });
      const title = String(summary.summary || '').trim() || 'Untitled';
      const { folderNames, repoNames } = extractWorkspaceKeys(summary);
      const modifiedAt = parseTimeMs(summary.lastModifiedTime, now);
      const userInputAt = parseTimeMs(summary.lastUserInputTime, modifiedAt);

      if (state === 'running' || state === 'waiting') {
        const existing = this.trackedActive.get(id);
        const startedAt = existing?.startedAt ?? Math.min(userInputAt, now);
        if (!existing || existing.lastStatus !== state || existing.title !== title) {
          this.trackedActive.set(id, { startedAt, lastStatus: state, title, folderNames, repoNames });
          stateChanged = true;
        }
        if (this.unreadDone.delete(id)) stateChanged = true;
        activeItems.push({
          id,
          title,
          state,
          startedAt,
          modifiedAt,
          runningSubagents: children.running + children.waiting,
          folderNames,
          repoNames,
        });
      } else {
        const viewedAt = parseTimeMs(summary.annotations?.lastUserViewTime, NaN);
        const rawModifiedAt = parseTimeMs(summary.lastModifiedTime, NaN);
        const alreadyViewedInHost = Number.isFinite(viewedAt) && Number.isFinite(rawModifiedAt) && viewedAt >= rawModifiedAt;
        const prev = this.trackedActive.get(id);
        if (prev) {
          this.trackedActive.delete(id);
          stateChanged = true;
          const viewingNow = focused !== false && activeConversationId === id;
          if (!viewingNow && !alreadyViewedInHost && !isUserCanceled(summary)) {
            const kind = state === 'error' || isErrorTermination(summary) ? 'error' : 'done';
            this.unreadDone.set(id, {
              completedAt: modifiedAt <= now ? modifiedAt : now,
              startedAt: prev.startedAt,
              title: title !== 'Untitled' ? title : prev.title,
              kind,
              folderNames: folderNames.length ? folderNames : prev.folderNames,
              repoNames: repoNames.length ? repoNames : prev.repoNames,
            });
          }
        } else if (alreadyViewedInHost && this.unreadDone.delete(id)) {
          stateChanged = true;
        }
      }
    }

    // If a tracked active conversation disappeared, clear its stale active marker.
    for (const id of [...this.trackedActive.keys()]) {
      if (!seenRootIds.has(id)) {
        this.trackedActive.delete(id);
        stateChanged = true;
      }
    }

    if (focused !== false && activeConversationId && this.unreadDone.delete(activeConversationId)) {
      stateChanged = true;
    }

    if (stateChanged) this.schedulePersist();
    this.lastSummaries = normalized;
    return activeItems;
  }

  buildSnapshot({ activeItems = [], connection = 'live', error = null } = {}) {
    const items = [...activeItems];
    for (const [id, entry] of this.unreadDone) {
      items.push({
        id,
        title: entry.title,
        state: entry.kind,
        startedAt: entry.startedAt,
        completedAt: entry.completedAt,
        modifiedAt: entry.completedAt,
        runningSubagents: 0,
        folderNames: entry.folderNames,
        repoNames: entry.repoNames,
      });
    }

    const order = { waiting: 0, error: 1, running: 2, done: 3 };
    items.sort((a, b) => {
      const rankDiff = (order[a.state] ?? 9) - (order[b.state] ?? 9);
      if (rankDiff !== 0) return rankDiff;
      return (b.modifiedAt || 0) - (a.modifiedAt || 0);
    });

    const totals = { running: 0, waiting: 0, done: 0, error: 0 };
    for (const item of items) {
      if (Object.hasOwn(totals, item.state)) totals[item.state]++;
    }

    return {
      connection,
      error,
      enabled: true,
      updatedAt: this.now(),
      totals,
      items,
    };
  }

  async sync({ force = false, activeConversationId = undefined, focused = undefined } = {}) {
    await this.loadState();
    const now = this.now();
    if (activeConversationId !== undefined || focused !== undefined) {
      this.lastViewer = {
        id: activeConversationId ?? null,
        focused: focused !== false,
        at: now,
      };
    }
    const viewerValid = now - this.lastViewer.at < 6000;
    const viewerId = activeConversationId !== undefined ? activeConversationId : (viewerValid ? this.lastViewer.id : null);
    const viewerFocused = focused !== undefined ? focused !== false : (viewerValid ? this.lastViewer.focused : true);

    if (!force && this.syncPending) return this.syncPending;
    if (!force && now - this.lastSyncAt < CACHE_TTL_MS && !this.lastError) {
      const activeItems = this.reconcile(this.lastSummaries, { activeConversationId: viewerId, focused: viewerFocused });
      return this.buildSnapshot({ activeItems, connection: 'live' });
    }

    const run = (async () => {
      try {
        const res = await this.client.call('GetAllCascadeTrajectories', { excludeSubtrajectories: false });
        this.lastSyncAt = this.now();
        this.lastError = null;
        const activeItems = this.reconcile(res?.trajectorySummaries || {}, { activeConversationId: viewerId, focused: viewerFocused });
        return this.buildSnapshot({ activeItems, connection: 'live' });
      } catch (err) {
        this.lastError = err?.message || 'Unable to connect to Antigravity';
        const activeItems = this.reconcile(this.lastSummaries, { activeConversationId: viewerId, focused: viewerFocused });
        return this.buildSnapshot({
          activeItems,
          connection: Object.keys(this.lastSummaries).length ? 'stale' : 'offline',
          error: this.lastError,
        });
      }
    })();

    this.syncPending = run;
    try {
      return await run;
    } finally {
      if (this.syncPending === run) this.syncPending = null;
    }
  }

  async markRead({ conversationId = null, conversationIds = null, all = false } = {}) {
    await this.loadState();
    let changed = false;
    if (all) {
      if (this.unreadDone.size > 0) {
        this.unreadDone.clear();
        changed = true;
      }
    } else {
      const list = [...(conversationIds || []), ...(conversationId ? [conversationId] : [])];
      for (const rawId of list) {
        const id = normalizeId(rawId);
        if (id && this.unreadDone.delete(id)) changed = true;
      }
    }
    if (changed) this.schedulePersist();
    const activeItems = this.reconcile(this.lastSummaries);
    return this.buildSnapshot({ activeItems, connection: this.lastError ? 'stale' : 'live', error: this.lastError });
  }

  startPolling(intervalMs = 1800) {
    if (this.pollTimer) return;
    void this.sync({ force: true });
    this.pollTimer = setInterval(() => {
      if (this.owns()) void this.sync({ force: true });
    }, intervalMs);
    this.pollTimer.unref?.();
  }

  async dispose() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    await this.persistNow();
  }
}
