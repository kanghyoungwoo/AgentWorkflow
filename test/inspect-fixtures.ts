import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { initRunDir } from '../src/store/runlog.ts';
import { newRunState, writeState } from '../src/store/state.ts';

export async function temp(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'aw-inspect-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
export async function savedRun(workspace: string, id = 'test-run') {
  const dir = await initRunDir(workspace, id, null);
  const state = newRunState({
    runId: id, workspace, mode: 'full', parallel: true, baseRef: 'HEAD', sinceRef: null,
    runBranch: `aw/${id}`, runWorktree: join(workspace, '.aw/worktrees', id, 'main'),
  });
  await writeState(dir, state);
  return { dir, state };
}
