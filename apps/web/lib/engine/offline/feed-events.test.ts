import { describe, expect, it } from 'vitest';
import { offlineKillFeed, offlineResetFeed } from './feed-events';
import { t } from '../../i18n';

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
