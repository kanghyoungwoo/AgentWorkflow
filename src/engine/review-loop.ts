import type { Issue, LoopState, Pending, ReviewOutput, RunEvent } from '../types.ts';
import type { InvokeOutcome } from './invoke.ts';
import { eventMessage } from './event-message.ts';

type AuthorOutput = NonNullable<LoopState['lastOutput']>;
function authorMessage(output: AuthorOutput): string {
  if (output.status === 'BLOCKED') return `${output.blocker!.kind}: ${output.blocker!.detail}`;
  if ('summary' in output) return output.summary;
  if ('items' in output) return `대상 ${output.items.length}개 완료 보고`;
  const created = output.docs.filter(doc => doc.action === 'created').length;
  const updated = output.docs.filter(doc => doc.action === 'updated').length;
  return `문서 ${output.docs.length}개(created ${created}, updated ${updated})`;
}

export type LoopPending = Omit<Pending, 'id' | 'createdAt' | 'lane' | 'stage'>;
export type LoopHooks<A> = {
  author: (loop: LoopState) => Promise<InvokeOutcome<A>>;
  gates: (output: A, loop: LoopState) => Promise<Issue[]>;
  review: (output: A, loop: LoopState) => Promise<InvokeOutcome<ReviewOutput>>;
  emit: (event: Omit<RunEvent, 'at'>) => Promise<void>;
};
export type LoopResult<A> =
  | { kind: 'approved'; output: A }
  | { kind: 'paused'; pending: LoopPending };
export function pending(
  kind: Pending['kind'], exitCode: Pending['exitCode'], summary: string, detail: string, resetAt: string | null = null,
): LoopPending {
  return { kind, exitCode, summary, detail, resetAt };
}
export async function runReviewLoop<A extends AuthorOutput>(
  loop: LoopState, limits: { sameIssueLimit: number; maxReviewRounds: number }, hooks: LoopHooks<A>,
): Promise<LoopResult<A>> {
  async function emit(type: 'author' | 'gate' | 'review' | 'pause', verdict: string, message: string) {
    await hooks.emit({
      type, verdict, message: eventMessage(message), round: loop.round, lane: null, stage: null, role: null,
    });
  }
  async function pause(value: LoopPending): Promise<LoopResult<A>> {
    await emit('pause', value.kind, value.summary);
    return { kind: 'paused', pending: value };
  }
  function callFailure(outcome: Exclude<InvokeOutcome<unknown>, { kind: 'ok' }>): LoopPending {
    return outcome.kind === 'failed'
      ? pending('failed', 1, '에이전트 호출이 두 번 모두 실패했습니다.', outcome.detail)
      : pending('rate_limited', 22, '사용량 한도로 작업을 중단했습니다.', outcome.detail, outcome.resetAt);
  }
  while (true) {
    loop.round += 1;
    const author = await hooks.author(loop);
    await emit('author', author.kind === 'ok' ? author.output.status : author.kind,
      author.kind === 'ok' ? authorMessage(author.output) : author.detail);
    if (author.kind !== 'ok') return pause(callFailure(author));
    const output = author.output;
    if (output.status === 'BLOCKED') {
      const blocker = output.blocker!;
      return pause(pending(blocker.kind, blocker.kind === 'permission_full' ? 21 : 20,
        '작업에 답변 또는 권한이 필요합니다.', blocker.detail));
    }
    let issues = await hooks.gates(output, loop);
    const gateRejected = issues.length > 0;
    await emit('gate', gateRejected ? 'REJECTED' : 'PASSED',
      gateRejected ? issues.map(issue => `${issue.id}: ${issue.problem.split(/\r\n|[\r\n]/)[0]}`).join('; ')
        : '통과');
    if (!gateRejected) {
      const review = await hooks.review(output, loop);
      const message = review.kind === 'ok'
        ? review.output.summary + (review.output.verdict !== 'APPROVED' && review.output.issues.length
          ? ` (${review.output.issues.map(issue => issue.id).join(', ')})` : '')
        : review.detail;
      await emit('review', review.kind === 'ok' ? review.output.verdict : review.kind, message);
      if (review.kind !== 'ok') return pause(callFailure(review));
      if (review.output.verdict === 'BLOCKED') {
        return pause(pending('reviewer_blocked', 20, '검수자가 판정할 수 없습니다.', review.output.blocker!.detail));
      }
      if (review.output.verdict === 'APPROVED') return { kind: 'approved', output };
      issues = review.output.issues;
    }
    loop.judgedRounds += 1;
    // 공용 상태에는 세 작업 출력 타입을 저장하며 루프 훅의 구체 타입은 호출자가 결정한다.
    loop.lastOutput = output as unknown as LoopState['lastOutput'];
    loop.lastIssues = issues;
    loop.reviewIssues = gateRejected
      ? [...loop.reviewIssues.filter(old => !issues.some(current => current.id === old.id)), ...issues]
      : [...issues];
    loop.issueStreak = Object.fromEntries([...new Set(issues.map(issue => issue.id))]
      .map(id => [id, (loop.issueStreak[id] ?? 0) + 1]));
    const repeated = issues.filter(issue => loop.issueStreak[issue.id] >= limits.sameIssueLimit);
    const detail = issues.map(issue => `${issue.id}: ${issue.problem}\n${issue.requiredChange}`).join('\n');
    if (repeated.length) {
      return pause(pending('loop_repeat', 20, '같은 지적이 연속으로 반복되어 답변이 필요합니다.', detail));
    }
    if (loop.judgedRounds >= limits.maxReviewRounds) {
      return pause(pending('round_cap', 20, '검수 반려 라운드 한도에 도달했습니다.', detail));
    }
  }
}
export function applyAnswer(loop: LoopState, answer: string): void {
  loop.judgedRounds = 0;
  loop.issueStreak = {};
  loop.decisions.push(answer);
}
export function applyGrant(loop: LoopState, grant: 'network' | 'full'): void {
  loop.grant = grant;
  applyAnswer(loop, grant === 'full' ? '전체 권한 사용을 승인했습니다.' : '네트워크 사용 권한을 승인했습니다.');
}
