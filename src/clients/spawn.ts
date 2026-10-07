import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, stat } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const children = new Set<number>();
export async function resolveExecutable(name: string): Promise<string | null> {
  const candidates = name.includes('/') ? [resolve(name)]
    : (process.env.PATH ?? '').split(delimiter).map(dir => resolve(dir || '.', name));
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch {}
  }
  return null;
}
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
export async function killProcessGroup(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('유효한 자식 pid가 필요합니다.');
  if (!signalGroup(pid, 'SIGTERM')) return;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!signalGroup(pid, 0)) return;
    await delay(50);
  }
  signalGroup(pid, 'SIGKILL');
}
export async function killAllChildren(): Promise<void> {
  await Promise.all([...children].map(killProcessGroup));
}
export type SpawnOptions = {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
  stdoutPath: string;
  stderrPath: string;
  env?: NodeJS.ProcessEnv;
};
export type SpawnResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
};
export async function spawnProcess(options: SpawnOptions): Promise<SpawnResult> {
  const started = performance.now();
  const stdout = await open(options.stdoutPath, 'w');
  try {
    const stderr = await open(options.stderrPath, 'w');
    try {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd, env: options.env, shell: false, detached: true,
        stdio: ['pipe', stdout.fd, stderr.fd],
      });
      const pid = child.pid;
      if (pid !== undefined) children.add(pid);
      let timedOut = false;
      let termination: Promise<void> | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        if (pid !== undefined) termination = killProcessGroup(pid);
      }, options.timeoutMs);
      // 조기 종료한 CLI에 큰 프롬프트를 쓰면 EPIPE가 날 수 있다.
      child.stdin!.on('error', () => {});
      try {
        const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
          (resolveResult, reject) => {
            child.once('error', reject);
            child.once('close', (exitCode, signal) => resolveResult({ exitCode, signal }));
            child.stdin!.end(options.stdin);
          },
        );
        await termination;
        return { ...result, timedOut, durationMs: Math.round(performance.now() - started) };
      } finally {
        clearTimeout(timer);
        if (pid !== undefined) children.delete(pid);
      }
    } finally {
      await stderr.close();
    }
  } finally {
    await stdout.close();
  }
}
