import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { clientFor } from '../clients/index.ts';
import type { AgentClient } from '../clients/index.ts';
import { spawnProcess } from '../clients/spawn.ts';
import { loadConfig } from '../config.ts';
import { commitAll, diffNameOnly, headSha, restore, squash } from '../git.ts';
import * as defaultAppRunner from '../qa/app-runner.ts';
import { newLoopState, readState, writeState } from '../store/state.ts';
import { appendEvent, developmentPath, fixPlanningPath, planningPath, qaDir, wikiPath } from '../store/runlog.ts';
import { parseRequest } from '../store/request.ts';
import type {
  DevAuthorOutput, ExitCode, Issue, LaneState, LoopState, Plan, PlanAuthorOutput, QaReport,
  ReviewOutput, Role, RunEvent, WikiAuthorOutput, WorkspaceConfig,
} from '../types.ts';
import { gateEvidence, gateItems, gateQaReport, gateReq, gateTests, gateWikiScope } from './gates.ts';
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
  let fixNumber = 0;
  try {
    const paths = await readdir(join(runDir, '01-planning/fix'));
    fixNumber = Math.max(0, ...paths.filter(path => /^main-\d+$/.test(path))
      .map(path => Number(path.slice(5))));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (state.lanes[0]?.phase === 'FIX_PLANNING' && state.lanes[0].loop.round === 0) fixNumber += 1;
  let activeStage = !state.setupDone ? 'SETUP' : state.stage;
  let activeLane: LaneState | undefined;
  let activeRole: Role | null = null;
  async function emit(type: RunEvent['type'], message: string, verdict: string | null = null,
    round: number | null = null, role: Role | null = null, stage: string | null = activeStage) {
    const event: RunEvent = {
      at: now().toISOString(), type, message, verdict, round, role, stage, lane: activeLane?.id ?? null,
    };
    await writeState(runDir, state);
    await appendEvent(runDir, event);
    deps.onEvent?.(event);
  }
  async function pause(value: LoopPending): Promise<ExitCode> {
    const events = await optionalText(join(runDir, 'events.jsonl')) ?? '';
    const previous = [...events.matchAll(/"message":"P-(\d+):/g)].map(m => Number(m[1]));
    const next = Math.max(0, ...previous, ...state.pending.map(p => Number(p.id.slice(2)))) + 1;
    const id = `P-${String(next).padStart(3, '0')}`;
    state.pending.push({
      ...value, id, lane: activeLane?.id ?? null, stage: activeStage, createdAt: now().toISOString(),
    });
    state.status = 'PAUSED';
    if (activeLane) activeLane.status = 'PAUSED';
    state.lastExitCode = pendingExit(state.pending.map(p => p.exitCode));
    if (value.kind === 'rate_limited') await emit('rate_limit', value.detail, value.kind, null, activeRole);
    await emit('pause', `${id}: ${value.summary}`, value.kind);
    return state.lastExitCode as ExitCode;
  }
  async function savePlan(round = activeLane?.loop.round ?? 0) {
    await saveJson(planPath, plan);
    await writeFile(join(runDir, '01-planning/plan.md'), renderPlan(plan!));
    if (state.lanes.length) {
      const path = join(runDir, '02-development/main/todo.md');
      await mkdir(dirname(path), { recursive: true });
      const previous = await optionalText(path) ?? '';
      const approvals: Record<string, number> = {};
      for (const entry of previous.split(/(?=^- \[)/m)) {
        const id = /^- \[x\] (\S+)/.exec(entry)?.[1];
        const round = /검수: 승인 \(round (\d+)\)/.exec(entry)?.[1];
        if (id && round) approvals[id] = Number(round);
      }
      await writeFile(path, renderTodo(plan!, round, approvals));
    }
  }
  async function call<T>(role: Role, schemaName: SchemaName, loop: LoopState, input: StageInputs,
    path: string, writable = false) {
    activeRole = role;
    await mkdir(dirname(path), { recursive: true });
    const outcome = await invoke<T>({
      client: (deps.clientFor ?? clientFor)(config, role), schemaName,
      guardDir: writable ? null : activeLane?.worktree ?? state.runWorktree,
      makeCall: async (_attempt, error) => {
        if (deps.interrupted?.()) throw new Error('시그널로 실행이 중단되었습니다.');
        const value = await makeAgentCall(role, {
          config, state, runDir, loop, lane: activeLane?.id ?? null, stage: activeStage, inputs: input, error,
        });
        await writeState(runDir, state);
        return value;
      },
      afterAttempt: writable ? async () => {
        const sha = await commitAll(activeLane?.worktree ?? state.runWorktree,
          `aw(${state.runId}): wip ${activeLane?.id ?? 'run'} ${activeStage} r${loop.round}`);
        if (sha) await emit('commit', sha, 'WIP', loop.round);
      } : undefined,
    });
    if (outcome.kind === 'ok') await saveJson(path, outcome.output);
    if (deps.interrupted?.()) throw new Error('시그널로 실행이 중단되었습니다.');
    return outcome;
  }
  async function loopEmit(event: Omit<RunEvent, 'at'>) {
    await emit(event.type, event.message, event.verdict, event.round,
      event.type === 'author' || event.type === 'review' ? activeRole : null);
  }
  async function planning(fix: boolean) {
    const loop = fix ? activeLane!.loop : state.planning;
    const defects = fix ? JSON.parse(await readFile(
      join(qaDir(runDir, 'main', activeLane!.qaAttempt), 'report.json'), 'utf8')).defects : undefined;
    const inputs: StageInputs = {
      context: {}, request, ...(fix ? { plan: plan!, defects } : {}),
      decisions: [...(activeLane?.decisions ?? []), ...loop.decisions],
    };
    const path = (kind: string) => fix
      ? fixPlanningPath(runDir, 'main', fixNumber, loop.round, kind)
      : planningPath(runDir, loop.round, kind);
    return runReviewLoop<PlanAuthorOutput>(loop, config.limits, {
      author: async () => {
        inputs.context = {
          mode: fix ? 'fix' : 'initial', parallel: false, maxLanes: config.limits.maxLanes,
          hasApp: config.app !== null, round: loop.round, lane: activeLane?.id ?? null,
        };
        return call('planningAuthor', 'plan-author', loop, inputs, path('author'));
      },
      gates: async output => {
        const finding = gateReq(output, {
          mode: fix ? 'fix' : 'initial', reqIds, hasApp: config.app !== null, parallel: false,
          plan, defectIds: defects?.map((d: { id: string }) => d.id) ?? [],
        });
        const issues = finding ? [finding] : [];
        await saveJson(path('gate'), issues);
        return issues;
      },
      review: output => call<ReviewOutput>('planningReviewer', 'review', loop,
        { ...inputs, output }, path('review')),
      emit: loopEmit,
    });
  }
  async function development(lane: LaneState) {
    const loop = lane.loop;
    loop.stageBase ??= await headSha(lane.worktree);
    await writeState(runDir, state);
    const targets = plan!.todos.filter(t => t.lane === lane.id && !t.approved);
    const path = (kind: string, ext = 'json') => developmentPath(runDir, lane.id, loop.round, kind, ext,
      fixNumber || undefined);
    let testResult = '(테스트 명령 없음)';
    return runReviewLoop<DevAuthorOutput>(loop, config.limits, {
      author: async () => {
        const result = await call<DevAuthorOutput>('devAuthor', 'dev-author', loop, {
          context: {
            lane: lane.id, ownedPaths: null, interfaces: null, testCommand: config.testCommand, round: loop.round,
          },
          targets: targets.map(t => ({ id: t.id, text: t.text })),
          approved: plan!.todos.filter(t => t.approved).map(t => ({ id: t.id, text: t.text })),
          decisions: [...lane.decisions, ...loop.decisions],
        }, path('author'), true);
        if (result.kind === 'ok') {
          for (const item of result.output.items) {
            const target = targets.find(t => t.id === item.id);
            if (target) { target.checked = item.checked; target.evidence = item.evidence; }
          }
          await savePlan();
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
          await emit('tests', testResult, tests ? 'FAIL' : 'PASS', loop.round);
        }
        const issues = [items, evidence, tests].filter((value): value is Issue => value !== null);
        await saveJson(path('gate'), issues);
        return issues;
      },
      review: output => call<ReviewOutput>('devReviewer', 'review', loop, {
        context: { lane: lane.id, stageBase: loop.stageBase, ownedPaths: null }, request,
        targets: targets.map(t => ({ id: t.id, text: t.text, checked: t.checked, evidence: t.evidence })),
        testResult, notes: output.notes, decisions: [...lane.decisions, ...loop.decisions],
      }, path('review')),
      emit: loopEmit,
    });
  }
  async function qa(lane: LaneState): Promise<QaOutcome> {
    const scenarios = plan!.qaScenarios;
    lane.qaAttempt += 1;
    let directory = qaDir(runDir, lane.id, lane.qaAttempt);
    const prepareDirectory = async () => {
      await mkdir(join(directory, 'scripts'), { recursive: true });
      await mkdir(join(directory, 'evidence'), { recursive: true });
      await writeState(runDir, state);
    };
    await prepareDirectory();
    if (!scenarios.length) {
      await emit('skip', '시나리오 0/0 PASS, 결함 없음 (skipped: QA 시나리오 없음)', 'PASS', lane.qaAttempt);
      return { kind: 'skipped' };
    }
    let handle: defaultAppRunner.AppHandle | null = null;
    const automatic: { outcome: QaOutcome | null } = { outcome: null };
    let baseUrl = 'none';
    const start = async () => {
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
      activeRole = 'qa';
      const result = await invoke<QaReport>({
        client: (deps.clientFor ?? clientFor)(config, 'qa'), schemaName: 'qa-report', guardDir: lane.worktree,
        makeCall: async (attempt, error) => {
          if (attempt === 2) { lane.qaAttempt += 1; directory = qaDir(runDir, lane.id, lane.qaAttempt); }
          await prepareDirectory();
          await start();
          const call = await makeAgentCall('qa', {
            config, state, runDir, loop: lane.loop, lane: lane.id, stage: 'QA', error,
            inputs: {
              context: {
                scope: lane.id, worktree: lane.worktree, baseUrl, qaDir: directory,
                playwrightUrl: appRunner.playwrightUrl(),
              }, scenarios, decisions: lane.decisions,
            },
          });
          await writeState(runDir, state);
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
      await emit('qa', eventMessage(message), report.status, lane.qaAttempt, 'qa');
    } else if (outcome.kind !== 'skipped') {
      await emit('qa', eventMessage(`${outcome.kind}: ${outcome.detail}`),
        outcome.kind === 'environment' ? 'BLOCKED' : outcome.kind, lane.qaAttempt, 'qa');
    }
    return outcome;
  }
  async function wiki() {
    const loop = state.wiki ??= newLoopState();
    loop.stageBase ??= await headSha(state.runWorktree);
    await writeState(runDir, state);
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
        return call('wikiAuthor', 'wiki-author', loop, inputs, path('author'), true);
      },
      gates: async output => {
        const finding = await gateWikiScope(output, {
          cwd: state.runWorktree, stageBase: loop.stageBase!, wikiDir: config.wikiDir,
        });
        const issues = finding ? [finding] : [];
        await saveJson(path('gate'), issues);
        return issues;
      },
      review: async output => call<ReviewOutput>('wikiReviewer', 'review', loop, {
        ...inputs, output, index: await optionalText(join(state.runWorktree, config.wikiDir, 'index.md')),
      }, path('review')),
      emit: loopEmit,
    });
  }
  async function done(): Promise<ExitCode> {
    state.status = 'DONE'; state.stage = 'DONE'; state.lastExitCode = 0;
    activeLane = undefined;
    await emit('done', '런을 완료했습니다.', null, null, null, null);
    return 0;
  }
  if (state.status === 'DONE') return 0;
  if (state.pending.length) return pendingExit(state.pending.map(p => p.exitCode));
  try {
    if (!state.setupDone) {
      activeStage = 'SETUP';
      if (config.setupCommand) {
        const files = await readdir(runDir);
        const attempt = Math.max(0, ...files.filter(path => /^setup-\d+\.log$/.test(path))
          .map(path => Number(path.slice(6, -4)))) + 1;
        const logPath = join(runDir, `setup-${attempt}.log`);
        await writeState(runDir, state);
        const result = await spawnProcess({
          command: 'sh', args: ['-c', config.setupCommand], cwd: state.runWorktree, stdin: '',
          timeoutMs: config.limits.stepTimeoutMin * 60_000, stdoutPath: logPath, stderrPath: logPath,
        });
        if (deps.interrupted?.()) throw new Error('시그널로 실행이 중단되었습니다.');
        if (result.exitCode !== 0 || result.timedOut) {
          return pause(pending('environment', 20, 'SETUP 실행에 실패했습니다.',
            (await readFile(logPath, 'utf8')).split('\n').slice(-200).join('\n')));
        }
      }
      state.setupDone = true;
      await emit('setup', 'SETUP을 완료했습니다.', 'PASS');
    }
    while (true) {
      activeStage = state.stage;
      activeRole = null;
      if (deps.interrupted?.()) throw new Error('시그널로 실행이 중단되었습니다.');
      if (state.stage === 'PLANNING') {
        const result = await planning(false);
        if (result.kind === 'paused') return pause(result.pending);
        plan = {
          summary: result.output.summary, lanes: null,
          todos: result.output.todos.map(t => ({
            ...t, lane: 'main', checked: false, evidence: null, approved: false,
          })), qaScenarios: result.output.qaScenarios.map(s => ({ ...s, lane: null })),
        };
        state.lanes = [{
          id: 'main', branch: state.runBranch, worktree: state.runWorktree, ownedPaths: null, portSlot: 0,
          setupDone: true, phase: 'DEV', loop: newLoopState(), decisions: [], qaAttempt: 0,
          qaRollbacks: 0, status: 'ACTIVE',
        }];
        await savePlan();
        state.stage = 'LANES';
        await writeState(runDir, state);
        if (state.mode === 'plan') return done();
      } else if (state.stage === 'LANES') {
        const lane = activeLane = state.lanes[0];
        activeStage = lane.phase;
        if (lane.phase === 'DEV') {
          const targets = plan!.todos.filter(t => !t.approved);
          if (targets.length) {
            const result = await development(lane);
            if (result.kind === 'paused') return pause(result.pending);
            const sha = await squash(lane.worktree, lane.loop.stageBase!,
              `aw(${state.runId}): main DEV 승인 (${targets.map(t => t.id).join(',')})`);
            for (const target of targets) target.approved = true;
            await savePlan();
            if (sha) await emit('commit', sha, 'APPROVED', lane.loop.round);
          }
          lane.phase = 'QA'; lane.loop = newLoopState();
          await writeState(runDir, state);
        } else if (lane.phase === 'QA') {
          const outcome = await qa(lane);
          const decision = decideQa(lane, outcome, config.limits);
          if (decision.next === 'paused') return pause(decision.pending);
          if (decision.next === 'fix') {
            fixNumber += 1; lane.phase = 'FIX_PLANNING'; lane.loop = newLoopState();
          }
          else { lane.phase = 'DONE'; lane.status = 'DONE'; state.stage = 'WIKI'; }
          await writeState(runDir, state);
        } else if (lane.phase === 'FIX_PLANNING') {
          const result = await planning(true);
          if (result.kind === 'paused') return pause(result.pending);
          const nextId = (prefix: string, ids: string[]) => `${prefix}-${String(
            Math.max(0, ...ids.filter(id => id.startsWith(prefix + '-')).map(id => Number(id.split('-')[1]))) + 1,
          ).padStart(3, '0')}`;
          for (const todo of result.output.todos) {
            const id = nextId('FIX', plan!.todos.map(t => t.id));
            plan!.todos.push({ ...todo, id, lane: 'main', checked: false, evidence: null, approved: false });
            await emit('renumber', `${todo.id} → ${id}`);
          }
          for (const scenario of result.output.qaScenarios) {
            const id = nextId('QA', plan!.qaScenarios.map(s => s.id));
            plan!.qaScenarios.push({ ...scenario, id, lane: null });
            await emit('renumber', `${scenario.id} → ${id}`);
          }
          await savePlan();
          lane.phase = 'DEV'; lane.loop = newLoopState();
          await writeState(runDir, state);
        } else throw new Error(`지원하지 않는 레인 단계: ${lane.phase}`);
      } else if (state.stage === 'WIKI') {
        activeLane = undefined;
        const result = await wiki();
        if (result.kind === 'paused') return pause(result.pending);
        const sha = await squash(state.runWorktree, state.wiki!.stageBase!,
          `aw(${state.runId}): run WIKI 승인`);
        if (sha) await emit('commit', sha, 'APPROVED', state.wiki!.round);
        return done();
      } else throw new Error(`지원하지 않는 단계: ${state.stage}`);
    }
  } catch (error) {
    return pause(pending('failed', 1, '파이프라인 실행이 중단되었습니다.', String(error)));
  }
}
