import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup } from '../src/commands/cleanup.ts';
import { worktreeAdd, resolveRef } from '../src/git.ts';
import { writeState, readState } from '../src/store/state.ts';
import { readEvents } from '../src/store/runlog.ts';
import { laneState, repo } from './engine-fixtures.ts';
import { savedRun } from './inspect-fixtures.ts';
import type { TestContext } from 'node:test';

async function fixture(t: TestContext, id = 'cleanup') {
  const { cwd: workspace, stageBase } = await repo(t);
  const { dir, state } = await savedRun(workspace, id);
  await worktreeAdd(workspace, state.runWorktree, state.runBranch, stageBase);
  const lane = {
    ...laneState(), id: 'a', branch: `aw/${id}-lane-a`,
    worktree: join(workspace, '.aw/worktrees', id, 'lane-a'),
  };
  await worktreeAdd(workspace, lane.worktree, lane.branch, stageBase);
  state.lanes = [lane]; state.status = 'DONE';
  state.scheduledResume = { atJobId: 12, at: new Date().toISOString() };
  await writeState(dir, state);
  return { workspace, dir, state, lane };
}
test('DONE cleanup: 런 브랜치와 ai-log 보존, worktree·레인 브랜치·예약 삭제', async t => {
  const f = await fixture(t);
  const canceled: number[] = [];
  assert.equal(await cleanup({
    command: 'cleanup', workspace: f.workspace, runId: f.state.runId, finished: false, force: false,
  }, { cancelResume: async id => { canceled.push(id); }, output: () => {} }), 0);
  assert.deepEqual(canceled, [12]);
  assert.equal((await readState(f.dir)).scheduledResume, null);
  assert.ok(await resolveRef(f.workspace, f.state.runBranch));
  assert.equal(await resolveRef(f.workspace, f.lane.branch), null);
  await access(join(f.dir, 'state.json'));
  await assert.rejects(access(f.state.runWorktree));
  await assert.rejects(access(f.lane.worktree));
  await assert.rejects(access(join(f.workspace, '.aw/worktrees', f.state.runId)));
  assert.ok((await readEvents(f.dir)).every(e => e.type === 'cleanup'));
  assert.equal(await cleanup({
    command: 'cleanup', workspace: f.workspace, runId: f.state.runId, finished: false, force: false,
  }, { output: () => {} }), 0);
});
test('DONE 아닌 런 --force 필요, dirty worktree 강제 제거', async t => {
  const f = await fixture(t);
  f.state.status = 'PAUSED'; f.state.scheduledResume = null;
  await writeState(f.dir, f.state);
  const command = {
    command: 'cleanup' as const, workspace: f.workspace, runId: f.state.runId, finished: false, force: false,
  };
  assert.equal(await cleanup(command, { output: () => {} }), 2);
  await writeFile(join(f.lane.worktree, 'base'), 'dirty');
  assert.equal(await cleanup({ ...command, force: true }, { output: () => {} }), 0);
});
test('--finished는 DONE만 제거하고 살아 있는 lock을 거부', async t => {
  const f = await fixture(t);
  f.state.scheduledResume = null;
  await writeState(f.dir, f.state);
  const paused = await savedRun(f.workspace, 'paused');
  paused.state.status = 'PAUSED'; await writeState(paused.dir, paused.state);
  await mkdir(paused.state.runWorktree, { recursive: true });
  const command = { command: 'cleanup' as const, workspace: f.workspace, finished: true, force: false };
  await writeFile(join(f.workspace, 'ai-log/notes.txt'), '메모');
  await mkdir(join(f.workspace, 'ai-log/bad dir'));
  await writeFile(join(f.dir, 'run.lock'), String(process.pid));
  assert.equal(await cleanup(command, { output: () => {} }), 2);
  await access(f.state.runWorktree);
  await rm(join(f.dir, 'run.lock'));
  assert.equal(await cleanup(command, { output: () => {} }), 0);
  await access(paused.state.runWorktree);
});
test('이미 없는 worktree도 prune한 뒤 레인 브랜치 삭제', async t => {
  const f = await fixture(t);
  f.state.scheduledResume = null; await writeState(f.dir, f.state);
  await rm(f.lane.worktree, { recursive: true, force: true });
  assert.equal(await cleanup({
    command: 'cleanup', workspace: f.workspace, runId: f.state.runId, finished: false, force: false,
  }, { output: () => {} }), 0);
  assert.equal(await resolveRef(f.workspace, f.lane.branch), null);
});
