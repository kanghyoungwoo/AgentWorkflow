import { readFile } from 'node:fs/promises';
import { profileFor } from '../clients/index.ts';
import type { AgentCall } from '../clients/index.ts';
import { rawPrefix } from '../store/runlog.ts';
import type { SchemaName } from './invoke.ts';
import type { LoopState, Plan, Role, RunState, WorkspaceConfig } from '../types.ts';

export type Section = { title: string; value: unknown; json?: boolean };
export async function assemblePrompt(
  role: Role, variables: Record<string, unknown>, sections: Section[], error: string | null = null,
): Promise<string> {
  const names: Record<Role, string> = {
    planningAuthor: 'planning-author', planningReviewer: 'planning-reviewer', devAuthor: 'dev-author',
    devReviewer: 'dev-reviewer', qa: 'qa', wikiAuthor: 'wiki-author', wikiReviewer: 'wiki-reviewer',
  };
  const common = await readFile(new URL('../../prompts/_common.md', import.meta.url), 'utf8');
  const template = await readFile(new URL(`../../prompts/${names[role]}.md`, import.meta.url), 'utf8');
  const body = template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (variables[key] === undefined || variables[key] === null) throw new Error(`프롬프트 변수 누락: ${match}`);
    return String(variables[key]);
  });
  if (/\{\{.*?\}\}/.test(body)) throw new Error('치환되지 않은 프롬프트 변수가 있습니다.');
  const inputs = [...sections];
  if (error) inputs.push({ title: 'Output validation errors', value: error });
  return common.trimEnd() + '\n\n' + body.trimEnd() + '\n\n# Inputs\n\n'
    + inputs.filter(s => s.value !== undefined && s.value !== null && s.value !== '')
      .map(s => `## ${s.title}\n\n${s.json ? '```json\n' + JSON.stringify(s.value, null, 2) + '\n```'
        : String(s.value)}\n`).join('\n');
}
export type StageInputs = {
  context: Record<string, unknown>;
  request?: string;
  requestSummary?: string;
  plan?: Plan;
  defects?: unknown;
  output?: unknown;
  targets?: unknown;
  approved?: unknown;
  testResult?: string;
  notes?: string;
  planSummary?: string;
  changedFiles?: string[];
  index?: string;
  scenarios?: unknown;
  decisions?: string[];
};
export function sectionsFor(role: Role, input: StageInputs, loop: LoopState): Section[] {
  const sections: Section[] = [];
  const add = (title: string, value: unknown, json = false) => {
    if (value !== undefined && value !== null && value !== '') sections.push({ title, value, json });
  };
  add('Run context', input.context, true);
  if (role.startsWith('planning') || role === 'devReviewer') add('request.md', input.request);
  if (role.startsWith('planning')) {
    if (role === 'planningAuthor') {
      if (loop.lastOutput) add('Previous output', loop.lastOutput, true);
      if (loop.lastIssues.length) add('Issues', loop.lastIssues, true);
    } else add('Plan to review', input.output, true);
    add('Approved plan', input.plan, true);
    add('QA defects', input.defects, true);
  }
  if (role.startsWith('dev')) {
    add('Target items', input.targets, true);
    if (role === 'devAuthor') {
      if (Array.isArray(input.approved) && input.approved.length) add('Approved items', input.approved, true);
      if (loop.lastIssues.length) add('Issues', loop.lastIssues, true);
      if (loop.lastOutput) add('Previous output', loop.lastOutput, true);
    } else {
      add('Test result', input.testResult);
      add('Author notes', input.notes);
    }
  }
  if (role.startsWith('wiki')) {
    add('Request summary', input.requestSummary);
    add('Plan summary', input.planSummary);
    if (input.changedFiles?.length) add('Changed files', input.changedFiles.join('\n'));
    add('Current index.md', input.index);
    if (role === 'wikiAuthor') {
      if (loop.lastIssues.length) add('Issues', loop.lastIssues, true);
      if (loop.lastOutput) add('Previous output', loop.lastOutput, true);
    } else add('Wiki author output', input.output, true);
  }
  if (role === 'qa') add('Scenarios', input.scenarios, true);
  if (role.endsWith('Reviewer')) add('Previous issues', loop.reviewIssues ?? [], true);
  const decisions = input.decisions ?? loop.decisions;
  if (decisions.length) add('Master decisions', decisions.map((value, i) => `${i + 1}. ${value}`).join('\n'));
  return sections;
}
export type CallOptions = {
  config: WorkspaceConfig;
  state: RunState;
  runDir: string;
  loop: LoopState;
  lane: string | null;
  stage: string;
  inputs: StageInputs;
  error?: string | null;
};
export async function makeAgentCall(role: Role, options: CallOptions): Promise<AgentCall> {
  const { config, state, loop, inputs } = options;
  const schemaName: SchemaName = role.endsWith('Reviewer') ? 'review'
    : role === 'qa' ? 'qa-report' : role === 'devAuthor' ? 'dev-author'
      : role === 'wikiAuthor' ? 'wiki-author' : 'plan-author';
  const lane = options.lane === 'integration' ? state.integration : state.lanes.find(l => l.id === options.lane);
  const worktree = lane?.worktree ?? state.runWorktree;
  const qaDir = typeof inputs.context.qaDir === 'string' ? inputs.context.qaDir : null;
  const cwd = role === 'qa' && config.roles.qa.client === 'codex' ? qaDir! : worktree;
  const round = role === 'qa' ? lane!.qaAttempt : loop.round;
  const seq = ++state.seq;
  return {
    role, profile: profileFor(role), grant: profileFor(role) === 'write' ? loop.grant : null, cwd,
    prompt: await assemblePrompt(role, { ...inputs.context, stageBase: loop.stageBase },
      sectionsFor(role, inputs, loop), options.error ?? null),
    schema: JSON.parse(await readFile(new URL(`../../schemas/${schemaName}.schema.json`, import.meta.url), 'utf8')),
    qaDir, model: config.roles[role].model, effort: config.roles[role].effort,
    timeoutMs: config.limits.stepTimeoutMin * 60_000,
    rawPrefix: rawPrefix(options.runDir, seq, options.lane, options.stage, role, round),
  };
}
