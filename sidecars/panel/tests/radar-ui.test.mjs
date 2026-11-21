import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRendererSource, validatedRadarInput, validatedMarkReadInput, RuntimeUi } from '../../../compat/runtime-ui.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

test('makeRendererSource compiles widget and theme cleanly with isolated globals', () => {
  const widget = readFileSync(join(ROOT, 'compat', 'radar-widget.cjs'), 'utf8');
  const theme = readFileSync(join(ROOT, 'compat', 'theme.cjs'), 'utf8');
  const source = makeRendererSource(widget, theme, 'owner-token-1', 12345);
  assert.ok(source.includes('__agRadarRuntimeCallV1_ownertoken1'));
  assert.ok(source.includes('window.__agRadarThemeFactory'));
  assert.ok(!source.includes('__agPulse'));
  assert.doesNotThrow(() => new Function(source));
});

test('input validators sanitize conversation IDs and flags', () => {
  const id = '2AB056C4-0D73-416F-8F34-1D22473C7D5D';
  assert.deepEqual(validatedRadarInput({ activeConversationId: id, focused: false }), {
    activeConversationId: id.toLowerCase(),
    focused: false,
  });
  assert.deepEqual(validatedRadarInput({ activeConversationId: 'bad-id' }), {
    activeConversationId: null,
    focused: true,
  });
  assert.deepEqual(validatedMarkReadInput({ conversationIds: [id, 'bad'], all: false }), {
    conversationId: null,
    conversationIds: [id.toLowerCase()],
    all: false,
  });
});

test('sidecar manifest stays headless without auxiliary web UI', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'sidecars', 'panel', 'sidecar.json'), 'utf8'));
  assert.equal(manifest.has_web_ui, false);
  assert.equal(manifest.ui_config, undefined);
});

test('RuntimeUi distinguishes missing DevToolsActivePort while staying in reconnecting state', async () => {
  const ui = new RuntimeUi({
    snapshot: async () => ({ connection: 'live', items: [], totals: {} }),
    source: 'safe-widget',
    discover: async () => {
      const err = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      throw err;
    },
  });
  await ui.tick();
  assert.equal(ui.health.state, 'reconnecting');
  assert.equal(ui.health.code, 'cdp-port-missing');
  await ui.stop();
});
