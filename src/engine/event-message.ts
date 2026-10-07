export function eventMessage(message: string): string {
  const line = message.replace(/\r\n|[\r\n]/g, ' ');
  return line.length > 200 ? line.slice(0, 199) + '…' : line;
}
