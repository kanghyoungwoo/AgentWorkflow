import { readFile } from 'node:fs/promises';
import { Ajv } from 'ajv';
import type { AgentCall, AgentClient, AgentResult } from '../clients/index.ts';
import { headSha, restore, statusPorcelain } from '../git.ts';

export type SchemaName = 'plan-author' | 'review' | 'dev-author' | 'qa-report' | 'wiki-author';
export type InvokeOptions<T> = {
  client: AgentClient;
  makeCall: (attempt: 1 | 2, previousError: string | null) => Promise<AgentCall>;
  schemaName: SchemaName;
  guardDir: string | null;
  check?: (output: T) => Promise<string | null>;
  afterAttempt?: (result: AgentResult) => Promise<void>;
};
export type InvokeOutcome<T> =
  | { kind: 'ok'; output: T }
  | { kind: 'failed'; detail: string }
  | { kind: 'rate_limited'; resetAt: string | null; detail: string };
const ajv = new Ajv({ allErrors: true });
const names: SchemaName[] = ['plan-author', 'review', 'dev-author', 'qa-report', 'wiki-author'];
const validators = new Map(await Promise.all(names.map(async name => {
  const url = new URL(`../../schemas/${name}.schema.json`, import.meta.url);
  return [name, ajv.compile(JSON.parse(await readFile(url, 'utf8')))] as const;
})));
function consistency(output: unknown): string | null {
  const value = output as { verdict?: string; status?: string; issues?: unknown[]; blocker: unknown };
  const blocked = (value.verdict ?? value.status) === 'BLOCKED';
  if (blocked !== (value.blocker !== null)) return 'BLOCKED와 blocker의 일관성이 맞지 않습니다.';
  if (value.verdict && ((value.verdict === 'APPROVED') !== (value.issues!.length === 0))) {
    return '검수 판정과 issues의 일관성이 맞지 않습니다.';
  }
  return null;
}
export async function invoke<T>(options: InvokeOptions<T>): Promise<InvokeOutcome<T>> {
  const errors: string[] = [];
  for (const attempt of [1, 2] as const) {
    let before: string | null = null;
    if (options.guardDir !== null) {
      await restore(options.guardDir, 'HEAD');
      before = await headSha(options.guardDir);
    }
    const call = await options.makeCall(attempt, errors.at(-1) ?? null);
    let result: AgentResult;
    try {
      result = await options.client.run(call);
    } catch (error) {
      result = {
        output: null, exitCode: null, timedOut: false, durationMs: 0,
        rateLimited: false, resetAt: null, sessionId: null, error: String(error),
      };
    }
    await options.afterAttempt?.(result);
    let reason: string | null = null;
    if (!result.rateLimited) {
      if (result.exitCode !== 0 || result.timedOut || result.error !== null) {
        reason = `프로세스 오류: 종료 코드 ${result.exitCode}, 타임아웃 ${result.timedOut}, ${result.error ?? ''}`;
      } else {
        const validate = validators.get(options.schemaName)!;
        if (!validate(result.output)) reason = `스키마 오류: ${ajv.errorsText(validate.errors)}`;
        else reason = consistency(result.output) ?? await options.check?.(result.output as T) ?? null;
      }
    }
    // 앞선 오류나 한도 응답에도 읽기 전용 호출이 남긴 변경은 복구한다.
    if (options.guardDir !== null && before !== null) {
      const dirty = await statusPorcelain(options.guardDir);
      const moved = await headSha(options.guardDir) !== before;
      if (dirty || moved) {
        await restore(options.guardDir, before);
        reason = [reason, `GATE-READONLY: 읽기 전용 호출이 파일 또는 HEAD를 변경했습니다. ${dirty}`]
          .filter(Boolean).join('\n');
      }
    }
    if (result.rateLimited) {
      return { kind: 'rate_limited', resetAt: result.resetAt, detail: result.error ?? '사용량 한도에 도달했습니다.' };
    }
    if (reason === null) return { kind: 'ok', output: result.output as T };
    errors.push(`${attempt}회차: ${reason}`);
  }
  return { kind: 'failed', detail: errors.join('\n') };
}
