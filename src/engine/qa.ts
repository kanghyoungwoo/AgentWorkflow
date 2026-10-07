import type { LaneState, QaReport } from '../types.ts';
import type { LoopPending } from './review-loop.ts';
import { pending } from './review-loop.ts';

type Defect = QaReport['defects'][number];
export type QaOutcome =
  | { kind: 'report'; report: QaReport }
  | { kind: 'skipped' }
  | { kind: 'auto_fail'; defect: Defect }
  | { kind: 'failed'; detail: string }
  | { kind: 'rate_limited'; resetAt: string | null; detail: string }
  | { kind: 'environment'; detail: string };
export type QaDecision =
  | { next: 'done' }
  | { next: 'fix'; defects: Defect[] }
  | { next: 'paused'; pending: LoopPending };
export function decideQa(
  lane: LaneState, outcome: QaOutcome, limits: { maxQaRollbacks: number },
): QaDecision {
  if (outcome.kind === 'skipped' || outcome.kind === 'report' && outcome.report.status === 'PASS') {
    return { next: 'done' };
  }
  if (outcome.kind === 'failed') {
    return { next: 'paused', pending: pending('failed', 1, 'QA 호출이 두 번 모두 실패했습니다.', outcome.detail) };
  }
  if (outcome.kind === 'rate_limited') {
    return { next: 'paused', pending: pending('rate_limited', 22,
      '사용량 한도로 QA를 중단했습니다.', outcome.detail, outcome.resetAt) };
  }
  if (outcome.kind === 'environment' || outcome.kind === 'report' && outcome.report.status === 'BLOCKED') {
    const detail = outcome.kind === 'environment' ? outcome.detail : outcome.report.blocker!.detail;
    return { next: 'paused', pending: pending('environment', 20, 'QA 실행 환경을 확인해야 합니다.', detail) };
  }
  const defects = outcome.kind === 'auto_fail' ? [outcome.defect] : outcome.report.defects;
  if (lane.qaRollbacks >= limits.maxQaRollbacks) {
    const detail = defects.map(defect => `${defect.id}: ${defect.title}\n${defect.actual}`).join('\n');
    return { next: 'paused', pending: pending('qa_rollback_cap', 20, 'QA 수정 롤백 한도에 도달했습니다.', detail) };
  }
  lane.qaRollbacks += 1;
  return { next: 'fix', defects };
}
