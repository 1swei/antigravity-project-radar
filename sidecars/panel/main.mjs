import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { platformPaths } from '../../compat/platform.mjs';
import { SidecarOwner } from '../../compat/sidecar-owner.mjs';
import { readHostTheme } from '../../compat/host-theme.mjs';
import { RuntimeUi, makeRendererSource } from '../../compat/runtime-ui.mjs';
import { AntigravityClient } from './client.mjs';
import { RadarStore } from './radar-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const paths = platformPaths();
const isHostSidecar = Boolean(
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT
  || process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
  || (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN),
);

const ownership = isHostSidecar ? new SidecarOwner(paths.data) : null;
let settingsCache = {};
let settingsAt = -Infinity;

const owns = () => (!ownership || ownership.owns()) && settingsCache.enabled !== false;

const runtimeSettings = () => {
  if (Date.now() - settingsAt < 1000) return settingsCache;
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(paths.settings, 'utf8').replace(/^\uFEFF/, ''));
  } catch {}
  try {
    const cfg = JSON.parse(readFileSync(paths.pluginConfig, 'utf8').replace(/^\uFEFF/, ''));
    if (cfg.plugins?.['antigravity-project-radar']?.enabled === false) settings.enabled = false;
  } catch {}
  settingsCache = settings;
  settingsAt = Date.now();
  return settings;
};

const client = new AntigravityClient();
const store = new RadarStore(client, { dataDir: paths.data, owns });

const getSnapshot = async input => {
  if (ownership && !await ownership.isOwner()) throw new Error('Sidecar ownership changed');
  runtimeSettings();
  const base = await store.sync({
    force: input?.force === true,
    activeConversationId: input?.activeConversationId ?? null,
    focused: input?.focused !== false,
  });
  return { ...base, theme: await readHostTheme(), integration: integration.health };
};

const markRead = async input => {
  if (ownership && !await ownership.isOwner()) throw new Error('Sidecar ownership changed');
  const base = await store.markRead(input);
  return { ...base, theme: await readHostTheme(), integration: integration.health };
};

const widgetSource = readFileSync(join(HERE, '..', '..', 'compat', 'radar-widget.cjs'), 'utf8');
const themeSource = readFileSync(join(HERE, '..', '..', 'compat', 'theme.cjs'), 'utf8');

const integration = new RuntimeUi({
  snapshot: getSnapshot,
  markRead,
  owner: ownership?.token,
  owns: () => (ownership ? ownership.isOwner() : true),
  source: makeRendererSource(widgetSource, themeSource, ownership?.token, ownership?.startedAt),
  dataDir: paths.data,
  enabled: () => runtimeSettings().enabled !== false,
});

if (isHostSidecar) {
  if (!await ownership.claim()) process.exit(0);
  store.startPolling(1800);
  integration.start();
  const shutdown = async () => {
    const exitTimer = setTimeout(() => process.exit(0), 2000);
    exitTimer.unref?.();
    await integration.stop();
    await store.dispose();
    ownership.stop();
    process.exit(0);
  };
  ownership.watch(shutdown);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => { void shutdown(); });
  }
} else {
  const port = Number(process.env.AG_RADAR_PORT || 17892);
  store.startPolling(1800);
  const server = createServer(async (req, res) => {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.writeHead(403); res.end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'GET' && req.url === '/api/radar') {
      res.end(JSON.stringify(await getSnapshot({})));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  server.listen(port, '127.0.0.1');
}
