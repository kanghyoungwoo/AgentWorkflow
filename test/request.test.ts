import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest } from '../src/store/request.ts';
test('하위 제목은 목표 본문과 요구사항 섹션에 속한다', () => {
  const text = [
    '# 작업',
    '## 목표',
    '목표 문장',
    '### 배경',
    '배경 문장',
    '## 요구사항',
    '- REQ-001: 첫 번째',
    '### 화면',
    '- REQ-002: 하위 제목 아래',
    '## 스펙 외 범위',
    '- 없음',
  ].join('\n');
  const result = parseRequest(text);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.goal, '목표 문장\n### 배경\n배경 문장');
  assert.deepEqual(result.requirements, [
    { id: 'REQ-001', text: '첫 번째' },
    { id: 'REQ-002', text: '하위 제목 아래' },
  ]);
});
const valid = '# 작업\n\n## 목표\n 목표 내용 \n\n## 요구사항\n- REQ-001: 첫 요구\n- REQ-002: 다음 요구\n## 스펙 외 범위\n- 없음\n';
test('요청 제목·목표·요구사항과 raw 추출, CRLF', () => {
  for (const text of [valid, valid.replaceAll('\n', '\r\n')]) {
    const result = parseRequest(text);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.title, '작업');
    assert.equal(result.goal, '목표 내용');
    assert.deepEqual(result.requirements,
      [{ id: 'REQ-001',
        text: '첫 요구' },
      { id: 'REQ-002',
        text: '다음 요구' }]);
    assert.equal(result.raw, text);
  }
});
for (const [name, text, error] of [
  ['제목 없음', valid.replace('# 작업', ''), '제목'],
  ['REQ 없음', valid.replace(/- REQ-\d{3}: .+\n/g, ''), '1개 이상'],
  ['REQ 중복', valid.replace('REQ-002', 'REQ-001'), '중복'],
  ['범위 없음', valid.replace('## 스펙 외 범위', '## 다른 섹션'), '스펙 외 범위'],
] as const) test(name, () => {
  const result = parseRequest(text);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join(' '), new RegExp(error));
});
test('섹션 밖 REQ 무시, 목표 생략', () => {
  const result = parseRequest('# 제목\n- REQ-001: 무시\n## 요구사항\n- REQ-001: 포함\n## 스펙 외 범위\n- REQ-001: 무시');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.goal, '');
    assert.deepEqual(result.requirements, [{ id: 'REQ-001', text: '포함' }]);
  }
});
