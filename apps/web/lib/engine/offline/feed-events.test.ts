import { describe, expect, it } from 'vitest';
import { offlineAdminFeed, offlineKillFeed, offlineResetFeed, offlineResetScoresFeed } from './feed-events';
import { t } from '../../i18n';

describe('offlineAdminFeed', () => {
  it('builds an admin feed event carrying the action so feedText renders feed.admin_<action>', () => {
    expect(offlineAdminFeed({ name: 'Maria', action: 'peace_off' }))
      .toEqual({ kind: 'admin', name: 'Maria', detail: 'peace_off' });
  });

  it('labels a nameless guest with feed.you', () => {
    expect(offlineAdminFeed({ name: '', action: 'structure_blocked' }))
      .toEqual({ kind: 'admin', name: t('feed.you'), detail: 'structure_blocked' });
  });
});

describe('offlineKillFeed', () => {
  it('names the player and the defeated creature', () => {
    expect(offlineKillFeed({ name: 'Maria', creatureName: t('creature.spider') })).toEqual({
      kind: 'kill', name: 'Maria', detail: t('creature.spider'),
    });
  });

  it('labels a nameless guest with feed.you', () => {
    expect(offlineKillFeed({ name: '  ', creatureName: t('creature.pig') })).toEqual({
      kind: 'kill', name: t('feed.you'), detail: t('creature.pig'),
    });
  });
});

describe('offlineResetFeed', () => {
  it('names the player who reset the world', () => {
    expect(offlineResetFeed({ name: 'Maria' })).toEqual({ kind: 'reset', name: 'Maria' });
  });

  it('labels a nameless guest with feed.you', () => {
    expect(offlineResetFeed({ name: '' })).toEqual({ kind: 'reset', name: t('feed.you') });
  });
});

describe('offlineResetScoresFeed', () => {
  it('names the player who reset the scores', () => {
    expect(offlineResetScoresFeed({ name: 'Maria' })).toEqual({ kind: 'reset_scores', name: 'Maria' });
  });

  it('labels a nameless guest with feed.you', () => {
    expect(offlineResetScoresFeed({ name: '' })).toEqual({ kind: 'reset_scores', name: t('feed.you') });
  });
});
