import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { doctor } from '../src/commands/doctor.ts';
import type { Check, DoctorDependencies } from '../src/commands/doctor.ts';
import { fakeClient } from './fake-client.ts';

async function fixture(t: import('node:test').TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), 'aw-doctor-test-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const roles = Object.fromEntries([
    'planningAuthor', 'planningReviewer', 'devAuthor', 'devReviewer', 'qa', 'wikiAuthor', 'wikiReviewer',
  ].map(role => [role, { client: 'claude' }]));
  await writeFile(join(workspace, 'agent-workflow.json'), JSON.stringify({ roles }));
  const commands: string[] = [];
  let printed = '';
  const deps: DoctorDependencies = {
    nodeVersion: '22.18.0', resolve: async name => `/fake/${name}`,
    execute: async (command, args) => {
      commands.push(`${command} ${args.join(' ')}`);
      let stdout = '';
      if (args.includes('--is-inside-work-tree')) stdout = 'true\n';
      if (args.includes('--verify')) stdout = 'sha\n';
      if (args.includes('--version')) stdout = '1.0\n';
      if (args.includes('auth')) stdout = '{"loggedIn":true}';
      if (args.includes('is-active')) stdout = 'active\n';
      if (args.includes('--count')) stdout = '1\n';
      return { exitCode: 0, stdout, stderr: '' };
    },
    launchBrowser: async () => {}, client: fakeClient(() => ({ ok: true })),
    print: text => { printed = text; },
  };
  const options = { command: 'doctor' as const, workspace, deep: false, json: true };
  return {
    workspace, options, deps, commands,
    report: () => JSON.parse(printed) as { ok: boolean; checks: Check[] }, text: () => printed,
  };
}
test('모든 역할이 Claude면 Codex를 검사하지 않으며 JSON과 종료 코드는 일치한다', async t => {
  const f = await fixture(t);
  assert.equal(await doctor(f.options, f.deps), 0);
  const report = f.report();
  assert.equal(report.ok, true);
  assert.deepEqual(Object.keys(report), ['ok', 'checks']);
  assert.ok(report.checks.every(check => Object.keys(check).join(',') === 'name,status,detail'));
  assert.equal(report.checks.some(check => check.name.includes('codex')), false);
  assert.equal(f.commands.some(command => command.includes('codex')), false);
  assert.ok(f.commands.includes('/fake/claude --version'));
  assert.ok(f.commands.includes('/fake/claude auth status'));
});
test('Claude 로그인 안 됨은 fail과 종료 코드 2', async t => {
  const f = await fixture(t);
  const execute = f.deps.execute;
  f.deps.execute = async (command, args, cwd) => args[0] === 'auth'
    ? { exitCode: 0, stdout: '{"loggedIn":false}', stderr: '' } : execute(command, args, cwd);
  assert.equal(await doctor(f.options, f.deps), 2);
  assert.equal(f.report().ok, false);
  assert.equal(f.report().checks.find(check => check.name === 'claude 로그인')?.status, 'fail');
});
test('at 명령 없음과 atd 비활성은 warn만', async t => {
  const f = await fixture(t);
  f.deps.resolve = async name => name === 'at' ? null : `/fake/${name}`;
  const execute = f.deps.execute;
  f.deps.execute = async (command, args, cwd) => command === 'systemctl'
    ? { exitCode: 3, stdout: 'inactive', stderr: '' } : execute(command, args, cwd);
  assert.equal(await doctor(f.options, f.deps), 0);
  for (const name of ['at', 'atd']) {
    assert.equal(f.report().checks.find(check => check.name === name)?.status, 'warn');
  }
});
test('설정 파일 없음은 기본 역할을 검사하고 Codex 로그인은 종료 코드로 판정한다', async t => {
  const f = await fixture(t);
  await rm(join(f.workspace, 'agent-workflow.json'));
  assert.equal(await doctor(f.options, f.deps), 0);
  assert.equal(f.report().checks.find(check => check.name === '설정')?.status, 'warn');
  assert.ok(f.commands.includes('/fake/codex login status'));
  const execute = f.deps.execute;
  f.deps.execute = async (command, args, cwd) => args[0] === 'login'
    ? { exitCode: 1, stdout: '', stderr: 'logged out' } : execute(command, args, cwd);
  assert.equal(await doctor(f.options, f.deps), 2);
});
test('설정 스키마 위반과 커밋 없는 저장소는 fail', async t => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, 'agent-workflow.json'), '{"unknown":true}');
  const execute = f.deps.execute;
  f.deps.execute = async (command, args, cwd) => args.includes('--verify')
    ? { exitCode: 1, stdout: '', stderr: '' } : execute(command, args, cwd);
  assert.equal(await doctor(f.options, f.deps), 2);
  for (const name of ['설정', 'workspace']) {
    assert.equal(f.report().checks.find(check => check.name === name)?.status, 'fail');
  }
});
test('Node 최소 버전, 변경 경고와 사람용 한국어 표', async t => {
  const f = await fixture(t);
  const execute = f.deps.execute;
  f.deps.execute = async (command, args, cwd) => args.includes('--porcelain')
    ? { exitCode: 0, stdout: ' M file\n', stderr: '' } : execute(command, args, cwd);
  assert.equal(await doctor(f.options, f.deps), 0);
  assert.equal(f.report().checks.find(check => check.name === '변경')?.status, 'warn');
  assert.equal(await doctor(f.options, { ...f.deps, nodeVersion: '22.17.0' }), 2);
  assert.equal(await doctor({ ...f.options, json: false }, f.deps), 0);
  assert.match(f.text(), /^검사\t판정\t상세\n/);
});
test('app이 있을 때만 chromium을 기동하고 실패하면 fail', async t => {
  const f = await fixture(t);
  let launches = 0;
  f.deps.launchBrowser = async () => { launches++; throw new Error('missing browser'); };
  assert.equal(await doctor(f.options, f.deps), 0);
  assert.equal(launches, 0);
  const config = JSON.parse(await readFile(join(f.workspace, 'agent-workflow.json'), 'utf8'));
  await writeFile(join(f.workspace, 'agent-workflow.json'), JSON.stringify({
    ...config, app: { startCommand: 'node app', readyUrl: 'http://localhost:{port}' },
  }));
  assert.equal(await doctor(f.options, f.deps), 2);
  assert.equal(launches, 1);
  assert.equal(f.report().checks.find(check => check.name === 'chromium')?.status, 'fail');
});
test('deep는 임시 저장소의 V3, V4를 검사하고 잘못된 diff 토큰은 warn이다', async t => {
  const f = await fixture(t);
  const calls: string[] = [];
  f.deps.client = fakeClient(async call => {
    calls.push(call.cwd);
    assert.equal(call.profile, 'readonly');
    assert.equal(call.schema && (call.schema as { additionalProperties: boolean }).additionalProperties, false);
    assert.ok(!call.rawPrefix.startsWith(call.cwd + '/'));
    if (call.prompt.includes('git diff HEAD')) return { token: 'wrong-token' };
    assert.deepEqual(call.schema, {
      type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false,
    });
    return { ok: true };
  });
  assert.equal(await doctor({ ...f.options, deep: true }, f.deps), 0);
  assert.equal(calls.length, 3);
  for (const name of ['V3', 'V4']) {
    assert.equal(f.report().checks.find(check => check.name === name)?.status, 'ok');
  }
  assert.equal(f.report().checks.find(check => check.name === 'V1')?.detail, 'M5에서 확인');
  const diffCheck = f.report().checks.find(check => check.name === 'V4 git diff');
  assert.equal(diffCheck?.status, 'warn');
  assert.match(diffCheck!.detail, /readonly 프로필에서 git diff 결과를 확인하지 못함.*wrong-token/);
  await assert.rejects(readFile(join(calls[0], 'diff-token.txt')), { code: 'ENOENT' });
});
test('deep의 diff 토큰은 커밋한 뒤 삭제한 줄에만 남고 일치하는 응답은 ok이다', async t => {
  const f = await fixture(t);
  const execute = f.deps.execute;
  const runGit = promisify(execFile);
  f.deps.execute = async (command, args, cwd) => {
    if (command !== 'git' || cwd === f.workspace) return execute(command, args, cwd);
    const { stdout, stderr } = await runGit(command, args, { cwd });
    return { exitCode: 0, stdout, stderr };
  };
  let diffCalls = 0;
  f.deps.client = fakeClient(async call => {
    if (!call.prompt.includes('git diff HEAD')) return { ok: true };
    diffCalls++;
    assert.equal(call.profile, 'readonly');
    assert.equal(call.prompt,
      'Run `git diff HEAD` with the Bash tool and return the text of the removed line as token.');
    assert.deepEqual(call.schema, {
      type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false,
    });
    assert.equal(await readFile(join(call.cwd, 'diff-token.txt'), 'utf8'), '');
    const { stdout } = await runGit('git', ['diff', 'HEAD'], { cwd: call.cwd });
    const removed = stdout.split('\n').find(line => line.startsWith('-') && !line.startsWith('---'));
    assert.match(removed!, /^-[0-9a-f-]{36}$/);
    return { token: removed!.slice(1) };
  });
  assert.equal(await doctor({ ...f.options, deep: true }, f.deps), 0);
  assert.equal(diffCalls, 1);
  for (const name of ['V3', 'V4', 'V4 git diff']) {
    assert.equal(f.report().checks.find(check => check.name === name)?.status, 'ok');
  }
});
test('deep 호출 실패는 V3와 V4의 detail에 error와 exitCode를 보존한다', async t => {
  const f = await fixture(t);
  const client = fakeClient(() => ({ ok: true }));
  f.deps.client = {
    run: async call => ({ ...await client.run(call), output: null, error: '호출 진단 메시지', exitCode: 7 }),
  };
  assert.equal(await doctor({ ...f.options, deep: true }, f.deps), 2);
  for (const name of ['V3', 'V4']) {
    const check = f.report().checks.find(check => check.name === name);
    assert.equal(check?.status, 'fail');
    assert.match(check!.detail, /error: 호출 진단 메시지, exitCode: 7/);
  }
  const diffCheck = f.report().checks.find(check => check.name === 'V4 git diff');
  assert.equal(diffCheck?.status, 'warn');
  assert.match(diffCheck!.detail, /error: 호출 진단 메시지, exitCode: 7/);
});
test('deep의 스키마 위반과 실제 파일 쓰기는 fail', async t => {
  const f = await fixture(t);
  f.deps.client = fakeClient(async call => {
    if (call.prompt.includes('probe.txt')) {
      await writeFile(join(call.cwd, 'probe.txt'), 'unauthorized');
      return { ok: true };
    }
    return { ok: 'true' };
  });
  assert.equal(await doctor({ ...f.options, deep: true }, f.deps), 2);
  for (const name of ['V3', 'V4']) {
    assert.equal(f.report().checks.find(check => check.name === name)?.status, 'fail');
  }
});
test('Claude 역할이 없으면 deep에서 에이전트를 호출하지 않는다', async t => {
  const f = await fixture(t);
  const config = JSON.parse(await readFile(join(f.workspace, 'agent-workflow.json'), 'utf8'));
  for (const role of Object.keys(config.roles)) config.roles[role].client = 'codex';
  await writeFile(join(f.workspace, 'agent-workflow.json'), JSON.stringify(config));
  f.deps.client = fakeClient(() => { throw new Error('호출 금지'); });
  assert.equal(await doctor({ ...f.options, deep: true }, f.deps), 0);
  assert.equal(f.report().checks.some(check => check.name === 'V3'), false);
});
for (const failure of ['missing', 'version', 'auth-json'] as const) {
  test(`클라이언트 실패: ${failure}`, async t => {
    const f = await fixture(t);
    const execute = f.deps.execute;
    if (failure === 'missing') {
      f.deps.resolve = async name => name === 'claude' ? null : `/fake/${name}`;
    } else {
      f.deps.execute = async (command, args, cwd) => {
        if (failure === 'version' && args[0] === '--version') {
          return { exitCode: 1, stdout: '', stderr: 'failed' };
        }
        if (failure === 'auth-json' && args[0] === 'auth') {
          return { exitCode: 0, stdout: 'invalid JSON', stderr: '' };
        }
        return execute(command, args, cwd);
      };
    }
    assert.equal(await doctor(f.options, f.deps), 2);
    assert.equal(f.report().ok, false);
    if (failure === 'missing') assert.equal(f.commands.some(command => command.includes('claude')), false);
  });
}
