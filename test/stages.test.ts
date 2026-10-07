import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assemblePrompt, makeAgentCall, sectionsFor } from '../src/engine/stages.ts';
import type { StageInputs } from '../src/engine/stages.ts';
import { newLoopState, newRunState } from '../src/store/state.ts';
import { loadConfig } from '../src/config.ts';
import { loopState, plan, finding } from './engine-fixtures.ts';
import type { Role } from '../src/types.ts';

const roles: Role[] = [
  'planningAuthor', 'planningReviewer', 'devAuthor', 'devReviewer', 'qa', 'wikiAuthor', 'wikiReviewer',
];
test('프롬프트 8개가 spec 코드 블록과 글자 그대로 일치한다', async () => {
  const spec = await readFile(new URL('../spec.md', import.meta.url), 'utf8');
  const blocks = [...spec.matchAll(/### 10\.[1-8] `([^`]+)`\n\n```markdown\n([\s\S]*?)\n```/g)];
  assert.equal(blocks.length, 8);
  for (const [, name, body] of blocks) {
    assert.equal(await readFile(new URL(`../prompts/${name}`, import.meta.url), 'utf8'), body + '\n');
  }
});
test('모든 역할의 섹션 순서, 생략, 이전 검수 지적과 decisions', () => {
  const loop = loopState();
  loop.lastOutput = plan(); loop.lastIssues = [finding()]; loop.reviewIssues = [finding('R-002')];
  const input: StageInputs = {
    context: {}, request: '요청', requestSummary: '목표', output: plan(),
    targets: [{ id: 'DEV-001', text: '개발' }], approved: [{ id: 'DEV-002', text: '승인' }],
    testResult: '테스트', notes: '노트', planSummary: '계획', changedFiles: ['base'], index: '색인',
    scenarios: [], decisions: ['레인 답변', '루프 답변'],
  };
  const expected: Record<Role, string[]> = {
    planningAuthor: ['Run context', 'request.md', 'Previous output', 'Issues', 'Master decisions'],
    planningReviewer: ['Run context', 'request.md', 'Plan to review', 'Previous issues', 'Master decisions'],
    devAuthor: ['Run context', 'Target items', 'Approved items', 'Issues', 'Previous output', 'Master decisions'],
    devReviewer: ['Run context', 'request.md', 'Target items', 'Test result',
      'Author notes', 'Previous issues', 'Master decisions'],
    qa: ['Run context', 'Scenarios', 'Master decisions'],
    wikiAuthor: ['Run context', 'Request summary', 'Plan summary', 'Changed files', 'Current index.md',
      'Issues', 'Previous output', 'Master decisions'],
    wikiReviewer: ['Run context', 'Request summary', 'Plan summary', 'Changed files', 'Current index.md',
      'Wiki author output', 'Previous issues', 'Master decisions'],
  };
  for (const role of roles) {
    const sections = sectionsFor(role, input, loop);
    assert.deepEqual(sections.map(s => s.title), expected[role]);
    assert.equal(sections.at(-1)!.value, '1. 레인 답변\n2. 루프 답변');
    const empty = sectionsFor(role, { context: {}, approved: [], changedFiles: [] }, newLoopState());
    assert.deepEqual(empty.map(s => s.title), role.endsWith('Reviewer')
      ? ['Run context', 'Previous issues'] : ['Run context']);
  }
  const fix = sectionsFor('planningAuthor', { ...input, plan: {} as never, defects: [] }, loop);
  assert.deepEqual(fix.map(s => s.title), [
    'Run context', 'request.md', 'Previous output', 'Issues', 'Approved plan', 'QA defects', 'Master decisions',
  ]);
});
test('템플릿 치환, JSON 들여쓰기, 2회차 오류와 변수 누락 오류', async () => {
  const prompt = await assemblePrompt('devReviewer', { stageBase: 'abc123' }, [
    { title: 'Run context', value: { lane: 'main' }, json: true },
  ], '스키마 오류');
  assert.ok(prompt.includes('git diff abc123..HEAD'));
  assert.ok(prompt.includes('```json\n{\n  "lane": "main"\n}\n```'));
  assert.ok(prompt.endsWith('## Output validation errors\n\n스키마 오류\n'));
  assert.ok(prompt.indexOf('Rules:') < prompt.indexOf('# Role:'));
  assert.ok(prompt.indexOf('# Role:') < prompt.indexOf('# Inputs'));
  await assert.rejects(assemblePrompt('qa', {}, []), /변수 누락/);
});
test('AgentCall 설정, 프로필, 스키마, cwd와 raw 번호', async () => {
  const { config } = await loadConfig('/tmp');
  const state = newRunState({
    runId: 'test', workspace: '/tmp', mode: 'wiki', parallel: false, baseRef: 'abc', sinceRef: 'abc',
    runBranch: 'aw/test', runWorktree: '/tmp/run',
  });
  const loop = newLoopState(); loop.stageBase = 'abc'; loop.round = 2; loop.grant = 'network';
  config.roles.wikiAuthor.model = 'model'; config.roles.wikiAuthor.effort = 'high';
  const call = await makeAgentCall('wikiAuthor', {
    config, state, runDir: '/tmp/log', loop, lane: null, stage: 'WIKI',
    inputs: { context: { wikiDir: 'docs/wiki' } },
  });
  assert.equal(call.profile, 'write'); assert.equal(call.grant, 'network');
  assert.equal(call.cwd, '/tmp/run'); assert.equal(call.model, 'model'); assert.equal(call.effort, 'high');
  assert.equal(call.timeoutMs, 45 * 60_000); assert.equal(state.seq, 1);
  assert.equal(call.rawPrefix, '/tmp/log/raw/0001-run-WIKI-wikiAuthor-r02');
  assert.ok('properties' in call.schema);
});
