import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { clientFor } from '../clients/index.ts';
import type { AgentClient } from '../clients/index.ts';
import { spawnProcess } from '../clients/spawn.ts';
import { loadConfig } from '../config.ts';
import { commitAll, diffNameOnly, headSha, isAncestor, merge, restore, squash, worktreeAdd } from '../git.ts';
import * as defaultAppRunner from '../qa/app-runner.ts';
import { newLoopState, readState, writeState } from '../store/state.ts';
import { appendEvent, developmentPath, fixPlanningPath, planningPath, qaDir, wikiPath } from '../store/runlog.ts';
import { parseRequest } from '../store/request.ts';
import type {
  DevAuthorOutput, ExitCode, Issue, LaneState, LoopState, Plan, PlanAuthorOutput, QaReport,
  ReviewOutput, Role, RunEvent, WikiAuthorOutput, WorkspaceConfig,
} from '../types.ts';
import { gateEvidence, gateItems, gateLanes, gateOwned, gateQaReport, gateReq, gateTests, gateWikiScope,
  lanesOverlap } from './gates.ts';
import { invoke } from './invoke.ts';
import { eventMessage } from './event-message.ts';
import type { SchemaName } from './invoke.ts';
import { decideQa } from './qa.ts';
import type { QaOutcome } from './qa.ts';
import { pending, runReviewLoop } from './review-loop.ts';
import type { LoopPending } from './review-loop.ts';
import { makeAgentCall } from './stages.ts';
import type { StageInputs } from './stages.ts';
import { renderPlan, renderReport, renderTodo } from './render.ts';

type LaneContext = { lane?: LaneState; stage: string; role: Role | null; fixNumber: number };

export type PipelineDeps = {
  clientFor?: (config: WorkspaceConfig, role: Role) => AgentClient;
  appRunner?: typeof defaultAppRunner;
  now?: () => Date;
  onEvent?: (event: RunEvent) => void;
  interrupted?: () => boolean;
};
export async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}
async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
export function pendingExit(codes: number[]): ExitCode {
  return ([1, 21, 20, 22].find(code => codes.includes(code)) ?? 0) as ExitCode;
}
export async function runPipeline(runDir: string, deps: PipelineDeps = {}): Promise<ExitCode> {
  const state = await readState(runDir);
  const { config } = await loadConfig(state.workspace);
  const appRunner = deps.appRunner ?? defaultAppRunner;
  const now = deps.now ?? (() => new Date());
  const request = await optionalText(join(runDir, '00-request/request.md'));
  const parsed = request ? parseRequest(request) : null;
  const reqIds = parsed?.ok ? parsed.requirements.map(r => r.id) : [];
  const planPath = join(runDir, '01-planning/plan.json');
  let plan: Plan | null = JSON.parse(await optionalText(planPath) ?? 'null');
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }
  const persist = () => serial(() => writeState(runDir, state));
  const runContext: LaneContext = {
    stage: !state.setupDone ? 'SETUP' : state.stage, role: null, fixNumber: 0,
  };
  async function contextFor(lane: LaneState): Promise<LaneContext> {
    let fixNumber = 0;
    try {
      const paths = await readdir(join(runDir, '01-planning/fix'));
      const prefix = lane.id + '-';
      const fixes = paths.filter(path => path.startsWith(prefix) && /^\d+$/.test(path.slice(prefix.length)));
      fixNumber = Math.max(0, ...fixes.map(path => Number(path.slice(prefix.length))));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (lane.phase === 'FIX_PLANNING' && lane.loop.round === 0) fixNumber += 1;
    return { lane, stage: lane.phase, role: null, fixNumber };
  }
  async function emitUnlocked(ctx: LaneContext, type: RunEvent['type'], message: string, verdict: string | null = null,
    round: number | null = null, role: Role | null = null, stage: string | null = ctx.stage) {
    const event: RunEvent = {
      at: now().toISOString(), type, message, verdict, round, role, stage, lane: ctx.lane?.id ?? null,
    };
    await writeState(runDir, state);
    await appendEvent(runDir, event);
    deps.onEvent?.(event);
  }
  async function pauseUnlocked(ctx: LaneContext, value: LoopPending): Promise<ExitCode> {
    const events = await optionalText(join(runDir, 'events.jsonl')) ?? '';
    const previous = [...events.matchAll(/"message":"P-(\d+):/g)].map(m => Number(m[1]));
    const next = Math.max(0, ...previous, ...state.pending.map(p => Number(p.id.slice(2)))) + 1;
    const id = `P-${String(next).padStart(3, '0')}`;
    state.pending.push({
      ...value, id, lane: ctx.lane?.id ?? null, stage: ctx.stage, createdAt: now().toISOString(),
    });
    state.status = 'PAUSED';
    if (ctx.lane) ctx.lane.status = 'PAUSED';
    state.lastExitCode = pendingExit(state.pending.map(p => p.exitCode));
    if (value.kind === 'rate_limited') await emitUnlocked(ctx, 'rate_limit', value.detail, value.kind, null, ctx.role);
    await emitUnlocked(ctx, 'pause', `${id}: ${value.summary}`, value.kind);
    return state.lastExitCode as ExitCode;
  }
  function emit(ctx: LaneContext, type: RunEvent['type'], message: string, verdict: string | null = null,
    round: number | null = null, role: Role | null = null, stage: string | null = ctx.stage) {
    return serial(() => emitUnlocked(ctx, type, message, verdict, round, role, stage));
  }
  function pause(ctx: LaneContext, value: LoopPending): Promise<ExitCode> {
    return serial(() => pauseUnlocked(ctx, value));
  }
  async function savePlanUnlocked(ctx: LaneContext, round = ctx.lane?.loop.round ?? 0) {
    await saveJson(planPath, plan);
    await writeFile(join(runDir, '01-planning/plan.md'), renderPlan(plan!));
    for (const lane of [...state.lanes, ...(state.integration ? [state.integration] : [])]) {
      const path = join(runDir, '02-development', lane.id, 'todo.md');
      await mkdir(dirname(path), { recursive: true });
      const previous = await optionalText(path) ?? '';
      const approvals: Record<string, number> = {};
      for (const entry of previous.split(/(?=^- \[)/m)) {
        const id = /^- \[x\] (\S+)/.exec(entry)?.[1];
        const round = /검수: 승인 \(round (\d+)\)/.exec(entry)?.[1];
        if (id && round) approvals[id] = Number(round);
      }
      await writeFile(path, renderTodo(plan!, lane.loop.round || round, approvals, lane.id));
    }
  }
  const savePlan = (ctx: LaneContext) => serial(() => savePlanUnlocked(ctx));
  async function call<T>(ctx: LaneContext, role: Role, schemaName: SchemaName, loop: LoopState, input: StageInputs,
    path: string, writable = false) {
    ctx.role = role;
    await mkdir(dirname(path), { recursive: true });
    const outcome = await invoke<T>({
      client: (deps.clientFor ?? clientFor)(config, role), schemaName,
      guardDir: writable ? null : ctx.lane?.worktree ?? state.runWorktree,
      makeCall: async (_attempt, error) => {
        if (deps.interrupted?.()) throw new Error('시그널로 실행이 중단되었습니다.');
        const value = await makeAgentCall(role, {
          config, state, runDir, loop, lane: ctx.lane?.id ?? null, stage: ctx.stage, inputs: input, error,
        });
        await persist();
        return value;
      },
      afterAttempt: writable ? async () => {
        const sha = await commitAll(ctx.lane?.worktree ?? state.runWorktree,
          `aw(${state.runId}): wip ${ctx.lane?.id ?? 'run'} ${ctx.stage} r${loop.round}`);
        if (sha) await emit(ctx, 'commit', sha, 'WIP', loop.round);
      } : undefined,
    });
    if (outcome.kind === 'ok') await saveJson(path, outcome.output);
    if (deps.interrupted?.()) throw new Error('시그널로 실행이 중단되었습니다.');
    return outcome;
  }
  async function loopEmit(ctx: LaneContext, event: Omit<RunEvent, 'at'>) {
    await emit(ctx, event.type, event.message, event.verdict, event.round,
      event.type === 'author' || event.type === 'review' ? ctx.role : null);
  }
  async function planning(ctx: LaneContext, fix: boolean) {
    const loop = fix ? ctx.lane!.loop : state.planning;
    const defects = fix ? JSON.parse(await readFile(
      join(qaDir(runDir, ctx.lane!.id, ctx.lane!.qaAttempt), 'report.json'), 'utf8')).defects : undefined;
    const inputs: StageInputs = {
      context: {}, request, ...(fix ? { plan: plan!, defects } : {}),
      decisions: [...(ctx.lane?.decisions ?? []), ...loop.decisions],
    };
    const path = (kind: string) => fix
      ? fixPlanningPath(runDir, ctx.lane!.id, ctx.fixNumber, loop.round, kind)
      : planningPath(runDir, loop.round, kind);
    return runReviewLoop<PlanAuthorOutput>(loop, config.limits, {
      author: async () => {
        inputs.context = {
          mode: fix ? 'fix' : 'initial', parallel: !fix && state.parallel, maxLanes: config.limits.maxLanes,
          hasApp: config.app !== null, round: loop.round, lane: ctx.lane?.id ?? null,
        };
        return call(ctx, 'planningAuthor', 'plan-author', loop, inputs, path('author'));
      },
      gates: async output => {
        const finding = gateReq(output, {
          mode: fix ? 'fix' : 'initial', reqIds, hasApp: config.app !== null, parallel: !fix && state.parallel,
          plan, defectIds: defects?.map((d: { id: string }) => d.id) ?? [],
        });
        const lanes = !fix && state.parallel ? gateLanes(output, { maxLanes: config.limits.maxLanes }) : null;
        const issues = [finding, lanes].filter((value): value is Issue => value !== null);
        await saveJson(path('gate'), issues);
        return issues;
      },
      review: output => call<ReviewOutput>(ctx, 'planningReviewer', 'review', loop,
        { ...inputs, output }, path('review')),
      emit: event => loopEmit(ctx, event),
    });
  }
  async function development(ctx: LaneContext) {
    const lane = ctx.lane!;
    const loop = lane.loop;
    loop.stageBase ??= await headSha(lane.worktree);
    await persist();
    const targets = plan!.todos.filter(t => t.lane === lane.id && !t.approved);
    const path = (kind: string, ext = 'json') => developmentPath(runDir, lane.id, loop.round, kind, ext,
      ctx.fixNumber || undefined);
    let testResult = '(테스트 명령 없음)';
    return runReviewLoop<DevAuthorOutput>(loop, config.limits, {
      author: async () => {
        const result = await call<DevAuthorOutput>(ctx, 'devAuthor', 'dev-author', loop, {
          context: {
            lane: lane.id, ownedPaths: lane.ownedPaths,
            interfaces: plan!.lanes?.find(l => l.id === lane.id)?.interfaces ?? null,
            testCommand: config.testCommand, round: loop.round,
          },
          targets: targets.map(t => ({ id: t.id, text: t.text })),
          approved: plan!.todos.filter(t => t.approved).map(t => ({ id: t.id, text: t.text })),
          decisions: [...lane.decisions, ...loop.decisions],
        }, path('author'), true);
        if (result.kind === 'ok') {
          await serial(async () => {
            for (const item of result.output.items) {
              const target = targets.find(t => t.id === item.id);
              if (target) { target.checked = item.checked; target.evidence = item.evidence; }
            }
            await savePlanUnlocked(ctx);
          });
        }
        return result;
      },
      gates: async output => {
        const items = gateItems(output, targets.map(t => t.id));
        const evidence = await gateEvidence(output, { cwd: lane.worktree, stageBase: loop.stageBase! });
        const tests = await gateTests({
          cwd: lane.worktree, testCommand: config.testCommand, timeoutMs: config.limits.stepTimeoutMin * 60_000,
          logPath: path('tests', 'log'),
        });
        if (config.testCommand) {
          const tail = (await readFile(path('tests', 'log'), 'utf8')).split('\n').slice(-200).join('\n');
          testResult = `명령: ${config.testCommand}\n종료 코드: ${tests ? '실패 (GATE-TESTS 참조)' : '0'}\n${tail}`;
          await emit(ctx, 'tests', testResult, tests ? 'FAIL' : 'PASS', loop.round);
        }
        const owned = lane.ownedPaths ? await gateOwned({
          cwd: lane.worktree, stageBase: loop.stageBase!, ownedPaths: lane.ownedPaths,
        }) : null;
        const issues = [items, evidence, tests, owned].filter((value): value is Issue => value !== null);
        await saveJson(path('gate'), issues);
        return issues;
      },
      review: output => call<ReviewOutput>(ctx, 'devReviewer', 'review', loop, {
        context: { lane: lane.id, stageBase: loop.stageBase, ownedPaths: lane.ownedPaths }, request,
        targets: targets.map(t => ({ id: t.id, text: t.text, checked: t.checked, evidence: t.evidence })),
        testResult, notes: output.notes, decisions: [...lane.decisions, ...loop.decisions],
      }, path('review')),
      emit: event => loopEmit(ctx, event),
    });
  }
  async function qa(ctx: LaneContext): Promise<QaOutcome> {
    const lane = ctx.lane!;
    const scenarios = lane.ownedPaths ? plan!.qaScenarios.filter(s => s.lane === lane.id) : plan!.qaScenarios;
    lane.qaAttempt += 1;
    let directory = qaDir(runDir, lane.id, lane.qaAttempt);
    const prepareDirectory = async () => {
      await mkdir(join(directory, 'scripts'), { recursive: true });
      await mkdir(join(directory, 'evidence'), { recursive: true });
      await persist();
    };
    await prepareDirectory();
    let handle: defaultAppRunner.AppHandle | null = null;
    const automatic: { outcome: QaOutcome | null } = { outcome: null };
    let baseUrl = 'none';
    const start = async () => {
      if (lane.id === 'integration' && config.testCommand) {
        const logPath = join(directory, 'evidence/integration-tests.log');
        const finding = await gateTests({
          cwd: lane.worktree, testCommand: config.testCommand,
          timeoutMs: config.limits.stepTimeoutMin * 60_000, logPath,
        });
        await emit(ctx, 'tests', finding?.problem ?? '통합 테스트 통과', finding ? 'FAIL' : 'PASS', lane.qaAttempt);
        if (finding) {
          automatic.outcome = { kind: 'auto_fail', defect: {
            id: 'BUG-INTEGRATION-TESTS', scenarioId: null, title: '통합 테스트 실패',
            reproduction: [config.testCommand], expected: '종료 코드 0', actual: finding.problem,
            evidence: ['evidence/integration-tests.log'],
          } };
          throw new Error(finding.problem);
        }
      }
      if (!scenarios.length) return;
      if (config.app) {
        let port: number;
        try { port = await appRunner.portForSlot(lane.portSlot, config.limits.maxLanes); }
        catch (error) { automatic.outcome = { kind: 'environment', detail: String(error) }; throw error; }
        baseUrl = new URL(config.app.readyUrl.replaceAll('{port}', String(port))).origin;
        try {
          handle = await appRunner.startApp({
            worktree: lane.worktree, app: config.app, port, logPath: join(directory, 'app.log'),
          });
        } catch (error) {
          const defect: QaReport['defects'][number] = {
            id: 'BUG-APP-START', scenarioId: null, title: '앱 기동 실패', reproduction: [config.app.startCommand],
            expected: '앱 준비 완료', actual: String(error), evidence: ['app.log'],
          };
          automatic.outcome = { kind: 'auto_fail', defect };
          throw error;
        }
      }
      if (scenarios.some(s => s.type === 'browser') && !await appRunner.chromiumAvailable()) {
        automatic.outcome = { kind: 'environment', detail: 'Chromium이 없습니다. qa-runtime setup을 실행하세요.' };
        throw new Error('Chromium 없음');
      }
    };
    const stop = async () => { if (handle) { await appRunner.stopApp(handle); handle = null; } };
    let outcome: QaOutcome;
    const qaBase = await headSha(lane.worktree);
    try {
      if (!scenarios.length) {
        await start();
        await emit(ctx, 'skip', '시나리오 0/0 PASS, 결함 없음 (skipped: QA 시나리오 없음)', 'PASS', lane.qaAttempt);
        return { kind: 'skipped' };
      }
      ctx.role = 'qa';
      const result = await invoke<QaReport>({
        client: (deps.clientFor ?? clientFor)(config, 'qa'), schemaName: 'qa-report', guardDir: lane.worktree,
        makeCall: async (attempt, error) => {
          if (attempt === 2) { lane.qaAttempt += 1; directory = qaDir(runDir, lane.id, lane.qaAttempt); }
          await prepareDirectory();
          await start();
          const call = await makeAgentCall('qa', {
            config, state, runDir, loop: lane.loop, lane: lane.id, stage: ctx.stage, error,
            inputs: {
              context: {
                scope: lane.id, worktree: lane.worktree, baseUrl, qaDir: directory,
                playwrightUrl: appRunner.playwrightUrl(),
              }, scenarios, decisions: lane.decisions,
            },
          });
          await persist();
          return call;
        },
        afterAttempt: stop,
        check: report => gateQaReport(report, { scenarioIds: scenarios.map(s => s.id), qaDir: directory }),
      });
      outcome = result.kind === 'ok' ? { kind: 'report', report: result.output } : result;
    } catch (error) { outcome = automatic.outcome ?? { kind: 'failed', detail: String(error) }; }
    finally { await stop(); }
    if (automatic.outcome) await restore(lane.worktree, qaBase);
    if (deps.interrupted?.()) throw new Error('시그널로 실행이 중단되었습니다.');
    if (outcome.kind === 'report' || outcome.kind === 'auto_fail') {
      const report: QaReport = outcome.kind === 'report' ? outcome.report : {
        status: 'FAIL', blocker: null, scenarios: [], exploratory: [], defects: [outcome.defect],
      };
      await saveJson(join(directory, 'report.json'), report);
      await writeFile(join(directory, 'report.md'), renderReport(report));
      const passed = report.scenarios.filter(scenario => scenario.result === 'PASS').length;
      const defects = report.defects.length ? `결함 ${report.defects.map(d => d.id).join(', ')}` : '결함 없음';
      let message = `시나리오 ${passed}/${scenarios.length} PASS, ${defects}`;
      if (outcome.kind === 'auto_fail') message += ` (자동 결함: ${outcome.defect.title})`;
      if (report.status === 'BLOCKED') message += ` (${report.blocker!.kind}: ${report.blocker!.detail})`;
      await emit(ctx, 'qa', eventMessage(message), report.status, lane.qaAttempt, 'qa');
    } else if (outcome.kind !== 'skipped') {
      await emit(ctx, 'qa', eventMessage(`${outcome.kind}: ${outcome.detail}`),
        outcome.kind === 'environment' ? 'BLOCKED' : outcome.kind, lane.qaAttempt, 'qa');
    }
    return outcome;
  }
  async function wiki(ctx: LaneContext) {
    const loop = state.wiki ??= newLoopState();
    loop.stageBase ??= await headSha(state.runWorktree);
    await persist();
    const changedFiles = (await diffNameOnly(state.runWorktree, state.sinceRef ?? state.baseRef))
      .filter(path => path !== config.wikiDir && !path.startsWith(config.wikiDir.replace(/\/$/, '') + '/'));
    const date = now();
    const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      + `-${String(date.getDate()).padStart(2, '0')}`;
    const inputs: StageInputs = {
      context: {}, requestSummary: parsed?.ok ? `# ${parsed.title}\n\n## 목표\n${parsed.goal}` : '(요청 없음)',
      planSummary: plan?.summary ?? '(계획 없음)', changedFiles,
    };
    const path = (kind: string) => wikiPath(runDir, loop.round, kind);
    return runReviewLoop<WikiAuthorOutput>(loop, config.limits, {
      author: async () => {
        inputs.context = {
          wikiDir: config.wikiDir, stageBase: loop.stageBase, round: loop.round, runId: state.runId, date: localDate,
        };
        inputs.index = await optionalText(join(state.runWorktree, config.wikiDir, 'index.md'));
        return call(ctx, 'wikiAuthor', 'wiki-author', loop, inputs, path('author'), true);
      },
      gates: async output => {
        const finding = await gateWikiScope(output, {
          cwd: state.runWorktree, stageBase: loop.stageBase!, wikiDir: config.wikiDir,
        });
        const issues = finding ? [finding] : [];
        await saveJson(path('gate'), issues);
        return issues;
      },
      review: async output => call<ReviewOutput>(ctx, 'wikiReviewer', 'review', loop, {
        ...inputs, output, index: await optionalText(join(state.runWorktree, config.wikiDir, 'index.md')),
      }, path('review')),
      emit: event => loopEmit(ctx, event),
    });
  }
  async function setup(ctx: LaneContext): Promise<boolean> {
    const lane = ctx.lane;
    ctx.stage = 'SETUP';
    if (lane && lane.worktree !== state.runWorktree && !await optionalText(join(lane.worktree, '.git'))) {
      await worktreeAdd(state.workspace, lane.worktree, lane.branch, state.runBranch);
    }
    if (config.setupCommand) {
      const directory = lane ? join(runDir, '02-development', lane.id) : runDir;
      await mkdir(directory, { recursive: true });
      const files = await readdir(directory);
      const attempt = Math.max(0, ...files.filter(path => /^setup-\d+\.log$/.test(path))
        .map(path => Number(path.slice(6, -4)))) + 1;
      const logPath = join(directory, `setup-${attempt}.log`);
      await persist();
      const result = await spawnProcess({
        command: 'sh', args: ['-c', config.setupCommand], cwd: lane?.worktree ?? state.runWorktree, stdin: '',
        timeoutMs: config.limits.stepTimeoutMin * 60_000, stdoutPath: logPath, stderrPath: logPath,
      });
      if (deps.interrupted?.()) throw new Error('시그널로 실행이 중단되었습니다.');
      if (result.exitCode !== 0 || result.timedOut) {
        await pause(ctx, pending('environment', 20, 'SETUP 실행에 실패했습니다.',
          (await readFile(logPath, 'utf8')).split('\n').slice(-200).join('\n')));
        return false;
      }
    }
    if (lane) lane.setupDone = true;
    else state.setupDone = true;
    await emit(ctx, 'setup', 'SETUP을 완료했습니다.', 'PASS');
    return true;
  }
  async function executeLane(ctx: LaneContext): Promise<void> {
    const lane = ctx.lane!;
    try {
      if (!lane.setupDone && !await setup(ctx)) return;
      while (lane.status === 'ACTIVE') {
        ctx.stage = lane.id === 'integration' && lane.phase === 'QA' ? 'INTEGRATION_QA' : lane.phase;
        ctx.role = null;
        if (deps.interrupted?.()) throw new Error('시그널로 실행이 중단되었습니다.');
        if (lane.phase === 'DEV') {
          const targets = plan!.todos.filter(t => t.lane === lane.id && !t.approved);
          if (targets.length) {
            const result = await development(ctx);
            if (result.kind === 'paused') { await pause(ctx, result.pending); return; }
            const sha = await squash(lane.worktree, lane.loop.stageBase!,
              `aw(${state.runId}): ${lane.id} DEV 승인 (${targets.map(t => t.id).join(',')})`);
            await serial(async () => {
              for (const target of targets) target.approved = true;
              await savePlanUnlocked(ctx);
            });
            if (sha) await emit(ctx, 'commit', sha, 'APPROVED', lane.loop.round);
          }
          lane.phase = 'QA'; lane.loop = newLoopState();
        } else if (lane.phase === 'QA') {
          const outcome = await qa(ctx);
          const decision = decideQa(lane, outcome, config.limits);
          if (decision.next === 'paused') { await pause(ctx, decision.pending); return; }
          if (decision.next === 'fix') {
            ctx.fixNumber += 1;
            lane.phase = 'FIX_PLANNING'; lane.loop = newLoopState();
          } else { lane.phase = 'DONE'; lane.status = 'DONE'; }
        } else if (lane.phase === 'FIX_PLANNING') {
          const result = await planning(ctx, true);
          if (result.kind === 'paused') { await pause(ctx, result.pending); return; }
          await serial(async () => {
            const nextId = (prefix: string, ids: string[]) => `${prefix}-${String(
              Math.max(0, ...ids.filter(id => id.startsWith(prefix + '-')).map(id => Number(id.split('-')[1]))) + 1,
            ).padStart(3, '0')}`;
            for (const todo of result.output.todos) {
              const id = nextId('FIX', plan!.todos.map(t => t.id));
              plan!.todos.push({ ...todo, id, lane: lane.id, checked: false, evidence: null, approved: false });
              if (todo.id !== id) await emitUnlocked(ctx, 'renumber', `${todo.id} → ${id}`);
            }
            for (const scenario of result.output.qaScenarios) {
              const id = nextId('QA', plan!.qaScenarios.map(s => s.id));
              plan!.qaScenarios.push({ ...scenario, id, lane: lane.id === 'main' ? null : lane.id });
              if (scenario.id !== id) await emitUnlocked(ctx, 'renumber', `${scenario.id} → ${id}`);
            }
            await savePlanUnlocked(ctx);
          });
          lane.phase = 'DEV'; lane.loop = newLoopState();
        } else throw new Error(`지원하지 않는 레인 단계: ${lane.phase}`);
        await persist();
      }
    } catch (error) {
      await pause(ctx, pending('failed', 1, '파이프라인 실행이 중단되었습니다.', String(error)));
    }
  }
  function newLane(id: string, branch: string, worktree: string, ownedPaths: string[] | null,
    portSlot: number, setupDone: boolean, phase: LaneState['phase'] = 'DEV'): LaneState {
    return {
      id, branch, worktree, ownedPaths, portSlot, setupDone, phase, loop: newLoopState(), decisions: [],
      qaAttempt: 0, qaRollbacks: 0, status: 'ACTIVE',
    };
  }
  async function done(): Promise<ExitCode> {
    state.status = 'DONE'; state.stage = 'DONE'; state.lastExitCode = 0;
    await emit(runContext, 'done', '런을 완료했습니다.', null, null, null, null);
    return 0;
  }
  if (state.status === 'DONE') return 0;
  if (state.pending.length && !(state.stage === 'LANES' && state.lanes.some(l => l.status === 'ACTIVE'))) {
    return pendingExit(state.pending.map(p => p.exitCode));
  }
  try {
    if (!state.setupDone && !await setup(runContext)) return state.lastExitCode as ExitCode;
    while (true) {
      runContext.stage = state.stage;
      runContext.role = null;
      if (deps.interrupted?.()) throw new Error('시그널로 실행이 중단되었습니다.');
      if (state.stage === 'PLANNING') {
        const result = await planning(runContext, false);
        if (result.kind === 'paused') return pause(runContext, result.pending);
        const parallel = state.parallel && !lanesOverlap(result.output.lanes!);
        if (state.parallel && !parallel) {
          await emit(runContext, 'mode_switch', '레인 소유 경로 겹침 또는 단일 레인으로 순차 모드로 전환합니다.');
        }
        plan = {
          summary: result.output.summary, lanes: parallel ? result.output.lanes : null,
          todos: result.output.todos.map(t => ({
            ...t, lane: parallel ? t.lane! : 'main', checked: false, evidence: null, approved: false,
          })), qaScenarios: result.output.qaScenarios.map(s => ({ ...s, lane: parallel ? s.lane : null })),
        };
        state.lanes = parallel ? plan.lanes!.map((lane, index) => newLane(
          lane.id, `aw/${state.runId}-lane-${lane.id}`,
          join(state.workspace, '.aw/worktrees', state.runId, `lane-${lane.id}`), lane.ownedPaths, index + 1, false,
        )) : [newLane('main', state.runBranch, state.runWorktree, null, 0, true)];
        await savePlan(runContext);
        state.stage = 'LANES';
        await persist();
        if (state.mode === 'plan') return done();
      } else if (state.stage === 'LANES') {
        const contexts = await Promise.all(state.lanes.filter(l => l.status === 'ACTIVE').map(contextFor));
        await Promise.all(contexts.map(executeLane));
        if (state.pending.length) {
          state.status = 'PAUSED';
          state.lastExitCode = pendingExit(state.pending.map(p => p.exitCode));
          await persist();
          return state.lastExitCode as ExitCode;
        }
        state.stage = plan!.lanes !== null ? 'MERGE' : 'WIKI';
        await persist();
      } else if (state.stage === 'MERGE') {
        for (const lane of [...state.lanes].sort((a, b) => a.id.localeCompare(b.id))) {
          if (await isAncestor(state.runWorktree, lane.branch, 'HEAD')) continue;
          const result = await merge(state.runWorktree, lane.branch);
          await emit(runContext, 'merge', lane.branch, result.ok ? 'PASS' : 'CONFLICT');
          if (!result.ok) {
            const quote = (value: string) => /[^a-zA-Z0-9_./-]/.test(value)
              ? "'" + value.replaceAll("'", "'\\''") + "'" : value;
            const command = `git -C ${quote(state.runWorktree)} merge --no-ff ${quote(lane.branch)}`;
            return pause(runContext, pending('merge_conflict', 20, '레인 머지 충돌을 해결해야 합니다.',
              `worktree: ${state.runWorktree}\n충돌 파일: ${result.conflicts.join(', ')}\n${command}`));
          }
        }
        state.integration = newLane('integration', state.runBranch, state.runWorktree, null, 0, true, 'QA');
        state.stage = 'INTEGRATION_QA';
        await savePlan(runContext);
        await persist();
      } else if (state.stage === 'INTEGRATION_QA') {
        await executeLane(await contextFor(state.integration!));
        if (state.pending.length) {
          state.status = 'PAUSED';
          state.lastExitCode = pendingExit(state.pending.map(p => p.exitCode));
          await persist();
          return state.lastExitCode as ExitCode;
        }
        state.stage = 'WIKI';
        await persist();
      } else if (state.stage === 'WIKI') {
        const result = await wiki(runContext);
        if (result.kind === 'paused') return pause(runContext, result.pending);
        const sha = await squash(state.runWorktree, state.wiki!.stageBase!,
          `aw(${state.runId}): run WIKI 승인`);
        if (sha) await emit(runContext, 'commit', sha, 'APPROVED', state.wiki!.round);
        return done();
      } else throw new Error(`지원하지 않는 단계: ${state.stage}`);
    }
  } catch (error) {
    return pause(runContext, pending('failed', 1, '파이프라인 실행이 중단되었습니다.', String(error)));
  }
}
