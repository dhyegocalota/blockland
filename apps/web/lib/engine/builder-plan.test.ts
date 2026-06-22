import { describe, expect, it } from 'vitest';
import { resolveCoopPlan } from './builder-plan';

describe('resolveCoopPlan', () => {
  it('offline never enables coop and seeds local creatures at boot', () => {
    expect(resolveCoopPlan({ serverUrl: 'wss://srv', hasBridge: true, mode: 'offline' }))
      .toEqual({ coopEnabled: false, populateAtBoot: true });
  });

  it('multiplayer enables coop and skips local creatures when server + bridge are present', () => {
    expect(resolveCoopPlan({ serverUrl: 'wss://srv', hasBridge: true, mode: 'multiplayer' }))
      .toEqual({ coopEnabled: true, populateAtBoot: false });
  });

  it('multiplayer without a server url stays single-player', () => {
    expect(resolveCoopPlan({ serverUrl: undefined, hasBridge: true, mode: 'multiplayer' }))
      .toEqual({ coopEnabled: false, populateAtBoot: true });
  });

  it('multiplayer without a bridge stays single-player', () => {
    expect(resolveCoopPlan({ serverUrl: 'wss://srv', hasBridge: false, mode: 'multiplayer' }))
      .toEqual({ coopEnabled: false, populateAtBoot: true });
  });
});
