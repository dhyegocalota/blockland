import { describe, expect, it } from 'vitest';
import { formatPlaytime, relativeTime } from './report-format';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatPlaytime', () => {
  it('shows hours and minutes past an hour', () => {
    expect(formatPlaytime(2 * HOUR + 15 * MINUTE)).toEqual({
      key: 'report.hours_minutes',
      vars: { hours: 2, minutes: 15 },
    });
  });

  it('shows minutes only below an hour', () => {
    expect(formatPlaytime(45 * MINUTE)).toEqual({ key: 'report.minutes', vars: { minutes: 45 } });
  });

  it('never rounds a brief session down to nothing', () => {
    expect(formatPlaytime(10 * 1000)).toEqual({ key: 'report.minutes', vars: { minutes: 1 } });
  });
});

describe('relativeTime', () => {
  it('buckets the most recent line as just now', () => {
    expect(relativeTime(1_000, 1_000 + 30 * 1000)).toEqual({ key: 'report.just_now', vars: {} });
  });

  it('buckets minutes, hours and days ago', () => {
    const now = 100 * DAY;
    expect(relativeTime(now - 5 * MINUTE, now)).toEqual({ key: 'report.minutes_ago', vars: { minutes: 5 } });
    expect(relativeTime(now - 3 * HOUR, now)).toEqual({ key: 'report.hours_ago', vars: { hours: 3 } });
    expect(relativeTime(now - 2 * DAY, now)).toEqual({ key: 'report.days_ago', vars: { days: 2 } });
  });

  it('clamps a future timestamp to just now instead of going negative', () => {
    expect(relativeTime(2_000, 1_000)).toEqual({ key: 'report.just_now', vars: {} });
  });
});
