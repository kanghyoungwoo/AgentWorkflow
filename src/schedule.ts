import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const toolRoot = fileURLToPath(new URL('../', import.meta.url));
export type Executor = (file: string, args: string[], input?: string) => Promise<{
  code: number | null; stdout: string; stderr: string;
}>;
export const execute: Executor = (file, args, input) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.stdin.on('error', () => {});
  child.on('close', code => resolve({ code, stdout, stderr }));
  child.stdin.end(input);
});
export function atTimestamp(date: Date): string {
  const rounded = new Date(date);
  if (rounded.getSeconds() || rounded.getMilliseconds()) rounded.setMinutes(rounded.getMinutes() + 1);
  rounded.setSeconds(0, 0);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return pad(rounded.getFullYear(), 4) + pad(rounded.getMonth() + 1) + pad(rounded.getDate())
    + pad(rounded.getHours()) + pad(rounded.getMinutes());
}
export function parseAtJobId(stderr: string): number | null {
  const match = /\bjob (\d+) at\b/.exec(stderr);
  return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
}
export async function atAvailable(exec: Executor = execute): Promise<boolean> {
  try {
    const found = await exec('sh', ['-c', 'command -v at']);
    if (found.code !== 0 || !found.stdout.trim()) return false;
    const daemon = await exec('systemctl', ['is-active', 'atd']);
    return daemon.code === 0 && daemon.stdout.trim() === 'active';
  } catch { return false; }
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export async function scheduleResume(options: {
  runId: string; workspace: string; at: Date;
}, exec: Executor = execute): Promise<{ atJobId: number; at: string } | null> {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(options.runId) || !Number.isFinite(options.at.getTime())) return null;
    const command = `${quote(process.execPath)} ${quote(join(toolRoot, 'bin/agent-workflow.mjs'))} `
      + `resume ${options.runId} --workspace ${quote(options.workspace)} `
      + `>> ${quote(join(options.workspace, 'ai-log', options.runId, 'scheduled-resume.log'))} 2>&1\n`;
    const result = await exec('at', ['-t', atTimestamp(options.at)], command);
    const atJobId = parseAtJobId(result.stderr);
    return result.code === 0 && atJobId !== null ? { atJobId, at: options.at.toISOString() } : null;
  } catch { return null; }
}
export async function cancelResume(atJobId: number, exec: Executor = execute): Promise<void> {
  try { await exec('atrm', [String(atJobId)]); } catch {}
}
