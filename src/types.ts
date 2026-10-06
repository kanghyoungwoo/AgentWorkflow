export type Role = "planningAuthor" | "planningReviewer" | "devAuthor" | "devReviewer"
  | "qa" | "wikiAuthor" | "wikiReviewer";
export type WorkspaceConfig = {
  setupCommand: string | null;
  testCommand: string | null;
  app: {
    startCommand: string;
    readyUrl: string;
    startTimeoutSec: number;
  } | null;
  wikiDir: string;
  roles: Record<Role, {
    client: "codex" | "claude";
    model: string | null;
    effort: "low" | "medium" | "high" | "xhigh" | null;
  }>;
  limits: {
    maxReviewRounds: number;
    sameIssueLimit: number;
    maxQaRollbacks: number;
    maxLanes: number;
    stepTimeoutMin: number;
  };
};
export type RunEvent = {
  at: string;
  lane: string | null;
  stage: string | null;
  role: Role | null;
  type: "run_start" | "setup" | "author" | "gate" | "tests" | "review" | "qa" | "skip"
    | "pause" | "resume" | "rate_limit" | "schedule" | "merge" | "commit"
    | "mode_switch" | "renumber" | "done";
  verdict: string | null;
  round: number | null;
  message: string;
};
export type BlockerKind = "spec_ambiguity" | "permission_network" | "permission_full"
  | "scope" | "environment" | "other";
export type Blocker = {
  kind: BlockerKind;
  detail: string
};
export type Response = {
  issueId: string;
  resolution: string
};
export type Issue = {
  id: string;
  target: string;
  problem: string;
  requiredChange: string;
};
export type PlanAuthorOutput = {
  status: "READY" | "BLOCKED";
  blocker: Blocker | null;
  summary: string;
  todos: Todo[];
  qaScenarios: QaScenario[];
  lanes: Lane[] | null;
  responses: Response[];
};
export type Todo = {
  id: string;
  text: string;
  reqIds: string[];
  lane: string | null;
  defectIds: string[];
};
export type QaScenario = {
  id: string;
  title: string;
  type: "browser" | "cli";
  reqIds: string[];
  lane: string | null;
  preconditions: string;
  steps: string[];
  expected: string[];
  adversarial: boolean;
};
export type Lane = {
  id: string;
  title: string;
  ownedPaths: string[];
  interfaces: string;
};
export type Plan = {
  summary: string;
  todos: (Todo & {
    lane: string;
    checked: boolean;
    evidence: Evidence | null;
    approved: boolean
  })[];
  qaScenarios: QaScenario[];
  lanes: Lane[] | null;
};
export type Evidence = {
  files: string[];
  summary: string
};
export type ReviewOutput = {
  verdict: "APPROVED" | "REJECTED" | "BLOCKED";
  summary: string;
  issues: Issue[];
  blocker: Blocker | null;
};
export type DevAuthorOutput = {
  status: "DONE" | "BLOCKED";
  blocker: Blocker | null;
  items: {
    id: string;
    checked: boolean;
    evidence: Evidence | null
  }[];
  testsRun: {
    command: string;
    passed: boolean;
    note: string
  } | null;
  responses: Response[];
  notes: string;
};
export type QaReport = {
  status: "PASS" | "FAIL" | "BLOCKED";
  blocker: Blocker | null;
  scenarios: {
    id: string;
    result: "PASS" | "FAIL" | "BLOCKED";
    observed: string;
    evidence: string[];
  }[];
  exploratory: {
    title: string;
    result: "PASS" | "FAIL";
    observed: string;
    evidence: string[];
  }[];
  defects: {
    id: string;
    scenarioId: string | null;
    title: string;
    reproduction: string[];
    expected: string;
    actual: string;
    evidence: string[];
  }[];
};
export type WikiAuthorOutput = {
  status: "DONE" | "BLOCKED";
  blocker: Blocker | null;
  docs: {
    path: string;
    action: "created" | "updated";
    reason: string
  }[];
  responses: Response[];
};
export type RunState = {
  runId: string;
  workspace: string;
  mode: "plan" | "full" | "wiki";
  parallel: boolean;
  baseRef: string;
  sinceRef: string | null;
  runBranch: string;
  runWorktree: string;
  setupDone: boolean;
  status: "RUNNING" | "PAUSED" | "DONE";
  stage: "PLANNING" | "LANES" | "MERGE" | "INTEGRATION_QA" | "WIKI" | "DONE";
  planning: LoopState;
  lanes: LaneState[];
  integration: LaneState | null;
  wiki: LoopState | null;
  pending: Pending[];
  lastExitCode: number | null;
  scheduledResume: {
    atJobId: number;
    at: string
  } | null;
  seq: number;
  updatedAt: string;
};
export type LoopState = {
  round: number;
  judgedRounds: number;
  issueStreak: Record<string, number>;
  lastOutput: PlanAuthorOutput | DevAuthorOutput | WikiAuthorOutput | null;
  lastIssues: Issue[];
  reviewIssues: Issue[];
  stageBase: string | null;
  decisions: string[];
  grant: "network" | "full" | null;
};
export type LaneState = {
  id: string;
  branch: string;
  worktree: string;
  ownedPaths: string[] | null;
  portSlot: number;
  setupDone: boolean;
  phase: "DEV" | "QA" | "FIX_PLANNING" | "DONE";
  loop: LoopState;
  decisions: string[];
  qaAttempt: number;
  qaRollbacks: number;
  status: "ACTIVE" | "PAUSED" | "DONE";
};
export type Pending = {
  id: string;
  lane: string | null;
  stage: string;
  kind: "loop_repeat" | "round_cap" | "qa_rollback_cap" | "reviewer_blocked"
    | "merge_conflict" | "failed" | "rate_limited" | BlockerKind;
  exitCode: 1 | 20 | 21 | 22;
  summary: string;
  detail: string;
  resetAt: string | null;
  createdAt: string;
};
export const EXIT_CODES = { OK: 0, FAIL: 1, USAGE: 2, NEEDS_ANSWER: 20, NEEDS_USER: 21, RATE_LIMITED: 22 } as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
