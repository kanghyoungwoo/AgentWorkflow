import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CommandLine } from '../cli.ts';
import type { ExitCode, RunEvent, RunState } from '../types.ts';
import { readState, readLock } from '../store/state.ts';
import { runDir, readEvents, renderTimeline, printEvent, validateRunId } from '../store/runlog.ts';

type Command<K extends CommandLine['command']> = Extract<CommandLine, { command: K }>;
export type InspectDeps = { output?: (text: string) => void };
async function optionalFile(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function entries(path: string): Promise<string[]> {
  try { return (await readdir(path)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export async function loadRun(workspace: string, runId: string): Promise<{ dir: string; state: RunState }> {
  validateRunId(runId);
  const dir = runDir(workspace, runId);
  try { return { dir, state: await readState(dir) }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('런 없음');
    throw error;
  }
}
function table(headers: string[], rows: unknown[][]): string {
  const cell = (value: unknown) => String(value ?? '-').replaceAll('|', '\\|').replace(/\r\n|\r|\n/g, ' ');
  return [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.map(cell).join(' | ')} |`).join('\n');
}
function snapshot(state: RunState, events: RunEvent[]) {
  const {
    runId, mode, parallel, status, stage, lastExitCode, runBranch, runWorktree, pending, scheduledResume,
  } = state;
  const lanes = state.lanes.map(({ id, phase, status, branch, worktree, qaAttempt, qaRollbacks }) => ({
    id, phase, status, branch, worktree, qaAttempt, qaRollbacks,
  }));
  return {
    runId, mode, parallel, status, stage, lastExitCode, runBranch, runWorktree,
    lanes, pending, scheduledResume, lastEvents: events.slice(-10),
  };
}
async function reports(path: string): Promise<{ path: string; mtime: number }[]> {
  const result: { path: string; mtime: number }[] = [];
  for (const name of await entries(path)) {
    const file = join(path, name);
    const info = await stat(file);
    if (info.isDirectory()) result.push(...await reports(file));
    else if (name === 'report.md') result.push({ path: file, mtime: info.mtimeMs });
  }
  return result;
}
export async function status(command: Command<'status'>, deps: InspectDeps = {}): Promise<ExitCode> {
  const output = deps.output ?? console.log;
  try {
    const { dir, state } = await loadRun(command.workspace, command.runId);
    if (command.json) { output(JSON.stringify(snapshot(state, await readEvents(dir)))); return 0; }
    let text: string | null = null;
    switch (command.view) {
      case 'current':
        text = `런: ${state.runId}\n단계: ${state.stage}\n상태: ${state.status}\n모드: ${state.mode}\n`
          + `병렬: ${state.parallel ? '예' : '아니오'}\n마지막 종료 코드: ${state.lastExitCode ?? '-'}\n`
          + `런 브랜치: ${state.runBranch}\n런 worktree: ${state.runWorktree}\n레인\n`
          + table(['id', 'phase', 'status', 'qaAttempt', 'qaRollbacks'], state.lanes.map(l => [
            l.id, l.phase, l.status, l.qaAttempt, l.qaRollbacks,
          ])) + '\nPending\n'
          + table(['id', 'lane', 'stage', 'kind', 'exitCode', 'summary', 'resetAt'], state.pending.map(p => [
            p.id, p.lane, p.stage, p.kind, p.exitCode, p.summary, p.resetAt,
          ])) + '\n예약: ' + (state.scheduledResume
            ? `${state.scheduledResume.at} (작업 ${state.scheduledResume.atJobId})` : '없음');
        break;
      case 'timeline': text = await optionalFile(join(dir, 'timeline.md')); break;
      case 'plan': text = await optionalFile(join(dir, '01-planning/plan.md')); break;
      case 'decisions': {
        const decisions = (await readEvents(dir)).filter(e =>
          ['author', 'gate', 'tests', 'review', 'qa'].includes(e.type) && e.verdict !== null,
        );
        text = decisions.length ? renderTimeline(decisions) : null;
        break;
      }
      case 'todo': {
        const todos: string[] = [];
        for (const lane of await entries(join(dir, '02-development'))) {
          const todo = await optionalFile(join(dir, '02-development', lane, 'todo.md'));
          if (todo !== null) todos.push(`## ${lane}\n${todo}`);
        }
        text = todos.length ? todos.join('\n') : null;
        break;
      }
      case 'qa': {
        const latest = (await reports(join(dir, '03-qa'))).sort((a, b) => b.mtime - a.mtime)[0];
        if (latest) text = `${latest.path}\n${await readFile(latest.path, 'utf8')}`;
        break;
      }
    }
    output(text ?? '아직 없음');
    return 0;
  } catch (error) { output((error as Error).message); return 2; }
}
type RawMeta = { client: 'codex' | 'claude'; exitCode: number | null; durationMs: number };
async function calls(dir: string) {
  const values = [];
  for (const name of await entries(join(dir, 'raw'))) {
    const match = /^(\d+)-(.+)-([A-Z_]+)-([a-zA-Z]+)-r(\d+)\.meta\.json$/.exec(name);
    if (!match) continue;
    const meta: RawMeta = JSON.parse(await readFile(join(dir, 'raw', name), 'utf8'));
    values.push({
      seq: Number(match[1]), lane: match[2], stage: match[3], role: match[4], round: Number(match[5]),
      exitCode: meta.exitCode, durationMs: meta.durationMs, client: meta.client,
      prefix: join(dir, 'raw', name.slice(0, -'.meta.json'.length)),
    });
  }
  return values.sort((a, b) => a.seq - b.seq);
}
export async function logs(command: Command<'logs'>, deps: InspectDeps = {}): Promise<ExitCode> {
  const output = deps.output ?? console.log;
  try {
    const { dir } = await loadRun(command.workspace, command.runId);
    const all = await calls(dir);
    if (command.seq === undefined) {
      const rows = all.map(({ prefix, client, ...row }) => row);
      output(command.json ? JSON.stringify(rows) : table(
        ['seq', 'lane', 'stage', 'role', 'round', 'exitCode', 'durationMs'], rows.map(row => Object.values(row)),
      ));
      return 0;
    }
    const call = all.find(c => c.seq === command.seq);
    if (!call) { output('호출 없음'); return 2; }
    const prompt = await optionalFile(`${call.prefix}.prompt.md`);
    const raw = await optionalFile(`${call.prefix}.${call.client === 'codex' ? 'last' : 'out'}.json`);
    let finalOutput: unknown = raw;
    if (call.client === 'claude' && raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        finalOutput = parsed.structured_output ?? raw;
      } catch {}
    }
    const stderr = (await optionalFile(`${call.prefix}.stderr.log`) ?? '')
      .replace(/\r?\n$/, '').split(/\r?\n/).slice(-100).join('\n');
    const { prefix, client, ...row } = call;
    const detail = { ...row, prompt, finalOutput, stderr };
    output(command.json ? JSON.stringify(detail)
      : `프롬프트\n${prompt ?? '아직 없음'}\n최종 출력\n`
        + `${typeof finalOutput === 'string' ? finalOutput : JSON.stringify(finalOutput, null, 2)}\nstderr\n${stderr}`);
    return 0;
  } catch (error) { output((error as Error).message); return 2; }
}
export async function listStates(workspace: string): Promise<RunState[]> {
  const states: RunState[] = [];
  const items = await readdir(join(workspace, 'ai-log'), { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const item of items) {
    if (!item.isDirectory()) continue;
    const id = item.name;
    try { validateRunId(id); }
    catch { continue; }
    const text = await optionalFile(join(runDir(workspace, id), 'state.json'));
    if (text !== null) states.push(JSON.parse(text));
  }
  return states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function list(command: Command<'list'>, deps: InspectDeps = {}): Promise<ExitCode> {
  const output = deps.output ?? console.log;
  try {
    const rows = (await listStates(command.workspace)).map(s => ({
      runId: s.runId, mode: s.mode, status: s.status, stage: s.stage,
      lastExitCode: s.lastExitCode, updatedAt: s.updatedAt,
    }));
    output(command.json ? JSON.stringify(rows) : table(
      ['run-id', 'mode', 'status', 'stage', 'lastExitCode', 'updatedAt'], rows.map(row => Object.values(row)),
    ));
    return 0;
  } catch (error) { output((error as Error).message); return 2; }
}
export async function watch(command: Command<'watch'>, deps: InspectDeps & {
  intervalMs?: number; sleep?: (ms: number) => Promise<void>; onEvent?: (event: RunEvent) => void;
} = {}): Promise<ExitCode> {
  const output = deps.output ?? console.log;
  try {
    const { dir } = await loadRun(command.workspace, command.runId);
    let count = 0;
    const flush = async () => {
      const events = await readEvents(dir);
      for (const event of events.slice(count)) (deps.onEvent ?? printEvent)(event);
      count = events.length;
    };
    for (;;) {
      await flush();
      const state = await readState(dir);
      if (state.status !== 'RUNNING') { await flush(); return (state.lastExitCode ?? 0) as ExitCode; }
      if (!(await readLock(dir))?.alive) { output('실행 프로세스가 없습니다'); return 1; }
      await (deps.sleep ?? delay)(deps.intervalMs ?? 2000);
    }
  } catch (error) { output((error as Error).message); return 2; }
}
