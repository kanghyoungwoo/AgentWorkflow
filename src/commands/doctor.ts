import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { loadConfig } from '../config.ts';
import { claudeClient } from '../clients/claude.ts';
import { codexClient } from '../clients/codex.ts';
import { resolveExecutable, spawnProcess } from '../clients/spawn.ts';
import type { AgentClient } from '../clients/index.ts';
import type { CommandLine } from '../cli.ts';
import type { ExitCode, WorkspaceConfig } from '../types.ts';

export type Check = { name: string; status: 'ok' | 'warn' | 'fail'; detail: string };
export type CommandResult = { exitCode: number | null; stdout: string; stderr: string };
export type DoctorDependencies = {
  execute: (command: string, args: string[], cwd: string) => Promise<CommandResult>;
  resolve: (name: string) => Promise<string | null>;
  launchBrowser: () => Promise<void>;
  claudeClient: AgentClient;
  codexClient: AgentClient;
  nodeVersion: string;
  print: (text: string) => void;
};
async function execute(command: string, args: string[], cwd: string): Promise<CommandResult> {
  const dir = await mkdtemp(join(tmpdir(), 'aw-doctor-command-'));
  try {
    const result = await spawnProcess({
      command, args, cwd, stdin: '', timeoutMs: 30000,
      stdoutPath: join(dir, 'out'), stderrPath: join(dir, 'err'),
    });
    return {
      exitCode: result.timedOut ? null : result.exitCode,
      stdout: await readFile(join(dir, 'out'), 'utf8'), stderr: await readFile(join(dir, 'err'), 'utf8'),
    };
  } catch {
    return { exitCode: null, stdout: '', stderr: '명령을 실행할 수 없습니다.' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const defaults: DoctorDependencies = {
  execute, resolve: resolveExecutable, claudeClient, codexClient, nodeVersion: process.versions.node,
  print: text => console.log(text),
  launchBrowser: async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
  },
};
async function deepChecks(
  config: WorkspaceConfig, deps: DoctorDependencies, checks: Check[],
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aw-doctor-deep-'));
  const cwd = join(dir, 'repo');
  try {
    await mkdir(cwd);
    for (const args of [
      ['init'], ['-c', 'user.name=doctor', '-c', 'user.email=doctor@localhost',
        '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--no-verify', '-m', 'doctor'],
    ]) {
      const result = await deps.execute('git', args, cwd);
      if (result.exitCode !== 0) throw new Error('임시 git 저장소를 준비할 수 없습니다.');
    }
    const base = {
      role: 'planningAuthor' as const, profile: 'readonly' as const, grant: null, cwd,
      qaDir: null, model: null, effort: null, timeoutMs: config.limits.stepTimeoutMin * 60000,
    };
    const schema = {
      type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false,
    };
    const ajv = new Ajv();
    const codexRole = Object.values(config.roles).find(role => role.client === 'codex');
    if (codexRole) {
      const v1 = await deps.codexClient.run({
        ...base, model: codexRole.model, effort: codexRole.effort,
        schema, prompt: 'Return {"ok": true}.', rawPrefix: join(dir, 'v1'),
      });
      const valid = !v1.error && !v1.timedOut && v1.exitCode === 0 && ajv.validate(schema, v1.output);
      checks.push({
        name: 'V1', status: valid ? 'ok' : 'fail',
        detail: 'Codex JSON 스키마 출력 검사'
          + (valid ? '' : ` (error: ${v1.error}, exitCode: ${v1.exitCode})`),
      });
    }
    const claudeRole = Object.values(config.roles).find(role => role.client === 'claude');
    if (!claudeRole) return;
    const claudeBase = { ...base, model: claudeRole.model, effort: claudeRole.effort };
    const v3 = await deps.claudeClient.run({
      ...claudeBase, schema, prompt: 'Return {"ok": true}.', rawPrefix: join(dir, 'v3'),
    });
    const v3Valid = !v3.error && v3.exitCode === 0 && ajv.validate(schema, v3.output);
    checks.push({
      name: 'V3', status: v3Valid ? 'ok' : 'fail',
      detail: 'Claude JSON 스키마 출력 검사'
        + (v3Valid ? '' : ` (error: ${v3.error}, exitCode: ${v3.exitCode})`),
    });
    const v4 = await deps.claudeClient.run({
      ...claudeBase, schema, rawPrefix: join(dir, 'v4'),
      prompt: 'Try to write probe.txt in this repository. Return {"ok": true}.',
    });
    const status = await deps.execute('git', ['status', '--porcelain'], cwd);
    const head = await deps.execute('git', ['rev-list', '--count', 'HEAD'], cwd);
    const probeExists = await stat(join(cwd, 'probe.txt')).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
    const valid = !v4.error && v4.exitCode === 0 && ajv.validate(schema, v4.output);
    const untouched = !probeExists && status.exitCode === 0 && !status.stdout.trim()
      && head.exitCode === 0 && head.stdout.trim() === '1';
    checks.push({
      name: 'V4', status: valid && untouched ? 'ok' : 'fail',
      detail: 'readonly 프로필의 파일 쓰기 차단 검사'
        + (valid && untouched ? '' : ` (error: ${v4.error}, exitCode: ${v4.exitCode})`),
    });
    const token = randomUUID();
    const tokenPath = join(cwd, 'diff-token.txt');
    await writeFile(tokenPath, `${token}\n`);
    for (const args of [
      ['add', 'diff-token.txt'], ['-c', 'user.name=doctor', '-c', 'user.email=doctor@localhost',
        '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'diff token'],
    ]) {
      const result = await deps.execute('git', args, cwd);
      if (result.exitCode !== 0) throw new Error('git diff 검사를 준비할 수 없습니다.');
    }
    await writeFile(tokenPath, '');
    const tokenSchema = {
      type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false,
    };
    const diff = await deps.claudeClient.run({
      ...claudeBase, schema: tokenSchema, rawPrefix: join(dir, 'v4-diff'),
      prompt: 'Run `git diff HEAD` with the Bash tool and return the text of the removed line as token.',
    });
    const diffValid = !diff.error && diff.exitCode === 0 && ajv.validate(tokenSchema, diff.output)
      && (diff.output as { token: string }).token === token;
    checks.push({
      name: 'V4 git diff', status: diffValid ? 'ok' : 'warn',
      detail: diffValid ? 'readonly 프로필에서 git diff 결과 확인'
        : `readonly 프로필에서 git diff 결과를 확인하지 못함 (output: ${JSON.stringify(diff.output)}, `
          + `error: ${diff.error}, exitCode: ${diff.exitCode})`,
    });
  } catch (error) {
    checks.push({ name: 'deep', status: 'fail', detail: (error as Error).message });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function doctor(
  options: Extract<CommandLine, { command: 'doctor' }>, overrides: Partial<DoctorDependencies> = {},
): Promise<ExitCode> {
  const deps = { ...defaults, ...overrides };
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], detail: string) => checks.push({ name, status, detail });
  const run = async (command: string, args: string[]) => {
    try {
      return await deps.execute(command, args, options.workspace);
    } catch {
      return { exitCode: null, stdout: '', stderr: '명령을 실행할 수 없습니다.' };
    }
  };
  const [major, minor] = deps.nodeVersion.replace(/^v/, '').split('.').map(Number);
  add('Node', major > 22 || major === 22 && minor >= 18 ? 'ok' : 'fail', `Node ${deps.nodeVersion} (필수 ≥ 22.18)`);
  const git = await deps.resolve('git');
  add('git', git ? 'ok' : 'fail', git ?? 'git 실행 파일이 없습니다.');
  if (git) {
    const repo = await run(git, ['rev-parse', '--is-inside-work-tree']);
    const commit = await run(git, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const valid = repo.exitCode === 0 && repo.stdout.trim() === 'true' && commit.exitCode === 0;
    add('workspace', valid ? 'ok' : 'fail', valid ? '커밋이 있는 git 저장소입니다.' : '커밋이 있는 git 저장소가 아닙니다.');
    if (valid) {
      const status = await run(git, ['status', '--porcelain']);
      add('변경', status.exitCode !== 0 ? 'fail' : status.stdout.trim() ? 'warn' : 'ok',
        status.exitCode !== 0 ? 'git 상태 검사 실패' : status.stdout.trim() ? '커밋 안 된 변경이 있습니다.' : '변경이 없습니다.');
    }
  }
  let config: WorkspaceConfig | undefined;
  try {
    const loaded = await loadConfig(options.workspace);
    config = loaded.config;
    add('설정', loaded.found ? 'ok' : 'warn', loaded.found ? '설정 스키마 통과' : '설정 파일이 없어 기본값을 사용합니다.');
  } catch (error) {
    add('설정', 'fail', (error as Error).message);
  }
  if (config) {
    for (const client of new Set(Object.values(config.roles).map(role => role.client))) {
      const path = await deps.resolve(client);
      add(`${client} 경로`, path ? 'ok' : 'fail', path ?? `${client} 실행 파일이 없습니다.`);
      if (!path) continue;
      const version = await run(path, ['--version']);
      add(`${client} 버전`, version.exitCode === 0 ? 'ok' : 'fail',
        version.exitCode === 0 ? version.stdout.trim() : '버전 확인 실패');
      const auth = await run(path, client === 'codex' ? ['login', 'status'] : ['auth', 'status']);
      let loggedIn = auth.exitCode === 0;
      if (client === 'claude') {
        try {
          loggedIn = loggedIn && JSON.parse(auth.stdout)?.loggedIn === true;
        } catch {
          loggedIn = false;
        }
      }
      add(`${client} 로그인`, loggedIn ? 'ok' : 'fail', loggedIn ? '로그인됨' : '로그인 확인 실패');
    }
    if (config.app) {
      try {
        await deps.launchBrowser();
        add('chromium', 'ok', 'headless 기동 성공');
      } catch {
        add('chromium', 'fail', 'headless 기동 실패');
      }
    }
    if (options.deep) await deepChecks(config, deps, checks);
  }
  const at = await deps.resolve('at');
  add('at', at ? 'ok' : 'warn', at ?? 'at 명령이 없습니다.');
  const atd = await run('systemctl', ['is-active', 'atd']);
  add('atd', atd.exitCode === 0 && atd.stdout.trim() === 'active' ? 'ok' : 'warn',
    atd.exitCode === 0 && atd.stdout.trim() === 'active' ? 'atd 활성' : 'atd 비활성 또는 확인 실패');
  const ok = !checks.some(check => check.status === 'fail');
  deps.print(options.json ? JSON.stringify({ ok, checks })
    : ['검사\t판정\t상세', ...checks.map(check => `${check.name}\t${check.status}\t${check.detail}`)].join('\n'));
  return ok ? 0 : 2;
}
