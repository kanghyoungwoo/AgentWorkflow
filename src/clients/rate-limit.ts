export function detectRateLimit(text: string): boolean {
  return /usage limit|rate limit|hit your limit|limit reached|quota/i.test(text);
}
function nextTime(hour: number, minute: number, period: string | undefined, now: Date): Date | null {
  if (minute > 59 || hour > (period ? 12 : 23) || hour < (period ? 1 : 0)) return null;
  if (period) hour = hour % 12 + (period.toLowerCase() === 'pm' ? 12 : 0);
  const result = new Date(now);
  result.setHours(hour, minute, 0, 0);
  if (result <= now) result.setDate(result.getDate() + 1);
  return result;
}
export function parseResetTime(text: string, now = new Date()): Date | null {
  const epoch = /\|(\d{10})(?!\d)/.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const reset = /resets? (?:at )?(\d{1,2})(?::(\d{2}))?\s?(am|pm)/i.exec(text);
  if (reset) {
    const result = nextTime(Number(reset[1]), Number(reset[2] ?? 0), reset[3], now);
    if (result) return result;
  }
  const relative = /try again in (?:(\d+) hours?)?\s*(?:(\d+) minutes?)?/i.exec(text);
  if (relative && (relative[1] || relative[2])) {
    const result = new Date(now.getTime() + (Number(relative[1] ?? 0) * 60 + Number(relative[2] ?? 0)) * 60000);
    if (!Number.isNaN(result.getTime())) return result;
  }
  const at = /try again at (\d{1,2}):(\d{2})\s?(AM|PM)?/i.exec(text);
  return at ? nextTime(Number(at[1]), Number(at[2]), at[3], now) : null;
}
