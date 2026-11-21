import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AntigravityClient, serverFromDiscovery, serverFromEnv } from '../client.mjs';

const stopServer = server => new Promise(resolve => {
  server.close(resolve);
  server.closeAllConnections();
});

test('serverFromEnv validates loopback HTTP addresses and safe CSRF tokens', () => {
  assert.deepEqual(serverFromEnv({ ANTIGRAVITY_LS_ADDRESS: 'localhost:60599', ANTIGRAVITY_CSRF_TOKEN: 'scoped-token' }), { port: 60599, csrf: 'scoped-token' });
  assert.deepEqual(serverFromEnv({ ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:60599', ANTIGRAVITY_CSRF_TOKEN: 'scoped-token' }), { port: 60599, csrf: 'scoped-token' });
  assert.deepEqual(serverFromEnv({ ANTIGRAVITY_LS_ADDRESS: 'http://127.0.0.1:60599/', ANTIGRAVITY_CSRF_TOKEN: 'scoped-token' }), { port: 60599, csrf: 'scoped-token' });
  assert.deepEqual(serverFromEnv({ ANTIGRAVITY_LS_ADDRESS: '[::1]:60599', ANTIGRAVITY_CSRF_TOKEN: 'scoped-token' }), { port: 60599, csrf: 'scoped-token', host: '::1' });
  for (const bad of [
    {},
    { ANTIGRAVITY_LS_ADDRESS: 'example.com:60599', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
    { ANTIGRAVITY_LS_ADDRESS: '192.168.1.10:60599', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
    { ANTIGRAVITY_LS_ADDRESS: 'https://127.0.0.1:60599', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
    { ANTIGRAVITY_LS_ADDRESS: 'http://127.0.0.1:0', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
    { ANTIGRAVITY_LS_ADDRESS: 'http://127.0.0.1:65536', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
    { ANTIGRAVITY_LS_ADDRESS: 'localhost', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
    { ANTIGRAVITY_LS_ADDRESS: 'http://127.0.0.1:60599/path', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
    { ANTIGRAVITY_LS_ADDRESS: 'http://127.0.0.1:60599?a=1', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
    { ANTIGRAVITY_LS_ADDRESS: 'localhost:60599', ANTIGRAVITY_CSRF_TOKEN: 'bad token' },
    { ANTIGRAVITY_LS_ADDRESS: 'localhost:60599', ANTIGRAVITY_CSRF_TOKEN: 'bad\ntoken' },
    { ANTIGRAVITY_LS_ADDRESS: 'localhost:60599', ANTIGRAVITY_CSRF_TOKEN: 'bad\0token' },
    { ANTIGRAVITY_LS_ADDRESS: 'localhost:60599', ANTIGRAVITY_CSRF_TOKEN: '   ' },
  ]) {
    assert.equal(serverFromEnv(bad), null);
  }
});

test('discover uses host-injected sidecar env credentials when CLI --csrf_token is absent (2.34.0+)', async t => {
  let seenToken = null;
  const server = createServer((req, res) => {
    seenToken = req.headers['x-codeium-csrf-token'];
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"trajectorySummaries":{}}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => stopServer(server));

  const port = server.address().port;
  const client = new AntigravityClient({
    paths: () => ({ log: 'fixture' }),
    readLog: async () => `listening on random port at ${port} for HTTP\n`,
    processes: async () => [{ ProcessId: 11064, CommandLine: 'language_server.exe --standalone --enable_sidecars', Ports: [port] }],
    env: { ANTIGRAVITY_LS_ADDRESS: `localhost:${port}`, ANTIGRAVITY_CSRF_TOKEN: 'scoped-234-token' },
  });
  assert.deepEqual(await client.discover(), { port, csrf: 'scoped-234-token', pid: 11064 });
  assert.deepEqual(await client.call('GetAllCascadeTrajectories', { excludeSubtrajectories: false }), { trajectorySummaries: {} });
  assert.equal(seenToken, 'scoped-234-token');
});

test('legacy CLI --csrf_token discovery still works without env', async () => {
  const client = new AntigravityClient({
    paths: () => ({ log: 'fixture' }),
    readLog: async () => 'listening on random port at 4567 for HTTP\n',
    processes: async () => [{ ProcessId: 88, CommandLine: 'language_server.exe --standalone --csrf_token=legacy-cli-token', Ports: [4567] }],
  });
  assert.deepEqual(await client.discover(), { port: 4567, csrf: 'legacy-cli-token', pid: 88 });
});

test('stale env port is rejected when live standalone process is confirmed on a different log port', async () => {
  const client = new AntigravityClient({
    paths: () => ({ log: 'fixture' }),
    readLog: async () => 'listening on random port at 7777 for HTTP\n',
    processes: async () => [{ ProcessId: 222, CommandLine: 'language_server.exe --standalone', Ports: [7777] }],
    env: { ANTIGRAVITY_LS_ADDRESS: 'localhost:6666', ANTIGRAVITY_CSRF_TOKEN: 'stale-token' },
  });
  await assert.rejects(client.discover(), /Missing local API credentials/);
});

test('env credentials recover when language_server.log is ENOENT while standalone process owns env port', async () => {
  const client = new AntigravityClient({
    paths: () => ({ log: 'missing.log' }),
    readLog: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    processes: async ({ expectedPorts }) => {
      assert.deepEqual(expectedPorts, [60599]);
      return [{ ProcessId: 333, CommandLine: 'language_server.exe --standalone', Ports: [60599] }];
    },
    env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:60599', ANTIGRAVITY_CSRF_TOKEN: 'scoped-token' },
  });
  assert.deepEqual(await client.discover(), { port: 60599, csrf: 'scoped-token', pid: 333 });
});

test('env port disambiguates multiple standalone instances without generation mixing', async () => {
  const rows = [
    { ProcessId: 101, CommandLine: 'language_server.exe --standalone', Ports: [5001] },
    { ProcessId: 102, CommandLine: 'language_server.exe --standalone', Ports: [5002] },
  ];
  assert.deepEqual(
    serverFromDiscovery('listening on random port at 5002 for HTTP\n', rows, { ANTIGRAVITY_LS_ADDRESS: 'localhost:5002', ANTIGRAVITY_CSRF_TOKEN: 'tok-2' }),
    { port: 5002, csrf: 'tok-2', pid: 102 },
  );
  const client = new AntigravityClient({
    paths: () => ({ log: 'fixture' }),
    readLog: async () => 'listening on random port at 5002 for HTTP\n',
    processes: async () => rows,
    env: { ANTIGRAVITY_LS_ADDRESS: 'localhost:5002', ANTIGRAVITY_CSRF_TOKEN: 'tok-2' },
  });
  assert.deepEqual(await client.discover(), { port: 5002, csrf: 'tok-2', pid: 102 });
});
