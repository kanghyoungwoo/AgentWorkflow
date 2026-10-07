import type { Role, WorkspaceConfig } from '../types.ts';
import { claudeClient } from './claude.ts';
import { codexClient } from './codex.ts';

export type Profile = 'readonly' | 'write' | 'qa';
export type AgentCall = {
  role: Role;
  profile: Profile;
  grant: 'network' | 'full' | null;
  cwd: string;
  prompt: string;
  schema: object;
  qaDir: string | null;
  model: string | null;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | null;
  timeoutMs: number;
  rawPrefix: string;
};
export type AgentResult = {
  output: unknown | null;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  rateLimited: boolean;
  resetAt: string | null;
  sessionId: string | null;
  error: string | null;
};
export interface AgentClient {
  run(call: AgentCall): Promise<AgentResult>;
}
export function profileFor(role: Role): Profile {
  if (role === 'qa') return 'qa';
  return role === 'devAuthor' || role === 'wikiAuthor' ? 'write' : 'readonly';
}
export function clientFor(config: WorkspaceConfig, role: Role): AgentClient {
  if (config.roles[role].client === 'codex') return codexClient;
  return claudeClient;
}
