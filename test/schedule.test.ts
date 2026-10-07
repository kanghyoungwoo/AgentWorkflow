import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { atTimestamp, parseAtJobId, scheduleResume, cancelResume, atAvailable, execute } from '../src/schedule.ts';
import { temp } from './inspect-fixtures.ts';

test('atTimestamp 로컬 시각, 초 올림과 월·연 경계', () => {
  assert.equal(atTimestamp(new Date(2026, 9, 7, 15, 2, 0)), '202610071502');
  assert.equal(atTimestamp(new Date(2026, 9, 7, 15, 2, 1)), '202610071503');
  assert.equal(atTimestamp(new Date(2026, 9, 31, 23, 59, 59)), '202611010000');
  assert.equal(atTimestamp(new Date(2026, 11, 31, 23, 59, 1)), '202701010000');
});
test('job 번호 파싱', () => {
  assert.equal(parseAtJobId('warning: commands will be executed using /bin/sh\n'
    + 'job 12 at Wed Oct  7 15:02:00 2026'), 12);
  assert.equal(parseAtJobId('등록 실패'), null);
});
test('가짜 at·atrm 실행 파일, stdin 인용과 실패 무시', async t => {
  const root = await temp(t);
  const ws = join(root, "work space's");
  const dir = join(ws, 'ai-log', 'test');
  await mkdir(dir, { recursive: true });
  const at = join(root, 'at');
  const atrm = join(root, 'atrm');
  const capture = join(root, 'stdin');
  const cancel = join(root, 'cancel');
  const argsPath = join(root, 'args');
  await writeFile(at, `#!/bin/sh\ncat > '${capture}'\nprintf "%s\\n" "$@" > '${argsPath}'\n`
    + 'printf "job 12 at Wed Oct 7\\n" >&2\n', { mode: 0o755 });
  await writeFile(atrm, `#!/bin/sh\nprintf "%s" "$1" > '${cancel}'\nexit 1\n`, { mode: 0o755 });
  const exec = (file: string, args: string[], input?: string) => execute(join(root, file), args, input);
  const date = new Date(2026, 9, 7, 15, 2);
  assert.deepEqual(await scheduleResume({ runId: 'test', workspace: ws, at: date }, exec), {
    atJobId: 12, at: date.toISOString(),
  });
  assert.equal(await readFile(argsPath, 'utf8'), '-t\n202610071502\n');
  const command = await readFile(capture, 'utf8');
  assert.ok(command.includes("work space'\\''s"));
  // 셸이 인용한 인자를 실제 값으로 복원하는지 확인한다.
  const parsed = command.replace(/^.*? resume /, 'printf "%s\\n" ');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('sh', ['-c', parsed]);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(String(code))));
  });
  assert.equal(await readFile(join(dir, 'scheduled-resume.log'), 'utf8'), `test\n--workspace\n${ws}\n`);
  await cancelResume(12, exec);
  assert.equal(await readFile(cancel, 'utf8'), '12');
  await cancelResume(12, async () => { throw new Error('없음'); });
  assert.equal(await scheduleResume({ runId: 'test', workspace: ws, at: date },
    async () => { throw new Error('없음'); }), null);
  assert.equal(await scheduleResume({ runId: 'test', workspace: ws, at: date },
    async () => ({ code: 1, stdout: '', stderr: 'job 12 at tomorrow' })), null);
});
test('atAvailable 실행 파일과 atd 상태', async () => {
  assert.equal(await atAvailable(async file => ({
    code: 0, stdout: file === 'sh' ? '/bin/at\n' : 'active\n', stderr: '',
  })), true);
  assert.equal(await atAvailable(async file => ({
    code: 0, stdout: file === 'sh' ? '/bin/at\n' : 'inactive\n', stderr: '',
  })), false);
  assert.equal(await atAvailable(async () => { throw new Error('없음'); }), false);
});
