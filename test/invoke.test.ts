import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invoke } from '../src/engine/invoke.ts';
import { commitAll, headSha, statusPorcelain } from '../src/git.ts';
import { fakeClient } from './fake-client.ts';
import { call, dev, plan, repo, report, review } from './engine-fixtures.ts';

test('형식 오류 재시도에 오류 전달, 실패 시도에도 afterAttempt 호출', async () => {
  const client = fakeClient([{ output: {} }, { output: review() }]);
  const attempts: Array<[number, string | null]> = [];
  let after = 0;
  const result = await invoke({
    client, schemaName: 'review', guardDir: null,
    makeCall: async (attempt, error) => { attempts.push([attempt, error]); return call(error ?? ''); },
    afterAttempt: async () => { after++; },
  });
  assert.equal(result.kind, 'ok');
  assert.equal(after, 2);
  assert.deepEqual(attempts[0], [1, null]);
  assert.match(attempts[1][1]!, /스키마/);
  assert.equal(client.calls[1].prompt, attempts[1][1]);
});
test('두 프로세스 실패 이유를 보존한다', async () => {
  const result = await invoke({
    client: fakeClient([{ exitCode: 7, error: '첫 오류' }, { timedOut: true, error: '두 번째 오류' }]),
    schemaName: 'review', guardDir: null, makeCall: async () => call(),
  });
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') {
    assert.match(result.detail, /첫 오류/);
    assert.match(result.detail, /두 번째 오류/);
    assert.match(result.detail, /타임아웃 true/);
  }
});
test('사용량 한도는 재시도하지 않으며 afterAttempt와 resetAt을 보존한다', async () => {
  const client = fakeClient([{ rateLimited: true, resetAt: '2026-10-07T12:00:00Z', error: '한도' }]);
  let after = 0;
  const result = await invoke({ client, schemaName: 'review', guardDir: null,
    makeCall: async () => call(), afterAttempt: async () => { after++; } });
  assert.deepEqual(result, { kind: 'rate_limited', resetAt: '2026-10-07T12:00:00Z', detail: '한도' });
  assert.equal(client.calls.length, 1);
  assert.equal(after, 1);
});
for (const output of [
  { ...review(), issues: [{ id: 'R-001', target: 'general', problem: '', requiredChange: '' }] },
  { ...review(), verdict: 'BLOCKED', blocker: null },
  { ...review(), verdict: 'REJECTED' },
  { ...plan(), status: 'BLOCKED' },
  { ...dev(), blocker: { kind: 'other', detail: '' } },
]) {
  test(`출력 일관성 위반: ${JSON.stringify(output)}`, async () => {
    const schemaName = 'verdict' in output ? 'review' : 'todos' in output ? 'plan-author' : 'dev-author';
    const result = await invoke({ client: fakeClient([{ output }, { output }]),
      schemaName, guardDir: null, makeCall: async () => call() });
    assert.equal(result.kind, 'failed');
  });
}
for (const twice of [false, true]) {
  for (const commit of [false, true]) {
    test(`G6 복구: 두 번 위반=${twice}, HEAD 변경=${commit}`, async t => {
      const { cwd, stageBase } = await repo(t);
      const mutate = async () => {
        await writeFile(join(cwd, 'base'), '변경');
        await writeFile(join(cwd, 'extra'), '추가');
        if (commit) await commitAll(cwd, 'agent');
      };
      const client = fakeClient([
        { output: review(), duringCall: mutate },
        { output: review(), duringCall: twice ? mutate : async () => {
          assert.equal(await readFile(join(cwd, 'base'), 'utf8'), 'base');
          assert.equal(await headSha(cwd), stageBase);
        } },
      ]);
      const result = await invoke({ client, schemaName: 'review', guardDir: cwd, makeCall: async () => call() });
      assert.equal(result.kind, twice ? 'failed' : 'ok');
      assert.equal(await headSha(cwd), stageBase);
      assert.equal(await statusPorcelain(cwd), '');
      await assert.rejects(readFile(join(cwd, 'extra')), { code: 'ENOENT' });
    });
  }
}
test('호출 전 테스트 부산물 정리와 앞선 형식 오류 뒤 G6 복구', async t => {
  const { cwd } = await repo(t);
  await writeFile(join(cwd, 'artifact'), '부산물');
  const client = fakeClient([
    { output: {}, duringCall: async () => {
      await assert.rejects(readFile(join(cwd, 'artifact')), { code: 'ENOENT' });
      await writeFile(join(cwd, 'artifact'), '새 부산물');
    } },
    { output: review(), duringCall: async () => {
      await assert.rejects(readFile(join(cwd, 'artifact')), { code: 'ENOENT' });
    } },
  ]);
  assert.equal((await invoke({ client, schemaName: 'review', guardDir: cwd,
    makeCall: async () => call() })).kind, 'ok');
});
test('G9 check 실패도 오류를 전달하고 재시도한다', async () => {
  let checked = 0;
  const errors: Array<string | null> = [];
  const result = await invoke({ client: fakeClient([{ output: report() }, { output: report() }]),
    schemaName: 'qa-report', guardDir: null,
    makeCall: async (_, error) => { errors.push(error); return call(); },
    check: async () => ++checked === 1 ? 'G9 증거 오류' : null });
  assert.equal(result.kind, 'ok');
  assert.match(errors[1]!, /G9 증거 오류/);
});
test('정상 작업 스키마 3종을 검증한다', async () => {
  for (const [schemaName, output] of [
    ['plan-author', plan()], ['dev-author', dev()],
    ['wiki-author', { status: 'DONE', blocker: null, docs: [], responses: [] }],
  ] as const) {
    assert.equal((await invoke({ client: fakeClient([{ output }]), schemaName,
      guardDir: null, makeCall: async () => call() })).kind, 'ok');
  }
});
test('다섯 스키마는 draft-07 strict 객체와 required 전체 속성을 사용한다', async () => {
  function inspect(value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    const schema = value as Record<string, unknown>;
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, Object.keys(schema.properties as object));
    }
    assert.equal('minItems' in schema, false);
    Object.values(schema).forEach(inspect);
  }
  for (const name of ['plan-author', 'review', 'dev-author', 'qa-report', 'wiki-author']) {
    const schema = JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
    inspect(schema);
  }
});
test('알 수 없는 중첩 속성과 enum은 스키마 오류다', async () => {
  const output = dev();
  Object.assign(output.items[0].evidence!, { extra: true });
  const result = await invoke({
    client: fakeClient([{ output }, { output: { ...review(), verdict: 'INVALID' } }]),
    schemaName: 'dev-author', guardDir: null, makeCall: async () => call(),
  });
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.match(result.detail, /additional properties/);
  const invalidEnum = await invoke({
    client: fakeClient([{ output: { ...review(), verdict: 'INVALID' } }, { output: review() }]),
    schemaName: 'review', guardDir: null, makeCall: async () => call(),
  });
  assert.equal(invalidEnum.kind, 'ok');
});
test('G6은 한도 응답에도 파일과 HEAD를 복구하고 재시도하지 않는다', async t => {
  const { cwd, stageBase } = await repo(t);
  const client = fakeClient([{ rateLimited: true, error: '한도', duringCall: async () => {
    await writeFile(join(cwd, 'base'), '변경');
    await commitAll(cwd, 'changed');
  } }]);
  const result = await invoke({ client, schemaName: 'review', guardDir: cwd, makeCall: async () => call() });
  assert.equal(result.kind, 'rate_limited');
  assert.equal(client.calls.length, 1);
  assert.equal(await headSha(cwd), stageBase);
  assert.equal(await statusPorcelain(cwd), '');
});
