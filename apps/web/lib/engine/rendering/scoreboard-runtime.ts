// The stars/record persistence glue, dependency-inverted onto the shared GameRuntime: the localStorage
// read/write of the best score and the HUD stat repaint. The pure formatting + record math it leans on
// (heartsLabel, bestScore, persistedRecord) lives in ./scoreboard and is unit-tested; this is the glue
// that drives them against localStorage + the live DOM.
import { MAX_HEARTS } from '../constants';
import { bestScore, heartsLabel, persistedRecord } from '../scoreboard';
import type { GameRuntime } from '../runtime';

export function createScoreboard(runtime: GameRuntime): void {
  runtime.storedBest = function storedBest(): number {
    const stored = localStorage.getItem(runtime.bestKey);
    return stored ? Number(stored) : 0;
  };

  runtime.recordServerScore = function recordServerScore(score: number): void {
    localStorage.setItem(runtime.bestKey, String(persistedRecord({ serverScore: score, stored: runtime.storedBest() })));
  };

  runtime.updateStats = function updateStats(): void {
    const { player } = runtime.state;
    runtime.el('hearts').textContent = heartsLabel({ hearts: player.hearts, maxHearts: MAX_HEARTS });
    runtime.el('stars').textContent = `⭐ ${player.stars}`;
    runtime.el('bag').textContent = `🎒 ${player.bag}`;
    runtime.el('record').textContent = `🏆 ${bestScore({ stars: player.stars, stored: runtime.storedBest() })}`;
  };
}
