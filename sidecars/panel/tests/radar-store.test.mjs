import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RadarStore, extractWorkspaceKeys, classifySummary } from '../radar-store.mjs';

const ID_1 = '11111111-1111-4111-8111-111111111111';
const ID_2 = '22222222-2222-4222-8222-222222222222';
const ID_SUB = '33333333-3333-4333-8333-333333333333';

test('extractWorkspaceKeys decodes CJK URIs and extracts folder and repo names', () => {
  const keys = extractWorkspaceKeys({
    workspaces: [
      {
        workspaceFolderAbsoluteUri: 'file:///d:/work/projects/%E8%BD%AF%E8%91%97',
        repository: { computedName: '1swei/agent-workspace' },
      },
      {
        workspaceFolderAbsoluteUri: 'file:///d:/work/projects/antigravity-plugins/',
        repository: { computedName: '1swei/agent-workspace' },
      },
    ],
  });
  assert.deepEqual(keys.folderNames, ['软著', 'antigravity-plugins']);
  assert.deepEqual(keys.repoNames, ['1swei/agent-workspace']);
});

test('classifySummary distinguishes running, waiting, error, and settled', () => {
  assert.equal(classifySummary({ status: 'CASCADE_RUN_STATUS_RUNNING' }), 'running');
  assert.equal(classifySummary({ status: 'CASCADE_RUN_STATUS_IDLE', hasRunningSubagents: true }), 'running');
  assert.equal(classifySummary({ status: 'CASCADE_RUN_STATUS_WAITING_FOR_USER' }), 'waiting');
  assert.equal(classifySummary({ status: 'CASCADE_RUN_STATUS_IDLE' }, { childWaiting: 1 }), 'waiting');
  assert.equal(classifySummary({ status: 'CASCADE_RUN_STATUS_FAILED' }), 'error');
  assert.equal(classifySummary({ status: 'CASCADE_RUN_STATUS_IDLE' }), 'settled');
});

test('RadarStore tracks running -> done transitions, rolls up subagents, and persists unread state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-radar-test-'));
  let nowMs = 1_700_000_000_000;
  let summaries = {
    [ID_1]: {
      summary: 'Build project radar',
      status: 'CASCADE_RUN_STATUS_IDLE',
      hasRunningSubagents: true,
      lastModifiedTime: new Date(nowMs).toISOString(),
      lastUserInputTime: new Date(nowMs - 5000).toISOString(),
      workspaces: [{ workspaceFolderAbsoluteUri: 'file:///d:/work/projects/antigravity-plugins' }],
    },
    [ID_SUB]: {
      summary: 'Subagent task',
      status: 'CASCADE_RUN_STATUS_RUNNING',
      trajectoryMetadata: { parentConversationId: ID_1, rootConversationId: ID_1 },
    },
    [ID_2]: {
      summary: 'Old idle chat',
      status: 'CASCADE_RUN_STATUS_IDLE',
      lastModifiedTime: new Date(nowMs - 60000).toISOString(),
      workspaces: [{ workspaceFolderAbsoluteUri: 'file:///d:/work/projects/ops' }],
    },
  };

  try {
    const client = { call: async () => ({ trajectorySummaries: summaries }) };
    const store = new RadarStore(client, { dataDir: dir, now: () => nowMs });

    // Initial poll: ID_1 is running (via subagent), ID_2 is already idle -> NOT unreadDone.
    const snap1 = await store.sync({ force: true, activeConversationId: ID_2, focused: true });
    assert.deepEqual(snap1.totals, { running: 1, waiting: 0, done: 0, error: 0 });
    assert.equal(snap1.items.length, 1);
    assert.equal(snap1.items[0].id, ID_1);
    assert.equal(snap1.items[0].runningSubagents, 1);

    // Transition ID_1 to settled while user is viewing ID_2 -> ID_1 becomes unread done!
    nowMs += 3000;
    summaries = {
      ...summaries,
      [ID_1]: {
        ...summaries[ID_1],
        hasRunningSubagents: false,
        status: 'CASCADE_RUN_STATUS_IDLE',
        latestExecutorTerminationReason: 'EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL',
        lastModifiedTime: new Date(nowMs).toISOString(),
      },
      [ID_SUB]: {
        ...summaries[ID_SUB],
        status: 'CASCADE_RUN_STATUS_IDLE',
      },
    };
    const snap2 = await store.sync({ force: true, activeConversationId: ID_2, focused: true });
    assert.deepEqual(snap2.totals, { running: 0, waiting: 0, done: 1, error: 0 });
    assert.equal(snap2.items[0].id, ID_1);
    assert.equal(snap2.items[0].state, 'done');

    await store.dispose();

    // Reload from disk in a fresh RadarStore instance -> unreadDone persists!
    const store2 = new RadarStore(client, { dataDir: dir, now: () => nowMs + 1000 });
    const snap3 = await store2.sync({ force: true, activeConversationId: ID_2, focused: true });
    assert.deepEqual(snap3.totals, { running: 0, waiting: 0, done: 1, error: 0 });

    // Viewing ID_1 clears its unreadDone automatically!
    const snap4 = await store2.sync({ force: true, activeConversationId: ID_1, focused: true });
    assert.deepEqual(snap4.totals, { running: 0, waiting: 0, done: 0, error: 0 });
    await store2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RadarStore skips unreadDone on user cancel and supports markRead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-radar-cancel-'));
  let nowMs = 1_700_000_000_000;
  let summaries = {
    [ID_1]: {
      summary: 'Cancelled task',
      status: 'CASCADE_RUN_STATUS_RUNNING',
      lastModifiedTime: new Date(nowMs).toISOString(),
      workspaces: [{ workspaceFolderAbsoluteUri: 'file:///d:/work/projects/ops' }],
    },
    [ID_2]: {
      summary: 'Errored task',
      status: 'CASCADE_RUN_STATUS_RUNNING',
      lastModifiedTime: new Date(nowMs).toISOString(),
      workspaces: [{ workspaceFolderAbsoluteUri: 'file:///d:/work/projects/ops' }],
    },
  };

  try {
    const client = { call: async () => ({ trajectorySummaries: summaries }) };
    const store = new RadarStore(client, { dataDir: dir, now: () => nowMs });
    await store.sync({ force: true });

    nowMs += 2000;
    summaries = {
      [ID_1]: {
        ...summaries[ID_1],
        status: 'CASCADE_RUN_STATUS_IDLE',
        latestExecutorTerminationReason: 'EXECUTOR_TERMINATION_REASON_USER_CANCELED',
        lastModifiedTime: new Date(nowMs).toISOString(),
      },
      [ID_2]: {
        ...summaries[ID_2],
        status: 'CASCADE_RUN_STATUS_IDLE',
        latestExecutorTerminationReason: 'EXECUTOR_TERMINATION_REASON_ERROR',
        lastModifiedTime: new Date(nowMs).toISOString(),
      },
    };
    const snap = await store.sync({ force: true });
    assert.deepEqual(snap.totals, { running: 0, waiting: 0, done: 0, error: 1 });
    assert.equal(snap.items[0].id, ID_2);

    const cleared = await store.markRead({ conversationId: ID_2 });
    assert.deepEqual(cleared.totals, { running: 0, waiting: 0, done: 0, error: 0 });
    await store.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RadarStore reverse-syncs unreadDone when host lastUserViewTime catches up to lastModifiedTime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-radar-viewsync-'));
  let nowMs = 1_700_000_000_000;
  let summaries = {
    [ID_1]: {
      summary: 'Viewed elsewhere',
      status: 'CASCADE_RUN_STATUS_RUNNING',
      lastModifiedTime: new Date(nowMs).toISOString(),
      workspaces: [{ workspaceFolderAbsoluteUri: 'file:///d:/work/projects/ops' }],
    },
  };

  try {
    const client = { call: async () => ({ trajectorySummaries: summaries }) };
    const store = new RadarStore(client, { dataDir: dir, now: () => nowMs });
    await store.sync({ force: true, activeConversationId: ID_2, focused: true });

    nowMs += 2000;
    summaries = {
      [ID_1]: {
        ...summaries[ID_1],
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: new Date(nowMs).toISOString(),
        annotations: { lastUserViewTime: new Date(nowMs - 1000).toISOString() },
      },
    };
    const snap1 = await store.sync({ force: true, activeConversationId: ID_2, focused: true });
    assert.deepEqual(snap1.totals, { running: 0, waiting: 0, done: 1, error: 0 });

    // Host marks conversation as viewed in annotations
    summaries = {
      [ID_1]: {
        ...summaries[ID_1],
        annotations: { lastUserViewTime: new Date(nowMs + 500).toISOString() },
      },
    };
    const snap2 = await store.sync({ force: true, activeConversationId: ID_2, focused: true });
    assert.deepEqual(snap2.totals, { running: 0, waiting: 0, done: 0, error: 0 });
    await store.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
