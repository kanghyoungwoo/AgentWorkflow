import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawnProcess } from '../clients/spawn.ts';
import { diffNameOnly } from '../git.ts';
import type { DevAuthorOutput, Issue, Lane, Plan, PlanAuthorOutput, QaReport, WikiAuthorOutput } from '../types.ts';

function issue(code: string, problems: string[]): Issue | null {
  return problems.length ? {
    id: `GATE-${code}`, target: 'general', problem: problems.join('\n'),
    requiredChange: '나열된 문제를 모두 수정하고 다시 제출하세요.',
  } : null;
}
function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}
function setProblems(actual: string[], expected: string[], label: string): string[] {
  const problems: string[] = [];
  const missing = expected.filter(id => !actual.includes(id));
  const extra = actual.filter(id => !expected.includes(id));
  const repeated = duplicates(actual);
  if (missing.length) problems.push(`${label}에 없는 대상: ${missing.join(', ')}`);
  if (extra.length) problems.push(`대상이 아닌 항목(${label}): ${extra.join(', ')}`);
  if (repeated.length) problems.push(`${label} 중복: ${repeated.join(', ')}`);
  return problems;
}
function outside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
}
const normalize = (path: string) => path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
function under(path: string, root: string): boolean {
  const a = normalize(path), b = normalize(root);
  return a === b || a.startsWith(b + '/') || b === '.' || b === '';
}
async function file(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}
export function gateReq(output: PlanAuthorOutput, options: {
  mode: 'initial' | 'fix'; reqIds: string[]; hasApp: boolean; parallel: boolean;
  plan: Plan | null; defectIds: string[];
}): Issue | null {
  const problems: string[] = [];
  const fix = options.mode === 'fix';
  const ids = output.todos.map(todo => todo.id);
  const qaIds = output.qaScenarios.map(scenario => scenario.id);
  const invalidTodos = ids.filter(id => !(fix ? /^FIX-\d{3}$/ : /^DEV-\d{3}$/).test(id));
  const invalidScenarios = qaIds.filter(id => !/^QA-\d{3}$/.test(id));
  if (invalidTodos.length) problems.push(`TODO id 형식 오류: ${invalidTodos.join(', ')}`);
  if (invalidScenarios.length) problems.push(`시나리오 id 형식 오류: ${invalidScenarios.join(', ')}`);
  const repeated = [...duplicates(ids), ...duplicates(qaIds)];
  if (repeated.length) problems.push(`id 중복: ${repeated.join(', ')}`);
  if (fix && !ids.length) problems.push('fix TODO가 1개 이상 필요합니다: todos=[]');
  for (const entry of [...output.todos, ...output.qaScenarios]) {
    if ('defectIds' in entry && !entry.reqIds.length) {
      problems.push(`${entry.id}: REQ가 1개 이상 필요합니다: reqIds=[]`);
    }
    for (const id of entry.reqIds) {
      if (!options.reqIds.includes(id)) problems.push(`${entry.id}: 알 수 없는 REQ ${id}`);
    }
  }
  if (!fix) {
    for (const id of options.reqIds) {
      if (!output.todos.some(todo => todo.reqIds.includes(id))) problems.push(`REQ 누락: ${id}`);
    }
  } else {
    for (const id of options.defectIds) {
      if (!output.todos.some(todo => todo.defectIds.includes(id))) problems.push(`결함 미대응: ${id}`);
    }
  }
  if (!options.hasApp) {
    for (const scenario of output.qaScenarios.filter(s => s.type === 'browser')) {
      problems.push(`${scenario.id}: 앱 설정 없이 browser 시나리오를 사용할 수 없습니다: hasApp=false`);
    }
  }
  if (fix || !options.parallel) {
    if (output.lanes !== null) {
      problems.push(`이 모드에서는 lanes가 null이어야 합니다: lanes=${JSON.stringify(output.lanes)}`);
    }
    for (const entry of [...output.todos, ...output.qaScenarios].filter(entry => entry.lane !== null)) {
      problems.push(`${entry.id}: 이 모드에서는 lane이 null이어야 합니다: lane=${entry.lane}`);
    }
  }
  return issue('REQ', problems);
}
export function gateLanes(output: PlanAuthorOutput, options: { maxLanes: number }): Issue | null {
  const lanes = output.lanes ?? [];
  const problems: string[] = [];
  if (!lanes.length || lanes.length > options.maxLanes) {
    problems.push(`레인 수가 허용 범위를 벗어났습니다: ${lanes.length}, 허용 1~${options.maxLanes}`);
  }
  const ids = lanes.map(lane => lane.id);
  const invalid = ids.filter(id => !/^[a-h]$/.test(id));
  if (invalid.length) problems.push(`레인 id 형식 오류: ${invalid.join(', ')}`);
  const repeated = duplicates(ids);
  if (repeated.length) problems.push(`레인 id 중복: ${repeated.join(', ')}`);
  for (const entry of [...output.todos, ...output.qaScenarios.filter(s => s.lane !== null)]) {
    if (entry.lane === null || !ids.includes(entry.lane)) {
      problems.push(`${entry.id}: 없는 레인 참조: lane=${entry.lane}`);
    }
  }
  for (const lane of lanes) {
    if (!lane.ownedPaths.length) problems.push(`${lane.id}: ownedPaths가 비었습니다: ownedPaths=[]`);
    for (const path of lane.ownedPaths) {
      if (!path || /[*?\[]/.test(path) || isAbsolute(path) || path.split('/').includes('..')) {
        problems.push(`${lane.id}: 허용되지 않는 ownedPaths ${JSON.stringify(path)}`);
      }
    }
  }
  return issue('LANES', problems);
}
export function lanesOverlap(lanes: Lane[]): boolean {
  if (lanes.length === 1) return true;
  return lanes.some((lane, index) => lanes.slice(index + 1).some(other =>
    lane.ownedPaths.some(a => other.ownedPaths.some(b => under(a, b) || under(b, a)))));
}
export function gateItems(output: DevAuthorOutput, targetIds: string[]): Issue | null {
  const problems = setProblems(output.items.map(item => item.id), targetIds, 'items');
  if (output.status === 'DONE') {
    for (const item of output.items) {
      if (!item.checked || !item.evidence?.files.length) problems.push(
        `${item.id}: 완료 표시 또는 증거가 없습니다: checked=${item.checked}, evidence=${JSON.stringify(item.evidence)}`,
      );
    }
  }
  return issue('ITEMS', problems);
}
export async function gateEvidence(
  output: DevAuthorOutput, options: { cwd: string; stageBase: string },
): Promise<Issue | null> {
  const problems: string[] = [];
  const paths = output.items.flatMap(item => item.evidence?.files ?? []);
  const root = await realpath(options.cwd);
  for (const path of paths) {
    const resolved = resolve(root, path);
    if (isAbsolute(path) || outside(root, resolved)) {
      problems.push(`worktree 밖 증거: ${path}`);
      continue;
    }
    try {
      const actual = await realpath(resolved);
      if (outside(root, actual)) problems.push(`worktree 밖 증거: ${path}`);
      else if (!await file(actual)) problems.push(`증거 파일 없음: ${path}`);
    } catch { problems.push(`증거 파일 없음: ${path}`); }
  }
  const changed = await diffNameOnly(options.cwd, options.stageBase);
  if (!paths.some(path => changed.includes(normalize(path)))) {
    problems.push(`증거가 단계 변경 파일에 포함되지 않습니다: 증거=${JSON.stringify(paths)}, 변경=${JSON.stringify(changed)}`);
  }
  return issue('EVIDENCE', problems);
}
export async function gateTests(options: {
  cwd: string; testCommand: string | null; timeoutMs: number; logPath: string;
}): Promise<Issue | null> {
  if (options.testCommand === null) return null;
  await mkdir(dirname(options.logPath), { recursive: true });
  let failure: string | null = null;
  try {
    const result = await spawnProcess({
      command: 'sh', args: ['-c', options.testCommand], stdin: '', cwd: options.cwd,
      timeoutMs: options.timeoutMs, stdoutPath: options.logPath, stderrPath: options.logPath,
    });
    if (result.exitCode !== 0 || result.timedOut) {
      failure = `테스트 실패: 종료 코드 ${result.exitCode}, 타임아웃 ${result.timedOut}, 명령=${options.testCommand}`;
    }
  } catch (error) {
    failure = `테스트 실행 오류: ${String(error)}, 명령=${options.testCommand}`;
  }
  const tail = (await readFile(options.logPath, 'utf8')).replace(/\n$/, '').split('\n').slice(-200).join('\n');
  return issue('TESTS', failure === null ? [] : [failure, tail]);
}
export async function gateOwned(options: {
  cwd: string; stageBase: string; ownedPaths: string[];
}): Promise<Issue | null> {
  const paths = await diffNameOnly(options.cwd, options.stageBase);
  return issue('OWNED', paths.filter(path => !options.ownedPaths.some(root => under(path, root)))
    .map(path => `레인 소유 범위 밖 변경: ${path}`));
}
export async function gateWikiScope(output: WikiAuthorOutput, options: {
  cwd: string; stageBase: string; wikiDir: string;
}): Promise<Issue | null> {
  const changed = await diffNameOnly(options.cwd, options.stageBase);
  const docs = output.docs.map(doc => normalize(doc.path));
  const problems = changed.filter(path => !under(path, options.wikiDir)).map(path => `Wiki 범위 밖 변경: ${path}`);
  problems.push(...setProblems(docs, changed, 'docs 경로 집합'));
  const logPath = normalize(options.wikiDir) + '/log.md';
  if (!docs.includes(logPath)) problems.push(`Wiki log.md가 누락되었습니다: ${logPath}`);
  return issue('WIKI-SCOPE', problems);
}
export async function gateQaReport(report: QaReport, options: {
  scenarioIds: string[]; qaDir: string;
}): Promise<string | null> {
  const problems = setProblems(report.scenarios.map(s => s.id), options.scenarioIds, '시나리오');
  const pass = report.scenarios.every(s => s.result === 'PASS') && report.defects.length === 0;
  if ((report.status === 'PASS') !== pass) {
    const results = report.scenarios.map(s => `${s.id}=${s.result}`).join(', ');
    const defects = report.defects.map(d => d.id).join(', ');
    problems.push(`PASS 판정과 시나리오·결함의 일관성이 맞지 않습니다: status=${report.status}`
      + `, 시나리오=[${results}], defects=[${defects}]`);
  }
  if (report.status === 'FAIL' && !report.defects.length) {
    problems.push('FAIL에는 결함이 1개 이상 필요합니다: status=FAIL, defects=[]');
  }
  const entries = [...report.scenarios, ...report.exploratory, ...report.defects];
  for (const entry of entries) {
    const label = 'id' in entry ? entry.id : entry.title;
    if (!entry.evidence.length) problems.push(`${label}: 증거가 1개 이상 필요합니다: evidence=[]`);
    for (const path of entry.evidence) {
      try {
        const root = await realpath(options.qaDir);
        const resolved = await realpath(resolve(root, path));
        const rel = relative(root, resolved);
        if (isAbsolute(path) || rel === '..' || rel.startsWith('../') || !await file(resolved)) {
          problems.push(`${label}: QA 디렉터리 밖 또는 유효하지 않은 증거: ${path}`);
        }
      } catch { problems.push(`${label}: 증거 파일 없음: ${path}`); }
    }
  }
  return problems.length ? problems.join('\n') : null;
}
