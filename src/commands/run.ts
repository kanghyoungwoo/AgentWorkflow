import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CommandLine } from '../cli.ts';
import { killAllChildren } from '../clients/spawn.ts';
import { loadConfig } from '../config.ts';
import { addExcludes, resolveRef, restore, worktreeAdd } from '../git.ts';
import { runPipeline, pendingExit } from '../engine/pipeline.ts';
import type { PipelineDeps } from '../engine/pipeline.ts';
import { applyAnswer, applyGrant } from '../engine/review-loop.ts';
import { acquireLock, newRunState, readLock, readState, releaseLock, writeState } from '../store/state.ts';
import { appendEvent, initRunDir, makeRunId, printEvent, runDir as directoryFor } from '../store/runlog.ts';
import { atAvailable, scheduleResume, cancelResume } from '../schedule.ts';
import { parseRequest } from '../store/request.ts';
import type { ExitCode, LoopState, Pending, RunEvent, RunState } from '../types.ts';

export type RunDeps = PipelineDeps & {
  atAvailable?: typeof atAvailable;
  scheduleResume?: typeof scheduleResume;
  cancelResume?: typeof cancelResume;
};
type RunCommand = Extract<CommandLine, { command: 'run' }>;
type ResumeCommand = Extract<CommandLine, { command: 'resume' }>;
async function event(dir: string, deps: RunDeps, type: RunEvent['type'], message: string) {
  const value: RunEvent = {
    at: (deps.now?.() ?? new Date()).toISOString(), lane: null, stage: null, role: null,
    type, verdict: null, round: null, message,
  };
  await appendEvent(dir, value);
  (deps.onEvent ?? printEvent)(value);
}
async function execute(dir: string, deps: RunDeps): Promise<ExitCode> {
  let interrupted = false;
  let killing: Promise<void> | undefined;
  const signal = () => {
    interrupted = true;
    killing ??= killAllChildren();
  };
  process.on('SIGINT', signal);
  process.on('SIGTERM', signal);
  try {
    const result = await runPipeline(dir, {
      ...deps, onEvent: deps.onEvent ?? printEvent, interrupted: () => interrupted || !!deps.interrupted?.(),
    });
    await killing;
    await schedulePending(dir, deps);
    return result;
  } finally {
    process.off('SIGINT', signal);
    process.off('SIGTERM', signal);
    await releaseLock(dir);
  }
}
export async function run(command: RunCommand, deps: RunDeps = {}): Promise<ExitCode> {
  let dir: string | undefined;
  try {
    await loadConfig(command.workspace);
    const request = command.requestFile
      ? await readFile(resolve(command.requestFile), 'utf8') : null;
    if (request !== null) {
      const parsed = parseRequest(request);
      if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    } else if (command.mode !== 'wiki') throw new Error('요청 파일이 필요합니다.');
    const baseRef = await resolveRef(command.workspace, 'HEAD');
    if (!baseRef) throw new Error('HEAD를 해석할 수 없습니다.');
    const sinceRef = command.since ? await resolveRef(command.workspace, command.since) : null;
    if (command.mode === 'wiki' && !sinceRef) throw new Error('--since를 해석할 수 없습니다.');
    const runId = makeRunId(command.name, deps.now?.() ?? new Date());
    dir = await initRunDir(command.workspace, runId, request);
    await acquireLock(dir);
    await addExcludes(command.workspace, ['/ai-log/', '/.aw/']);
    const runWorktree = join(command.workspace, '.aw/worktrees', runId, 'main');
    const runBranch = `aw/${runId}`;
    await worktreeAdd(command.workspace, runWorktree, runBranch, baseRef);
    await writeState(dir, newRunState({
      runId, workspace: command.workspace, mode: command.mode, parallel: command.parallel,
      baseRef, sinceRef, runBranch, runWorktree,
    }));
    console.log(runId);
    await event(dir, deps, 'run_start', '런을 시작했습니다.');
    return await execute(dir, deps);
  } catch (error) {
    console.error(String(error));
    return 2;
  } finally { if (dir) await releaseLock(dir); }
}
function loopFor(state: RunState, value: Pending): LoopState {
  if (value.lane === 'integration') return state.integration!.loop;
  if (value.lane) return state.lanes.find(l => l.id === value.lane)!.loop;
  if (value.stage === 'WIKI') return state.wiki!;
  return state.planning;
}
export async function resume(command: ResumeCommand, deps: RunDeps = {}): Promise<ExitCode> {
  let dir: string | undefined;
  let locked = false;
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(command.runId)) throw new Error('잘못된 run-id입니다.');
    dir = directoryFor(command.workspace, command.runId);
    if ((await readLock(dir))?.alive) throw new Error('이미 실행 중입니다.');
    const state = await readState(dir);
    if (state.workspace !== command.workspace) throw new Error('런 워크스페이스가 일치하지 않습니다.');
    await acquireLock(dir);
    locked = true;
    await loadConfig(command.workspace);
    if (command.mode && state.mode !== 'plan') throw new Error('--mode full은 plan 런에만 사용할 수 있습니다.');
    const manual = state.pending.filter(p => p.kind !== 'failed' && p.kind !== 'rate_limited');
    let selected: Pending | undefined;
    if (command.answer !== undefined || command.grant !== undefined) {
      const candidates = manual.filter(p => command.lane === undefined || p.lane === command.lane);
      if (candidates.length !== 1) throw new Error('답변할 Pending 하나를 --lane으로 선택하세요.');
      selected = candidates[0];
      if (command.grant && selected.stage !== 'DEV' && selected.stage !== 'WIKI') {
        throw new Error('--grant는 DEV·WIKI 루프에서만 사용할 수 있습니다.');
      }
      if (command.grant && !command.answer
        && selected.kind !== 'permission_network' && selected.kind !== 'permission_full') {
        throw new Error('이 Pending에는 --answer가 필요합니다.');
      }
    } else if (command.lane !== undefined) throw new Error('--lane에는 --answer 또는 --grant가 필요합니다.');
    if (selected) {
      const lane = selected.lane === 'integration' ? state.integration : state.lanes.find(l => l.id === selected!.lane);
      if (selected.stage === 'QA' || selected.stage === 'INTEGRATION_QA') {
        lane!.decisions.push(command.answer!);
        if (selected.kind === 'qa_rollback_cap') lane!.qaRollbacks = 0;
        lane!.phase = 'QA';
      } else if (selected.stage !== 'SETUP' && selected.kind !== 'merge_conflict') {
        const loop = loopFor(state, selected);
        if (command.answer !== undefined) applyAnswer(loop, command.answer);
        if (command.grant) applyGrant(loop, command.grant);
      }
      if (lane) lane.status = 'ACTIVE';
      await event(dir, deps, 'resume', `답변: ${command.answer ?? '-'}, 권한: ${command.grant ?? '-'}`);
    }
    const retries = state.pending.filter(p => p.kind === 'failed' || p.kind === 'rate_limited');
    state.pending = manual.filter(p => p !== selected);
    if (command.mode) {
      state.mode = 'full';
      if (state.status === 'DONE') state.stage = 'LANES';
      await event(dir, deps, 'mode_switch', 'plan 런을 full 모드로 전환했습니다.');
    }
    for (const retry of retries) {
      const lane = retry.lane === 'integration' ? state.integration : state.lanes.find(l => l.id === retry.lane);
      if (lane) lane.status = 'ACTIVE';
    }
    if (state.pending.length && !(state.stage === 'LANES' && state.lanes.some(l => l.status === 'ACTIVE'))) {
      state.lastExitCode = pendingExit(state.pending.map(p => p.exitCode));
      await writeState(dir, state);
      return state.lastExitCode as ExitCode;
    }
    if (state.status === 'DONE' && !command.mode) {
      await writeState(dir, state);
      return 0;
    }
    if (state.scheduledResume) {
      await (deps.cancelResume ?? cancelResume)(state.scheduledResume.atJobId);
      state.scheduledResume = null;
      await writeState(dir, state);
    }
    await restore(state.runWorktree, 'HEAD');
    for (const lane of state.lanes) {
      if (lane.worktree !== state.runWorktree) {
        try { await readFile(join(lane.worktree, '.git')); await restore(lane.worktree, 'HEAD'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (!state.pending.some(p => p.lane === lane.id) && lane.status === 'PAUSED') lane.status = 'ACTIVE';
    }
    if (state.integration?.status === 'PAUSED') state.integration.status = 'ACTIVE';
    state.status = 'RUNNING'; state.lastExitCode = null;
    await writeState(dir, state);
    if (!selected) await event(dir, deps, 'resume', retries.length ? '중단된 호출을 재시도합니다.' : '런을 재개합니다.');
    return await execute(dir, deps);
  } catch (error) {
    console.error(String(error));
    return 2;
  } finally { if (dir && locked) await releaseLock(dir); }
}

export async function schedulePending(dir: string, deps: RunDeps = {}): Promise<void> {
  const state = await readState(dir);
  const limited = state.pending.filter(p => p.kind === 'rate_limited');
  if (!limited.length) return;
  const times = limited.map(p => p.resetAt ? Date.parse(p.resetAt) : NaN).filter(Number.isFinite);
  let message = '리셋 시각이 없어 resume을 예약하지 않았습니다.';
  if (times.length) {
    if (await (deps.atAvailable ?? atAvailable)()) {
      state.scheduledResume = await (deps.scheduleResume ?? scheduleResume)({
        runId: state.runId, workspace: state.workspace, at: new Date(Math.max(...times) + 120_000),
      });
      message = state.scheduledResume
        ? `resume 예약: ${state.scheduledResume.at} (작업 ${state.scheduledResume.atJobId})`
        : 'at 등록에 실패하여 resume을 예약하지 않았습니다.';
      await writeState(dir, state);
    } else message = 'at 또는 atd를 사용할 수 없어 resume을 예약하지 않았습니다.';
  }
  await event(dir, deps, 'schedule', message);
}
