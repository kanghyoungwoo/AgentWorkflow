import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { buildCodexArgs, codexClient } from '../src/clients/codex.ts';
import type { AgentCall } from '../src/clients/index.ts';

const base: AgentCall = {
  role: 'planningAuthor', profile: 'readonly', grant: null, cwd: '/tmp', prompt: 'prompt',
  schema: { type: 'object' }, qaDir: null, model: null, effort: null, timeoutMs: 5000, rawPrefix: '/tmp/raw',
};
for (const [profile, grant, expected] of [
  ['readonly', null, ['-s', 'read-only']],
  ['write', null, ['-s', 'workspace-write']],
  ['write', 'network', ['-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true']],
  ['write', 'full', ['--dangerously-bypass-approvals-and-sandbox']],
  ['qa', null, ['-s', 'workspace-write']],
] as const) {
  for (const model of [null, 'custom']) {
    for (const effort of [null, 'high'] as const) {
      test(`Codex argv: ${profile}/${grant}/${model}/${effort}`, () => {
        const call = { ...base, profile, grant, model, effort };
        const args = ['exec', '--json', '-C', call.cwd, ...expected,
          '--output-schema', '/schema.json', '-o', '/last.json'];
        if (model !== null) args.push('-m', model);
        if (effort !== null) args.push('-c', `model_reasoning_effort=${effort}`);
        assert.deepEqual(buildCodexArgs(call, '/schema.json', '/last.json'), [...args, '-']);
      });
    }
  }
}
test('grant는 write에만 적용하며 QA cwd는 호출자가 준 값을 쓴다', () => {
  for (const profile of ['readonly', 'qa'] as const) {
    const call = { ...base, profile, cwd: '/tmp/qa', qaDir: '/tmp/other' };
    const args = buildCodexArgs(call, '/schema', '/last');
    for (const grant of ['full', 'network'] as const) {
      assert.deepEqual(buildCodexArgs({ ...call, grant }, '/schema', '/last'), args);
    }
    assert.equal(args[3], '/tmp/qa');
  }
});
async function fixture(t: import('node:test').TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'aw-codex-'));
  const previous = process.env.PATH;
  t.after(async () => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(cwd, { recursive: true, force: true });
  });
  process.env.PATH = `${cwd}:${previous ?? ''}`;
  const executable = join(cwd, 'codex');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const last = args[args.indexOf('-o') + 1];
const schema = args[args.indexOf('--output-schema') + 1];
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  if (input !== 'no-session') {
    console.log('ignored non-JSON line');
    console.log(JSON.stringify({type: 'thread.started', thread_id: 'first-thread'}));
    console.log(JSON.stringify({type: 'thread.started', thread_id: 'second-thread'}));
  }
  if (input === 'missing') return;
  if (input === 'empty') return fs.writeFileSync(last, '  ');
  if (input === 'malformed') return fs.writeFileSync(last, '{broken');
  if (input.startsWith('limited')) {
    const message = "You've hit your usage limit ... try again in 2 hours 13 minutes";
    if (input === 'limited-stdout') console.log(message);
    else console.error(message);
    if (input === 'limited-nonzero') {
      fs.writeFileSync(last, JSON.stringify({ok: true}));
      process.exitCode = 7;
    }
    if (input === 'limited-timeout') setInterval(() => {}, 1000);
    return;
  }
  if (input === 'nonzero') process.exitCode = 7;
  if (input === 'successful-limit') console.error('usage limit');
  fs.writeFileSync(last, JSON.stringify({prompt: input, cwd: process.cwd(),
    schema: JSON.parse(fs.readFileSync(schema, 'utf8'))}));
});
`);
  await chmod(executable, 0o755);
  return { cwd, executable, call: { ...base, cwd, rawPrefix: join(cwd, 'raw', '0001') } };
}
test('Codex stdin, raw 6종, output과 첫 sessionId를 추출한다', async t => {
  const { cwd, call } = await fixture(t);
  call.prompt = '안녕\nstdin';
  call.rawPrefix = relative(process.cwd(), call.rawPrefix);
  const prefix = resolve(call.rawPrefix);
  const result = await codexClient.run(call);
  assert.deepEqual(result.output, { prompt: call.prompt, cwd, schema: call.schema });
  assert.equal(result.sessionId, 'first-thread');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, null);
  assert.equal(result.rateLimited, false);
  assert.equal(result.resetAt, null);
  assert.deepEqual((await readdir(join(cwd, 'raw'))).sort(), [
    '0001.last.json', '0001.meta.json', '0001.out.jsonl',
    '0001.prompt.md', '0001.schema.json', '0001.stderr.log',
  ]);
  assert.equal(await readFile(`${prefix}.prompt.md`, 'utf8'), call.prompt);
  assert.deepEqual(JSON.parse(await readFile(`${prefix}.schema.json`, 'utf8')), call.schema);
  assert.deepEqual(JSON.parse(await readFile(`${prefix}.last.json`, 'utf8')), result.output);
  assert.match(await readFile(`${prefix}.out.jsonl`, 'utf8'), /thread.started/);
  assert.equal(await readFile(`${prefix}.stderr.log`, 'utf8'), '');
  const meta = JSON.parse(await readFile(`${prefix}.meta.json`, 'utf8'));
  assert.deepEqual(meta, {
    client: 'codex', args: buildCodexArgs(call, `${prefix}.schema.json`, `${prefix}.last.json`), cwd,
    exitCode: 0, durationMs: result.durationMs, sessionId: result.sessionId, rateLimited: false,
  });
  assert.ok(isAbsolute(meta.args[meta.args.indexOf('--output-schema') + 1]));
  assert.ok(!meta.args.includes(call.prompt));
});
for (const [prompt, error] of [
  ['missing', /파일이 없습니다/], ['empty', /파일이 비었습니다/], ['malformed', /파싱/],
] as const) {
  test(`last.json 추출 오류: ${prompt}`, async t => {
    const { call } = await fixture(t);
    await codexClient.run(call);
    const result = await codexClient.run({ ...call, prompt });
    assert.equal(result.output, null);
    assert.equal(result.exitCode, 0);
    assert.match(result.error!, error);
    assert.equal(result.rateLimited, false);
  });
}
for (const prompt of ['limited-stdout', 'limited-stderr', 'limited-nonzero', 'limited-timeout']) {
  test(`한도 메시지와 리셋 시각: ${prompt}`, async t => {
    const { call } = await fixture(t);
    const started = Date.now();
    const result = await codexClient.run({ ...call, prompt, timeoutMs: prompt === 'limited-timeout' ? 500 : 5000 });
    const ended = Date.now();
    assert.equal(result.rateLimited, true);
    assert.ok(result.error);
    const reset = Date.parse(result.resetAt!);
    assert.ok(reset >= started + 133 * 60000 && reset <= ended + 133 * 60000);
    if (prompt === 'limited-nonzero') assert.equal(result.exitCode, 7);
    if (prompt === 'limited-timeout') assert.equal(result.timedOut, true);
    const meta = JSON.parse(await readFile(`${call.rawPrefix}.meta.json`, 'utf8'));
    assert.equal(meta.rateLimited, true);
  });
}
test('세션 이벤트 없음, 비정상 종료와 성공 출력의 한도 단어를 구분한다', async t => {
  const { call } = await fixture(t);
  const noSession = await codexClient.run({ ...call, prompt: 'no-session' });
  assert.equal(noSession.sessionId, null);
  assert.equal(noSession.error, null);
  const nonzero = await codexClient.run({ ...call, prompt: 'nonzero' });
  assert.equal(nonzero.exitCode, 7);
  assert.match(nonzero.error!, /비정상 종료/);
  assert.equal(nonzero.rateLimited, false);
  const successful = await codexClient.run({ ...call, prompt: 'successful-limit' });
  assert.equal(successful.error, null);
  assert.equal(successful.rateLimited, false);
});
test('Codex 실행 파일 없음과 실행 예외를 오류 결과로 보존한다', async t => {
  const { cwd, executable, call } = await fixture(t);
  process.env.PATH = cwd;
  await writeFile(executable, `#!${join(cwd, 'missing-interpreter')}\n`);
  const failed = await codexClient.run(call);
  assert.equal(failed.exitCode, null);
  assert.match(failed.error!, /프로세스를 실행할 수 없습니다: .*ENOENT/);
  await rm(executable);
  const missing = await codexClient.run(call);
  assert.equal(missing.output, null);
  assert.equal(missing.exitCode, null);
  assert.equal(missing.sessionId, null);
  assert.match(missing.error!, /실행 파일을 찾을 수 없습니다/);
});
