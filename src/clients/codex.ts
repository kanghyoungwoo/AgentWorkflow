import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AgentCall, AgentClient, AgentResult } from './index.ts';
import { resolveExecutable, spawnProcess } from './spawn.ts';
import { detectRateLimit, parseResetTime } from './rate-limit.ts';

export function buildCodexArgs(call: AgentCall, schemaPath: string, lastPath: string): string[] {
  const args = ['exec', '--json', '-C', call.cwd];
  if (call.profile === 'write' && call.grant === 'full') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('-s', call.profile === 'readonly' ? 'read-only' : 'workspace-write');
    if (call.profile === 'write' && call.grant === 'network') {
      args.push('-c', 'sandbox_workspace_write.network_access=true');
    }
  }
  args.push('--output-schema', schemaPath, '-o', lastPath);
  if (call.model !== null) args.push('-m', call.model);
  if (call.effort !== null) args.push('-c', `model_reasoning_effort=${call.effort}`);
  args.push('-');
  return args;
}
function extractSessionId(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event?.type === 'thread.started') {
        return typeof event.thread_id === 'string' ? event.thread_id : null;
      }
    } catch {}
  }
  return null;
}
async function extractOutput(lastPath: string): Promise<{ output: unknown | null; error: string | null }> {
  let text: string;
  try {
    text = await readFile(lastPath, 'utf8');
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'Codex last.json 파일이 없습니다.' : `Codex last.json을 읽을 수 없습니다: ${String(error)}`;
    return { output: null, error: message };
  }
  if (!text.trim()) return { output: null, error: 'Codex last.json 파일이 비었습니다.' };
  try {
    const output: unknown = JSON.parse(text);
    return { output, error: output === null ? 'Codex 결과 JSON을 추출할 수 없습니다.' : null };
  } catch {
    return { output: null, error: 'Codex last.json을 파싱할 수 없습니다.' };
  }
}
export const codexClient: AgentClient = {
  async run(call): Promise<AgentResult> {
    const prefix = resolve(call.rawPrefix);
    const schemaPath = `${prefix}.schema.json`;
    const lastPath = `${prefix}.last.json`;
    const args = buildCodexArgs(call, schemaPath, lastPath);
    await mkdir(dirname(prefix), { recursive: true });
    await writeFile(`${prefix}.prompt.md`, call.prompt);
    await writeFile(schemaPath, JSON.stringify(call.schema, null, 2) + '\n');
    await rm(lastPath, { force: true });
    await Promise.all([writeFile(`${prefix}.out.jsonl`, ''), writeFile(`${prefix}.stderr.log`, '')]);
    let result: AgentResult = {
      output: null, exitCode: null, timedOut: false, durationMs: 0,
      rateLimited: false, resetAt: null, sessionId: null, error: null,
    };
    const command = await resolveExecutable('codex');
    if (!command) result.error = 'codex 실행 파일을 찾을 수 없습니다.';
    else {
      try {
        const spawned = await spawnProcess({
          command, args, cwd: call.cwd, stdin: call.prompt, timeoutMs: call.timeoutMs,
          stdoutPath: `${prefix}.out.jsonl`, stderrPath: `${prefix}.stderr.log`,
        });
        const stdout = await readFile(`${prefix}.out.jsonl`, 'utf8');
        const stderr = await readFile(`${prefix}.stderr.log`, 'utf8');
        const extracted = await extractOutput(lastPath);
        const error = spawned.timedOut ? 'Codex 호출 시간이 초과되었습니다.'
          : spawned.exitCode !== 0 ? 'Codex 프로세스가 비정상 종료했습니다.' : extracted.error;
        const rateLimited = error !== null && detectRateLimit(`${stdout}\n${stderr}`);
        result = {
          ...result, output: extracted.output, exitCode: spawned.exitCode,
          timedOut: spawned.timedOut, durationMs: spawned.durationMs, sessionId: extractSessionId(stdout),
          error, rateLimited,
          resetAt: rateLimited ? parseResetTime(`${stdout}\n${stderr}`)?.toISOString() ?? null : null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.error = `Codex 프로세스를 실행할 수 없습니다: ${message}`;
      }
    }
    await writeFile(`${prefix}.meta.json`, JSON.stringify({
      client: 'codex', args, cwd: call.cwd, exitCode: result.exitCode, durationMs: result.durationMs,
      sessionId: result.sessionId, rateLimited: result.rateLimited,
    }, null, 2) + '\n');
    return result;
  },
};
