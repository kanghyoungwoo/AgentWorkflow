import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideQa } from '../src/engine/qa.ts';
import type { QaOutcome } from '../src/engine/qa.ts';
import { defect, laneState, report } from './engine-fixtures.ts';
const limits = { maxQaRollbacks: 3 };
for (const outcome of [{ kind: 'skipped' }, { kind: 'report', report: report() }] satisfies QaOutcome[]) {
  test(`QA 통과: ${outcome.kind}`, () => {
    const lane = laneState();
    assert.deepEqual(decideQa(lane, outcome, limits), { next: 'done' });
    assert.equal(lane.qaRollbacks, 0);
  });
}
for (const outcome of [
  { kind: 'report', report: { ...report(), status: 'FAIL', defects: [defect()] } },
  { kind: 'auto_fail', defect: { ...defect(), id: 'BUG-APP-START' } },
  { kind: 'auto_fail', defect: { ...defect(), id: 'BUG-INTEGRATION-TESTS' } },
] satisfies QaOutcome[]) {
  test(`QA 실패 롤백 경계: ${outcome.kind}`, () => {
    const lane = laneState();
    lane.qaRollbacks = 2;
    const result = decideQa(lane, outcome, limits);
    assert.equal(result.next, 'fix');
    if (result.next === 'fix') assert.equal(result.defects.length, 1);
    assert.equal(lane.qaRollbacks, 3);
    const capped = decideQa(lane, outcome, limits);
    assert.equal(capped.next, 'paused');
    if (capped.next === 'paused') {
      assert.equal(capped.pending.kind, 'qa_rollback_cap');
      assert.equal(capped.pending.exitCode, 20);
    }
    assert.equal(lane.qaRollbacks, 3);
  });
}
for (const [outcome, kind, code] of [
  [{ kind: 'environment', detail: '포트 사용 중' }, 'environment', 20],
  [{ kind: 'environment', detail: 'chromium 없음' }, 'environment', 20],
  [{ kind: 'report', report: { ...report(), status: 'BLOCKED',
    blocker: { kind: 'environment', detail: '앱 연결 불가' } } }, 'environment', 20],
  [{ kind: 'failed', detail: '두 시도 실패' }, 'failed', 1],
  [{ kind: 'rate_limited', detail: '한도', resetAt: '2026-10-07T12:00:00Z' }, 'rate_limited', 22],
] satisfies Array<[QaOutcome, string, number]>) {
  test(`QA 중단: ${kind} ${JSON.stringify(outcome)}`, () => {
    const lane = laneState();
    lane.qaRollbacks = 2;
    const previous = structuredClone(lane);
    const result = decideQa(lane, outcome, limits);
    assert.equal(result.next, 'paused');
    if (result.next === 'paused') {
      assert.equal(result.pending.kind, kind);
      assert.equal(result.pending.exitCode, code);
      assert.ok(result.pending.detail);
      assert.equal(result.pending.resetAt, outcome.kind === 'rate_limited' ? outcome.resetAt : null);
    }
    assert.deepEqual(lane, previous);
  });
}
