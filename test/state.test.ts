import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newLoopState, newRunState, readState, writeState, acquireLock, releaseLock, readLock,
} from '../src/store/state.ts';
const input = {
  runId: 'id',
  workspace: '/ws',
  parallel: false,
  baseRef: 'sha',
  sinceRef: null,
  runBranch: 'aw/id',
  runWorktree: '/worktree'
};
test('루프와 모드별 런 초기 상태', () => {
  assert.deepEqual(newLoopState(), {
    round: 0,
    judgedRounds: 0,
    issueStreak: {},
    lastOutput: null,
    lastIssues: [],
    reviewIssues: [],
    stageBase: null,
    decisions: [],
    grant: null
  });
  for (const mode of ['plan', 'full', 'wiki'] as const) {
    const state = newRunState({ ...input, mode });
    assert.equal(state.stage, mode === 'wiki' ? 'WIKI' : 'PLANNING');
    assert.equal(state.status, 'RUNNING');
    assert.deepEqual(state.planning, newLoopState());
    assert.deepEqual(state.wiki, mode === 'wiki' ? newLoopState() : null);
    assert.deepEqual(state.lanes, []);
    assert.deepEqual(state.pending, []);
    assert.equal(state.integration, null);
    assert.equal(state.seq, 0);
    assert.equal(state.setupDone, false);
    assert.equal(state.lastExitCode, null);
    assert.equal(state.scheduledResume, null);
  }
});
test('state 원자 쓰기·읽기와 updatedAt 갱신', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aw-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = newRunState({ ...input, mode: 'full' });
  state.updatedAt = '2000-01-01T00:00:00.000Z';
  await writeState(dir, state);
  assert.notEqual(state.updatedAt, '2000-01-01T00:00:00.000Z');
  assert.equal(new Date(state.updatedAt).toISOString(), state.updatedAt);
  assert.deepEqual(await readState(dir), state);
});
test('lock 획득·중복 거부·죽은 PID·잘못된 내용 인계·release', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aw-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await readLock(dir), null);
  await acquireLock(dir);
  assert.deepEqual(await readLock(dir), { pid: process.pid, alive: true });
  await assert.rejects(acquireLock(dir), /이미 실행 중/);
  await releaseLock(dir);
  assert.equal(await readLock(dir), null);
  await releaseLock(dir);
  const deadPid = 2147483647;
  await writeFile(join(dir, 'run.lock'), String(deadPid));
  assert.deepEqual(await readLock(dir), { pid: deadPid, alive: false });
  await releaseLock(dir);
  assert.equal(await readFile(join(dir, 'run.lock'), 'utf8'), String(deadPid));
  await acquireLock(dir);
  await releaseLock(dir);
  for (const malformed of ['garbage', '0', '-1', '1.5', '']) {
    await writeFile(join(dir, 'run.lock'), malformed);
    assert.equal((await readLock(dir))?.alive, false);
    await acquireLock(dir);
    assert.equal((await readLock(dir))?.pid, process.pid);
    await releaseLock(dir);
  }
});
