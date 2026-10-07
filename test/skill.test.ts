import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Master 스킬이 spec §10.9 코드 블록과 글자 그대로 일치한다', async () => {
  const spec = await readFile(new URL('../spec.md', import.meta.url), 'utf8');
  const blocks = [...spec.matchAll(
    /### 10\.9 Master 스킬 `skill\/agent-workflow\/SKILL\.md`\n\n```markdown\n([\s\S]*?)\n```/g,
  )];
  assert.equal(blocks.length, 1);
  const skill = await readFile(new URL('../skill/agent-workflow/SKILL.md', import.meta.url), 'utf8');
  assert.equal(skill, blocks[0][1] + '\n');
});
