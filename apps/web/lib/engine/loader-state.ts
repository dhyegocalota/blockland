// The game-loader's pure state machine: the lobby is light (no three.js / wasm in the first-load
// bundle), so when the player commits to Play we dynamically import the engine + init the wasm core +
// build the first frame behind an on-brand loading screen. This models that lifecycle so the React glue
// stays a thin reducer driver: idle (lobby) → loading(stage) → ready (game live) / error (retry).
// The two loading stages stage the heavy work: 'engine' fetches the code-split engine chunk, 'world'
// covers the wasm init + worldgen + first frame.

export enum LoaderPhase {
  Idle = 'idle',
  Loading = 'loading',
  Ready = 'ready',
  Error = 'error',
}

export enum LoaderStage {
  Engine = 'engine',
  World = 'world',
}

export type LoaderState =
  | { phase: LoaderPhase.Idle }
  | { phase: LoaderPhase.Loading; stage: LoaderStage }
  | { phase: LoaderPhase.Ready }
  | { phase: LoaderPhase.Error };

export type LoaderEvent =
  | { kind: 'start' }
  | { kind: 'stage'; stage: LoaderStage }
  | { kind: 'ready' }
  | { kind: 'fail' }
  | { kind: 'retry' };

export const IDLE_STATE: LoaderState = { phase: LoaderPhase.Idle };

// The loading screen is shown whenever we are past the lobby and not yet live: while loading, and on
// error (where it swaps its body for the retry message — never a blank screen).
export function loaderVisible(state: LoaderState): boolean {
  return state.phase === LoaderPhase.Loading || state.phase === LoaderPhase.Error;
}

// The i18n key for the current loading stage's line, or null when not in a loading stage.
const STAGE_KEYS: Record<LoaderStage, string> = {
  [LoaderStage.Engine]: 'loading.engine',
  [LoaderStage.World]: 'loading.world',
};

export function stageKey(state: LoaderState): string | null {
  if (state.phase !== LoaderPhase.Loading) return null;
  return STAGE_KEYS[state.stage];
}

// Deterministic transitions. Pressing Play (start) and retrying both enter loading at the first stage.
// `stage` only advances within loading. `ready`/`fail` are accepted only while loading so a late event
// can't resurrect a settled loader. Unknown transitions are no-ops (return the current state).
export function loaderReducer(state: LoaderState, event: LoaderEvent): LoaderState {
  if (event.kind === 'start' && state.phase === LoaderPhase.Idle) {
    return { phase: LoaderPhase.Loading, stage: LoaderStage.Engine };
  }
  if (event.kind === 'retry' && state.phase === LoaderPhase.Error) {
    return { phase: LoaderPhase.Loading, stage: LoaderStage.Engine };
  }
  if (event.kind === 'stage' && state.phase === LoaderPhase.Loading) {
    return { phase: LoaderPhase.Loading, stage: event.stage };
  }
  if (event.kind === 'ready' && state.phase === LoaderPhase.Loading) {
    return { phase: LoaderPhase.Ready };
  }
  if (event.kind === 'fail' && state.phase === LoaderPhase.Loading) {
    return { phase: LoaderPhase.Error };
  }
  return state;
}
