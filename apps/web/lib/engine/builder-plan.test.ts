import { describe, expect, it } from 'vitest';
import { resolveCoopPlan } from './builder-plan';

describe('resolveCoopPlan', () => {
  it('offline never enables coop and seeds local creatures at boot', () => {
    expect(resolveCoopPlan({ serverUrl: 'wss://srv', hasBridge: true, mode: 'offline' }))
      .toEqual({ coopEnabled: false, populateAtBoot: true });
  });

  it('online enables coop and skips local creatures when server + bridge are present', () => {
    expect(resolveCoopPlan({ serverUrl: 'wss://srv', hasBridge: true, mode: 'online' }))
      .toEqual({ coopEnabled: true, populateAtBoot: false });
  });

  it('online without a server url stays offline', () => {
    expect(resolveCoopPlan({ serverUrl: undefined, hasBridge: true, mode: 'online' }))
      .toEqual({ coopEnabled: false, populateAtBoot: true });
  });

  it('online without a bridge stays offline', () => {
    expect(resolveCoopPlan({ serverUrl: 'wss://srv', hasBridge: false, mode: 'online' }))
      .toEqual({ coopEnabled: false, populateAtBoot: true });
  });
});
