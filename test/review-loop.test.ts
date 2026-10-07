import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BlockerKind, PlanAuthorOutput, ReviewOutput, RunEvent } from '../src/types.ts';
import type { InvokeOutcome } from '../src/engine/invoke.ts';
import { applyAnswer, applyGrant, runReviewLoop } from '../src/engine/review-loop.ts';
import { finding, loopState, plan, review } from './engine-fixtures.ts';

const limits = { sameIssueLimit: 2, maxReviewRounds: 5 };
const ok = <T>(output: T): InvokeOutcome<T> => ({ kind: 'ok', output });
const failed = { kind: 'failed', detail: '두 시도 실패' } as const;
const rate = { kind: 'rate_limited', detail: '한도', resetAt: '2026-10-07T12:00:00Z' } as const;
test('게이트 통과 후 검수 승인과 이벤트', async () => {
  const loop = loopState();
  const events: Omit<RunEvent, 'at'>[] = [];
  const result = await runReviewLoop(loop, limits, {
    author: async () => ok(plan()), gates: async () => [], review: async () => ok(review()),
    emit: async event => { events.push(event); },
  });
  assert.equal(result.kind, 'approved');
  assert.equal(loop.round, 1);
  assert.equal(loop.judgedRounds, 0);
  assert.deepEqual(events.map(e => e.type), ['author', 'gate', 'review']);
});
for (const source of ['gate', 'review'] as const) {
  test(`${source} 반려 후 다음 라운드 승인`, async () => {
    const loop = loopState();
    let reviewers = 0;
    const result = await runReviewLoop(loop, limits, {
      author: async () => ok(plan()),
      gates: async () => source === 'gate' && loop.round === 1 ? [finding('GATE-REQ')] : [],
      review: async () => {
        reviewers++;
        return ok(review(source === 'review' && loop.round === 1 ? [finding()] : []));
      }, emit: async () => {},
    });
    assert.equal(result.kind, 'approved');
    assert.equal(loop.round, 2);
    assert.equal(loop.judgedRounds, 1);
    assert.equal(reviewers, source === 'gate' ? 1 : 2);
    assert.deepEqual(loop.lastOutput, plan());
  });
  test(`${source} 반복 한도가 라운드 한도보다 우선`, async () => {
    const loop = loopState();
    const result = await runReviewLoop(loop, { sameIssueLimit: 2, maxReviewRounds: 2 }, {
      author: async () => ok(plan()), gates: async () => source === 'gate' ? [finding('GATE-REQ')] : [],
      review: async () => ok(review([finding()])), emit: async () => {},
    });
    assert.equal(result.kind, 'paused');
    if (result.kind === 'paused') assert.equal(result.pending.kind, 'loop_repeat');
    assert.equal(loop.judgedRounds, 2);
  });
}
test('서로 다른 지적은 round_cap, 연속 카운트에서 사라진 id 삭제', async () => {
  const loop = loopState();
  const result = await runReviewLoop(loop, { sameIssueLimit: 2, maxReviewRounds: 3 }, {
    author: async () => ok(plan()), gates: async () => [],
    review: async () => ok(review([finding(loop.round === 2 ? 'R-002' : 'R-001')])), emit: async () => {},
  });
  assert.equal(result.kind, 'paused');
  if (result.kind === 'paused') assert.equal(result.pending.kind, 'round_cap');
  assert.deepEqual(loop.issueStreak, { 'R-001': 1 });
});
for (const kind of [
  'permission_full', 'permission_network', 'spec_ambiguity', 'scope', 'environment', 'other',
] satisfies BlockerKind[]) {
  test(`작업 BLOCKED ${kind}`, async () => {
    const loop = loopState();
    const previous = plan();
    loop.lastOutput = previous;
    loop.judgedRounds = 1;
    loop.issueStreak = { 'R-001': 1 };
    const result = await runReviewLoop(loop, limits, {
      author: async () => ok({ ...plan(), status: 'BLOCKED', blocker: { kind, detail: '필요한 이유' } }),
      gates: async () => { assert.fail('BLOCKED에는 게이트 없음'); },
      review: async () => { assert.fail('BLOCKED에는 검수 없음'); }, emit: async () => {},
    });
    assert.equal(result.kind, 'paused');
    if (result.kind === 'paused') {
      assert.equal(result.pending.kind, kind);
      assert.equal(result.pending.exitCode, kind === 'permission_full' ? 21 : 20);
      assert.equal(result.pending.detail, '필요한 이유');
    }
    assert.equal(loop.judgedRounds, 1);
    assert.equal(loop.lastOutput, previous);
    assert.deepEqual(loop.issueStreak, { 'R-001': 1 });
  });
}
for (const source of ['author', 'review'] as const) {
  for (const outcome of [failed, rate]) {
    test(`${source} ${outcome.kind} 중단은 판정 상태 보존`, async () => {
      const loop = loopState();
      loop.judgedRounds = 1;
      loop.lastOutput = plan();
      loop.lastIssues = [finding()];
      const previous = structuredClone(loop);
      const events: Omit<RunEvent, 'at'>[] = [];
      const result = await runReviewLoop(loop, limits, {
        author: async (): Promise<InvokeOutcome<PlanAuthorOutput>> => source === 'author' ? outcome : ok(plan()),
        gates: async () => [],
        review: async (): Promise<InvokeOutcome<ReviewOutput>> => source === 'review' ? outcome : ok(review()),
        emit: async event => { events.push(event); },
      });
      assert.equal(result.kind, 'paused');
      if (result.kind === 'paused') {
        assert.equal(result.pending.kind, outcome.kind);
        assert.equal(result.pending.exitCode, outcome.kind === 'failed' ? 1 : 22);
        assert.equal(result.pending.resetAt, outcome.kind === 'rate_limited' ? outcome.resetAt : null);
      }
      assert.deepEqual({ ...loop, round: 0 }, previous);
      assert.equal(events.at(-1)!.type, 'pause');
    });
  }
}
test('검수 BLOCKED는 reviewer_blocked이며 판정 상태 보존', async () => {
  const loop = loopState();
  const result = await runReviewLoop(loop, limits, {
    author: async () => ok(plan()), gates: async () => [],
    review: async () => ok({ ...review([finding()]), verdict: 'BLOCKED',
      blocker: { kind: 'other', detail: '판정 불가' } }), emit: async () => {},
  });
  assert.equal(result.kind, 'paused');
  if (result.kind === 'paused') {
    assert.equal(result.pending.kind, 'reviewer_blocked');
    assert.equal(result.pending.exitCode, 20);
  }
  assert.equal(loop.judgedRounds, 0);
  assert.equal(loop.lastOutput, null);
});
test('게이트 반려는 R-id 유지, 같은 GATE 교체, 검수 반려는 목록 교체', async () => {
  const loop = loopState();
  const observed: string[][] = [];
  await runReviewLoop(loop, { sameIssueLimit: 9, maxReviewRounds: 9 }, {
    author: async () => { observed.push(loop.reviewIssues.map(i => i.id)); return ok(plan()); },
    gates: async () => loop.round === 2 || loop.round === 3
      ? [{ ...finding('GATE-REQ'), problem: `문제 ${loop.round}` }] : [],
    review: async () => {
      if (loop.round === 4) {
        assert.equal(loop.reviewIssues[1].problem, '문제 3');
        return ok(review([finding('R-002')]));
      }
      return ok(review(loop.round === 1 ? [finding('R-001')] : []));
    }, emit: async () => {},
  });
  assert.deepEqual(observed, [[], ['R-001'], ['R-001', 'GATE-REQ'], ['R-001', 'GATE-REQ'], ['R-002']]);
});
test('applyAnswer와 applyGrant는 카운터 리셋, decisions 추가, round와 이전 출력 보존', () => {
  const loop = loopState();
  loop.round = 8;
  loop.lastOutput = plan();
  loop.judgedRounds = 4;
  loop.issueStreak = { 'R-001': 2 };
  applyAnswer(loop, '결정과 이유');
  assert.equal(loop.judgedRounds, 0);
  assert.deepEqual(loop.issueStreak, {});
  assert.deepEqual(loop.decisions, ['결정과 이유']);
  for (const grant of ['network', 'full'] as const) {
    loop.judgedRounds = 4;
    loop.issueStreak = { 'R-001': 2 };
    applyGrant(loop, grant);
    assert.equal(loop.grant, grant);
    assert.equal(loop.judgedRounds, 0);
    assert.deepEqual(loop.issueStreak, {});
  }
  assert.equal(loop.round, 8);
  assert.deepEqual(loop.lastOutput, plan());
  assert.equal(loop.decisions.length, 3);
});
