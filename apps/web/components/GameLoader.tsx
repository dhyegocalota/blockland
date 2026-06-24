'use client';

// The on-brand loading screen shown the moment the player commits to Play, while the code-split engine
// chunk + the wasm core + the first frame load (now always heavy: offline runs the wasm game-core by
// default). It mirrors the lobby `#start` visual language — sky gradient, drifting clouds, green hill,
// a bobbing voxel avatar and gold accents — so it reads as part of the game, not a generic spinner.
// Pure state lives in lib/engine/loader-state; this is just markup driven by it.
import { t } from '../lib/i18n';
import { LoaderPhase, stageKey, type LoaderState } from '../lib/engine/loader-state';

const STAGE_PROGRESS: Record<string, number> = {
  'loading.engine': 50,
  'loading.world': 90,
};

export default function GameLoader({ state, retry }: { state: LoaderState; retry: () => void }) {
  const failed = state.phase === LoaderPhase.Error;
  const key = stageKey(state);
  const progress = key ? STAGE_PROGRESS[key] : 100;

  return (
    <div id="gameLoader" role="status" aria-live="polite">
      <div className="loaderSky" aria-hidden="true">
        <span className="cloud cloud-a">☁️</span>
        <span className="cloud cloud-b">☁️</span>
        <span className="cloud cloud-c">☁️</span>
      </div>
      <div className="panel">
        <div className="loaderAvatar" aria-hidden="true">🧱</div>
        {failed ? (
          <>
            <h2>{t('loading.error_title')}</h2>
            <p>{t('loading.error_hint')}</p>
            <button id="loaderRetry" onClick={retry}>{t('loading.retry')}</button>
          </>
        ) : (
          <>
            <h2>{t('loading.title')}</h2>
            <p className="loaderStage">{key ? t(key) : t('loading.world')}</p>
            <div className="loaderTrack" aria-hidden="true">
              <div className="loaderFill" style={{ width: `${progress}%` }} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
