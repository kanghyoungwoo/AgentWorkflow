import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';
import type { AgentCall } from '../src/clients/index.ts';
import type {
  DevAuthorOutput, Issue, LaneState, LoopState, PlanAuthorOutput, QaReport, ReviewOutput,
} from '../src/types.ts';
import { commitAll } from '../src/git.ts';

const exec = promisify(execFile);
export async function repo(t: TestContext): Promise<{ cwd: string; stageBase: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'aw-engine-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await exec('git', ['init', '-b', 'main'], { cwd });
  await exec('git', ['config', 'user.name', 'AW Test'], { cwd });
  await exec('git', ['config', 'user.email', 'aw@example.invalid'], { cwd });
  await writeFile(join(cwd, 'base'), 'base');
  return { cwd, stageBase: (await commitAll(cwd, 'base'))! };
}
export function call(prompt = ''): AgentCall {
  return {
    role: 'planningReviewer', profile: 'readonly', grant: null, cwd: '/tmp', prompt,
    schema: {}, qaDir: null, model: null, effort: null, timeoutMs: 1000, rawPrefix: '/tmp/fake',
  };
}
export function plan(): PlanAuthorOutput {
  return {
    status: 'READY', blocker: null, summary: '계획', responses: [], lanes: null,
    todos: [{ id: 'DEV-001', text: '구현하세요.', reqIds: ['REQ-001'], lane: null, defectIds: [] }],
    qaScenarios: [{
      id: 'QA-001', title: '확인', type: 'cli', reqIds: ['REQ-001'], lane: null,
      preconditions: '', steps: ['실행'], expected: ['성공'], adversarial: true,
    }],
  };
}
export function dev(): DevAuthorOutput {
  return {
    status: 'DONE', blocker: null, items: [{
      id: 'DEV-001', checked: true, evidence: { files: ['base'], summary: '구현했습니다.' },
    }], testsRun: null, responses: [], notes: '',
  };
}
export function review(issues: Issue[] = []): ReviewOutput {
  return { verdict: issues.length ? 'REJECTED' : 'APPROVED', summary: '검수', issues, blocker: null };
}
export function finding(id = 'R-001'): Issue {
  return { id, target: 'general', problem: '문제', requiredChange: '수정하세요.' };
}
export function loopState(): LoopState {
  return {
    round: 0, judgedRounds: 0, issueStreak: {}, lastOutput: null, lastIssues: [], reviewIssues: [],
    stageBase: null, decisions: [], grant: null,
  };
}
export function laneState(): LaneState {
  return {
    id: 'main', branch: 'aw/test', worktree: '/tmp', ownedPaths: null, portSlot: 0,
    setupDone: true, phase: 'QA', loop: loopState(), decisions: [], qaAttempt: 1,
    qaRollbacks: 0, status: 'ACTIVE',
  };
}
export function report(): QaReport {
  return {
    status: 'PASS', blocker: null,
    scenarios: [{ id: 'QA-001', result: 'PASS', observed: '성공', evidence: ['evidence.log'] }],
    exploratory: [], defects: [],
  };
}
export function defect(): QaReport['defects'][number] {
  return {
    id: 'BUG-001', scenarioId: 'QA-001', title: '실패', reproduction: ['실행'],
    expected: '성공', actual: '실패', evidence: ['evidence.log'],
  };
}
