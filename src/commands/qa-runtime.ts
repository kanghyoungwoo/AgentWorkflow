import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CommandLine } from '../cli.ts';
import type { ExitCode } from '../types.ts';
import { toolRoot } from '../schedule.ts';
import { checkPort } from '../qa/app-runner.ts';

export type Installer = (file: string, args: string[]) => Promise<number | null>;
const install: Installer = (file, args) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: 'inherit' });
  child.on('error', reject);
  child.on('close', resolve);
});
export async function setupQaRuntime(command: Extract<CommandLine, { command: 'qa-runtime setup' }>, deps: {
  home?: string; install?: Installer; output?: (text: string) => void;
} = {}): Promise<ExitCode> {
  const output = deps.output ?? console.log;
  try {
    const { basePort, slots } = command;
    if (!Number.isInteger(slots) || slots < 1 || slots > 32 || !Number.isInteger(basePort)
      || basePort < 1 || basePort + slots - 1 > 65535) throw new Error('QA 포트 범위가 잘못되었습니다.');
    const code = await (deps.install ?? install)(process.execPath, [
      join(toolRoot, 'node_modules/playwright/cli.js'), 'install', 'chromium',
    ]);
    if (code !== 0) throw new Error(`Chromium 설치 실패: ${code}`);
    for (let port = basePort; port < basePort + slots; port++) await checkPort(port);
    const dir = join(deps.home ?? homedir(), '.agent-workflow');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'qa-runtime.json'), JSON.stringify({ basePort, slots }, null, 2) + '\n');
    output(`QA 런타임 설정 저장: ${join(dir, 'qa-runtime.json')}`);
    return 0;
  } catch (error) { output((error as Error).message); return 2; }
}
