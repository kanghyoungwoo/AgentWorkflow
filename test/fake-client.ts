import type { AgentCall, AgentClient, AgentResult } from '../src/clients/index.ts';

export type FakeResponse = Partial<AgentResult> & {
  duringCall?: (call: AgentCall) => void | Promise<void>;
};
export function fakeClient(
  respond: ((call: AgentCall) => unknown | Promise<unknown>) | FakeResponse[],
): AgentClient & { calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  return {
    calls,
    async run(call): Promise<AgentResult> {
      const index = calls.push(call) - 1;
      const scripted = Array.isArray(respond);
      const response = scripted ? respond[index] : null;
      if (scripted && !response) throw new Error('fake-client 응답이 부족합니다.');
      await response?.duringCall?.(call);
      const { duringCall: _, ...result } = response ?? {};
      return {
        output: scripted ? null : await respond(call), exitCode: 0, timedOut: false, durationMs: 1,
        rateLimited: false, resetAt: null, sessionId: 'fake-session', error: null, ...result,
      };
    },
  };
}
