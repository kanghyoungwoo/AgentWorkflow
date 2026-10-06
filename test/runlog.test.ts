import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as log from '../src/store/runlog.ts';
import type { RunEvent } from '../src/types.ts';
process.env.TZ = 'Asia/Seoul';
const event: RunEvent = {
  at: '2026-01-02T03:04:05.000Z',
  lane: null,
  stage: null,
  role: null,
  type: 'run_start',
  verdict: null,
  round: null,
  message: '내용|파이프\r\n다음\n줄'
};
test('로컬 시각 run ID와 slug', () => {
  assert.equal(log.makeRunId('sample', new Date(2026, 0, 2, 3, 4, 5)), '20260102_030405_sample');
  for (const slug of ['run', 'a-01', '-']) assert.equal(log.isValidSlug(slug), true);
  for (const slug of ['', '한글', 'A', 'a_b', 'a b']) assert.equal(log.isValidSlug(slug), false);
});
test('runlog 경로, 자리 넘침과 fix 경로', () => {
  assert.equal(log.runDir('/ws', 'id'), '/ws/ai-log/id');
  assert.equal(log.planningPath('/run', 1, 'author'), '/run/01-planning/round-01.author.json');
  assert.equal(log.fixPlanningPath('/run', 'a', 2, 3, 'review'), '/run/01-planning/fix/a-2/round-03.review.json');
  assert.equal(log.developmentPath('/run', 'a', 2, 'tests', 'log'), '/run/02-development/a/round-02.tests.log');
  assert.equal(log.developmentPath('/run', 'a', 2, 'author', 'json', 3),
    '/run/02-development/a/fix-3/round-02.author.json');
  assert.equal(log.qaDir('/run', 'integration', 4), '/run/03-qa/integration/attempt-04');
  assert.equal(log.wikiPath('/run', 123, 'gate'), '/run/04-wiki/round-123.gate.json');
  assert.equal(log.rawPrefix('/run', 1, null, 'PLANNING', 'planningAuthor', 2),
    '/run/raw/0001-run-PLANNING-planningAuthor-r02');
  assert.equal(log.rawPrefix('/run', 12345, 'a', 'DEV', 'devAuthor', 123), '/run/raw/12345-a-DEV-devAuthor-r123');
});
test('timeline null, 파이프, 줄바꿈 렌더링', () => {
  assert.equal(log.renderTimeline([event]),
  '| 시각 | 레인 | 단계 | 역할 | 판정 | 내용 |\n'
  + '| --- | --- | --- | --- | --- | --- |\n'
  + '| 2026-01-02 12:04:05 | - | - | - | - | 내용\\|파이프 다음 줄 |\n');
});
test('초기화, 덮어쓰기 거부, 이벤트와 timeline의 정확한 일치', async t => {
  const ws = await mkdtemp(join(tmpdir(), 'aw-log-'));
  t.after(() => rm(ws, { recursive: true, force: true }));
  const dir = await log.initRunDir(ws, 'id', '요청');
  assert.equal(await readFile(join(dir, '00-request/request.md'), 'utf8'), '요청');
  assert.equal((await stat(join(dir, 'raw'))).isDirectory(), true);
  await assert.rejects(log.initRunDir(ws, 'id', '새 요청'), /이미/);
  assert.deepEqual(await log.readEvents(dir), []);
  const events = [event, {
      ...event, lane: 'a', stage: 'DEV', role: 'devAuthor' as const, verdict: 'DONE', type: 'author' as const
  }];
  for (const e of events) await log.appendEvent(dir, e);
  assert.deepEqual(await log.readEvents(dir), events);
  assert.equal(await readFile(join(dir, 'timeline.md'), 'utf8'), log.renderTimeline(await log.readEvents(dir)));
  const empty = await log.initRunDir(ws, 'empty', null);
  await assert.rejects(readFile(join(empty, '00-request/request.md')), { code: 'ENOENT' });
});
