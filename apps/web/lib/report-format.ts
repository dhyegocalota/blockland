// Pure formatters for the lobby-admin reports. They return i18n keys + vars (never finished strings)
// so the locale word lives in the catalog and both locales stay in parity; the component runs them
// through t(). Kept here, colocated with its test, so the rendering glue stays trivial.
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MINUTES_PER_HOUR = 60;

export interface Localized {
  key: string;
  vars: Record<string, number>;
}

// A play-time total as whole hours + minutes: "Xh Ym" past an hour, "Ym" below it (always at least
// one minute so a brief session is never shown as nothing).
export function formatPlaytime(usedMs: number): Localized {
  const totalMinutes = Math.max(1, Math.floor(usedMs / MS_PER_MINUTE));
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  if (hours === 0) return { key: 'report.minutes', vars: { minutes } };
  return { key: 'report.hours_minutes', vars: { hours, minutes } };
}

// How long ago a chat line was sent, bucketed coarsely (now / minutes / hours / days) so the report
// reads naturally without a full relative-time library.
export function relativeTime(sentAt: number, now: number): Localized {
  const elapsed = Math.max(0, now - sentAt);
  if (elapsed < MS_PER_MINUTE) return { key: 'report.just_now', vars: {} };
  if (elapsed < MS_PER_HOUR) return { key: 'report.minutes_ago', vars: { minutes: Math.floor(elapsed / MS_PER_MINUTE) } };
  if (elapsed < MS_PER_DAY) return { key: 'report.hours_ago', vars: { hours: Math.floor(elapsed / MS_PER_HOUR) } };
  return { key: 'report.days_ago', vars: { days: Math.floor(elapsed / MS_PER_DAY) } };
}

export const REPORT_PAGE_SIZE = 12;

export interface Page<T> {
  items: T[];
  page: number;
  totalPages: number;
}

// One page of a report list. The chat backlog is bounded (the server caps it), so we fetch once and
// page in the client. The requested page is clamped into range so prev/next can never run off either
// end, and an empty list still resolves to a single (empty) page so the pager reads "1 / 1".
export function paginate<T>(items: T[], requestedPage: number, pageSize = REPORT_PAGE_SIZE): Page<T> {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, totalPages };
}
