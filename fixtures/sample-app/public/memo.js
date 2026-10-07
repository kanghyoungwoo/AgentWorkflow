export function addMemo(memos, text) {
  const value = text.trim();
  return value ? [...memos, value] : [...memos];
}
