/** Dates on screen follow the time zone in 设置 (the one the schedule uses), not the machine's own zone. */
let zone: string | undefined;
let formatter: Intl.DateTimeFormat | undefined;

export function setDisplayTimeZone(next: string | undefined) {
  if (next === zone) return;
  try { formatter = next ? new Intl.DateTimeFormat('en-CA', {timeZone: next, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23'}) : undefined; zone = next; }
  catch { formatter = undefined; zone = undefined; }
}

export function displayParts(date: Date): {year: number; month: number; day: number; hour: number; minute: number} {
  if (!formatter) return {year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes()};
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return {year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute)};
}

/** "2026年10月19日 10:00" (or just the date) in the time zone from 设置. */
export function displayDateTime(value: string | number | Date, withTime = true): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const p = displayParts(date), day = `${p.year}年${p.month}月${p.day}日`;
  return withTime ? `${day} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` : day;
}
