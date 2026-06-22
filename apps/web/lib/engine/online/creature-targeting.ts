// Co-op targeting: the crosshair raycasts and hit/attack requests for server-owned creatures and pvp
// players, dependency-inverted onto the shared GameRuntime. The server owns every creature and every
// hit's outcome, so these only aim (the same sphere test as the local raycast) and send a request;
// death, reward, despawn and damage all come back authoritatively in the next snapshot/Hurt message.
import { Vector3 } from 'three';
import { debug } from '../../log';
import { REACH } from '../constants';
import { creatureDefFor } from './creature-snapshot';
import { sphereCastClosest } from '../sphere-cast';
import type { CoopCreature, CoopPlayer } from '../../coop';
import type { GameRuntime } from '../runtime';

export function createCreatureTargeting(runtime: GameRuntime): void {
  const { camera } = runtime;

  runtime.raycastServerCreature = function raycastServerCreature(): { creature: CoopCreature; t: number } | null {
    if (!runtime.coop) return null;
    const dir = new Vector3();
    camera.getWorldDirection(dir);
    const candidates = runtime.coop.getCreatures();
    const pick = sphereCastClosest({ origin: camera.position, dir, targets: candidates, maxDist: REACH });
    return pick ? { creature: candidates[pick.index], t: pick.t } : null;
  };

  runtime.hitServerCreature = function hitServerCreature(cr: CoopCreature): void {
    runtime.coop?.sendHit(cr.id);
    runtime.coop?.flashCreature(cr.id);
    runtime.spawnPoof(new Vector3(cr.x, cr.y, cr.z), creatureDefFor(cr.kind).color);
    const def = creatureDefFor(cr.kind);
    runtime.blip(def.kind === 'monster' ? 300 : 880, 0.08);
    debug('engine', 'hit request', { id: cr.id, kind: cr.kind });
  };

  // Co-op pvp: when the room has pvp on we aim the crosshair at a remote player (same sphere test as
  // creatures) and ask the server to apply the hit; the server validates pvp + range and replies with
  // Hurt to the target. Returns null when pvp is off so players never damage each other.
  runtime.raycastRemotePlayer = function raycastRemotePlayer(): { player: CoopPlayer; t: number } | null {
    if (!runtime.coop || !runtime.state.pvp) return null;
    const dir = new Vector3();
    camera.getWorldDirection(dir);
    const candidates = runtime.coop.getPlayers();
    const pick = sphereCastClosest({ origin: camera.position, dir, targets: candidates, maxDist: REACH });
    return pick ? { player: candidates[pick.index], t: pick.t } : null;
  };

  runtime.attackRemotePlayer = function attackRemotePlayer(p: CoopPlayer): void {
    runtime.coop?.sendAttackPlayer(p.id);
    runtime.spawnPoof(new Vector3(p.x, p.y, p.z), '#ff5555');
    runtime.blip(300, 0.08);
    debug('engine', 'attack player', { id: p.id });
  };
}
