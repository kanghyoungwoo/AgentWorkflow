import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, stopApp, portForSlot, playwrightUrl, chromiumAvailable } from '../src/qa/app-runner.ts';
import type { TestContext } from 'node:test';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'aw-app-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await mkdir(join(dir, '.agent-workflow'));
  await writeFile(join(dir, '.agent-workflow/qa-runtime.json'), JSON.stringify({ basePort: port, slots: 1 }));
  await writeFile(join(dir, 'server.mjs'), `
import { createServer } from 'node:http';
createServer((req,res) => { res.end('ready'); }).listen(Number(process.env.PORT), '127.0.0.1');
`);
  const app = {
    startCommand: 'node server.mjs --port {port}', readyUrl: 'http://127.0.0.1:{port}/', startTimeoutSec: 2,
  };
  return { dir, port, app, logPath: join(dir, 'app.log') };
}
test('앱 준비 대기, PORT와 포트 치환, 프로세스 그룹 종료', async t => {
  const f = await fixture(t);
  assert.equal(await portForSlot(0, 3, f.dir), f.port);
  const app = await startApp({ worktree: f.dir, ...f });
  assert.equal(await (await fetch(`http://127.0.0.1:${f.port}/`)).text(), 'ready');
  await stopApp(app);
  await assert.rejects(fetch(`http://127.0.0.1:${f.port}/`));
  assert.equal(await portForSlot(0, 3, f.dir), f.port);
});
test('기동 실패와 준비 시간 초과', async t => {
  const f = await fixture(t);
  await assert.rejects(startApp({ worktree: f.dir, ...f, app: { ...f.app, startCommand: 'exit 3' } }), /종료/);
  await assert.rejects(startApp({
    worktree: f.dir, ...f, app: { ...f.app, startCommand: 'sleep 5', startTimeoutSec: 0.1 },
  }), /초과/);
});
test('포트 사용 중과 범위 밖 슬롯은 environment 원인이 된다', async t => {
  const f = await fixture(t);
  const server = createServer();
  await new Promise<void>(resolve => server.listen(f.port, '127.0.0.1', resolve));
  try {
    await assert.rejects(portForSlot(0, 3, f.dir), /사용할 수 없습니다/);
    await assert.rejects(portForSlot(1, 3, f.dir), /범위 밖/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('도구 Playwright URL과 Chromium 존재 여부 확인', async () => {
  assert.ok(playwrightUrl().endsWith('/node_modules/playwright/index.mjs'));
  assert.equal(typeof await chromiumAvailable(), 'boolean');
});
