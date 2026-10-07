import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';
import type { AgentCall } from '../src/clients/index.ts';
import type { BlockerKind, Plan, QaScenario, Role } from '../src/types.ts';
import { run, resume } from '../src/commands/run.ts';
import type { RunDeps } from '../src/commands/run.ts';
import { commitAll, headSha, resolveRef } from '../src/git.ts';
import { readEvents } from '../src/store/runlog.ts';
import { readState } from '../src/store/state.ts';
import { dev, plan, repo, review } from './engine-fixtures.ts';
import { fakeClient } from './fake-client.ts';
import * as appRunner from '../src/qa/app-runner.ts';

const exec = promisify(execFile);
function section<T>(call: AgentCall, name: string): T {
  const value = call.prompt.split(`## ${name}\n\n`)[1].split('\n\n## ')[0];
  return JSON.parse(value.slice(8).split('\n```')[0]);
}
function barrier(count: number) {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return async () => { if (++arrived === count) release(); await ready; };
}
async function fixture(t: TestContext, options: {
  overlap?: boolean; single?: boolean; mode?: 'plan' | 'full'; testCommand?: string;
  setupCommand?: string; maxReviewRounds?: number; maxQaRollbacks?: number; noScenarios?: boolean;
} = {}) {
  const { cwd } = await repo(t);
  const roles: Role[] = [
    'planningAuthor', 'planningReviewer', 'devAuthor', 'devReviewer', 'qa', 'wikiAuthor', 'wikiReviewer',
  ];
  await writeFile(join(cwd, 'agent-workflow.json'), JSON.stringify({
    roles: Object.fromEntries(roles.map(role => [role, { client: 'claude' }])),
    setupCommand: options.setupCommand, testCommand: options.testCommand,
    limits: { maxReviewRounds: options.maxReviewRounds, maxQaRollbacks: options.maxQaRollbacks },
  }));
  const requestFile = join(cwd, 'request.md');
  await writeFile(requestFile, '# 테스트\n\n## 목표\n구현\n\n## 요구사항\n- REQ-001: 구현\n\n## 스펙 외 범위\n- 없음\n');
  await commitAll(cwd, 'config');
  const control = {
    blocked: {} as Record<string, BlockerKind>, fails: {} as Record<string, number>, outside: false,
    devBarrier: null as null | (() => Promise<void>), fixBarrier: null as null | (() => Promise<void>),
    conflict: false, qaRetry: false,
  };
  let writes = 0;
  const fake = fakeClient(async call => {
    if (call.role === 'planningAuthor') {
      const context = section<{ mode: string; lane: string; parallel: boolean }>(call, 'Run context');
      const output = plan();
      if (context.mode === 'fix') {
        await control.fixBarrier?.();
        output.todos[0].id = 'FIX-001';
        output.todos[0].defectIds = section<{ id: string }[]>(call, 'QA defects').map(d => d.id);
        return output;
      }
      assert.equal(context.parallel, true);
      output.lanes = (options.single ? ['a'] : ['a', 'b']).map(id => ({
        id, title: id, ownedPaths: [options.overlap ? (id === 'a' ? 'src' : 'src/a') : id],
        interfaces: `${id} 계약`,
      }));
      output.todos = output.lanes.map((lane, i) => ({
        ...output.todos[0], id: `DEV-00${i + 1}`, lane: lane.id,
      }));
      output.qaScenarios = [...output.lanes.map((lane, i) => ({
        ...output.qaScenarios[0], id: `QA-00${i + 1}`, lane: lane.id,
      })), { ...output.qaScenarios[0], id: 'QA-003', lane: null }];
      if (options.noScenarios) output.qaScenarios = [];
      return output;
    }
    if (call.role.endsWith('Reviewer')) return review();
    if (call.role === 'devAuthor') {
      const context = section<{ lane: string; ownedPaths: string[] | null; interfaces: string | null }>(
        call, 'Run context');
      const targets = section<{ id: string }[]>(call, 'Target items');
      if (targets[0].id.startsWith('DEV')) await control.devBarrier?.();
      const kind = control.blocked[context.lane];
      if (kind) return { ...dev(), status: 'BLOCKED', blocker: { kind, detail: '답변 필요' } };
      const file = context.lane === 'main' ? 'base'
        : context.lane === 'integration' ? 'fixed' : `${context.lane}/file`;
      await mkdir(dirname(join(call.cwd, file)), { recursive: true });
      await writeFile(join(call.cwd, file), `개발 ${++writes}`);
      if (context.lane === 'a') {
        assert.deepEqual(context.ownedPaths, ['a']);
        assert.equal(context.interfaces, 'a 계약');
        if (control.outside) await writeFile(join(call.cwd, 'base'), '범위 밖');
      }
      return { ...dev(), items: targets.map(item => ({
        id: item.id, checked: true, evidence: { files: [file], summary: '구현' },
      })) };
    }
    if (call.role === 'qa') {
      const context = section<{ scope: string; worktree: string }>(call, 'Run context');
      if (control.conflict && context.scope === 'a') {
        control.conflict = false;
        const main = join(dirname(call.cwd), 'main');
        await mkdir(join(main, 'a'), { recursive: true });
        await writeFile(join(main, 'a/file'), '런 브랜치 변경');
        await commitAll(main, 'concurrent run change');
      }
      const scenarios = section<QaScenario[]>(call, 'Scenarios');
      await writeFile(join(call.qaDir!, 'evidence/result.log'), '관찰');
      const fail = (control.fails[context.scope] ?? 0) > 0;
      if (fail) control.fails[context.scope] -= 1;
      const output = {
        status: fail ? 'FAIL' : 'PASS', blocker: null, exploratory: [],
        scenarios: scenarios.map(s => ({
          id: s.id, result: fail ? 'FAIL' : 'PASS', observed: '관찰', evidence: ['evidence/result.log'],
        })), defects: fail ? [{
          id: 'BUG-001', scenarioId: scenarios[0].id, title: '실패', reproduction: ['실행'],
          expected: '성공', actual: '실패', evidence: ['evidence/result.log'],
        }] : [],
      };
      if (context.scope === 'integration' && control.qaRetry) {
        control.qaRetry = false;
        output.scenarios[0].evidence = ['missing'];
      }
      return output;
    }
    const wiki = join(call.cwd, 'docs/wiki');
    await mkdir(wiki, { recursive: true });
    await writeFile(join(wiki, 'log.md'), '기록');
    return {
      status: 'DONE', blocker: null, responses: [],
      docs: [{ path: 'docs/wiki/log.md', action: 'created', reason: '기록' }],
    };
  });
  const deps: RunDeps = {
    atAvailable: async () => false,
    now: () => new Date('2026-10-07T01:02:03Z'), onEvent: () => {}, clientFor: () => fake,
  };
  const start = async () => {
    const code = await run({
      command: 'run', workspace: cwd, mode: options.mode ?? 'full', requestFile, parallel: true, name: 'parallel',
    }, deps);
    const [id] = await readdir(join(cwd, 'ai-log'));
    return { code, dir: join(cwd, 'ai-log', id), id };
  };
  return {
    cwd, control, fake, deps, start,
    resume: (id: string, args: { answer?: string; lane?: string; mode?: 'full' } = {}) =>
      resume({ command: 'resume', workspace: cwd, runId: id, ...args }, deps),
  };
}
for (const options of [{ overlap: true }, { single: true }]) {
  test(`G2' 순차 전환 ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, options);
    const { code, dir } = await f.start();
    assert.equal(code, 0);
    const output: Plan = JSON.parse(await readFile(join(dir, '01-planning/plan.json'), 'utf8'));
    assert.equal(output.lanes, null);
    assert.ok(output.todos.every(todo => todo.lane === 'main'));
    assert.ok(output.qaScenarios.every(s => s.lane === null));
    assert.ok((await readEvents(dir)).some(e => e.type === 'mode_switch'));
    assert.ok((await readFile(join(dir, '02-development/main/todo.md'), 'utf8')).includes('DEV-001'));
    const state = await readState(dir);
    assert.equal(state.parallel, true);
    assert.equal(state.integration, null);
    assert.ok(!(await readEvents(dir)).some(e => e.type === 'merge'));
  });
}
test('통합 테스트 통과 후 시나리오가 없으면 QA 호출 없이 skip하고 WIKI로 진행', async t => {
  const f = await fixture(t, { noScenarios: true, testCommand: 'echo integration-test' });
  const { code, dir } = await f.start();
  assert.equal(code, 0);
  const state = await readState(dir);
  assert.equal(state.status, 'DONE');
  assert.equal(state.integration!.status, 'DONE');
  assert.equal(f.fake.calls.filter(call => call.role === 'qa').length, 0);
  assert.ok(f.fake.calls.some(call => call.role === 'wikiAuthor'));
  const log = await readFile(join(dir, '03-qa/integration/attempt-01/evidence/integration-tests.log'), 'utf8');
  assert.ok(log.includes('integration-test'));
  const events = (await readEvents(dir)).filter(event => event.lane === 'integration');
  const testsIndex = events.findIndex(event => event.type === 'tests' && event.verdict === 'PASS');
  const skipIndex = events.findIndex(event => event.type === 'skip' && event.verdict === 'PASS');
  assert.ok(testsIndex >= 0);
  assert.ok(skipIndex > testsIndex);
});
test('두 레인 DEV 동시 실행, worktree, 두 merge 커밋과 전체 통합 QA', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  f.control.devBarrier = barrier(2);
  const { code, dir } = await f.start();
  assert.equal(code, 0);
  const state = await readState(dir);
  assert.equal(state.status, 'DONE');
  assert.equal(state.integration!.status, 'DONE');
  for (const lane of state.lanes) {
    assert.equal(lane.branch, `aw/${state.runId}-lane-${lane.id}`);
    assert.equal(lane.worktree, join(f.cwd, '.aw/worktrees', state.runId, `lane-${lane.id}`));
    assert.equal(await headSha(lane.worktree), await resolveRef(f.cwd, lane.branch));
    assert.equal(lane.setupDone, true);
    assert.ok((await readFile(join(dir, `02-development/${lane.id}/todo.md`), 'utf8')).includes('[x] DEV'));
    assert.ok(await readFile(join(dir, `03-qa/${lane.id}/attempt-01/report.json`)));
  }
  const merges = (await exec('git', ['log', '--merges', '--format=%H'], { cwd: state.runWorktree }))
    .stdout.trim().split('\n');
  assert.equal(merges.length, 2);
  const qaCalls = f.fake.calls.filter(call => call.role === 'qa');
  assert.deepEqual(Object.fromEntries(qaCalls.map(call => [
    section<{ scope: string }>(call, 'Run context').scope,
    section<QaScenario[]>(call, 'Scenarios').map(s => s.id),
  ])), { a: ['QA-001'], b: ['QA-002'], integration: ['QA-001', 'QA-002', 'QA-003'] });
  assert.ok(await readFile(join(dir, '03-qa/integration/attempt-01/report.md')));
  assert.ok(f.fake.calls.some(call => call.role === 'wikiAuthor'));
  const prefixes = f.fake.calls.map(call => call.rawPrefix);
  assert.equal(new Set(prefixes).size, prefixes.length);
  const events = await readEvents(dir);
  assert.equal(events.filter(e => e.type === 'merge').length, 2);
  assert.ok(events.some(e => e.lane === 'integration' && e.stage === 'INTEGRATION_QA'));
});
test('a BLOCKED 중 b DONE, --lane a 답변으로 완주', async t => {
  const f = await fixture(t);
  f.control.blocked.a = 'scope';
  const { code, dir, id } = await f.start();
  assert.equal(code, 20);
  const state = await readState(dir);
  assert.equal(state.lanes[0].status, 'PAUSED');
  assert.equal(state.lanes[1].status, 'DONE');
  assert.equal(state.pending[0].lane, 'a');
  delete f.control.blocked.a;
  assert.equal(await f.resume(id, { lane: 'a', answer: '진행' }), 0);
  assert.ok(f.fake.calls.filter(c => c.role === 'devAuthor').at(-1)!.prompt.includes('1. 진행'));
});
test('두 Pending 선택과 종료 코드 우선순위, 나머지 Pending 중에도 선택 레인 실행', async t => {
  const f = await fixture(t);
  f.control.blocked.a = 'scope';
  f.control.blocked.b = 'permission_full';
  const { code, dir, id } = await f.start();
  assert.equal(code, 21);
  const paused = await readState(dir);
  assert.equal(new Set(paused.pending.map(p => p.id)).size, 2);
  assert.equal(await f.resume(id, { answer: '진행' }), 2);
  delete f.control.blocked.a;
  assert.equal(await f.resume(id, { lane: 'a', answer: 'a 진행' }), 21);
  const partial = await readState(dir);
  assert.equal(partial.lanes[0].status, 'DONE');
  assert.equal(partial.status, 'PAUSED');
  assert.equal(partial.lastExitCode, 21);
  delete f.control.blocked.b;
  assert.equal(await f.resume(id, { lane: 'b', answer: 'b 진행' }), 0);
});
test('G7 소유 범위 밖 변경은 리뷰 없이 GATE-OWNED 반려', async t => {
  const f = await fixture(t, { maxReviewRounds: 1 });
  f.control.outside = true;
  const { code, dir } = await f.start();
  assert.equal(code, 20);
  const issues = JSON.parse(await readFile(join(dir, '02-development/a/round-01.gate.json'), 'utf8'));
  assert.ok(issues.some((issue: { id: string }) => issue.id === 'GATE-OWNED'));
  assert.ok(!f.fake.calls.some(c => c.role === 'devReviewer'
    && section<{ lane: string }>(c, 'Run context').lane === 'a'));
  assert.equal((await readState(dir)).lanes[1].status, 'DONE');
});
test('merge_conflict 명령으로 해결 후 resume은 병합된 레인을 건너뛰고 완주', async t => {
  const f = await fixture(t);
  f.control.conflict = true;
  const { code, dir, id } = await f.start();
  assert.equal(code, 20);
  const state = await readState(dir);
  const pending = state.pending[0];
  assert.equal(pending.kind, 'merge_conflict');
  assert.equal(pending.stage, 'MERGE');
  assert.equal(pending.lane, null);
  assert.ok(pending.detail.includes('a/file'));
  const command = pending.detail.split('\n').at(-1)!;
  assert.equal(command, `git -C ${state.runWorktree} merge --no-ff aw/${id}-lane-a`);
  await assert.rejects(exec('sh', ['-c', command]));
  await writeFile(join(state.runWorktree, 'a/file'), '충돌 해결');
  await commitAll(state.runWorktree, 'manual merge resolution');
  assert.equal(await f.resume(id, { answer: '충돌 해결 커밋 완료' }), 0);
  const finished = await readState(dir);
  assert.deepEqual(finished.planning.decisions, []);
  const events = await readEvents(dir);
  assert.deepEqual(events.filter(e => e.type === 'merge').map(e => e.message),
    [`aw/${id}-lane-a`, `aw/${id}-lane-b`]);
  assert.ok(events.some(e => e.type === 'resume' && e.message.includes('충돌 해결 커밋 완료')));
});
for (const testFailure of [true, false]) {
  test(`통합 ${testFailure ? 'testCommand 실패' : 'QA FAIL'} 후 integration FIX와 WIKI`, async t => {
    const command = 'if [ -f a/file ] && [ -f b/file ]; then test -f fixed; fi';
    const f = await fixture(t, { testCommand: testFailure ? command : 'true' });
    if (!testFailure) f.control.fails.integration = 1;
    const { code, dir } = await f.start();
    assert.equal(code, 0);
    const state = await readState(dir);
    assert.equal(state.integration!.qaAttempt, 2);
    assert.equal(state.integration!.qaRollbacks, 1);
    const report = JSON.parse(await readFile(join(dir, '03-qa/integration/attempt-01/report.json'), 'utf8'));
    assert.equal(report.defects[0].id, testFailure ? 'BUG-INTEGRATION-TESTS' : 'BUG-001');
    assert.ok(await readFile(join(dir, '03-qa/integration/attempt-01/evidence/integration-tests.log'))
      .then(() => true));
    assert.ok(await readFile(join(dir, '01-planning/fix/integration-1/round-01.author.json')));
    assert.ok(await readFile(join(dir, '02-development/integration/fix-1/round-01.author.json')));
    const output: Plan = JSON.parse(await readFile(join(dir, '01-planning/plan.json'), 'utf8'));
    assert.equal(output.todos.find(todo => todo.id === 'FIX-001')!.lane, 'integration');
    assert.equal(output.qaScenarios.at(-1)!.lane, 'integration');
    const qaCalls = f.fake.calls.filter(c => c.role === 'qa'
      && section<{ scope: string }>(c, 'Run context').scope === 'integration');
    assert.equal(qaCalls.length, testFailure ? 1 : 2);
    assert.ok(f.fake.calls.some(c => c.role === 'wikiAuthor'));
  });
}
test('동시 FIX 승인에도 전역 FIX/QA id와 레인 todo는 겹치지 않는다', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  f.control.fails = { a: 1, b: 1 };
  f.control.fixBarrier = barrier(2);
  const { code, dir } = await f.start();
  assert.equal(code, 0);
  const output: Plan = JSON.parse(await readFile(join(dir, '01-planning/plan.json'), 'utf8'));
  assert.deepEqual(output.todos.filter(todo => todo.id.startsWith('FIX')).map(todo => todo.id),
    ['FIX-001', 'FIX-002']);
  assert.equal(new Set(output.qaScenarios.map(s => s.id)).size, output.qaScenarios.length);
  for (const lane of ['a', 'b']) {
    const todos = output.todos.filter(todo => todo.lane === lane);
    const text = await readFile(join(dir, `02-development/${lane}/todo.md`), 'utf8');
    assert.ok(todos.every(todo => todo.approved && text.includes(`[x] ${todo.id}`)));
    assert.ok(await readFile(join(dir, `01-planning/fix/${lane}-1/round-01.author.json`)));
  }
  const events = await readEvents(dir);
  assert.equal(events.filter(e => e.type === 'renumber' && e.message === 'FIX-001 → FIX-002').length, 1);
  assert.ok(!events.some(e => e.type === 'renumber' && e.message === 'FIX-001 → FIX-001'));
});
test('레인 SETUP 실패는 다른 레인 완료 후 재실행, worktree 복구', async t => {
  const command = 'case "$PWD" in */lane-a) test -f "$PWD/../../../../allow-a";; *) true;; esac';
  const f = await fixture(t, { setupCommand: command });
  const { code, dir, id } = await f.start();
  assert.equal(code, 20);
  const state = await readState(dir);
  assert.equal(state.pending[0].stage, 'SETUP');
  assert.equal(state.pending[0].lane, 'a');
  assert.equal(state.lanes[1].status, 'DONE');
  await writeFile(join(f.cwd, 'allow-a'), '허용');
  await writeFile(join(state.lanes[0].worktree, 'base'), '더러운 파일');
  await writeFile(join(state.lanes[0].worktree, 'untracked'), '부산물');
  assert.equal(await f.resume(id, { lane: 'a', answer: '설정 수정' }), 0);
  assert.equal(await readFile(join(state.lanes[0].worktree, 'base'), 'utf8'), 'base');
  await assert.rejects(readFile(join(state.lanes[0].worktree, 'untracked')));
  assert.ok(await readFile(join(dir, '02-development/a/setup-2.log')));
});
test('integration QA Pending 답변은 integration decisions에 저장', async t => {
  const f = await fixture(t, { maxQaRollbacks: 1 });
  f.control.fails.integration = 2;
  const { code, dir, id } = await f.start();
  assert.equal(code, 20);
  const state = await readState(dir);
  assert.equal(state.pending[0].lane, 'integration');
  assert.equal(state.pending[0].stage, 'INTEGRATION_QA');
  const first = await readFile(join(dir, '01-planning/fix/integration-1/round-01.author.json'), 'utf8');
  f.control.fails.integration = 1;
  assert.equal(await f.resume(id, { lane: 'integration', answer: '다시 관찰' }), 0);
  const finished = await readState(dir);
  assert.deepEqual(finished.integration!.decisions, ['다시 관찰']);
  assert.equal(await readFile(join(dir, '01-planning/fix/integration-1/round-01.author.json'), 'utf8'), first);
  assert.ok(await readFile(join(dir, '02-development/integration/fix-2/round-01.author.json')));
  assert.ok(f.fake.calls.filter(c => c.role === 'qa').at(-1)!.prompt.includes('1. 다시 관찰'));
});
test('레인 포트 슬롯 a=1, b=2, integration=0 및 QA attempt마다 통합 테스트', async t => {
  const f = await fixture(t, { testCommand: 'echo integration-test' });
  const path = join(f.cwd, 'agent-workflow.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.app = { startCommand: 'true', readyUrl: 'http://127.0.0.1:{port}/' };
  await writeFile(path, JSON.stringify(config));
  const slots: number[] = [];
  f.deps.appRunner = {
    ...appRunner, portForSlot: async slot => { slots.push(slot); return 4100 + slot; },
    startApp: async () => ({ pid: 123 }), stopApp: async () => {},
  };
  f.control.qaRetry = true;
  const { code, dir } = await f.start();
  assert.equal(code, 0);
  assert.deepEqual(slots.sort(), [0, 0, 1, 2]);
  for (const attempt of ['01', '02']) {
    assert.ok((await readFile(join(dir,
      `03-qa/integration/attempt-${attempt}/evidence/integration-tests.log`), 'utf8')).includes('integration-test'));
  }
});
test('parallel plan 런은 레인 생성 없이 완료되고 --mode full로 시작한다', async t => {
  const f = await fixture(t, { mode: 'plan' });
  const { code, dir, id } = await f.start();
  assert.equal(code, 0);
  const planned = await readState(dir);
  assert.equal(planned.parallel, true);
  assert.ok(planned.lanes.every(lane => !lane.setupDone && lane.status === 'ACTIVE'));
  assert.ok(!f.fake.calls.some(call => call.role === 'devAuthor'));
  for (const lane of planned.lanes) await assert.rejects(readFile(join(lane.worktree, '.git')));
  f.control.devBarrier = barrier(2);
  assert.equal(await f.resume(id, { mode: 'full' }), 0);
  assert.equal((await readState(dir)).integration!.status, 'DONE');
});
test('parallel G2 실패는 기획 검수 전에 GATE-LANES 반려', async t => {
  const f = await fixture(t, { maxReviewRounds: 1 });
  f.deps.clientFor = () => ({ async run(call) {
    const result = await f.fake.run(call);
    if (call.role === 'planningAuthor') {
      (result.output as { lanes: { ownedPaths: string[] }[] }).lanes[0].ownedPaths = [];
    }
    return result;
  } });
  const { code, dir } = await f.start();
  assert.equal(code, 20);
  const issues = JSON.parse(await readFile(join(dir, '01-planning/round-01.gate.json'), 'utf8'));
  assert.ok(issues.some((issue: { id: string }) => issue.id === 'GATE-LANES'));
  assert.ok(!f.fake.calls.some(call => call.role === 'planningReviewer'));
});
test('한 레인 failed와 다른 수동 Pending을 함께 재개하고 종료 코드 1을 우선한다', async t => {
  const f = await fixture(t);
  let fail = true;
  f.control.blocked.b = 'permission_full';
  f.deps.clientFor = () => ({ async run(call) {
    if (call.role === 'devAuthor' && section<{ lane: string }>(call, 'Run context').lane === 'a' && fail) {
      return {
        output: null, exitCode: 1, timedOut: false, durationMs: 0, rateLimited: false,
        resetAt: null, sessionId: null, error: '중단',
      };
    }
    return f.fake.run(call);
  } });
  const { code, dir, id } = await f.start();
  assert.equal(code, 1);
  assert.equal((await readState(dir)).pending.length, 2);
  fail = false;
  delete f.control.blocked.b;
  assert.equal(await f.resume(id, { lane: 'b', answer: '재개' }), 0);
});

test('두 레인 한도: 늦은 resetAt +2분 단일 예약, resume 해제와 재예약', async t => {
  const f = await fixture(t);
  const limited = fakeClient([
    { rateLimited: true, resetAt: '2026-10-08T00:00:00Z' },
    { rateLimited: true, resetAt: '2026-10-08T01:00:00Z' },
    { rateLimited: true, resetAt: '2026-10-09T02:00:00Z' },
    { rateLimited: true, resetAt: '2026-10-09T03:00:00Z' },
  ]);
  f.deps.clientFor = () => ({ run: call => call.role === 'devAuthor' ? limited.run(call) : f.fake.run(call) });
  const scheduled: string[] = [];
  const canceled: number[] = [];
  f.deps.atAvailable = async () => true;
  f.deps.scheduleResume = async options => {
    scheduled.push(options.at.toISOString());
    return { atJobId: 12 + scheduled.length, at: options.at.toISOString() };
  };
  f.deps.cancelResume = async id => { canceled.push(id); };
  const { code, dir, id } = await f.start();
  assert.equal(code, 22);
  assert.equal((await readState(dir)).pending.length, 2);
  assert.deepEqual(scheduled, ['2026-10-08T01:02:00.000Z']);
  assert.deepEqual((await readState(dir)).scheduledResume, { atJobId: 13, at: scheduled[0] });
  const before = await readState(dir);
  for (const args of [
    { lane: 'missing' }, { lane: 'missing', answer: '진행' },
    { answer: '진행' }, { grant: 'network' as const }, { mode: 'full' as const },
  ]) {
    assert.equal(await resume({ command: 'resume', workspace: before.workspace, runId: id, ...args }, f.deps), 2);
    assert.deepEqual(canceled, []);
    assert.deepEqual(await readState(dir), before);
  }
  assert.equal(await f.resume(id), 22);
  assert.deepEqual(canceled, [13]);
  assert.deepEqual(scheduled, ['2026-10-08T01:02:00.000Z', '2026-10-09T03:02:00.000Z']);
  assert.deepEqual((await readState(dir)).scheduledResume, { atJobId: 14, at: scheduled[1] });
  assert.equal((await readEvents(dir)).filter(e => e.type === 'schedule').length, 2);
});
