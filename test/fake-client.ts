import type { AgentCall, AgentClient, AgentResult } from '../src/clients/index.ts';

export function fakeClient(
  respond: (call: AgentCall) => unknown | Promise<unknown>,
): AgentClient {
  return {
    async run(call): Promise<AgentResult> {
      return {
        output: await respond(call), exitCode: 0, timedOut: false, durationMs: 1,
        rateLimited: false, resetAt: null, sessionId: 'fake-session', error: null,
      };
    },
  };
}
