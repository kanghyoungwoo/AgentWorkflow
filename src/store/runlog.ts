import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunEvent, Role } from '../types.ts';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
export function localTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
export function isValidSlug(name: string): boolean {
  return /^[a-z0-9-]+$/.test(name);
}
export function makeRunId(name: string, now = new Date()): string {
  return `${localTime(now).replaceAll('-', '').replace(' ', '_').replaceAll(':', '')}_${name}`;
}
export function runDir(workspace: string, runId: string): string {
  return join(workspace, 'ai-log', runId);
}
export function planningPath(dir: string, round: number, kind: string): string {
  return join(dir, '01-planning', `round-${pad(round)}.${kind}.json`);
}
export function fixPlanningPath(dir: string, lane: string, fix: number, round: number, kind: string): string {
  return join(dir, '01-planning', 'fix', `${lane}-${fix}`, `round-${pad(round)}.${kind}.json`);
}
export function developmentPath(
  dir: string, lane: string, round: number, kind: string, ext: string, fix?: number,
): string {
  return join(
    dir, '02-development', lane,
    ...(fix === undefined ? [] : [`fix-${fix}`]), `round-${pad(round)}.${kind}.${ext}`,
  );
}
export function qaDir(dir: string, lane: string, attempt: number): string {
  return join(dir, '03-qa', lane, `attempt-${pad(attempt)}`);
}
export function wikiPath(dir: string, round: number, kind: string): string {
  return join(dir, '04-wiki', `round-${pad(round)}.${kind}.json`);
}
export function rawPrefix(
  dir: string, seq: number, lane: string | null, stage: string, role: Role, round: number,
): string {
  return join(dir, 'raw', `${pad(seq, 4)}-${lane ?? 'run'}-${stage}-${role}-r${pad(round)}`);
}
export async function initRunDir(workspace: string, runId: string, requestText: string | null): Promise<string> {
  const dir = runDir(workspace, runId);
  await mkdir(join(workspace, 'ai-log'), { recursive: true });
  try {
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`런 디렉터리가 이미 있습니다: ${runId}`);
    throw error;
  }
  await mkdir(join(dir, 'raw'));
  if (requestText !== null) {
    await mkdir(join(dir, '00-request'));
    await writeFile(join(dir, '00-request', 'request.md'), requestText);
  }
  return dir;
}
const header = '| 시각 | 레인 | 단계 | 역할 | 판정 | 내용 |\n| --- | --- | --- | --- | --- | --- |\n';
function renderRow(event: RunEvent): string {
  const cell = (value: string | null) => (value ?? '-').replaceAll('|', '\\|').replace(/\r\n|\r|\n/g, ' ');
  return `| ${[
    localTime(new Date(event.at)), event.lane, event.stage, event.role, event.verdict, event.message,
  ].map(cell).join(' | ')} |\n`;
}
export function renderTimeline(events: RunEvent[]): string {
  return header + events.map(renderRow).join('');
}
export async function readEvents(dir: string): Promise<RunEvent[]> {
  try {
    return (await readFile(join(dir, 'events.jsonl'), 'utf8'))
      .split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
export async function appendEvent(dir: string, event: RunEvent): Promise<void> {
  await appendFile(join(dir, 'events.jsonl'), JSON.stringify(event) + '\n');
  try {
    await writeFile(join(dir, 'timeline.md'), header, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await appendFile(join(dir, 'timeline.md'), renderRow(event));
}

export function formatEvent(event: RunEvent): string {
  return `${localTime(new Date(event.at))} ${event.lane ?? 'run'} ${event.stage ?? '-'} `
    + `${event.role ?? '-'} ${event.type} ${event.verdict ?? '-'} ${event.message.replace(/\r\n|\r|\n/g, ' ')}`;
}
export function printEvent(event: RunEvent): void {
  console.log(formatEvent(event));
}
export function validateRunId(runId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('잘못된 run-id입니다.');
}
