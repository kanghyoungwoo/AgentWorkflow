import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRateLimit, parseResetTime } from '../src/clients/rate-limit.ts';

const now = new Date(2026, 9, 7, 14, 0, 0);
for (const [text, expected] of [
  ['Claude AI usage limit reached|1791234567', new Date(1791234567000)],
  ['5-hour limit reached ∙ resets 3pm', new Date(2026, 9, 7, 15)],
  ["You've hit your usage limit. Try again in 2 hours 13 minutes.", new Date(2026, 9, 7, 16, 13)],
  ['try again at 3:05 PM', new Date(2026, 9, 7, 15, 5)],
  ['reset at 1pm', new Date(2026, 9, 8, 13)],
  ['try again at 13:05', new Date(2026, 9, 8, 13, 5)],
  ['resets 12am', new Date(2026, 9, 8)],
  ['resets at 12:30pm', new Date(2026, 9, 8, 12, 30)],
  ['Try again in 15 minutes', new Date(2026, 9, 7, 14, 15)],
  ['Try again in 2 hours', new Date(2026, 9, 7, 16)],
  ['nothing', null], ['try again in ', null], ['resets 99pm', null], ['try again at 3:99 PM', null],
] as const) test(`리셋 시각: ${text}`, () => {
  assert.equal(parseResetTime(text, now)?.getTime() ?? null, expected?.getTime() ?? null);
});
test('한도 감지와 패턴 우선순위', () => {
  for (const text of ['usage limit', 'RATE LIMIT', 'hit your limit', 'limit reached', 'quota']) {
    assert.equal(detectRateLimit(text), true);
  }
  assert.equal(detectRateLimit('ordinary failure'), false);
  assert.equal(parseResetTime('|1791234567 resets 3pm', now)?.getTime(), 1791234567000);
  assert.equal(parseResetTime('resets 3pm try again in 2 hours', now)?.getTime(), new Date(2026, 9, 7, 15).getTime());
  assert.equal(parseResetTime('try again in 2 hours try again at 3:05 PM', now)?.getTime(),
    new Date(2026, 9, 7, 16).getTime());
});
