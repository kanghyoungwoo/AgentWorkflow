import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnProcess, resolveExecutable, killAllChildren } from '../src/clients/spawn.ts';

async function temp(t: import('node:test').TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aw-spawn-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test('stdin, 원문 파일 저장과 종료 코드', async t => {
  const cwd = await temp(t);
  const prompt = '한국어\n"$`' + 'x'.repeat(150000);
  const result = await spawnProcess({
    command: process.execPath,
    args: ['-e', "process.stdin.pipe(process.stdout);process.stderr.write('error\\n');process.exitCode=7"],
    cwd, stdin: prompt, timeoutMs: 5000, stdoutPath: join(cwd, 'out'), stderrPath: join(cwd, 'err'),
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.ok(result.durationMs >= 0);
  assert.equal(await readFile(join(cwd, 'out'), 'utf8'), prompt);
  assert.equal(await readFile(join(cwd, 'err'), 'utf8'), 'error\n');
});
async function stopped(pid: number): Promise<boolean> {
  try {
    // Linux의 좀비는 종료됐지만 부모가 수거하기 전까지 pid가 남는다.
    const status = await readFile(`/proc/${pid}/stat`, 'utf8');
    return status.slice(status.lastIndexOf(')') + 2).startsWith('Z');
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return true;
    throw error;
  }
}
test('타임아웃은 SIGTERM을 무시하는 손자도 종료한다', async t => {
  const cwd = await temp(t);
  const childScript = "process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)";
  const script = `const {spawn}=require('node:child_process');
    spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:['ignore',1,2]});
    setInterval(()=>{},1000);`;
  const result = await spawnProcess({
    command: process.execPath, args: ['-e', script], cwd, stdin: '', timeoutMs: 700,
    stdoutPath: join(cwd, 'out'), stderrPath: join(cwd, 'err'),
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGTERM');
  const pid = Number((await readFile(join(cwd, 'out'), 'utf8')).trim());
  assert.ok(pid > 0);
  for (let n = 0; n < 20 && !await stopped(pid); n++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(await stopped(pid), true);
});
test('killAllChildren은 추적한 프로세스를 종료한다', async t => {
  const cwd = await temp(t);
  const running = spawnProcess({
    command: process.execPath, args: ['-e', 'console.log(process.pid);setInterval(()=>{},1000)'],
    cwd, stdin: '', timeoutMs: 10000, stdoutPath: join(cwd, 'out'), stderrPath: join(cwd, 'err'),
  });
  for (let n = 0; n < 100; n++) {
    if (await readFile(join(cwd, 'out'), 'utf8').catch(() => '')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await killAllChildren();
  const result = await running;
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.timedOut, false);
});
test('PATH 검색은 파일과 실행 권한을 검사한다', async t => {
  const cwd = await temp(t);
  t.mock.method(process, 'cwd', () => cwd);
  const previous = process.env.PATH;
  process.env.PATH = cwd;
  t.after(() => { process.env.PATH = previous; });
  assert.equal(await resolveExecutable('aw-does-not-exist'), null);
  await writeFile(join(cwd, 'tool'), 'test');
  assert.equal(await resolveExecutable('tool'), null);
  await chmod(join(cwd, 'tool'), 0o755);
  assert.equal(await resolveExecutable('tool'), join(cwd, 'tool'));
  await mkdir(join(cwd, 'directory'));
  assert.equal(await resolveExecutable('directory'), null);
});
test('없는 실행 파일은 거부되며 raw 파일은 닫힌다', async t => {
  const cwd = await temp(t);
  await assert.rejects(spawnProcess({
    command: join(cwd, 'missing'), args: [], cwd, stdin: '', timeoutMs: 1000,
    stdoutPath: join(cwd, 'out'), stderrPath: join(cwd, 'err'),
  }), { code: 'ENOENT' });
});

test('stdoutPath와 stderrPath가 같으면 두 출력을 한 파일에 저장한다', async t => {
  const cwd = await temp(t);
  const logPath = join(cwd, 'combined.log');
  await writeFile(logPath, '이전 로그');
  const result = await spawnProcess({
    command: 'sh', args: ['-c', 'printf "stdout\\n"; printf "stderr\\n" >&2; printf "last\\n"'],
    cwd, stdin: '', timeoutMs: 1000, stdoutPath: logPath, stderrPath: logPath,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(await readFile(logPath, 'utf8'), 'stdout\nstderr\nlast\n');
});
