export const short = (hash?: string, head = 6, tail = 4) =>
  !hash ? '' : hash.length <= head + tail + 2 ? hash : `${hash.slice(0, head + 2)}…${hash.slice(-tail)}`;

export const num = (value: number, digits = 4) =>
  value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const compact = (value: number) =>
  Math.abs(value) >= 1000 ? value.toLocaleString('en-US', { maximumFractionDigits: 0 }) : num(value, 4);

export const bps = (value: number) => `${(value / 100).toFixed(2)}%`;

export const clock = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const countdown = (unixSeconds: string) => {
  const left = Number(unixSeconds) - Math.floor(Date.now() / 1000);
  if (Number.isNaN(left)) return '—';
  if (left <= 0) return 'expired';
  const days = Math.floor(left / 86400);
  const hours = Math.floor((left % 86400) / 3600);
  const mins = Math.floor((left % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
};

export const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export const severity = (ratio: number) => (ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warn' : 'ok');
