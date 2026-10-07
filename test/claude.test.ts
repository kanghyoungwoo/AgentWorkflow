import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClaudeArgs, extractClaudeResult, claudeClient } from '../src/clients/claude.ts';
import { profileFor, clientFor } from '../src/clients/index.ts';
import type { AgentCall } from '../src/clients/index.ts';
import { loadConfig } from '../src/config.ts';

const base: AgentCall = {
  role: 'planningAuthor', profile: 'readonly', grant: null, cwd: '/tmp', prompt: 'prompt',
  schema: { type: 'object' }, qaDir: null, model: null, effort: null, timeoutMs: 5000, rawPrefix: '/tmp/raw',
};
const head = ['-p', '--output-format', 'json', '--json-schema', '{"type":"object"}', '--session-id', 'uuid'];
const tail = ['--strict-mcp-config', '--disable-slash-commands'];
for (const [profile, grant, expected] of [
  ['readonly', null, ['--permission-mode', 'dontAsk', '--allowedTools',
    'Read Grep Glob Bash(git diff *) Bash(git log *) Bash(git show *) Bash(git status *)',
    '--disallowedTools', 'Edit Write NotebookEdit']],
  ['write', null, ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read Grep Glob Edit Write Bash']],
  ['write', 'network', ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read Grep Glob Edit Write Bash']],
  ['write', 'full', ['--permission-mode', 'bypassPermissions', '--allowedTools', 'Read Grep Glob Edit Write Bash']],
  ['qa', null, ['--permission-mode', 'dontAsk', '--allowedTools', 'Read Grep Glob Write Edit Bash',
    '--add-dir', '/tmp/qa']],
] as const) test(`Claude argv: ${profile}/${grant}`, () => {
  assert.deepEqual(buildClaudeArgs({ ...base, profile, grant, qaDir: '/tmp/qa' }, 'uuid'),
    [...head, ...expected, ...tail]);
});
test('model과 effort는 마지막에 추가하고 grant는 write에만 적용한다', () => {
  const plain = buildClaudeArgs(base, 'uuid');
  assert.deepEqual(buildClaudeArgs({ ...base, model: 'custom', effort: 'high' }, 'uuid'),
    [...plain, '--model', 'custom', '--effort', 'high']);
  assert.deepEqual(buildClaudeArgs({ ...base, grant: 'full' }, 'uuid'), plain);
  assert.throws(() => buildClaudeArgs({ ...base, profile: 'qa' }, 'uuid'), /qaDir/);
});
for (const [stdout, output] of [
  ['{"structured_output":{"ok":true},"result":"invalid"}', { ok: true }],
  ['{"result":"{\\"ok\\":true}"}', { ok: true }],
  ['{"structured_output":false}', false],
  ['{"is_error":true,"structured_output":{"ok":true}}', null],
  ['invalid', null], ['{"result":"invalid"}', null], ['{}', null], ['null', null], ['[]', null],
] as const) test(`Claude 결과 추출: ${stdout}`, () => {
  const result = extractClaudeResult(stdout);
  assert.deepEqual(result.output, output);
  assert.equal(result.error === null, output !== null);
});
test('역할 프로필과 클라이언트 선택', async () => {
  for (const role of ['planningAuthor', 'planningReviewer', 'devReviewer', 'wikiReviewer'] as const) {
    assert.equal(profileFor(role), 'readonly');
  }
  assert.equal(profileFor('devAuthor'), 'write');
  assert.equal(profileFor('wikiAuthor'), 'write');
  assert.equal(profileFor('qa'), 'qa');
  const { config } = await loadConfig('/tmp/aw-missing-config-directory');
  assert.throws(() => clientFor(config, 'devAuthor'), /codex 어댑터는 아직 없음/);
  assert.equal(clientFor(config, 'qa'), claudeClient);
});
test('Claude 실행 예외의 원래 메시지를 error에 보존한다', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'aw-claude-error-'));
  const previous = process.env.PATH;
  t.after(async () => {
    process.env.PATH = previous;
    await rm(cwd, { recursive: true, force: true });
  });
  process.env.PATH = cwd;
  const executable = join(cwd, 'claude');
  await writeFile(executable, `#!${join(cwd, 'missing-interpreter')}\n`);
  await chmod(executable, 0o755);
  const result = await claudeClient.run({ ...base, cwd, rawPrefix: join(cwd, 'raw') });
  assert.equal(result.exitCode, null);
  assert.ok(result.error?.startsWith('Claude 프로세스를 실행할 수 없습니다: '));
  assert.ok(result.error?.includes(`spawn ${executable} ENOENT`));
});
test('가짜 Claude의 raw 4개 파일, meta, stdin과 한도 응답', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'aw-claude-'));
  const previous = process.env.PATH;
  t.after(async () => {
    process.env.PATH = previous;
    await rm(cwd, { recursive: true, force: true });
  });
  process.env.PATH = `${cwd}:${previous ?? ''}`;
  const executable = join(cwd, 'claude');
  await writeFile(executable, `#!${process.execPath}
let input='';
process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
  if(input==='limited') {
    console.log(JSON.stringify({is_error:true,result:'Claude AI usage limit reached|1791234567'}));
    console.error('quota');
  } else if(input==='nonzero') {
    console.error('rate limit try again in 15 minutes');
    process.exitCode=7;
  } else if(input==='malformed') {
    console.log('usage limit');
  } else {
    console.log(JSON.stringify({structured_output:{prompt:input,cwd:process.cwd()}}));
  }
});
`);
  await chmod(executable, 0o755);
  const call = { ...base, cwd, prompt: '안녕\nstdin', rawPrefix: join(cwd, 'raw', '0001') };
  const result = await claudeClient.run(call);
  assert.deepEqual(result.output, { prompt: call.prompt, cwd });
  assert.equal(result.exitCode, 0);
  assert.equal(result.error, null);
  assert.equal(result.rateLimited, false);
  assert.match(result.sessionId!, /^[0-9a-f-]{36}$/);
  assert.equal(await readFile(`${call.rawPrefix}.prompt.md`, 'utf8'), call.prompt);
  assert.equal(await readFile(`${call.rawPrefix}.stderr.log`, 'utf8'), '');
  assert.deepEqual(JSON.parse(await readFile(`${call.rawPrefix}.out.json`, 'utf8')).structured_output, result.output);
  const meta = JSON.parse(await readFile(`${call.rawPrefix}.meta.json`, 'utf8'));
  assert.deepEqual(meta, {
    client: 'claude', args: buildClaudeArgs(call, result.sessionId!), cwd,
    exitCode: 0, durationMs: result.durationMs, sessionId: result.sessionId, rateLimited: false,
  });
  const limited = await claudeClient.run({ ...call, prompt: 'limited' });
  assert.equal(limited.rateLimited, true);
  assert.equal(limited.exitCode, 0);
  assert.equal(limited.resetAt, new Date(1791234567000).toISOString());
  assert.ok(limited.error);
  assert.notEqual(result.sessionId, limited.sessionId);
  assert.equal(JSON.parse(await readFile(`${call.rawPrefix}.meta.json`, 'utf8')).rateLimited, true);
  const nonzero = await claudeClient.run({ ...call, prompt: 'nonzero' });
  assert.equal(nonzero.exitCode, 7);
  assert.equal(nonzero.rateLimited, true);
  assert.ok(nonzero.resetAt);
  assert.match(nonzero.error!, /비정상 종료/);
  const malformed = await claudeClient.run({ ...call, prompt: 'malformed' });
  assert.equal(malformed.rateLimited, true);
  assert.equal(malformed.resetAt, null);
  const successful = await claudeClient.run({ ...call, prompt: 'usage limit' });
  assert.equal(successful.rateLimited, false);
  assert.equal(successful.error, null);
  process.env.PATH = cwd + '/missing';
  const missing = await claudeClient.run(call);
  assert.equal(missing.exitCode, null);
  assert.match(missing.error!, /실행 파일을 찾을 수 없습니다/);
});
