import type { Plan, QaReport } from '../types.ts';

const cell = (value: string) => value.replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
export function renderPlan(plan: Plan): string {
  const todos = plan.todos.map(t => `| ${t.id} | ${t.lane} | ${cell(t.text)} | ${t.reqIds.join(', ')} |`);
  const scenarios = plan.qaScenarios.map(s =>
    `| ${s.id} | ${cell(s.title)} | ${s.type} | ${s.lane ?? '-'} | `
    + `${cell(s.steps.join('\n'))} | ${cell(s.expected.join('\n'))} |`);
  let text = `# 계획\n\n${plan.summary}\n\n## TODO\n\n`
    + '| id | lane | 문구 | reqIds |\n| --- | --- | --- | --- |\n' + todos.join('\n')
    + '\n\n## QA 시나리오\n\n| id | 제목 | type | lane | 단계 | 기대 결과 |\n'
    + '| --- | --- | --- | --- | --- | --- |\n' + scenarios.join('\n') + '\n';
  if (plan.lanes) text += '\n## 레인\n\n' + plan.lanes.map(l =>
    `- ${l.id}: ${l.title}\n  ownedPaths: ${l.ownedPaths.join(', ')}\n  interfaces: ${l.interfaces}`).join('\n') + '\n';
  return text;
}
export function renderTodo(plan: Plan, round: number, approvals: Record<string, number> = {}): string {
  return plan.todos.filter(t => t.lane === 'main').map(t => {
    let text = `- [${t.checked ? 'x' : ' '}] ${t.id} ${t.text}\n`;
    if (t.evidence) text += `    완료 근거: ${t.evidence.summary} (files: ${t.evidence.files.join(', ')})\n`;
    if (t.approved) text += `    검수: 승인 (round ${approvals[t.id] ?? round})\n`;
    return text;
  }).join('');
}
export function renderReport(report: QaReport): string {
  return `# QA\n\nstatus: ${report.status}\n\n| id | result | observed | evidence |\n`
    + '| --- | --- | --- | --- |\n' + report.scenarios.map(s =>
      `| ${s.id} | ${s.result} | ${cell(s.observed)} | ${s.evidence.join(', ')} |`).join('\n')
    + '\n\n## 탐색\n\n' + report.exploratory.map(e =>
      `- ${e.title}: ${e.result}\n  ${e.observed}\n  evidence: ${e.evidence.join(', ')}`).join('\n')
    + '\n\n## 결함\n\n' + report.defects.map(d =>
      `- ${d.id}: ${d.title}\n  재현: ${d.reproduction.join(' → ')}\n`
      + `  기대: ${d.expected}\n  실제: ${d.actual}\n  evidence: ${d.evidence.join(', ')}`).join('\n') + '\n';
}
