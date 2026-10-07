import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMemo } from '../public/memo.js';
test('메모를 추가하고 원래 목록을 보존한다', () => {
  const original = ['첫 메모'];
  assert.deepEqual(addMemo(original, ' 두 번째 '), ['첫 메모', '두 번째']);
  assert.deepEqual(original, ['첫 메모']);
  assert.deepEqual(addMemo(original, '  '), original);
});
