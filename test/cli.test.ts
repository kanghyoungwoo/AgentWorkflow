import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseCommandLine, main } from '../src/cli.ts';

for (const argv of [
  ['doctor', '--deep', '--json'], ['run', '--mode', 'plan', '--request-file', 'request.md'],
  ['run', '--mode', 'full', '--request-file', 'r', '--parallel', '--name', 'a-1'],
  ['run', '--mode', 'wiki', '--since', 'HEAD~1'], ['run', '--mode', 'wiki', '--since', 'HEAD', '--request-file', 'r'],
  ['resume', 'id', '--answer', '답변', '--lane', 'a', '--grant', 'network', '--mode', 'full'],
  ['resume', 'id', '--grant', 'full'],
  ['status', 'id', '--json'], ['logs', 'id', '--json', '--seq', '1'], ['list', '--json'], ['watch', 'id'],
  ['cleanup', 'id', '--force'], ['cleanup', '--finished'], ['qa-runtime', 'setup'],
  ['qa-runtime', 'setup', '--slots', '32', '--base-port', '65535'],
]) test(`CLI 정상: ${argv.join(' ')}`, () => {
  assert.equal(parseCommandLine(argv).ok, true);
});
for (const view of ['current', 'timeline', 'decisions', 'plan', 'todo', 'qa']) test(`status view ${view}`, () => {
  assert.equal(parseCommandLine(['status', 'id', '--view', view]).ok, true);
});
test('CLI 기본값과 절대 workspace', () => {
  const doctor = parseCommandLine(['doctor', '--workspace', '.']);
  assert.deepEqual(doctor, { ok: true, command: 'doctor', workspace: resolve('.'), deep: false, json: false });
  const run = parseCommandLine(['run', '--mode', 'full', '--request-file', 'r']);
  assert.equal(run.ok && run.command === 'run' && run.name, 'run');
  const status = parseCommandLine(['status', 'id']);
  assert.equal(status.ok && status.command === 'status' && status.view, 'current');
  assert.deepEqual(parseCommandLine(['qa-runtime', 'setup']), {
    ok: true, command: 'qa-runtime setup', workspace: process.cwd(), slots: 4, basePort: 4100
  });
});
for (const argv of [
  [],
  ['unknown'],
  ['doctor', '--unknown'],
  ['doctor', 'extra'],
  ['run'],
  ['run', '--mode', 'other'],
  ['run', '--mode', 'full'],
  ['run', '--mode', 'plan'], ['run', '--mode', 'wiki'], ['run', '--mode', 'wiki', '--since', 'HEAD', '--parallel'],
  ['run', '--mode', 'full', '--request-file', 'r', '--since', 'HEAD'],
  ['run', '--mode', 'plan', '--request-file', 'r', '--name', '한글'],
  ['run', '--mode', 'full', '--request-file', ''], ['run', '--mode', 'full', '--request-file', 'r', '--name', ''],
  ['resume'],
  ['resume', 'a', 'b'],
  ['resume', 'id', '--answer', ''],
  ['resume', 'id', '--grant', 'bad'],
  ['resume', 'id', '--mode', 'plan'],
  ['status'],
  ['status', 'a', 'b'],
  ['status', 'id', '--view', 'other'],
  ['logs'],
  ['logs', 'id', '--seq', '0'],
  ['logs', 'id', '--seq', '1.5'],
  ['logs', 'id', '--seq', '1e2'],
  ['list', 'id'], ['watch'], ['cleanup'], ['cleanup', 'id', '--finished'], ['cleanup', 'a', 'b'],
  ['qa-runtime'],
  ['qa-runtime', 'other'],
  ['qa-runtime', 'setup', 'extra'],
  ['qa-runtime', 'setup', '--slots', '0'],
  ['qa-runtime', 'setup', '--slots', '33'],
  ['qa-runtime', 'setup', '--base-port', '0'],
  ['qa-runtime', 'setup', '--base-port', '65536'],
  ['doctor', '--workspace', ''],
  ...['run', 'resume', 'watch', 'cleanup', 'qa-runtime'].map(command =>
    command === 'qa-runtime' ? [command, 'setup', '--json'] : [command, '--json'],
  ),
]) test(`CLI 거부: ${argv.join(' ') || '(없음)'}`, () => {
  const result = parseCommandLine(argv);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /인자 오류/);
});
test('main: 인자 오류는 stderr와 2, list 핸들러 등록', async t => {
  const stderr: string[] = [];
  t.mock.method(console, 'error', (text: string) => stderr.push(text));
  assert.equal(await main([]), 2);
  assert.match(stderr.pop()!, /사용법/);
  assert.equal(await main(['run', '--mode', 'full']), 2);
  assert.match(stderr.pop()!, /--request-file.*\n사용법/s);
  t.mock.method(console, 'log', () => {});
  assert.equal(await main(['list', '--workspace', '/tmp/aw-no-runs', '--json']), 0);
});
