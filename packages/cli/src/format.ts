const USE_COLOR = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

const wrap = (code: string) => (text: string): string => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);

export const dim = wrap('2');
export const bold = wrap('1');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const cyan = wrap('36');

/** "3dk önce", "2sa önce" - the log is scanned, not read. */
export function relativeTime(unixSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (seconds < 60) return `${seconds}sn önce`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}dk önce`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}sa önce`;
  return `${Math.floor(hours / 24)}g önce`;
}

const SOURCE_LABEL: Record<string, string> = {
  watch: 'oto',
  agent: 'ajan',
  manual: 'elle',
  'pre-restore': 'geri-al',
};

export const sourceLabel = (source: string): string => SOURCE_LABEL[source] ?? source;

/** Parses "2h", "30m", "7d" into milliseconds. */
export function parseDuration(input: string): number {
  const match = /^(\d+)\s*(s|sn|m|dk|h|sa|d|g)$/i.exec(input.trim());
  if (!match) throw new Error(`Süre anlaşılamadı: "${input}". Örnek: 30m, 2h, 7d`);
  const value = Number.parseInt(match[1] as string, 10);
  const unit = (match[2] as string).toLowerCase();
  const multipliers: Record<string, number> = { s: 1e3, sn: 1e3, m: 6e4, dk: 6e4, h: 36e5, sa: 36e5, d: 864e5, g: 864e5 };
  return value * (multipliers[unit] as number);
}

export function formatSize(kib: number): string {
  if (kib < 1024) return `${kib} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}
