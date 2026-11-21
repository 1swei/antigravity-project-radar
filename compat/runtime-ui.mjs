import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { platformPaths } from './platform.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BINDING = '__agRadarRuntimeCallV1';
const offline = message => ({ connection: 'offline', error: message, items: [], totals: { running: 0, waiting: 0, done: 0, error: 0 } });

export function validTarget(target, port) {
  try {
    const page = new URL(target.url);
    const ws = new URL(target.webSocketDebuggerUrl);
    return target.type === 'page' && ['http:', 'https:'].includes(page.protocol) && LOOPBACK.has(page.hostname)
      && ws.protocol === 'ws:' && LOOPBACK.has(ws.hostname) && Number(ws.port) === port;
  } catch {
    return false;
  }
}

export function validatedRadarInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { activeConversationId: null, focused: true };
  const activeConversationId = typeof value.activeConversationId === 'string' && GUID.test(value.activeConversationId)
    ? value.activeConversationId.toLowerCase()
    : null;
  const focused = value.focused !== false;
  return { activeConversationId, focused };
}

export function validatedMarkReadInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid markRead request');
  const conversationId = typeof value.conversationId === 'string' && GUID.test(value.conversationId)
    ? value.conversationId.toLowerCase()
    : null;
  const conversationIds = Array.isArray(value.conversationIds)
    ? value.conversationIds.filter(id => typeof id === 'string' && GUID.test(id)).map(id => id.toLowerCase()).slice(0, 256)
    : null;
  return { conversationId, conversationIds, all: value.all === true };
}

function jsonGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 1048576) req.destroy(new Error('Discovery response too large'));
      });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error('Renderer discovery unavailable');
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Renderer discovery timeout')));
    req.end();
  });
}

export async function discoverTargets(profile) {
  const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
  if (text.length > 1024) throw new Error('Invalid renderer discovery file');
  const port = Number(text.split(/\r?\n/)[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid renderer port');
  const targets = await jsonGet(port, '/json/list');
  if (!Array.isArray(targets)) throw new Error('Invalid renderer discovery response');
  return targets.filter(target => validTarget(target, port));
}

export class CdpConnection {
  constructor(url, { WebSocketImpl = globalThis.WebSocket, timeout = 5000, onEvent = () => {}, onClose = () => {} } = {}) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.timeout = timeout;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
  }

  async open() {
    if (!this.WebSocketImpl) throw new Error('This Node runtime has no WebSocket support');
    this.ws = new this.WebSocketImpl(this.url);
    this.ws.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 2097152) return;
        const message = JSON.parse(event.data);
        if (message.id) {
          const item = this.pending.get(message.id);
          if (!item) return;
          this.pending.delete(message.id);
          clearTimeout(item.timer);
          if (message.error) item.reject(new Error('Renderer command failed: ' + message.error.code));
          else item.resolve(message.result || {});
        } else if (message.method) {
          this.onEvent(message);
        }
      } catch {}
    });
    this.ws.addEventListener('close', () => this.disconnect());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('Renderer connection timeout')); }, this.timeout);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); this.close(); reject(new Error('Renderer connection failed')); }, { once: true });
    });
    return this;
  }

  command(method, params = {}) {
    if (this.closed || this.ws?.readyState !== 1) return Promise.reject(new Error('Renderer disconnected'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Renderer command timeout')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  disconnect() {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Renderer disconnected'));
    }
    this.pending.clear();
    this.onClose();
  }

  close() {
    this.disconnect();
    this.ws?.close();
  }
}

function rendererBridge(binding) {
  if (window !== window.top) return;
  if (window.__agRadarRuntimeBridge && window.agRadarHost) return;
  window.__agRadarRuntimeBridge?.dispose();
  const pending = new Map();
  let sequence = 0;
  const empty = () => ({ connection: 'offline', error: 'Waiting for Project Radar', items: [], totals: { running: 0, waiting: 0, done: 0, error: 0 }, enabled: false });
  const call = (type, input) => new Promise(resolve => {
    if (pending.size >= 8) { resolve(empty()); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); resolve(empty()); }, 15000);
    pending.set(id, { resolve, timer });
    try {
      window[binding](JSON.stringify({ id, type, input }));
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      resolve(empty());
    }
  });
  window.__agRadarRuntimeBridge = {
    binding,
    resolve(id, result) {
      const item = pending.get(id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(id);
      item.resolve(result);
    },
    reconnect() {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.resolve(empty());
      }
      pending.clear();
    },
    dispose() {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.resolve(empty());
      }
      pending.clear();
      delete window.__agRadarRuntimeBridge;
    },
  };
  if (!window.agRadarHost) {
    window.agRadarHost = {
      getRadar: input => call('radar', input),
      markRead: input => call('markRead', input),
      report: input => { void call('diagnostic', input); },
    };
  }
}

export function makeRendererSource(widget, theme = '', owner = null, generation = 0) {
  const extract = source => {
    const prefix = 'module.exports = ';
    const index = source.indexOf(prefix);
    if (index < 0) throw new Error('Radar widget source format changed');
    return source.slice(index + prefix.length).trim().replace(/;$/, '');
  };
  const version = createHash('sha256').update(widget + theme + rendererBridge.toString() + JSON.stringify(owner)).digest('hex');
  const upgrade = 'if(window.__agRadarRuntimeVersion!==' + JSON.stringify(version) + '){window.__agRadarDispose?.();window.__agRadarRuntimeBridge?.dispose();delete window.agRadarHost;window.__agRadarRuntimeVersion=' + JSON.stringify(version) + ';}';
  const binding = owner ? BINDING + '_' + owner.replaceAll('-', '') : BINDING;
  const rank = JSON.stringify([generation, owner || '']);
  const code = upgrade
    + 'window.__agRadarRuntimeOwner=' + JSON.stringify(owner) + ';window.__agRadarRuntimeRank=' + rank + ';'
    + '(' + rendererBridge.toString() + ')(' + JSON.stringify(binding) + ');'
    + (theme ? 'window.__agRadarThemeFactory=(' + extract(theme) + ');' : '')
    + '(' + extract(widget) + ')();';
  return owner
    ? 'if(!window.__agRadarRuntimeRank||window.__agRadarRuntimeRank[0]<' + generation + '||(window.__agRadarRuntimeRank[0]===' + generation + '&&window.__agRadarRuntimeRank[1]<=' + JSON.stringify(owner) + ')){' + code + '}'
    : code;
}

export class RuntimeUi {
  constructor({
    snapshot,
    markRead,
    source,
    profile = platformPaths().profile,
    dataDir,
    owner = null,
    owns = async () => true,
    enabled = async () => true,
    discover = discoverTargets,
    targetOrigin = target => new URL(target.url).origin,
    connect = (url, options) => new CdpConnection(url, options),
    interval = 3000,
  } = {}) {
    this.snapshot = snapshot;
    this.markRead = markRead;
    this.source = source;
    this.profile = profile;
    this.dataDir = dataDir;
    this.owner = owner;
    this.owns = owns;
    this.enabled = enabled;
    this.discover = discover;
    this.targetOrigin = targetOrigin;
    this.connect = connect;
    this.interval = interval;
    this.sessions = new Map();
    this.running = false;
    this.stopping = false;
    this.busy = false;
    this.binding = owner ? BINDING + '_' + owner.replaceAll('-', '') : BINDING;
    this.health = { state: 'waiting', mode: 'runtime', message: 'Waiting for the app renderer', windows: 0 };
  }

  async setHealth(state, message, extra = {}) {
    this.health = { state, mode: 'runtime', message, windows: this.sessions.size, checkedAt: new Date().toISOString(), ...extra };
    if (this.dataDir && await this.owns()) {
      try {
        await mkdir(this.dataDir, { recursive: true });
        await writeFile(join(this.dataDir, 'integration-state.json'), JSON.stringify(this.health));
      } catch {}
    }
  }

  rendererGuard(expression) {
    return this.owner ? 'if(window.__agRadarRuntimeOwner===' + JSON.stringify(this.owner) + '){' + expression + '}' : expression;
  }

  async event(connection, message) {
    if (this.stopping || connection.closed) return;
    const p = message.params || {};
    if (message.method === 'Page.frameNavigated' && p.frame && !p.frame.parentId) {
      const replaced = connection.frameId !== p.frame.id;
      connection.generation++;
      connection.frameId = p.frame.id;
      connection.contexts.clear();
      connection.mounted = false;
      const trusted = p.frame.url === connection.origin || p.frame.url?.startsWith(connection.origin + '/');
      if (replaced && trusted) {
        for (const [id, context] of connection.contextCandidates) {
          if (context.frameId === connection.frameId && context.origin === connection.origin) connection.contexts.add(id);
        }
      }
      return;
    }
    if (message.method === 'Runtime.executionContextCreated') {
      if (p.context?.auxData?.isDefault) {
        connection.contextCandidates.set(p.context.id, { frameId: p.context.auxData.frameId, origin: p.context.origin });
        if (connection.contextCandidates.size > 32) connection.contextCandidates.delete(connection.contextCandidates.keys().next().value);
        if (p.context.auxData.frameId === connection.frameId && p.context.origin === connection.origin) connection.contexts.add(p.context.id);
      }
      return;
    }
    if (message.method === 'Runtime.executionContextsCleared') {
      connection.generation++;
      connection.contexts.clear();
      connection.contextCandidates.clear();
      connection.mounted = false;
      return;
    }
    if (message.method === 'Runtime.executionContextDestroyed') {
      if (connection.contexts.has(p.executionContextId)) connection.generation++;
      connection.contexts.delete(p.executionContextId);
      connection.contextCandidates.delete(p.executionContextId);
      return;
    }
    if (message.method !== 'Runtime.bindingCalled' || p.name !== this.binding || !connection.contexts.has(p.executionContextId)) return;
    if (!await this.owns() || connection.closed || !connection.contexts.has(p.executionContextId)) return;
    if (typeof p.payload !== 'string' || p.payload.length > 8192 || connection.inflight >= 8) return;

    let input;
    try {
      input = JSON.parse(p.payload);
      if (!Number.isSafeInteger(input.id) || input.id < 1) return;
    } catch {
      return;
    }

    const generation = connection.generation;
    const current = () => !connection.closed && connection.generation === generation && connection.contexts.has(p.executionContextId);
    connection.inflight++;
    try {
      let result = {};
      if (input.type === 'radar') {
        result = await this.enabled()
          ? await this.snapshot(validatedRadarInput(input.input))
          : { ...offline('Antigravity Project Radar disabled'), enabled: false };
      } else if (input.type === 'markRead' && this.markRead) {
        if (!await this.enabled()) throw new Error('Plugin disabled');
        result = await this.markRead(validatedMarkReadInput(input.input));
      } else if (input.type === 'diagnostic') {
        if (input.input?.stage === 'mounted') connection.mounted = true;
      } else {
        return;
      }
      if (JSON.stringify(result).length > 1048576) result = offline('Radar response too large');
      if (this.stopping || !await this.owns() || !current()) return;
      await connection.command('Runtime.evaluate', {
        expression: this.rendererGuard('window.__agRadarRuntimeBridge?.resolve(' + input.id + ',' + JSON.stringify(result) + ')'),
        contextId: p.executionContextId,
      });
    } catch {
      const failure = offline('Reconnecting Project Radar');
      if (this.stopping || !await this.owns() || !current()) return;
      try {
        await connection.command('Runtime.evaluate', {
          expression: this.rendererGuard('window.__agRadarRuntimeBridge?.resolve(' + input.id + ',' + JSON.stringify(failure) + ')'),
          contextId: p.executionContextId,
        });
      } catch {}
    } finally {
      connection.inflight--;
    }
  }

  async attach(target) {
    const connection = this.connect(target.webSocketDebuggerUrl, { onEvent: message => { void this.event(connection, message); } });
    connection.origin = this.targetOrigin(target);
    connection.generation = 0;
    connection.contexts = new Set();
    connection.contextCandidates = new Map();
    connection.inflight = 0;
    connection.mounted = false;
    try {
      await connection.open();
      if (this.stopping || !await this.owns()) throw new Error('Sidecar ownership changed');
      const frame = await connection.command('Page.getFrameTree');
      connection.frameId = frame.frameTree?.frame?.id;
      if (!connection.frameId) throw new Error('Main renderer frame unavailable');
      await connection.command('Page.enable');
      await connection.command('Runtime.enable');
      await connection.command('Runtime.addBinding', { name: this.binding });
      const guardedSource = 'if (location.origin === ' + JSON.stringify(connection.origin) + ') {' + this.source + '}';
      connection.guardedSource = guardedSource;
      connection.script = (await connection.command('Page.addScriptToEvaluateOnNewDocument', { source: guardedSource })).identifier;
      if (this.stopping || !await this.owns()) {
        await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.script });
        throw new Error('Sidecar ownership changed');
      }
      const result = await connection.command('Runtime.evaluate', { expression: guardedSource });
      if (result.exceptionDetails) throw new Error('Radar widget initialization failed');
      return connection;
    } catch (error) {
      try { if (connection.script) await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.script }); } catch {}
      try { if (this.owner) await connection.command('Runtime.removeBinding', { name: this.binding }); } catch {}
      connection.close();
      throw error;
    }
  }

  async tick() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      if (!await this.owns()) { await this.detachAll(); return; }
      if (!await this.enabled()) { await this.detachAll(); await this.setHealth('disabled', 'Radar is disabled'); return; }
      const targets = await this.discover(this.profile);
      const active = new Set(targets.map(t => t.webSocketDebuggerUrl));
      if (this.stopping || !await this.owns()) return;

      for (const [url, connection] of this.sessions) {
        if (!active.has(url) || connection.closed || connection.origin !== this.targetOrigin(targets.find(t => t.webSocketDebuggerUrl === url))) {
          await this.detach(connection);
          this.sessions.delete(url);
        }
      }
      for (const target of targets) {
        if (!this.sessions.has(target.webSocketDebuggerUrl)) {
          this.sessions.set(target.webSocketDebuggerUrl, await this.attach(target));
        }
      }
      if (this.stopping || !await this.owns()) { await this.detachAll(); return; }

      for (const [url, connection] of this.sessions) {
        try {
          if (!connection.contexts.size) {
            const frame = await connection.command('Page.getFrameTree');
            connection.frameId = frame.frameTree?.frame?.id;
            connection.contextCandidates.clear();
            await connection.command('Runtime.disable');
            await connection.command('Runtime.enable');
            await connection.command('Runtime.addBinding', { name: this.binding });
            await connection.command('Runtime.evaluate', { expression: this.rendererGuard('window.__agRadarRuntimeBridge?.reconnect?.();') });
          }
          const result = await connection.command('Runtime.evaluate', {
            returnByValue: true,
            expression: '({mounted:Boolean(window.__agRadarInstalled),bridge:Boolean(window.__agRadarRuntimeBridge && window.agRadarHost' + (this.owner ? ' && window.__agRadarRuntimeBridge.binding===' + JSON.stringify(this.binding) : '') + ')})',
          });
          if (result.exceptionDetails) throw new Error('Renderer not ready');
          const status = result.result?.value;
          connection.mounted = status?.mounted === true;
          if (status && (!status.mounted || !status.bridge)) {
            if (!await this.owns()) break;
            const recovery = await connection.command('Runtime.evaluate', { expression: connection.guardedSource });
            if (recovery.exceptionDetails) throw new Error('Radar widget recovery failed');
          }
        } catch {
          try { if (connection.script) await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.script }); } catch {}
          await this.detach(connection);
          this.sessions.delete(url);
        }
      }

      const mounted = [...this.sessions.values()].some(c => c.mounted);
      await this.setHealth(
        mounted ? 'mounted' : this.sessions.size ? 'waiting-for-sidebar' : 'waiting',
        mounted ? 'Radar attached to Antigravity sidebar' : this.sessions.size ? 'Renderer connected; waiting for sidebar' : 'Waiting for app renderer',
      );
    } catch (error) {
      const cdpMissing = error?.code === 'ENOENT';
      await this.setHealth(
        'reconnecting',
        cdpMissing
          ? 'Sidebar badges require Antigravity launched with --remote-debugging-port=0 (DevToolsActivePort not found).'
          : 'Renderer connection unavailable; retrying automatically.',
        { code: cdpMissing ? 'cdp-port-missing' : 'connection-unavailable' },
      );
    } finally {
      this.busy = false;
    }
  }

  async detach(connection) {
    const owned = await this.owns();
    if (owned) {
      try {
        await connection.command('Runtime.evaluate', {
          expression: this.rendererGuard('window.__agRadarDispose?.();window.__agRadarRuntimeBridge?.dispose();delete window.agRadarHost;'),
        });
      } catch {}
    }
    try { if (connection.script) await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.script }); } catch {}
    try { if (this.owner || owned) await connection.command('Runtime.removeBinding', { name: this.binding }); } catch {}
    connection.close();
  }

  async detachAll() {
    for (const connection of this.sessions.values()) await this.detach(connection);
    this.sessions.clear();
  }

  start({ keepAlive = false } = {}) {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.interval);
    if (!keepAlive) this.timer.unref?.();
  }

  async stop() {
    this.running = false;
    this.stopping = true;
    clearInterval(this.timer);
    await this.detachAll();
  }
}
