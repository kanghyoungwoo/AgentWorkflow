import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';
import type { AgentCall, AgentResult } from '../src/clients/index.ts';
import type { Plan, QaReport, Role } from '../src/types.ts';
import { run, resume } from '../src/commands/run.ts';
import { runPipeline } from '../src/engine/pipeline.ts';
import type { RunDeps } from '../src/commands/run.ts';
import { readEvents } from '../src/store/runlog.ts';
import { readState, writeState } from '../src/store/state.ts';
import { headSha, commitAll } from '../src/git.ts';
import { dev, finding, plan, repo, review } from './engine-fixtures.ts';
import { fakeClient } from './fake-client.ts';
import * as appRunner from '../src/qa/app-runner.ts';

const exec = promisify(execFile);
function section(call: AgentCall, name: string): unknown {
  const begin = call.prompt.indexOf(`## ${name}\n\n`);
  if (begin < 0) return null;
  const value = call.prompt.slice(begin + name.length + 5).split('\n\n## ')[0];
  return value.startsWith('```json\n') ? JSON.parse(value.slice(8).split('\n```')[0]) : value.trim();
}
async function fixture(t: TestContext, options: {
  mode?: 'plan' | 'full' | 'wiki'; limits?: object; setupCommand?: string; testCommand?: string;
} = {}) {
  const { cwd } = await repo(t);
  const roles: Role[] = [
    'planningAuthor', 'planningReviewer', 'devAuthor', 'devReviewer', 'qa', 'wikiAuthor', 'wikiReviewer',
  ];
  const config = {
    roles: Object.fromEntries(roles.map(r => [r, { client: 'claude' }])), limits: options.limits,
    setupCommand: options.setupCommand, testCommand: options.testCommand,
  };
  await writeFile(join(cwd, 'agent-workflow.json'), JSON.stringify(config));
  await commitAll(cwd, 'config');
  const requestFile = join(cwd, 'request.md');
  await writeFile(requestFile, '# 테스트\n\n## 목표\n목표\n\n## 요구사항\n- REQ-001: 구현\n\n## 스펙 외 범위\n- 없음\n');
  await commitAll(cwd, 'request');
  const control = { failQa: 0, reject: 0, blocker: '', blockedRole: 'devAuthor' as Role, emptyQa: false };
  let writes = 0;
  let transport: Partial<AgentResult> | null = null;
  let transportCount = 0;
  const fake = fakeClient(async call => {
    if (control.blocker && call.role === control.blockedRole) {
      const kind = control.blocker;
      const blocker = { kind, detail: '확인이 필요합니다.' };
      if (call.role.endsWith('Reviewer')) {
        return { verdict: 'BLOCKED', summary: '중단', issues: [finding()], blocker };
      }
      if (call.role === 'devAuthor') return { ...dev(), status: 'BLOCKED', blocker };
      return { ...plan(), status: 'BLOCKED', blocker };
    }
    if (call.role === 'planningAuthor') {
      const context = section(call, 'Run context') as { mode: string };
      const output = plan();
      if (control.emptyQa) output.qaScenarios = [];
      if (context.mode === 'fix') {
        output.todos[0].id = 'FIX-001'; output.todos[0].defectIds = ['BUG-001'];
      }
      return output;
    }
    if (call.role.endsWith('Reviewer')) {
      if (call.role === 'planningReviewer' && control.reject-- > 0) return review([finding()]);
      return review();
    }
    if (call.role === 'devAuthor') {
      await writeFile(join(call.cwd, 'base'), `개발 ${++writes}`);
      const targets = section(call, 'Target items') as { id: string }[];
      return { ...dev(), items: targets.map(item => ({ ...dev().items[0], id: item.id })) };
    }
    if (call.role === 'qa') {
      await writeFile(join(call.qaDir!, 'evidence', 'result.log'), '외부 관찰 결과');
      const scenarios = section(call, 'Scenarios') as { id: string }[];
      const fail = control.failQa-- > 0;
      return {
        status: fail ? 'FAIL' : 'PASS', blocker: null, exploratory: [],
        scenarios: scenarios.map(s => ({
          id: s.id, result: fail ? 'FAIL' : 'PASS', observed: '실행 결과', evidence: ['evidence/result.log'],
        })), defects: fail ? [{
          id: 'BUG-001', scenarioId: scenarios[0].id, title: '결함', reproduction: ['실행'],
          expected: '성공', actual: '실패', evidence: ['evidence/result.log'],
        }] : [],
      };
    }
    const wiki = join(call.cwd, 'docs/wiki');
    await mkdir(wiki, { recursive: true });
    await writeFile(join(wiki, 'index.md'), '[로그](log.md)\n');
    await writeFile(join(wiki, 'log.md'), `런 기록 ${++writes}\n`);
    return {
      status: 'DONE', blocker: null, responses: [],
      docs: ['index.md', 'log.md'].map(name => ({ path: `docs/wiki/${name}`, action: 'created', reason: '기록' })),
    };
  });
  const deps: RunDeps = {
    atAvailable: async () => false,
    now: () => new Date('2026-10-07T01:02:03Z'), onEvent: () => {},
    clientFor: () => ({
      async run(call) {
        if (transport && transportCount-- > 0) return {
          output: null, exitCode: 1, timedOut: false, durationMs: 1, rateLimited: false,
          resetAt: null, sessionId: null, error: '실패', ...transport,
        };
        return fake.run(call);
      },
    }),
  };
  const command = {
    command: 'run' as const, workspace: cwd, mode: options.mode ?? 'full',
    requestFile, parallel: false, name: 'test',
  };
  const start = async () => {
    const code = await run(command, deps);
    const [id] = await readdir(join(cwd, 'ai-log'));
    return { code, dir: join(cwd, 'ai-log', id), id };
  };
  return {
    cwd, control, fake, deps, command, start,
    failTransport(value: Partial<AgentResult>, count: number) { transport = value; transportCount = count; },
    resume: (id: string, args: { answer?: string; grant?: 'network' | 'full'; mode?: 'full' } = {}) =>
      resume({ command: 'resume', workspace: cwd, runId: id, ...args }, deps),
  };
}
test('full 완주: DEV/WIKI squash 커밋, 로그와 TODO, 테스트 게이트', async t => {
  const f = await fixture(t, { testCommand: 'printf "test passed\\n"' });
  const { code, dir } = await f.start();
  assert.equal(code, 0);
  const state = await readState(dir);
  assert.equal(state.status, 'DONE'); assert.equal(state.lastExitCode, 0);
  const commits = (await exec('git', ['log', '--format=%s', `${state.baseRef}..HEAD`], {
    cwd: state.runWorktree,
  })).stdout.trim().split('\n');
  assert.deepEqual(commits, [
    `aw(${state.runId}): run WIKI 승인`, `aw(${state.runId}): main DEV 승인 (DEV-001)`,
  ]);
  for (const path of ['01-planning/plan.json', '01-planning/plan.md', '02-development/main/todo.md',
    '03-qa/main/attempt-01/report.json', '03-qa/main/attempt-01/report.md', 'timeline.md']) {
    assert.ok((await readFile(join(dir, path), 'utf8')).length);
  }
  const todo = await readFile(join(dir, '02-development/main/todo.md'), 'utf8');
  assert.ok(todo.includes('검수: 승인 (round 1)'));
  const events = await readEvents(dir);
  assert.ok(events.some(e => e.type === 'tests' && e.verdict === 'PASS'));
  assert.deepEqual(events.filter(e => e.type === 'author').map(e => e.message), [
    '계획', '대상 1개 완료 보고', '문서 2개(created 2, updated 0)',
  ]);
  assert.ok(events.filter(e => e.type === 'gate').every(e => e.message === '통과'));
  assert.ok(events.filter(e => e.type === 'review').every(e => e.message === '검수'));
  assert.equal(events.find(e => e.type === 'qa')!.message, '시나리오 1/1 PASS, 결함 없음');
  const timeline = await readFile(join(dir, 'timeline.md'), 'utf8');
  for (const event of events.filter(e => ['author', 'gate', 'review', 'qa'].includes(e.type))) {
    assert.ok(timeline.includes(event.message));
  }
  assert.ok(events.filter(e => e.type === 'author' || e.type === 'review').every(e => e.role && e.stage));
  assert.ok(f.fake.calls.every(c => c.cwd === state.runWorktree));
  assert.equal(await runPipeline(dir, f.deps), 0);
});
test('plan DONE → resume --mode full', async t => {
  const f = await fixture(t, { mode: 'plan' });
  const { code, dir, id } = await f.start();
  assert.equal(code, 0); assert.equal(f.fake.calls.length, 2);
  assert.equal(await f.resume(id, { mode: 'full' }), 0);
  assert.equal((await readState(dir)).mode, 'full');
  assert.ok((await readEvents(dir)).some(e => e.type === 'mode_switch'));
});
test('QA FAIL 두 번 → FIX 재번호 → fix-N DEV → QA PASS', async t => {
  const f = await fixture(t); f.control.failQa = 2;
  const { code, dir } = await f.start(); assert.equal(code, 0);
  const stored: Plan = JSON.parse(await readFile(join(dir, '01-planning/plan.json'), 'utf8'));
  assert.deepEqual(stored.todos.map(t => t.id), ['DEV-001', 'FIX-001', 'FIX-002']);
  assert.deepEqual(stored.qaScenarios.map(s => s.id), ['QA-001', 'QA-002', 'QA-003']);
  assert.ok(stored.todos.every(t => t.approved && t.lane === 'main'));
  assert.ok(stored.qaScenarios.every(s => s.lane === null));
  for (const n of [1, 2]) assert.ok(await readFile(
    join(dir, `02-development/main/fix-${n}/round-01.author.json`), 'utf8'));
  assert.equal((await readState(dir)).lanes[0].qaAttempt, 3);
  assert.deepEqual((await readEvents(dir)).filter(e => e.type === 'qa').map(e => e.message), [
    '시나리오 0/1 PASS, 결함 BUG-001', '시나리오 0/2 PASS, 결함 BUG-001',
    '시나리오 3/3 PASS, 결함 없음',
  ]);
  const fixCall = f.fake.calls.find(c => c.role === 'planningAuthor' && c.prompt.includes('## QA defects'))!;
  assert.ok(fixCall.prompt.includes('## Approved plan'));
  assert.ok((await readEvents(dir)).some(e => e.type === 'renumber' && e.message === 'FIX-001 → FIX-002'));
});
for (const kind of ['loop_repeat', 'round_cap'] as const) {
  test(`${kind} 답변 뒤 새 라운드에서 재개`, async t => {
    const f = await fixture(t, { limits: kind === 'round_cap' ? { maxReviewRounds: 1 } : {} });
    f.control.reject = 2;
    const { code, dir, id } = await f.start(); assert.equal(code, 20);
    const paused = await readState(dir); assert.equal(paused.pending[0].kind, kind);
    assert.ok((await readEvents(dir)).some(e => e.type === 'review' && e.message === '검수 (R-001)'));
    f.control.reject = 0;
    assert.equal(await f.resume(id), 20);
    assert.equal(await f.resume(id, { answer: '요구를 그대로 구현한다.' }), 0);
    const next = f.fake.calls.filter(c => c.role === 'planningAuthor').at(-1)!;
    assert.ok(next.prompt.includes('## Previous output')); assert.ok(next.prompt.includes('## Issues'));
    assert.ok(next.prompt.includes('1. 요구를 그대로 구현한다.'));
    assert.equal((await readState(dir)).planning.round, paused.planning.round + 1);
  });
}
for (const [kind, exitCode, grant] of [
  ['permission_network', 20, 'network'], ['permission_full', 21, 'full'],
] as const) {
  test(`${kind} 권한 부여가 DEV 호출에 반영되고 루프 종료 시 사라진다`, async t => {
    const f = await fixture(t); f.control.blocker = kind;
    const { code, dir, id } = await f.start(); assert.equal(code, exitCode);
    assert.equal((await readState(dir)).pending[0].kind, kind);
    f.control.blocker = '';
    assert.equal(await f.resume(id, { grant }), 0);
    assert.equal(f.fake.calls.filter(c => c.role === 'devAuthor').at(-1)!.grant, grant);
    assert.equal(f.fake.calls.find(c => c.role === 'wikiAuthor')!.grant, null);
  });
}
test('reviewer_blocked 답변 재개와 planning grant 거부', async t => {
  const f = await fixture(t); f.control.blockedRole = 'planningReviewer'; f.control.blocker = 'spec_ambiguity';
  const { code, dir, id } = await f.start(); assert.equal(code, 20);
  assert.equal((await readState(dir)).pending[0].kind, 'reviewer_blocked');
  assert.equal(await f.resume(id, { grant: 'network' }), 2);
  f.control.blocker = '';
  assert.equal(await f.resume(id, { answer: '요청 기준으로 판정한다.' }), 0);
});
for (const kind of ['failed', 'rate_limited'] as const) {
  test(`${kind} 인자 없는 resume, 마지막 판정 상태 유지`, async t => {
    const f = await fixture(t);
    f.failTransport(kind === 'failed' ? {} : {
      rateLimited: true, resetAt: '2026-10-08T00:00:00Z',
    }, kind === 'failed' ? 2 : 1);
    const { code, dir, id } = await f.start(); assert.equal(code, kind === 'failed' ? 1 : 22);
    const state = await readState(dir);
    assert.equal(state.pending[0].kind, kind);
    if (kind === 'rate_limited') assert.equal(state.pending[0].resetAt, '2026-10-08T00:00:00Z');
    assert.equal(state.planning.judgedRounds, 0);
    assert.equal(await f.resume(id), 0);
    assert.equal((await readState(dir)).planning.round, 2);
    assert.ok(await readFile(join(dir, '01-planning/round-02.author.json'), 'utf8'));
  });
}
test('qa_rollback_cap 답변 뒤 QA부터 재개하고 decisions를 주입한다', async t => {
  const f = await fixture(t, { limits: { maxQaRollbacks: 1 } }); f.control.failQa = 2;
  const { code, dir, id } = await f.start(); assert.equal(code, 20);
  const state = await readState(dir); assert.equal(state.pending[0].kind, 'qa_rollback_cap');
  const before = f.fake.calls.length;
  assert.equal(await f.resume(id, { answer: '관찰 결과를 다시 확인한다.' }), 0);
  assert.equal(f.fake.calls[before].role, 'qa');
  assert.ok(f.fake.calls[before].prompt.includes('1. 관찰 결과를 다시 확인한다.'));
  assert.equal((await readState(dir)).lanes[0].qaRollbacks, 0);
});
test('SETUP environment 뒤 설정 재로드와 재실행', async t => {
  const f = await fixture(t, { setupCommand: 'echo setup-error; exit 1' });
  const { code, dir, id } = await f.start(); assert.equal(code, 20);
  const state = await readState(dir);
  assert.equal(state.pending[0].stage, 'SETUP'); assert.ok(state.pending[0].detail.includes('setup-error'));
  const path = join(f.cwd, 'agent-workflow.json');
  const config = JSON.parse(await readFile(path, 'utf8')); config.setupCommand = 'true';
  await writeFile(path, JSON.stringify(config));
  assert.equal(await f.resume(id, { answer: '설정을 수정했습니다.' }), 0);
  assert.equal((await readState(dir)).setupDone, true);
});
test('RUNNING + 죽은 PID 잠금과 더러운 worktree 복구', async t => {
  const f = await fixture(t, { mode: 'plan' }); const { dir, id } = await f.start();
  const state = await readState(dir); state.mode = 'full'; state.status = 'RUNNING'; state.stage = 'LANES';
  await writeState(dir, state); await writeFile(join(dir, 'run.lock'), '2147483647\n');
  await writeFile(join(state.runWorktree, 'base'), '비정상 종료 변경');
  await writeFile(join(state.runWorktree, 'untracked'), '쓰레기');
  const original = f.deps.clientFor!;
  f.deps.clientFor = (config, role) => {
    const client = original(config, role);
    return { async run(call) {
      if (call.role === 'devAuthor') {
        assert.equal(await readFile(join(call.cwd, 'base'), 'utf8'), 'base');
        await assert.rejects(readFile(join(call.cwd, 'untracked')));
      }
      return client.run(call);
    } };
  };
  assert.equal(await f.resume(id), 0);
});
test('wiki --since 변경 파일과 요청/계획 없음', async t => {
  const f = await fixture(t, { mode: 'wiki' }); const since = await headSha(f.cwd);
  await writeFile(join(f.cwd, 'changed'), '변경'); await commitAll(f.cwd, 'changed');
  const { requestFile: _, ...command } = f.command;
  assert.equal(await run({ ...command, since }, f.deps), 0);
  const call = f.fake.calls.find(c => c.role === 'wikiAuthor')!;
  assert.equal(section(call, 'Changed files'), 'changed');
  assert.equal(section(call, 'Request summary'), '(요청 없음)');
  assert.equal(section(call, 'Plan summary'), '(계획 없음)');
  assert.equal(f.fake.calls.length, 2);
});
test('살아 있는 잠금의 resume은 2이고 state는 보존한다', async t => {
  const f = await fixture(t, { mode: 'plan' }); const { dir, id } = await f.start();
  const before = await readFile(join(dir, 'state.json'), 'utf8');
  await writeFile(join(dir, 'run.lock'), `${process.pid}\n`);
  assert.equal(await f.resume(id, { mode: 'full' }), 2);
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), before);
});
test('빈 시나리오 skip', async t => {
  const f = await fixture(t);
  f.control.emptyQa = true;
  const { code, dir } = await f.start(); assert.equal(code, 0);
  assert.ok(!f.fake.calls.some(c => c.role === 'qa'));
  assert.equal((await readEvents(dir)).find(e => e.type === 'skip')!.message,
    '시나리오 0/0 PASS, 결함 없음 (skipped: QA 시나리오 없음)');
});
test('QA G9 오류 재시도는 새 attempt와 오류 섹션을 사용한다', async t => {
  const f = await fixture(t); let invalid = true;
  const original = f.deps.clientFor!;
  f.deps.clientFor = (config, role) => {
    const client = original(config, role);
    return { async run(call) {
      const result = await client.run(call);
      if (call.role === 'qa' && invalid) {
        invalid = false;
        (result.output as { scenarios: { evidence: string[] }[] }).scenarios[0].evidence = ['missing.log'];
      }
      return result;
    } };
  };
  const { code, dir } = await f.start(); assert.equal(code, 0);
  const calls = f.fake.calls.filter(c => c.role === 'qa');
  assert.equal(calls.length, 2); assert.notEqual(calls[0].qaDir, calls[1].qaDir);
  assert.ok(calls[1].prompt.includes('## Output validation errors'));
  assert.equal((await readState(dir)).lanes[0].qaAttempt, 2);
});
test('QA environment 답변 뒤 레인 decisions를 QA 입력에 전달한다', async t => {
  const f = await fixture(t);
  const path = join(f.cwd, 'agent-workflow.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.app = { startCommand: 'true', readyUrl: 'http://127.0.0.1:{port}/' };
  await writeFile(path, JSON.stringify(config));
  f.deps.appRunner = { ...appRunner, portForSlot: async () => { throw new Error('포트 점유'); } };
  const { code, dir, id } = await f.start(); assert.equal(code, 20);
  assert.equal((await readState(dir)).pending[0].kind, 'environment');
  const event = (await readEvents(dir)).find(e => e.type === 'qa')!;
  assert.equal(event.verdict, 'BLOCKED'); assert.ok(event.message.includes('포트 점유'));
  config.app = null; await writeFile(path, JSON.stringify(config));
  assert.equal(await f.resume(id, { answer: '앱 설정을 정리했다.' }), 0);
  assert.ok(f.fake.calls.find(c => c.role === 'qa')!.prompt.includes('1. 앱 설정을 정리했다.'));
});
test('QA cap을 리셋한 뒤 추가 수정도 fix 로그를 덮어쓰지 않는다', async t => {
  const f = await fixture(t, { limits: { maxQaRollbacks: 1 } }); f.control.failQa = 2;
  const { code, dir, id } = await f.start(); assert.equal(code, 20);
  const first = await readFile(join(dir, '02-development/main/fix-1/round-01.author.json'), 'utf8');
  f.control.failQa = 1;
  assert.equal(await f.resume(id, { answer: '다시 관찰하고 원인을 수정한다.' }), 0);
  assert.equal(await readFile(join(dir, '02-development/main/fix-1/round-01.author.json'), 'utf8'), first);
  assert.ok(await readFile(join(dir, '02-development/main/fix-2/round-01.author.json'), 'utf8'));
  const call = f.fake.calls.find(c => c.role === 'devAuthor' && c.prompt.includes('FIX-002'))!;
  assert.ok(call.prompt.includes('1. 다시 관찰하고 원인을 수정한다.'));
  assert.ok(f.fake.calls.filter(c => c.role === 'planningAuthor').at(-1)!.prompt
    .includes('1. 다시 관찰하고 원인을 수정한다.'));
});
test('앱 기동 실패는 BUG-APP-START report를 쓰고 FIX_PLANNING으로 간다', async t => {
  const f = await fixture(t);
  const path = join(f.cwd, 'agent-workflow.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.app = { startCommand: 'exit 1', readyUrl: 'http://127.0.0.1:{port}/' };
  await writeFile(path, JSON.stringify(config));
  f.deps.appRunner = {
    ...appRunner, portForSlot: async () => 4100,
    startApp: async options => {
      await writeFile(options.logPath, '기동 오류');
      await writeFile(join(options.worktree, 'app-dirty'), '기동 중 변경');
      throw new Error('기동 오류');
    },
  };
  const original = f.deps.clientFor!;
  f.deps.clientFor = (config, role) => ({ async run(call) {
    if (call.role === 'planningAuthor' && call.prompt.includes('## QA defects')) {
      return { ...await original(config, role).run(call), output: {
        ...plan(), status: 'BLOCKED', blocker: { kind: 'environment', detail: '앱 확인 필요' },
      } };
    }
    return original(config, role).run(call);
  } });
  const { code, dir } = await f.start(); assert.equal(code, 20);
  const report = JSON.parse(await readFile(join(dir, '03-qa/main/attempt-01/report.json'), 'utf8'));
  assert.equal(report.defects[0].id, 'BUG-APP-START'); assert.equal(report.status, 'FAIL');
  assert.equal((await readEvents(dir)).find(e => e.type === 'qa')!.message,
    '시나리오 0/1 PASS, 결함 BUG-APP-START (자동 결함: 앱 기동 실패)');
  assert.ok((await readFile(join(dir, '03-qa/main/attempt-01/report.md'), 'utf8')).includes('BUG-APP-START'));
  assert.equal((await readState(dir)).lanes[0].phase, 'FIX_PLANNING');
  await assert.rejects(readFile(join((await readState(dir)).runWorktree, 'app-dirty')));
  assert.ok(!f.fake.calls.some(c => c.role === 'qa'));
});
test('browser 시나리오에서 Chromium이 없으면 앱을 종료하고 environment로 멈춘다', async t => {
  const f = await fixture(t);
  const path = join(f.cwd, 'agent-workflow.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.app = { startCommand: 'server', readyUrl: 'http://127.0.0.1:{port}/health' };
  await writeFile(path, JSON.stringify(config));
  let stopped = 0;
  f.deps.appRunner = {
    ...appRunner, portForSlot: async () => 4100, startApp: async () => ({ pid: 123 }),
    stopApp: async () => { stopped += 1; }, chromiumAvailable: async () => false,
  };
  const original = f.deps.clientFor!;
  f.deps.clientFor = (config, role) => ({ async run(call) {
    const result = await original(config, role).run(call);
    if (role === 'planningAuthor') (result.output as { qaScenarios: { type: string }[] })
      .qaScenarios[0].type = 'browser';
    return result;
  } });
  const { code, dir } = await f.start(); assert.equal(code, 20); assert.equal(stopped, 1);
  assert.equal((await readState(dir)).pending[0].kind, 'environment');
});
test('QA 재시도마다 앱 재기동과 종료, worktree 변조 G6 복구', async t => {
  const f = await fixture(t);
  const path = join(f.cwd, 'agent-workflow.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.app = { startCommand: 'server', readyUrl: 'http://127.0.0.1:{port}/health' };
  await writeFile(path, JSON.stringify(config));
  let started = 0, stopped = 0;
  f.deps.appRunner = {
    ...appRunner, portForSlot: async () => 4100,
    startApp: async () => { started += 1; return { pid: 123 }; },
    stopApp: async () => { stopped += 1; },
  };
  const original = f.deps.clientFor!;
  f.deps.clientFor = (config, role) => ({ async run(call) {
    const result = await original(config, role).run(call);
    if (role === 'qa' && started === 1) await writeFile(join(call.cwd, 'tampered'), 'G6');
    return result;
  } });
  const { code, dir } = await f.start(); assert.equal(code, 0);
  assert.equal(started, 2); assert.equal(stopped, 2);
  const calls = f.fake.calls.filter(c => c.role === 'qa');
  assert.ok(calls[1].prompt.includes('GATE-READONLY'));
  assert.equal((section(calls[0], 'Run context') as { baseUrl: string }).baseUrl, 'http://127.0.0.1:4100');
  await assert.rejects(readFile(join((await readState(dir)).runWorktree, 'tampered')));
});
test('SIGTERM 진행 중 DEV의 WIP 보존, failed 1과 잠금 해제', async t => {
  const f = await fixture(t); let signalled = false;
  const original = f.deps.clientFor!;
  f.deps.clientFor = (config, role) => ({ async run(call) {
    const result = await original(config, role).run(call);
    if (role === 'devAuthor' && !signalled) {
      signalled = true;
      const handler = process.listeners('SIGTERM').at(-1)!;
      handler('SIGTERM');
    }
    return result;
  } });
  const { code, dir, id } = await f.start(); assert.equal(code, 1);
  const state = await readState(dir);
  assert.equal(state.pending[0].stage, 'DEV'); assert.equal(state.pending[0].kind, 'failed');
  assert.equal(await readFile(join(state.runWorktree, 'base'), 'utf8'), '개발 1');
  await assert.rejects(readFile(join(dir, 'run.lock')));
  assert.equal(await f.resume(id), 0);
});
test('DEV rate limit 뒤 WIP 커밋과 stageBase를 보존하여 승인 때 squash한다', async t => {
  const f = await fixture(t); let limited = false;
  const original = f.deps.clientFor!;
  f.deps.clientFor = (config, role) => ({ async run(call) {
    const result = await original(config, role).run(call);
    if (role === 'devAuthor' && !limited) {
      limited = true;
      return { ...result, rateLimited: true, error: '사용량 한도', resetAt: '2026-10-08T00:00:00Z' };
    }
    return result;
  } });
  const { code, dir, id } = await f.start(); assert.equal(code, 22);
  const state = await readState(dir);
  assert.equal(await readFile(join(state.runWorktree, 'base'), 'utf8'), '개발 1');
  assert.equal(state.lanes[0].loop.stageBase, state.baseRef);
  assert.equal(await f.resume(id), 0);
  const log = (await exec('git', ['log', '--format=%s', `${state.baseRef}..HEAD`], {
    cwd: state.runWorktree,
  })).stdout;
  assert.ok(!log.includes('wip')); assert.ok(log.includes('main DEV 승인'));
});

test('DEV 게이트 반려 메시지에는 GATE id와 문제 요지가 남는다', async t => {
  const f = await fixture(t);
  const original = f.deps.clientFor!;
  let incomplete = true;
  f.deps.clientFor = (config, role) => ({ async run(call) {
    const result = await original(config, role).run(call);
    if (role === 'devAuthor' && incomplete) {
      incomplete = false;
      (result.output as { items: { checked: boolean }[] }).items[0].checked = false;
    }
    return result;
  } });
  const { code, dir } = await f.start(); assert.equal(code, 0);
  const event = (await readEvents(dir)).find(e => e.type === 'gate' && e.verdict === 'REJECTED')!;
  const issues = JSON.parse(await readFile(join(dir, '02-development/main/round-01.gate.json'), 'utf8'));
  assert.equal(event.message, `GATE-ITEMS: ${issues[0].problem.split('\n')[0]}`);
});

test('QA 결함 메시지에는 모든 결함 id를 기록한다', async t => {
  const f = await fixture(t); f.control.failQa = 1;
  const original = f.deps.clientFor!;
  f.deps.clientFor = (config, role) => ({ async run(call) {
    const result = await original(config, role).run(call);
    if (role === 'planningAuthor' && call.prompt.includes('## QA defects')) {
      (result.output as ReturnType<typeof plan>).todos[0].defectIds.push('BUG-002');
    }
    if (role === 'qa') {
      const report = result.output as QaReport;
      if (report.status === 'FAIL') report.defects.push({ ...report.defects[0], id: 'BUG-002' });
    }
    return result;
  } });
  const { code, dir } = await f.start(); assert.equal(code, 0);
  assert.equal((await readEvents(dir)).find(e => e.type === 'qa')!.message,
    '시나리오 0/1 PASS, 결함 BUG-001, BUG-002');
});
for (const kind of ['failed', 'rate_limited', 'BLOCKED'] as const) {
  test(`QA ${kind} 메시지는 중단 요지를 한 줄 200자 이하로 기록한다`, async t => {
    const f = await fixture(t);
    const original = f.deps.clientFor!;
    f.deps.clientFor = (config, role) => ({ async run(call) {
      const result = await original(config, role).run(call);
      if (role !== 'qa') return result;
      const detail = '환경 확인 필요\n' + '가'.repeat(201);
      if (kind === 'BLOCKED') {
        const report = result.output as QaReport;
        report.status = 'BLOCKED'; report.scenarios[0].result = 'BLOCKED';
        report.blocker = { kind: 'environment', detail };
        return result;
      }
      return { ...result, exitCode: 1, error: detail, rateLimited: kind === 'rate_limited' };
    } });
    const { code, dir } = await f.start();
    assert.equal(code, kind === 'failed' ? 1 : kind === 'rate_limited' ? 22 : 20);
    const event = (await readEvents(dir)).find(e => e.type === 'qa')!;
    assert.equal(event.verdict, kind);
    assert.ok(event.message.includes('환경 확인 필요'));
    assert.equal(event.message.length, 200); assert.ok(event.message.endsWith('…'));
    assert.ok(!/[\r\n]/.test(event.message));
    if (kind === 'BLOCKED') assert.ok(event.message.startsWith('시나리오 0/1 PASS, 결함 없음'));
  });
}

for (const resetAt of ['2026-10-08T00:00:00Z', null]) {
  test(`한도 예약 불가 기록: resetAt=${resetAt}`, async t => {
    const f = await fixture(t);
    f.failTransport({ rateLimited: true, resetAt }, 1);
    f.deps.scheduleResume = async () => { assert.fail('예약하지 않아야 합니다.'); };
    const { code, dir } = await f.start();
    assert.equal(code, 22);
    assert.equal((await readState(dir)).scheduledResume, null);
    const scheduled = (await readEvents(dir)).find(e => e.type === 'schedule')!;
    assert.ok(scheduled.message.includes(resetAt ? 'at 또는 atd' : '리셋 시각이 없어'));
  });
}
test('at 등록 실패도 기존 한도 종료 코드를 유지', async t => {
  const f = await fixture(t);
  f.failTransport({ rateLimited: true, resetAt: '2026-10-08T00:00:00Z' }, 1);
  f.deps.atAvailable = async () => true;
  f.deps.scheduleResume = async () => null;
  const { code, dir } = await f.start();
  assert.equal(code, 22);
  assert.equal((await readState(dir)).scheduledResume, null);
  assert.ok((await readEvents(dir)).some(e => e.type === 'schedule' && e.message.includes('등록에 실패')));
});

test('resume 설정 로드 실패 시 기존 예약 보존', async t => {
  const f = await fixture(t, { mode: 'plan' });
  const { dir, id } = await f.start();
  const state = await readState(dir);
  state.scheduledResume = { atJobId: 42, at: '2026-10-08T00:00:00Z' };
  await writeState(dir, state);
  const canceled: number[] = [];
  f.deps.cancelResume = async job => { canceled.push(job); };
  await writeFile(join(f.cwd, 'agent-workflow.json'), 'invalid');
  assert.equal(await f.resume(id), 2);
  assert.deepEqual(canceled, []);
  assert.deepEqual((await readState(dir)).scheduledResume, state.scheduledResume);
});
