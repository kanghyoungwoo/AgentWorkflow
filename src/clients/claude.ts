import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentCall, AgentClient, AgentResult } from './index.ts';
import { resolveExecutable, spawnProcess } from './spawn.ts';
import { detectRateLimit, parseResetTime } from './rate-limit.ts';

export function buildClaudeArgs(call: AgentCall, sessionId: string): string[] {
  const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(call.schema),
    '--session-id', sessionId];
  if (call.profile === 'readonly') {
    args.push('--permission-mode', 'dontAsk', '--allowedTools',
      'Read Grep Glob Bash(git diff *) Bash(git log *) Bash(git show *) Bash(git status *)',
      '--disallowedTools', 'Edit Write NotebookEdit');
  } else if (call.profile === 'write') {
    args.push('--permission-mode', call.grant === 'full' ? 'bypassPermissions' : 'acceptEdits',
      '--allowedTools', 'Read Grep Glob Edit Write Bash');
  } else {
    if (!call.qaDir) throw new Error('qa 프로필에는 qaDir이 필요합니다.');
    args.push('--permission-mode', 'dontAsk', '--allowedTools', 'Read Grep Glob Write Edit Bash',
      '--add-dir', call.qaDir);
  }
  args.push('--strict-mcp-config', '--disable-slash-commands');
  if (call.model !== null) args.push('--model', call.model);
  if (call.effort !== null) args.push('--effort', call.effort);
  return args;
}
export function extractClaudeResult(stdout: string): { output: unknown | null; error: string | null } {
  try {
    const value = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { output: null, error: 'Claude 응답이 JSON 객체가 아닙니다.' };
    }
    if (value.is_error === true) return { output: null, error: 'Claude가 오류 응답을 반환했습니다.' };
    const output = Object.hasOwn(value, 'structured_output') ? value.structured_output
      : typeof value.result === 'string' ? JSON.parse(value.result) : null;
    return { output, error: output === null ? 'Claude 결과 JSON을 추출할 수 없습니다.' : null };
  } catch {
    return { output: null, error: 'Claude 결과 JSON을 파싱할 수 없습니다.' };
  }
}
export const claudeClient: AgentClient = {
  async run(call): Promise<AgentResult> {
    const sessionId = randomUUID();
    const args = buildClaudeArgs(call, sessionId);
    const prefix = call.rawPrefix;
    await mkdir(dirname(prefix), { recursive: true });
    await writeFile(`${prefix}.prompt.md`, call.prompt);
    let result: AgentResult = {
      output: null, exitCode: null, timedOut: false, durationMs: 0,
      rateLimited: false, resetAt: null, sessionId, error: null,
    };
    await Promise.all([writeFile(`${prefix}.out.json`, ''), writeFile(`${prefix}.stderr.log`, '')]);
    const command = await resolveExecutable('claude');
    if (!command) result.error = 'claude 실행 파일을 찾을 수 없습니다.';
    else {
      try {
        const spawned = await spawnProcess({
          command, args, cwd: call.cwd, stdin: call.prompt, timeoutMs: call.timeoutMs,
          stdoutPath: `${prefix}.out.json`, stderrPath: `${prefix}.stderr.log`,
        });
        const stdout = await readFile(`${prefix}.out.json`, 'utf8');
        const stderr = await readFile(`${prefix}.stderr.log`, 'utf8');
        const extracted = extractClaudeResult(stdout);
        const error = spawned.timedOut ? 'Claude 호출 시간이 초과되었습니다.'
          : spawned.exitCode !== 0 ? 'Claude 프로세스가 비정상 종료했습니다.' : extracted.error;
        const rateLimited = error !== null && detectRateLimit(`${stdout}\n${stderr}`);
        result = {
          ...result, exitCode: spawned.exitCode, timedOut: spawned.timedOut, durationMs: spawned.durationMs,
          output: extracted.output, error, rateLimited,
          resetAt: rateLimited ? parseResetTime(`${stdout}\n${stderr}`)?.toISOString() ?? null : null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.error = `Claude 프로세스를 실행할 수 없습니다: ${message}`;
      }
    }
    await writeFile(`${prefix}.meta.json`, JSON.stringify({
      client: 'claude', args, cwd: call.cwd, exitCode: result.exitCode, durationMs: result.durationMs,
      sessionId, rateLimited: result.rateLimited,
    }, null, 2) + '\n');
    return result;
  },
};
