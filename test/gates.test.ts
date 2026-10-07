import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Lane, PlanAuthorOutput, QaReport, WikiAuthorOutput } from '../src/types.ts';
import {
  gateEvidence, gateItems, gateLanes, gateOwned, gateQaReport, gateReq, gateTests, gateWikiScope, lanesOverlap,
} from '../src/engine/gates.ts';
import { killAllChildren } from '../src/clients/spawn.ts';
import { commitAll } from '../src/git.ts';
import { defect, dev, plan, repo, report } from './engine-fixtures.ts';

const initial = {
  mode: 'initial', reqIds: ['REQ-001'], hasApp: false, parallel: false, plan: null, defectIds: [],
} as const;
function reqOptions(mode: 'initial' | 'fix' = 'initial') {
  return { ...initial, mode, reqIds: [...initial.reqIds], defectIds: mode === 'fix' ? ['BUG-001'] : [] };
}
function fix(): PlanAuthorOutput {
  const output = plan();
  output.todos[0].id = 'FIX-001';
  output.todos[0].defectIds = ['BUG-001'];
  output.qaScenarios = [];
  return output;
}
const lane = (id: string, paths = ['src']): Lane => ({ id, title: '레인', ownedPaths: paths, interfaces: '' });
test('G1 초기·fix 정상과 fix에서 기존 계획 id 재사용 허용', () => {
  assert.equal(gateReq(plan(), reqOptions()), null);
  const approved = { summary: '', todos: [], qaScenarios: plan().qaScenarios, lanes: null };
  const output = fix();
  output.qaScenarios = plan().qaScenarios;
  assert.equal(gateReq(output, { ...reqOptions('fix'), plan: approved }), null);
});
const reqCases: Array<[string, (output: PlanAuthorOutput) => void]> = [
  ['TODO 형식', p => { p.todos[0].id = 'DEV-1'; }],
  ['QA 형식', p => { p.qaScenarios[0].id = 'QA-1'; }],
  ['REQ 누락', p => { p.todos = []; }],
  ['TODO 모르는 REQ', p => { p.todos[0].reqIds.push('REQ-999'); }],
  ['QA 모르는 REQ', p => { p.qaScenarios[0].reqIds.push('REQ-999'); }],
  ['TODO 중복', p => { p.todos.push(structuredClone(p.todos[0])); }],
  ['QA 중복', p => { p.qaScenarios.push(structuredClone(p.qaScenarios[0])); }],
  ['browser 앱 없음', p => { p.qaScenarios[0].type = 'browser'; }],
  ['비병렬 lanes', p => { p.lanes = []; }],
  ['비병렬 TODO lane', p => { p.todos[0].lane = 'a'; }],
  ['비병렬 QA lane', p => { p.qaScenarios[0].lane = 'a'; }],
  ['빈 TODO REQ', p => { p.todos[0].reqIds = []; }],
];
for (const [name, change] of reqCases) {
  test(`G1 초기 실패: ${name}`, () => {
    const output = plan();
    change(output);
    const issue = gateReq(output, reqOptions());
    assert.equal(issue?.id, 'GATE-REQ');
    assert.equal(issue?.target, 'general');
    assert.ok(issue?.requiredChange);
  });
}
for (const [name, change] of [
  ['TODO 0개', p => { p.todos = []; }],
  ['FIX 형식', p => { p.todos[0].id = 'DEV-001'; }],
  ['결함 미대응', p => { p.todos[0].defectIds = []; }],
  ['모르는 REQ', p => { p.todos[0].reqIds = ['REQ-999']; }],
  ['FIX 중복', p => { p.todos.push(structuredClone(p.todos[0])); }],
  ['lanes 금지', p => { p.lanes = [lane('a')]; }],
  ['lane 금지', p => { p.todos[0].lane = 'a'; }],
  ['QA 형식', p => { p.qaScenarios = [{ ...plan().qaScenarios[0], id: 'QA-1' }]; }],
  ['QA 중복', p => { p.qaScenarios = [plan().qaScenarios[0], plan().qaScenarios[0]]; }],
  ['browser 앱 없음', p => { p.qaScenarios = [{ ...plan().qaScenarios[0], type: 'browser' }]; }],
] satisfies Array<[string, (output: PlanAuthorOutput) => void]>) {
  test(`G1 fix 실패: ${name}`, () => {
    const output = fix();
    change(output);
    assert.ok(gateReq(output, { ...reqOptions('fix'), parallel: true }));
  });
}
test('G1 모든 문제를 나열하고 browser 앱 허용', () => {
  const output = plan();
  output.todos[0].id = 'bad';
  output.todos[0].reqIds = ['unknown'];
  const problem = gateReq(output, reqOptions())!.problem;
  assert.match(problem, /형식/);
  assert.match(problem, /알 수 없는/);
  assert.match(problem, /누락/);
  const browser = plan();
  browser.qaScenarios[0].type = 'browser';
  assert.equal(gateReq(browser, { ...reqOptions(), hasApp: true }), null);
});
function parallel(): PlanAuthorOutput {
  const output = plan();
  output.lanes = [lane('a')];
  output.todos[0].lane = 'a';
  return output;
}
test('G2 정상, QA null 레인 허용', () => {
  assert.equal(gateLanes(parallel(), { maxLanes: 3 }), null);
});
for (const [name, change] of [
  ['레인 없음', p => { p.lanes = null; }],
  ['레인 0개', p => { p.lanes = []; }],
  ['상한 초과', p => { p.lanes = [lane('a'), lane('b'), lane('c'), lane('d')]; }],
  ['id 형식', p => { p.lanes![0].id = 'aa'; }],
  ['id 중복', p => { p.lanes!.push(lane('a')); }],
  ['TODO 없는 레인', p => { p.todos[0].lane = 'b'; }],
  ['TODO null 레인', p => { p.todos[0].lane = null; }],
  ['QA 없는 레인', p => { p.qaScenarios[0].lane = 'b'; }],
  ['ownedPaths 빈 목록', p => { p.lanes![0].ownedPaths = []; }],
] satisfies Array<[string, (output: PlanAuthorOutput) => void]>) {
  test(`G2 실패: ${name}`, () => {
    const output = parallel();
    change(output);
    assert.equal(gateLanes(output, { maxLanes: 3 })?.id, 'GATE-LANES');
  });
}
for (const path of ['src/*', 'src/?', 'src/[ab]', '/src', 'src/../file', '']) {
  test(`G2 ownedPaths 금지: ${path}`, () => {
    const output = parallel();
    output.lanes![0].ownedPaths = [path];
    assert.ok(gateLanes(output, { maxLanes: 3 }));
  });
}
test('G2 겹침은 다른 레인끼리 구성요소 단위로 판정한다', () => {
  assert.equal(lanesOverlap([lane('a')]), true);
  assert.equal(lanesOverlap([lane('a', ['src']), lane('b', ['src/a'])]), true);
  assert.equal(lanesOverlap([lane('a', ['src/a']), lane('b', ['src'])]), true);
  assert.equal(lanesOverlap([lane('a', ['src']), lane('b', ['src2'])]), false);
  assert.equal(lanesOverlap([lane('a', ['./src/']), lane('b', ['src/a/'])]), true);
  assert.equal(lanesOverlap([lane('a', ['src', 'src/a']), lane('b', ['docs'])]), false);
});
test('G3 집합 일치, 중복과 DONE 완료·증거 검사', () => {
  assert.equal(gateItems(dev(), ['DEV-001']), null);
  assert.ok(gateItems(dev(), []));
  assert.ok(gateItems(dev(), ['DEV-001', 'DEV-002']));
  const duplicate = dev();
  duplicate.items.push(duplicate.items[0]);
  assert.ok(gateItems(duplicate, ['DEV-001']));
  for (const item of [
    { ...dev().items[0], checked: false }, { ...dev().items[0], evidence: null },
    { ...dev().items[0], evidence: { files: [], summary: '' } },
  ]) assert.ok(gateItems({ ...dev(), items: [item] }, ['DEV-001']));
  assert.equal(gateItems({ ...dev(), status: 'BLOCKED', items: [{ ...dev().items[0], evidence: null }] },
    ['DEV-001']), null);
});
test('G4 증거 파일 존재와 단계 변경 포함', async t => {
  const options = await repo(t);
  assert.ok(await gateEvidence(dev(), options));
  const missing = dev();
  missing.items[0].evidence!.files = ['missing'];
  assert.match((await gateEvidence(missing, options))!.problem, /파일 없음/);
  await writeFile(join(options.cwd, 'base'), '변경');
  await commitAll(options.cwd, 'change');
  assert.equal(await gateEvidence(dev(), options), null);
  missing.items[0].evidence!.files = ['base', 'missing'];
  assert.match((await gateEvidence(missing, options))!.problem, /missing/);
});
test('G5 null 명령, 성공, 실패 로그의 마지막 200줄', async t => {
  const { cwd } = await repo(t);
  const options = { cwd, timeoutMs: 1000, logPath: join(cwd, 'tests.log') };
  assert.equal(await gateTests({ ...options, testCommand: null }), null);
  await assert.rejects(readFile(options.logPath), { code: 'ENOENT' });
  assert.equal(await gateTests({ ...options, testCommand: 'printf success' }), null);
  assert.equal(await readFile(options.logPath, 'utf8'), 'success');
  const issue = await gateTests({ ...options, testCommand: 'seq 1 220; echo error >&2; exit 3' });
  assert.equal(issue!.id, 'GATE-TESTS');
  const lines = issue!.problem.split('\n');
  assert.equal(lines.length, 201);
  assert.equal(lines[1], '22');
  assert.equal(lines.at(-1), 'error');
  assert.match(lines[0], /코드 3/);
});
test('G5 타임아웃', async t => {
  const { cwd } = await repo(t);
  const issue = await gateTests({ cwd, testCommand: 'exec sleep 5', timeoutMs: 30,
    logPath: join(cwd, 'tests.log') });
  assert.match(issue!.problem, /타임아웃 true/);
});
test('G7 ownedPaths 구성요소 경계와 한글 파일', async t => {
  const options = await repo(t);
  await mkdir(join(options.cwd, 'src'), { recursive: true });
  await mkdir(join(options.cwd, 'src2'), { recursive: true });
  await writeFile(join(options.cwd, 'src/한글.ts'), '코드');
  await writeFile(join(options.cwd, 'src2/a'), '코드');
  await commitAll(options.cwd, 'files');
  assert.match((await gateOwned({ ...options, ownedPaths: ['./src/'] }))!.problem, /src2\/a/);
  assert.equal(await gateOwned({ ...options, ownedPaths: ['src', 'src2/a'] }), null);
});
test('G8 Wiki 범위, docs 집합, log.md와 한글 경로', async t => {
  const options = { ...await repo(t), wikiDir: 'docs/wiki' };
  await mkdir(join(options.cwd, options.wikiDir), { recursive: true });
  const paths = ['docs/wiki/log.md', 'docs/wiki/검색.md'];
  for (const path of paths) await writeFile(join(options.cwd, path), '문서');
  await commitAll(options.cwd, 'wiki');
  const output: WikiAuthorOutput = { status: 'DONE', blocker: null, responses: [],
    docs: paths.map(path => ({ path, action: 'created', reason: '문서화' })) };
  assert.equal(await gateWikiScope(output, options), null);
  const missing = await gateWikiScope({ ...output, docs: [output.docs[1]] }, options);
  assert.match(missing!.problem, /집합/);
  assert.match(missing!.problem, /log.md/);
  assert.ok(await gateWikiScope({ ...output, docs: [...output.docs, output.docs[0]] }, options));
  await writeFile(join(options.cwd, 'outside'), '범위 밖');
  await commitAll(options.cwd, 'outside');
  assert.match((await gateWikiScope(output, options))!.problem, /범위 밖.*outside/);
});
test('G9 시나리오 집합과 evidence 파일·경로 검사', async t => {
  const { cwd } = await repo(t);
  const qaDir = join(cwd, 'qa');
  await mkdir(qaDir);
  await writeFile(join(qaDir, 'evidence.log'), '증거');
  const options = { scenarioIds: ['QA-001'], qaDir };
  assert.equal(await gateQaReport(report(), options), null);
  assert.ok(await gateQaReport({ ...report(), scenarios: [] }, options));
  assert.ok(await gateQaReport({ ...report(), scenarios: [report().scenarios[0], report().scenarios[0]] }, options));
  assert.ok(await gateQaReport({ ...report(), scenarios: [{ ...report().scenarios[0], id: 'QA-999' }] }, options));
  await symlink(join(cwd, 'base'), join(qaDir, 'link'));
  for (const path of ['../base', join(cwd, 'base'), 'missing', 'link']) {
    const output = report();
    output.scenarios[0].evidence = [path];
    assert.ok(await gateQaReport(output, options), path);
  }
  const empty = report();
  empty.scenarios[0].evidence = [];
  assert.ok(await gateQaReport(empty, options));
  for (const entry of ['exploratory', 'defects'] as const) {
    const output = report();
    if (entry === 'exploratory') {
      output.exploratory = [{ title: '탐색', result: 'PASS', observed: '', evidence: ['missing'] }];
    } else {
      output.status = 'FAIL';
      output.defects = [{ ...defect(), evidence: ['missing'] }];
    }
    assert.match((await gateQaReport(output, options))!, /증거 파일 없음/);
  }
});
test('G9 PASS 쌍방향 조건과 FAIL 결함 필수', async t => {
  const { cwd: qaDir } = await repo(t);
  await writeFile(join(qaDir, 'evidence.log'), '증거');
  const options = { scenarioIds: ['QA-001'], qaDir };
  const bad: QaReport[] = [
    { ...report(), status: 'FAIL' }, { ...report(), status: 'BLOCKED' },
    { ...report(), scenarios: [{ ...report().scenarios[0], result: 'FAIL' }] },
    { ...report(), defects: [defect()] },
    { ...report(), status: 'FAIL', scenarios: [{ ...report().scenarios[0], result: 'FAIL' }] },
  ];
  for (const output of bad) assert.ok(await gateQaReport(output, options));
  assert.equal(await gateQaReport({ ...report(), status: 'FAIL', defects: [defect()] }, options), null);
  assert.equal(await gateQaReport({ ...report(), status: 'BLOCKED',
    scenarios: [{ ...report().scenarios[0], result: 'BLOCKED' }],
    blocker: { kind: 'environment', detail: '접속 불가' } }, options), null);
});

test('G1 형식과 중복 문제는 해당 id를 모두 식별한다', () => {
  const output = plan();
  output.todos[0].id = 'DEV-1';
  output.todos.push({ ...output.todos[0], id: 'X-002' });
  output.qaScenarios[0].id = 'QA-1';
  let problem = gateReq(output, reqOptions())!.problem;
  assert.match(problem, /TODO id 형식 오류: DEV-1, X-002/);
  assert.match(problem, /시나리오 id 형식 오류: QA-1/);
  output.todos = [plan().todos[0], plan().todos[0]];
  output.qaScenarios = [plan().qaScenarios[0], plan().qaScenarios[0]];
  problem = gateReq(output, reqOptions())!.problem;
  assert.match(problem, /id 중복: DEV-001, QA-001/);
});
test('G2 레인 형식과 중복 문제는 해당 id를 식별한다', () => {
  const output = parallel();
  output.lanes = [lane('z'), lane('a'), lane('a')];
  const problem = gateLanes(output, { maxLanes: 3 })!.problem;
  assert.match(problem, /레인 id 형식 오류: z/);
  assert.match(problem, /레인 id 중복: a/);
});
test('G3 빠진 대상, 남는 항목과 중복을 구분한다', () => {
  const output = dev();
  output.items[0].id = 'DEV-009';
  output.items.push(output.items[0]);
  const problem = gateItems(output, ['DEV-002'])!.problem;
  assert.match(problem, /items에 없는 대상: DEV-002/);
  assert.match(problem, /대상이 아닌 항목.*DEV-009/);
  assert.match(problem, /items 중복: DEV-009/);
});
test('G4 절대 경로, 상위 경로와 worktree 밖 심볼릭 링크를 차단한다', async t => {
  const options = await repo(t);
  await writeFile(join(options.cwd, 'base'), '변경');
  await commitAll(options.cwd, 'change');
  await symlink('/etc/hostname', join(options.cwd, 'link'));
  for (const path of ['/etc/hostname', '../x', 'link']) {
    const output = dev();
    output.items[0].evidence!.files = ['base', path];
    const problem = (await gateEvidence(output, options))!.problem;
    assert.ok(problem.includes(`worktree 밖 증거: ${path}`), problem);
  }
  await symlink(join(options.cwd, 'base'), join(options.cwd, 'inside'));
  const output = dev();
  output.items[0].evidence!.files = ['base', 'inside'];
  assert.equal(await gateEvidence(output, options), null);
});
test('G5 실행 중인 테스트도 killAllChildren으로 종료한다', async t => {
  const { cwd } = await repo(t);
  const logPath = join(cwd, 'tests.log');
  const running = gateTests({ cwd, testCommand: 'echo ready; exec sleep 30', timeoutMs: 10000, logPath });
  t.after(() => killAllChildren());
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if ((await readFile(logPath, 'utf8').catch(() => '')).includes('ready')) {
      ready = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(ready);
  await killAllChildren();
  const problem = (await running)!.problem;
  assert.match(problem, /테스트 실패/);
  assert.match(problem, /타임아웃 false/);
});
test('G9 증거 누락은 시나리오·탐색·결함을 식별한다', async t => {
  const { cwd: qaDir } = await repo(t);
  const output = report();
  output.status = 'FAIL';
  output.scenarios[0].evidence = [];
  output.exploratory = [{ title: '잘못된 입력 탐색', result: 'FAIL', observed: '', evidence: [] }];
  output.defects = [{ ...defect(), evidence: [] }];
  const problem = (await gateQaReport(output, { scenarioIds: ['QA-001'], qaDir }))!;
  assert.match(problem, /QA-001: 증거가 1개 이상/);
  assert.match(problem, /잘못된 입력 탐색: 증거가 1개 이상/);
  assert.match(problem, /BUG-001: 증거가 1개 이상/);
});
