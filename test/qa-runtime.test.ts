import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setupQaRuntime } from '../src/commands/qa-runtime.ts';
import { temp } from './inspect-fixtures.ts';

async function portServer() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  const close = () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  return { port, close };
}
test('가짜 설치 실행기와 임시 홈에 runtime JSON 저장', async t => {
  const home = await temp(t);
  const server = await portServer();
  await server.close();
  const installs: string[][] = [];
  assert.equal(await setupQaRuntime({
    command: 'qa-runtime setup', workspace: home, slots: 1, basePort: server.port,
  }, { home, install: async (file, args) => { installs.push([file, ...args]); return 0; }, output: () => {} }), 0);
  assert.equal(installs[0][0], process.execPath);
  assert.ok(installs[0][1].endsWith('/node_modules/playwright/cli.js'));
  assert.deepEqual(installs[0].slice(2), ['install', 'chromium']);
  assert.deepEqual(JSON.parse(await readFile(join(home, '.agent-workflow/qa-runtime.json'), 'utf8')), {
    basePort: server.port, slots: 1,
  });
});
test('포트 점유와 설치 실패는 2, 설정을 쓰지 않음', async t => {
  const home = await temp(t);
  const server = await portServer();
  t.after(server.close);
  const output: string[] = [];
  const command = { command: 'qa-runtime setup' as const, workspace: home, slots: 1, basePort: server.port };
  assert.equal(await setupQaRuntime(command, {
    home, install: async () => 0, output: text => output.push(text),
  }), 2);
  assert.ok(output.pop()!.includes(String(server.port)));
  await assert.rejects(access(join(home, '.agent-workflow/qa-runtime.json')));
  assert.equal(await setupQaRuntime(command, { home, install: async () => 1, output: () => {} }), 2);
  assert.equal(await setupQaRuntime({ ...command, slots: 2, basePort: 65535 }, {
    home, install: async () => { assert.fail('잘못된 범위에서는 설치하지 않음'); }, output: () => {},
  }), 2);
});
