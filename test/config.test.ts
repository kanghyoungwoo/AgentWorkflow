import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';

test('설정 기본값과 부분 병합', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aw-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { config, found } = await loadConfig(dir);
  assert.equal(found, false);
  assert.equal(config.setupCommand, null);
  assert.equal(config.testCommand, null);
  assert.equal(config.app, null);
  assert.equal(config.wikiDir, 'docs/wiki');
  assert.deepEqual(config.limits, {
    maxReviewRounds: 5, sameIssueLimit: 2, maxQaRollbacks: 3, maxLanes: 3, stepTimeoutMin: 45
  });
  for (const [role, value] of Object.entries(config.roles)) {
    assert.deepEqual(value, {
      client: role.endsWith('Author') ? 'codex' : 'claude', model: null, effort: null,
    });
  }
  await writeFile(join(dir, 'agent-workflow.json'), JSON.stringify({
    roles: {
      devAuthor: { model: 'custom' }
    }, limits: { maxLanes: 8 }, app: {
      startCommand: 'npm start', readyUrl: 'http://localhost:{port}'
    }
  }));
  const loaded = await loadConfig(dir);
  assert.equal(loaded.found, true);
  assert.deepEqual(loaded.config.roles.devAuthor, { client: 'codex', model: 'custom', effort: null });
  assert.deepEqual(loaded.config.roles.qa, config.roles.qa);
  assert.deepEqual(loaded.config.limits, { ...config.limits, maxLanes: 8 });
  assert.equal(loaded.config.app?.startTimeoutSec, 90);
});
for (const [name, value] of [
  ['JSON 문법', '{'], ['모르는 최상위 키', '{"other":1}'], ['모르는 역할', '{"roles":{"other":{}}}'],
  ['역할 필드', '{"roles":{"qa":{"other":1}}}'], ['client enum', '{"roles":{"qa":{"client":"other"}}}'],
  ['effort enum', '{"roles":{"qa":{"effort":"other"}}}'], ['maxLanes', '{"limits":{"maxLanes":9}}'],
  ['0 제한', '{"limits":{"sameIssueLimit":0}}'], ['소수 제한', '{"limits":{"stepTimeoutMin":1.5}}'],
  ['빈 명령', '{"testCommand":""}'], ['빈 URL', '{"app":{"startCommand":"start","readyUrl":""}}'],
  ['app 필수값', '{"app":{"startCommand":"start"}}'],
  ['app 모르는 키', '{"app":{"startCommand":"start","readyUrl":"url","other":1}}'],
] as const) test(`설정 거부: ${name}`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aw-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'agent-workflow.json'), value);
  await assert.rejects(loadConfig(dir), /설정 (JSON 문법 오류|스키마 위반)/);
});
