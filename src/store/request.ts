export type ParsedRequest = {
  title: string;
  goal: string;
  requirements: {
    id: string;
    text: string
  }[];
  raw: string
};
export type RequestResult = ({ ok: true } & ParsedRequest) | {
  ok: false;
  errors: string[]
};
export function parseRequest(raw: string): RequestResult {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const title = lines.find(line => /^# .+/.test(line))?.slice(2).trim() ?? '';
  const requirements: ParsedRequest['requirements'] = [];
  const goals: string[] = [];
  let section = '';
  let hasOutOfScope = false;
  for (const line of lines) {
    if (/^#{1,2} /.test(line)) {
      section = line.startsWith('## ') ? line.slice(3).trim() : '';
      if (section === '스펙 외 범위') hasOutOfScope = true;
    } else if (section === '요구사항') {
      const match = /^- (REQ-\d{3}): (.+)$/.exec(line);
      if (match) requirements.push({ id: match[1], text: match[2] });
    } else if (section === '목표') goals.push(line);
  }
  const errors: string[] = [];
  if (!title) errors.push('# 제목이 필요합니다.');
  if (!requirements.length) errors.push('요구사항 섹션에 REQ 항목이 1개 이상 필요합니다.');
  const ids = new Set<string>();
  for (const { id } of requirements) {
    if (ids.has(id)) errors.push(`요구사항 ID가 중복되었습니다: ${id}`);
    ids.add(id);
  }
  if (!hasOutOfScope) errors.push('## 스펙 외 범위 섹션이 필요합니다.');
  return errors.length ? { ok: false, errors } : { ok: true, title, goal: goals.join('\n').trim(), requirements, raw };
}
