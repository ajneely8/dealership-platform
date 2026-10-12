/**
 * The daily research window (default 07:00–21:00 America/Chicago). Everything here uses the
 * platform's IANA time-zone data, so daylight-saving changes need no special handling: "07:00"
 * means 07:00 on the wall clock in that zone, whatever the UTC offset is that day.
 */
export type WindowConfig = { enabled: boolean; start: string; end: string; timezone: string };

function parseHm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Wall-clock parts of an instant in the given zone. */
export function localParts(at: Date, timezone: string): { year: number; month: number; day: number; minutes: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? "Sun");
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), minutes: Number(p.hour) * 60 + Number(p.minute), weekday };
}

export function isWithinWindow(at: Date, cfg: WindowConfig): boolean {
  if (!cfg.enabled) return true;
  const { minutes } = localParts(at, cfg.timezone);
  const start = parseHm(cfg.start);
  const end = parseHm(cfg.end);
  // An end before the start means the window crosses midnight.
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** The UTC offset (minutes) the zone uses at a given instant. */
function offsetMinutes(at: Date, timezone: string): number {
  const p = localParts(at, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, Math.floor(p.minutes / 60), p.minutes % 60);
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/**
 * The next instant the window opens, on or after `at`. Resolved through the zone's offset for
 * that day, so a start time on a DST switch-over day still lands on the right wall-clock time.
 */
export function nextWindowStart(at: Date, cfg: WindowConfig): Date {
  if (!cfg.enabled) return at;
  const start = parseHm(cfg.start);
  const p0 = localParts(at, cfg.timezone);
  // Walk the zone's calendar days (not 24-hour steps, which skip a day around a DST change).
  for (let k = 0; k <= 2; k++) {
    const d = new Date(Date.UTC(p0.year, p0.month - 1, p0.day + k));
    const wall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Math.floor(start / 60), start % 60);
    // Resolve the UTC offset in force at that wall-clock moment (two passes handle a switch-over day).
    let guess = new Date(wall - offsetMinutes(at, cfg.timezone) * 60_000);
    guess = new Date(wall - offsetMinutes(guess, cfg.timezone) * 60_000);
    if (guess.getTime() > at.getTime()) return guess;
  }
  return new Date(at.getTime() + 86_400_000);
}

export function describeWindow(cfg: WindowConfig): string {
  if (!cfg.enabled) return "Research runs around the clock";
  return `Research runs ${cfg.start}–${cfg.end} ${cfg.timezone.replace(/_/g, " ")}, every day`;
}
