import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { status, logs, list, watch } from '../src/commands/inspect.ts';
import { appendEvent, formatEvent, localTime } from '../src/store/runlog.ts';
import { writeState } from '../src/store/state.ts';
import type { RunEvent } from '../src/types.ts';
import { laneState } from './engine-fixtures.ts';
import { savedRun, temp } from './inspect-fixtures.ts';

const event = (type: RunEvent['type'], message: string, verdict: string | null = null): RunEvent => ({
  at: '2026-10-07T06:02:03Z', lane: null, stage: 'PLANNING', role: 'planningAuthor',
  type, message, verdict, round: 1,
});
test('status 모든 view, decisions 필터, JSON 최근 10개 및 없는 런', async t => {
  const workspace = await temp(t);
  const { dir, state } = await savedRun(workspace);
  state.lanes = [{ ...laneState(), id: 'a' }];
  state.scheduledResume = { atJobId: 12, at: '2026-10-08T00:00:00Z' };
  state.pending = [{
    id: 'p', lane: 'a', stage: 'DEV', kind: 'rate_limited', exitCode: 22,
    summary: '한도', detail: '', resetAt: state.scheduledResume.at, createdAt: state.updatedAt,
  }];
  await writeState(dir, state);
  for (let n = 0; n < 12; n++) await appendEvent(dir, event('author', `판정${n}`, 'READY'));
  await appendEvent(dir, event('schedule', '예약제외', 'READY'));
  await appendEvent(dir, event('review', '무판정제외'));
  await appendEvent(dir, event('qa', 'QA판정', 'PASS'));
  const out: string[] = [];
  const deps = { output: (text: string) => out.push(text) };
  const command = { command: 'status' as const, workspace, runId: state.runId, json: false };
  assert.equal(await status({ ...command, view: 'current' }, deps), 0);
  assert.match(out.pop()!, /마지막 종료 코드.*런 브랜치.*Pending.*한도.*작업 12/s);
  assert.equal(await status({ ...command, view: 'timeline' }, deps), 0);
  assert.match(out.pop()!, /예약제외/);
  assert.equal(await status({ ...command, view: 'decisions' }, deps), 0);
  const decisions = out.pop()!;
  assert.match(decisions, /\| 시각 \| 레인 \| 단계 \| 역할 \| 판정 \| 내용 \|/);
  assert.match(decisions, /QA판정/);
  assert.doesNotMatch(decisions, /예약제외|무판정제외/);
  for (const view of ['plan', 'todo', 'qa'] as const) {
    assert.equal(await status({ ...command, view }, deps), 0);
    assert.equal(out.pop(), '아직 없음');
  }
  for (const path of ['01-planning', '02-development/a', '02-development/b',
    '03-qa/a/attempt-01', '03-qa/integration/attempt-02']) await mkdir(join(dir, path), { recursive: true });
  await writeFile(join(dir, '01-planning/plan.md'), '계획 원문');
  await writeFile(join(dir, '02-development/a/todo.md'), 'a 할 일');
  await writeFile(join(dir, '02-development/b/todo.md'), 'b 할 일');
  await writeFile(join(dir, '03-qa/a/attempt-01/report.md'), '오래된 보고');
  const latest = join(dir, '03-qa/integration/attempt-02/report.md');
  await writeFile(latest, '최근 보고');
  await utimes(join(dir, '03-qa/a/attempt-01/report.md'), 0, 0);
  for (const [view, expected] of [['plan', /계획 원문/], ['todo', /## a.*a 할 일.*## b.*b 할 일/s],
    ['qa', /integration\/attempt-02\/report.md\n최근 보고/]] as const) {
    assert.equal(await status({ ...command, view }, deps), 0);
    assert.match(out.pop()!, expected);
  }
  await status({ ...command, view: 'qa', json: true }, deps);
  const value = JSON.parse(out.pop()!);
  assert.deepEqual(Object.keys(value), [
    'runId', 'mode', 'parallel', 'status', 'stage', 'lastExitCode', 'runBranch', 'runWorktree',
    'lanes', 'pending', 'scheduledResume', 'lastEvents',
  ]);
  assert.equal(value.lastEvents.length, 10);
  assert.equal(value.lastEvents[0].message, '판정5');
  assert.deepEqual(Object.keys(value.lanes[0]), [
    'id', 'phase', 'status', 'branch', 'worktree', 'qaAttempt', 'qaRollbacks',
  ]);
  assert.equal(await status({ ...command, runId: 'missing', view: 'current' }, deps), 2);
  assert.equal(out.pop(), '런 없음');
  assert.equal(await status({ ...command, runId: '../bad', view: 'current' }, deps), 2);
});
test('logs seq 정렬, 클라이언트별 최종 출력과 stderr 100줄', async t => {
  const workspace = await temp(t);
  const { dir, state } = await savedRun(workspace);
  for (const [seq, client] of [[2, 'claude'], [1, 'codex']] as const) {
    const prefix = join(dir, 'raw', `000${seq}-lane-a-DEV-devAuthor-r02`);
    await writeFile(`${prefix}.meta.json`, JSON.stringify({ client, exitCode: 0, durationMs: seq * 10 }));
    await writeFile(`${prefix}.prompt.md`, `프롬프트${seq}`);
    await writeFile(`${prefix}.${client === 'codex' ? 'last' : 'out'}.json`, JSON.stringify(
      client === 'codex' ? { status: 'DONE' } : { structured_output: { status: 'READY' } },
    ));
    await writeFile(`${prefix}.stderr.log`, Array.from({ length: 105 }, (_, n) => `줄${n}`).join('\n') + '\n');
  }
  const out: string[] = [];
  const deps = { output: (text: string) => out.push(text) };
  const command = { command: 'logs' as const, workspace, runId: state.runId, json: true };
  assert.equal(await logs(command, deps), 0);
  const rows = JSON.parse(out.pop()!);
  assert.deepEqual(rows.map((row: { seq: number }) => row.seq), [1, 2]);
  assert.equal(rows[0].lane, 'lane-a');
  assert.equal(rows[1].durationMs, 20);
  await logs({ ...command, json: false }, deps);
  assert.match(out.pop()!, /seq.*durationMs/s);
  for (const seq of [1, 2]) {
    assert.equal(await logs({ ...command, seq }, deps), 0);
    const value = JSON.parse(out.pop()!);
    assert.equal(value.prompt, `프롬프트${seq}`);
    assert.equal(value.stderr.split('\n').length, 100);
    assert.equal(value.stderr.split('\n')[0], '줄5');
    if (seq === 1) assert.equal(value.finalOutput, '{"status":"DONE"}');
    else assert.deepEqual(value.finalOutput, { status: 'READY' });
    await logs({ ...command, seq, json: false }, deps);
    assert.match(out.pop()!, /프롬프트.*최종 출력.*stderr/s);
  }
  await writeFile(join(dir, 'raw/0002-lane-a-DEV-devAuthor-r02.out.json'), '원문');
  await logs({ ...command, seq: 2 }, deps);
  assert.equal(JSON.parse(out.pop()!).finalOutput, '원문');
  assert.equal(await logs({ ...command, seq: 99 }, deps), 2);
  assert.equal(await logs({ ...command, runId: 'missing' }, deps), 2);
});
test('list updatedAt 내림차순, 빈 목록과 잘못된 항목 건너뛰기', async t => {
  const workspace = await temp(t);
  const out: string[] = [];
  const deps = { output: (text: string) => out.push(text) };
  const command = { command: 'list' as const, workspace, json: true };
  assert.equal(await list(command, deps), 0);
  assert.deepEqual(JSON.parse(out.pop()!), []);
  for (const [id, date] of [['old', '2026-01-01'], ['new', '2026-02-01']]) {
    const { dir, state } = await savedRun(workspace, id);
    state.updatedAt = date;
    await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  }
  await writeFile(join(workspace, 'ai-log/notes.txt'), '메모');
  await writeFile(join(workspace, 'ai-log/notes'), 'run-id 형식인 파일');
  await mkdir(join(workspace, 'ai-log/bad dir'));
  await writeFile(join(workspace, 'ai-log/bad dir/state.json'), 'invalid');
  assert.equal(await list(command, deps), 0);
  assert.deepEqual(JSON.parse(out.pop()!).map((s: { runId: string }) => s.runId), ['new', 'old']);
});
test('watch 기존·신규 이벤트 중복 없이 출력, DONE 종료 코드와 죽은 PID', async t => {
  const workspace = await temp(t);
  const { dir, state } = await savedRun(workspace);
  await appendEvent(dir, event('run_start', '기존'));
  await writeFile(join(dir, 'run.lock'), String(process.pid));
  const seen: string[] = [];
  const command = { command: 'watch' as const, workspace, runId: state.runId };
  assert.equal(await watch(command, {
    intervalMs: 1, onEvent: e => seen.push(e.message), sleep: async ms => {
      assert.equal(ms, 1);
      assert.deepEqual(seen, ['기존']);
      await appendEvent(dir, event('done', '신규'));
      state.status = 'DONE'; state.lastExitCode = 22;
      await writeState(dir, state);
    },
  }), 22);
  assert.deepEqual(seen, ['기존', '신규']);
  state.status = 'RUNNING'; await writeState(dir, state);
  await writeFile(join(dir, 'run.lock'), '2147483647');
  const out: string[] = [];
  assert.equal(await watch(command, { onEvent: () => {}, output: text => out.push(text) }), 1);
  assert.equal(out.pop(), '실행 프로세스가 없습니다');
  assert.equal(await watch({ ...command, runId: 'missing' }, { output: () => {} }), 2);
});
test('공용 이벤트 출력은 로컬 시각과 한 줄 메시지', () => {
  const value = event('author', '첫줄\r\n다음줄', 'READY');
  assert.equal(formatEvent(value), `${localTime(new Date(value.at))} run PLANNING planningAuthor author READY 첫줄 다음줄`);
});
