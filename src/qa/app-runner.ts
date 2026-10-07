import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { killProcessGroup, trackChild, untrackChild } from '../clients/spawn.ts';
import type { WorkspaceConfig } from '../types.ts';

export async function portForSlot(slot: number, maxLanes: number, home = homedir()): Promise<number> {
  let runtime = { basePort: 4100, slots: maxLanes + 1 };
  try { runtime = JSON.parse(await readFile(`${home}/.agent-workflow/qa-runtime.json`, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const port = runtime.basePort + slot;
  if (!Number.isInteger(slot) || slot < 0 || slot >= runtime.slots
    || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('QA 포트 슬롯이 범위 밖입니다.');
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', error => reject(new Error(`QA 포트 ${port}를 사용할 수 없습니다: ${error.message}`)));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
  });
  return port;
}
export type AppHandle = { pid: number };
export async function startApp(options: {
  worktree: string; app: NonNullable<WorkspaceConfig['app']>; port: number; logPath: string;
}): Promise<AppHandle> {
  await mkdir(dirname(options.logPath), { recursive: true });
  const log = await open(options.logPath, 'w');
  const replace = (value: string) => value.replaceAll('{port}', String(options.port));
  const child = spawn('sh', ['-c', replace(options.app.startCommand)], {
    cwd: options.worktree, detached: true, stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, PORT: String(options.port) },
  });
  if (child.pid) trackChild(child.pid);
  let failed: string | null = null;
  child.once('error', error => { failed = error.message; });
  child.once('exit', (code, signal) => { failed = `앱이 먼저 종료했습니다: ${code ?? signal}`; });
  await log.close();
  const deadline = Date.now() + options.app.startTimeoutSec * 1000;
  try {
    while (Date.now() < deadline) {
      if (failed !== null) throw new Error(failed);
      try {
        const response = await fetch(replace(options.app.readyUrl), {
          signal: AbortSignal.timeout(Math.max(1, Math.min(500, deadline - Date.now()))),
        });
        await response.body?.cancel();
        if (response.ok && failed === null) return { pid: child.pid! };
      } catch {}
      await delay(50);
    }
    throw new Error(failed ?? '앱 준비 시간이 초과되었습니다.');
  } catch (error) {
    if (child.pid) { await killProcessGroup(child.pid); untrackChild(child.pid); }
    throw error;
  }
}
export async function stopApp(app: AppHandle): Promise<void> {
  await killProcessGroup(app.pid);
  untrackChild(app.pid);
}
export async function chromiumAvailable(): Promise<boolean> {
  const { chromium } = await import('playwright');
  try { await access(chromium.executablePath()); return true; } catch { return false; }
}
export function playwrightUrl(): string {
  return new URL('../../node_modules/playwright/index.mjs', import.meta.url).href;
}
