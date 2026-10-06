import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LoopState, RunState } from '../types.ts';

export function newLoopState(): LoopState {
  return {
    round: 0,
    judgedRounds: 0,
    issueStreak: {},
    lastOutput: null,
    lastIssues: [],
    reviewIssues: [],
    stageBase: null,
    decisions: [],
    grant: null
  };
}
export function newRunState(input: Pick<RunState,
  'runId' | 'workspace' | 'mode' | 'parallel' | 'baseRef' | 'sinceRef' | 'runBranch' | 'runWorktree'>): RunState {
  return {
    ...input,
    setupDone: false,
    status: 'RUNNING',
    stage: input.mode === 'wiki' ? 'WIKI' : 'PLANNING',
    planning: newLoopState(),
    lanes: [],
    integration: null,
    wiki: input.mode === 'wiki' ? newLoopState() : null,
    pending: [],
    lastExitCode: null,
    scheduledResume: null,
    seq: 0,
    updatedAt: new Date().toISOString()
  };
}
export async function readState(runDir: string): Promise<RunState> {
  return JSON.parse(await readFile(join(runDir, 'state.json'), 'utf8'));
}
export async function writeState(runDir: string, state: RunState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const temporary = join(runDir, `state.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n');
    await rename(temporary, join(runDir, 'state.json'));
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
export async function readLock(runDir: string): Promise<{
  pid: number;
  alive: boolean
} | null> {
  let text: string;
  try {
    text = await readFile(join(runDir, 'run.lock'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const pid = /^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN;
  return { pid, alive: Number.isSafeInteger(pid) && pid > 0 && isAlive(pid) };
}
export async function acquireLock(runDir: string): Promise<void> {
  const path = join(runDir, 'run.lock');
  for (;;) {
    try {
      await writeFile(path, `${process.pid}\n`, { flag: 'wx' });
      return;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const lock = await readLock(runDir);
    if (lock?.alive) throw new Error('이미 실행 중입니다.');
    // 배타 생성으로 새 소유권을 확보하기 전에 죽은 PID의 잠금을 제거한다.
    await unlink(path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
export async function releaseLock(runDir: string): Promise<void> {
  if ((await readLock(runDir))?.pid === process.pid) await unlink(join(runDir, 'run.lock'));
}
