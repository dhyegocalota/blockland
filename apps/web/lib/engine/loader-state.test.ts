import { describe, expect, it } from 'vitest';
import {
  IDLE_STATE,
  LoaderPhase,
  LoaderStage,
  loaderReducer,
  loaderVisible,
  stageKey,
  type LoaderState,
} from './loader-state';

describe('loaderReducer', () => {
  it('starts loading at the engine stage when Play is pressed', () => {
    expect(loaderReducer(IDLE_STATE, { kind: 'start' })).toEqual({
      phase: LoaderPhase.Loading,
      stage: LoaderStage.Engine,
    });
  });

  it('advances to the world stage while loading', () => {
    const loading: LoaderState = { phase: LoaderPhase.Loading, stage: LoaderStage.Engine };
    expect(loaderReducer(loading, { kind: 'stage', stage: LoaderStage.World })).toEqual({
      phase: LoaderPhase.Loading,
      stage: LoaderStage.World,
    });
  });

  it('settles to ready when the world is live', () => {
    const loading: LoaderState = { phase: LoaderPhase.Loading, stage: LoaderStage.World };
    expect(loaderReducer(loading, { kind: 'ready' })).toEqual({ phase: LoaderPhase.Ready });
  });

  it('settles to error when the load fails', () => {
    const loading: LoaderState = { phase: LoaderPhase.Loading, stage: LoaderStage.Engine };
    expect(loaderReducer(loading, { kind: 'fail' })).toEqual({ phase: LoaderPhase.Error });
  });

  it('retries back into the engine stage from error', () => {
    const errored: LoaderState = { phase: LoaderPhase.Error };
    expect(loaderReducer(errored, { kind: 'retry' })).toEqual({
      phase: LoaderPhase.Loading,
      stage: LoaderStage.Engine,
    });
  });

  it('ignores start unless idle', () => {
    const ready: LoaderState = { phase: LoaderPhase.Ready };
    expect(loaderReducer(ready, { kind: 'start' })).toBe(ready);
  });

  it('ignores ready/fail once settled so a late event cannot resurrect the loader', () => {
    const ready: LoaderState = { phase: LoaderPhase.Ready };
    expect(loaderReducer(ready, { kind: 'fail' })).toBe(ready);
    const errored: LoaderState = { phase: LoaderPhase.Error };
    expect(loaderReducer(errored, { kind: 'ready' })).toBe(errored);
  });

  it('ignores stage changes outside of loading', () => {
    expect(loaderReducer(IDLE_STATE, { kind: 'stage', stage: LoaderStage.World })).toBe(IDLE_STATE);
  });
});

describe('loaderVisible', () => {
  it('shows the loader while loading and on error, hides it idle and ready', () => {
    expect(loaderVisible({ phase: LoaderPhase.Loading, stage: LoaderStage.Engine })).toBe(true);
    expect(loaderVisible({ phase: LoaderPhase.Error })).toBe(true);
    expect(loaderVisible(IDLE_STATE)).toBe(false);
    expect(loaderVisible({ phase: LoaderPhase.Ready })).toBe(false);
  });
});

describe('stageKey', () => {
  it('maps each loading stage to its i18n key, null otherwise', () => {
    expect(stageKey({ phase: LoaderPhase.Loading, stage: LoaderStage.Engine })).toBe('loading.engine');
    expect(stageKey({ phase: LoaderPhase.Loading, stage: LoaderStage.World })).toBe('loading.world');
    expect(stageKey(IDLE_STATE)).toBeNull();
    expect(stageKey({ phase: LoaderPhase.Ready })).toBeNull();
  });
});
