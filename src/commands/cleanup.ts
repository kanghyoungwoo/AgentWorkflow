import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandLine } from '../cli.ts';
import type { ExitCode, RunEvent } from '../types.ts';
import { branchDelete, laneBranches, worktreeRemove, worktreePrune } from '../git.ts';
import { cancelResume } from '../schedule.ts';
import { acquireLock, readLock, releaseLock, writeState } from '../store/state.ts';
import { appendEvent, printEvent } from '../store/runlog.ts';
import { listStates, loadRun } from './inspect.ts';

export async function cleanup(command: Extract<CommandLine, { command: 'cleanup' }>, deps: {
  cancelResume?: typeof cancelResume; output?: (text: string) => void;
} = {}): Promise<ExitCode> {
  const output = deps.output ?? console.log;
  let result: ExitCode = 0;
  try {
    const ids = command.finished
      ? (await listStates(command.workspace)).filter(s => s.status === 'DONE').map(s => s.runId)
      : [command.runId!];
    for (const id of ids) {
      let dir: string | undefined;
      let locked = false;
      try {
        const run = await loadRun(command.workspace, id);
        dir = run.dir;
        const state = run.state;
        if ((await readLock(dir))?.alive) throw new Error('이미 실행 중입니다.');
        if (state.status !== 'DONE' && !command.force) throw new Error('DONE이 아닌 런은 --force가 필요합니다.');
        await acquireLock(dir);
        locked = true;
        const record = async (message: string) => {
          const event: RunEvent = {
            at: new Date().toISOString(), lane: null, stage: null, role: null,
            type: 'cleanup', verdict: null, round: null, message,
          };
          await appendEvent(dir!, event);
          if (deps.output) output(message); else printEvent(event);
        };
        const trees = new Set(state.lanes.map(l => l.worktree));
        trees.delete(state.runWorktree);
        trees.add(state.runWorktree);
        for (const tree of trees) {
          try { await lstat(tree); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
          await worktreeRemove(command.workspace, tree, command.force);
          await record(`worktree 삭제: ${tree}`);
        }
        await worktreePrune(command.workspace);
        for (const branch of await laneBranches(command.workspace, id)) {
          if (branch === state.runBranch) continue;
          await branchDelete(command.workspace, branch);
          await record(`레인 브랜치 삭제: ${branch}`);
        }
        const root = join(command.workspace, '.aw/worktrees', id);
        await rm(root, { recursive: true, force: true });
        await record(`worktree 디렉터리 삭제: ${root}`);
        await worktreePrune(command.workspace);
        if (state.scheduledResume) {
          await (deps.cancelResume ?? cancelResume)(state.scheduledResume.atJobId);
          state.scheduledResume = null;
          await writeState(dir, state);
          await record('resume 예약 해제');
        }
      } catch (error) { output((error as Error).message); result = 2; }
      finally { if (dir && locked) await releaseLock(dir); }
    }
    return result;
  } catch (error) { output((error as Error).message); return 2; }
}
