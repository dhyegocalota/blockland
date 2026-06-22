import * as THREE from 'three';
import { PLATFORM_NAME, type Brand } from './tenants';
import { t } from './i18n';
import { debug } from './log';
import {
  AIR, CHUNK, EYE_HEIGHT, FACE_ID, FLY_SPEED, GRAVITY, JUMP_SPEED, PLAYER_HEIGHT,
  PLAYER_RADIUS, REACH, SIZE_X, SIZE_Y, SIZE_Z, WALK_SPEED, clampToWorld,
} from './engine/constants';
import { BLOCKS, type BlockDef, blockById } from './engine/blocks';
import { heightAt } from './engine/worldgen';
import { VoxelWorld } from './engine/world';
import { type Axis, moveAxis } from './engine/physics';
import { blockVelocityIntoActors, cellOverlapsActor, clearFeetAbove } from './engine/actors';
import { type VoxelHit, raycastVoxel as ddaRaycast } from './engine/raycast';
import { stampBall, stampCola, stampFigure, stampSteve, stampTrophy } from './engine/structures';
import { CREATURE_DEFS, type CreatureDef, stepCreatureDirection } from './engine/creatures';
import { creatureDefFor } from './engine/creature-snapshot';
import { renderBlockCanvas } from './engine/textures';
import { sphereCastClosest } from './engine/sphere-cast';
import { moveVector } from './engine/movement';
import { BlockInventory, hotbarCountLabel } from './engine/inventory';
import { parseSavedPosition, serializeSavedPosition } from './engine/saved-position';
import { faceBlockNameFor } from './engine/tenant-brand';
import { nextFrame, smoothFps } from './engine/frame-cap';
import { STRUCTURE_KINDS, type StructureKind, structureReach, structureTarget } from './engine/structure-build';
import { bestScore, heartsLabel, persistedRecord } from './engine/scoreboard';
import { aimPitch, aimYaw, lookDirection } from './engine/aim';
import { type DebugSnapshot, buildDebugSnapshot } from './engine/debug-snapshot';
import { canPlaceSelected as canPlaceOffline, shouldSpendBlock } from './engine/place-eligibility';
import { STARTING_ROSTER, spawnPosition } from './engine/creature-spawn';
import { bobOffset, creatureBitesPlayer, FLASH_TIME, knockbackVector, stepCreaturePosition } from './engine/creature-combat';
import { chooseCoopTarget, chooseLocalTarget } from './engine/attack-target';
import { groundHeight as groundHeightAt } from './engine/terrain-column';
import { readJoystick } from './engine/joystick';
import { type EngineContext } from './engine/context';
import { createScene } from './engine/scene-setup';
import { buildMaterials, makeFaceMaterial } from './engine/materials';
import { createChunkMesher } from './engine/chunk-mesher';
import { createPoofRuntime } from './engine/poofs-runtime';
import { createCoop, MAIN_WORLD, type Appearance, type CoopController, type CoopCreature, type CoopHud, type CoopPlayer, type RoomState } from './coop';
import type { EditCell, EditOp, Role } from './protocol';

interface Creature {
  typeKey: string;
  def: CreatureDef;
  mesh: THREE.Group;
  body: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  hp: number;
  dir: number;
  timer: number;
  bob: number;
  flash: number;
}

interface Player {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  fly: boolean;
  hearts: number;
  stars: number;
  bag: number;
  hurtCooldown: number;
}

export { STRUCTURE_KINDS, type StructureKind } from './engine/structure-build';

interface GameWindow extends Window {
  __blGameBooted?: boolean;
  __blGameCleanup?: (() => void) | undefined;
  webkitAudioContext?: typeof AudioContext;
}

export type { DebugSnapshot } from './engine/debug-snapshot';

// Web build identifier shown in the debug panel — the deploy's short commit SHA, "dev" when running locally.
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';

// The admin command surface shared by the in-game engine and the headless lobby connection, so the
// same useRoomAdmin dispatch drives both.
export interface RoomAdminApi {
  setAdminPeace(on: boolean): void;
  setAdminStructure(kind: string, allowed: boolean): void;
  setAdminPvp(on: boolean): void;
  setAdminChat(on: boolean): void;
  kickPlayer(id: number): void;
  banPlayer(id: number): void;
  resetWorld(): void;
  resetScores(): void;
  suspendRoom(on: boolean): void;
  setRole(id: number, role: Role): void;
  setApprovalRequired(on: boolean): void;
  approvePlayer(accountId: string): void;
}

// The bridge connects the React HUD to the engine: the HUD supplies the player name (resolved at
// connect time so late edits to the name field count) and receives net status / chat updates; the
// engine exposes chat sending and a live debug snapshot for F3.
// The control surface the engine binds back to the React HUD: chat, admin commands, debug snapshot.
export interface GameApi extends RoomAdminApi {
  sendChat(text: string): void;
  setInfiniteResources(on: boolean): void;
  returnToSpawn(): void;
  debugSnapshot(): DebugSnapshot;
}

export interface CoopBridge {
  resolveName(): string;
  resolveAppearance(): Appearance;
  resolveClaim(name: string): string;
  // True when the player chose single-player on the start screen: never connect, simulate locally.
  resolveOffline(): boolean;
  hud: CoopHud;
  bind(api: GameApi): void;
}

export function initGame(brand: Brand, bridge?: CoopBridge): (() => void) | undefined {
  if (typeof window === 'undefined') return undefined;
  const win = window as unknown as GameWindow;
  if (win.__blGameBooted) return win.__blGameCleanup;
  win.__blGameBooted = true;
  const bootStart = performance.now();
  const FACE_URL = brand.image;
  const FACE_BLOCK_NAME = faceBlockNameFor(brand.name);
  const BEST_KEY = `bl-best-${brand.id}`;
  if (typeof document !== 'undefined') document.title = `${brand.name} — ${PLATFORM_NAME}`;

  const abort = new AbortController();
  const signal = abort.signal;
  let disposed = false;
  let rafId = 0;
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  // ---------- World layout ----------
  const chunksX = Math.ceil(SIZE_X / CHUNK);
  const chunksZ = Math.ceil(SIZE_Z / CHUNK);

  // ---------- Block names (i18n key, except the tenant face block) ----------
  function blockName(b: BlockDef): string {
    if (b.id === FACE_ID) return FACE_BLOCK_NAME;
    if (!b.nameKey) throw new Error(`block ${b.id} has no name key`);
    return t(b.nameKey);
  }

  function el(id: string): HTMLElement {
    const node = document.getElementById(id);
    if (!node) throw new Error(`missing element #${id}`);
    return node;
  }

  // ---------- Materials ----------
  const materials: Record<number, THREE.MeshLambertMaterial> = {};

  // ---------- Voxel storage (sparse: only visited chunks use memory -> endless world) ----------
  const world = new VoxelWorld();
  const inBounds = (x: number, y: number, z: number): boolean => world.inBounds(x, y, z);
  const getVoxel = (x: number, y: number, z: number): number => world.get(x, y, z);
  const setVoxel = (x: number, y: number, z: number, id: number): void => world.set(x, y, z, id);
  const isSolid = (x: number, y: number, z: number): boolean => world.isSolid(x, y, z);

  function buildWelcomeMonument() {
    const cx = SIZE_X >> 1, cz = SIZE_Z >> 1;
    const top = heightAt(cx, cz);
    setVoxel(cx, top + 1, cz, FACE_ID);
    setVoxel(cx, top + 2, cz, FACE_ID);
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) setVoxel(cx + dx, top + 1, cz + dz, 8);
  }

  // ---------- Scene + meshing (streamed chunk meshes around the player) ----------
  const { scene, camera, renderer, canvas, worldGroup, highlight } = createScene({ isTouch });
  const chunkMeshes = new Map<string, THREE.Mesh[]>();
  const ctx: EngineContext = { isTouch, scene, worldGroup, world, materials, chunkMeshes, chunksX, chunksZ };
  const mesher = createChunkMesher(ctx);
  const updateChunks = (force?: boolean): void => mesher.updateChunks({ playerPos: player.pos, force });
  const processMeshQueue = (budget: number): void => mesher.processMeshQueue(budget);
  const remeshRegion = (minX: number, maxX: number, minZ: number, maxZ: number): void => mesher.remeshRegion(minX, maxX, minZ, maxZ);
  const poofRuntime = createPoofRuntime({ scene });

  // ---------- Player state ----------
  const MAX_HEARTS = 3;
  // Spawn at the world center, lifted above the terrain AND anything built there (no spawning inside a structure).
  const spawnPoint = (): THREE.Vector3 => {
    const sx = SIZE_X >> 1, sz = (SIZE_Z >> 1) + 4;
    const feet = clearFeetAbove({ feet: heightAt(sx, sz) + 1, isSolid: (y) => isSolid(sx, y, sz) });
    return new THREE.Vector3(SIZE_X / 2, feet + EYE_HEIGHT, SIZE_Z / 2 + 4);
  };

  // Persist where the player last stood (per tenant) so re-entering the game drops them back there
  // instead of the spawn point.
  const POS_KEY = `bl-pos:${brand.id}`;
  const loadSavedPos = (): THREE.Vector3 | null => {
    const saved = parseSavedPosition(localStorage.getItem(POS_KEY));
    if (!saved) return null;
    return new THREE.Vector3(saved.x, saved.y, saved.z);
  };
  const savePos = (): void => {
    localStorage.setItem(POS_KEY, serializeSavedPosition(player.pos));
  };

  const savedPos = loadSavedPos();
  const player: Player = {
    pos: savedPos ? savedPos : spawnPoint(),
    vel: new THREE.Vector3(),
    yaw: Math.PI, pitch: -0.2,
    onGround: false, fly: false,
    hearts: MAX_HEARTS, stars: 0, bag: 0, hurtCooldown: 0,
  };
  let selected = 1;
  let peaceful = true;
  let pvp = false;
  let chatEnabled = true;
  // Approval gate (server-authoritative, off by default). Offline there is no gate, so it stays false.
  let approvalRequired = false;
  // Block resources OFFLINE only: mining a block banks one of its kind, placing spends one. Infinite by
  // default (solo sandbox + admins build freely). In co-op the inventory is server-authoritative (see
  // coop.inventoryCount / coop.infinite); these locals are unused there. Magic structures are exempt.
  let infiniteResources = true;
  const inventory = new BlockInventory();
  const blockedStructures = new Set<string>();
  let coop: CoopController | null = null;
  let fps = 0;

  // ---------- Co-op (remote players) — only when a server URL is configured ----------
  const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL;
  // In co-op the server owns every creature: motion, hp and death are decided on the server tick and
  // come back in the snapshot. We render those (coop.getCreatures) and never run the local simulation.
  // Local creatures stay only for true single-player (no server / no HUD bridge).
  const coopEnabled = !!serverUrl && !!bridge;
  // If a synced edit lands on the local player (e.g. a structure built where they stand), lift them out.
  function unstuckPlayer(): void {
    const fx = Math.floor(player.pos.x), fz = Math.floor(player.pos.z);
    const feet = Math.floor(player.pos.y - EYE_HEIGHT);
    if (!isSolid(fx, feet, fz) && !isSolid(fx, feet + 1, fz)) return;
    player.pos.y = clearFeetAbove({ feet, isSolid: (y) => isSolid(fx, y, fz) }) + EYE_HEIGHT;
    player.vel.set(0, 0, 0);
  }
  function applyRemoteEdit({ x, y, z, id, mine }: { x: number; y: number; z: number; id: number; mine: boolean }): void {
    if (!inBounds(x, y, z)) return;
    // When the server confirms OUR own dig broke a block, that is when we collect it (digs are
    // server-authoritative now, so we wait for the break instead of applying it optimistically).
    if (mine && id === AIR) {
      const removed = getVoxel(x, y, z);
      if (removed !== AIR) { player.bag += 1; inventory.bank(removed); updateHotbarCounts(); updateStats(); }
    }
    setVoxel(x, y, z, id);
    remeshRegion(x - 1, x + 1, z - 1, z + 1);
    unstuckPlayer();
    debug('coop', 'remote edit', { x, y, z, id, mine });
  }
  function applyRemoteEditBatch(edits: EditCell[]): void {
    if (edits.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const { x, y, z, id } of edits) {
      if (!inBounds(x, y, z)) continue;
      setVoxel(x, y, z, id);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (minX <= maxX) remeshRegion(minX - 1, maxX + 1, minZ - 1, maxZ + 1);
    unstuckPlayer();
    debug('coop', 'remote edit batch', { count: edits.length });
  }
  // Room-wide settings (admin-controlled, server-authoritative): peace calms the local creatures for
  // everyone, and blocked structures disable those entries in the build menu.
  function applyRoomState({ peace, blockedStructures: blocked, pvp: pvpOn, chatEnabled: chatOn, approvalRequired: approval }: RoomState): void {
    peaceful = peace;
    pvp = pvpOn;
    chatEnabled = chatOn;
    approvalRequired = approval;
    blockedStructures.clear();
    for (const kind of blocked) blockedStructures.add(kind);
    syncBuildMenu();
    debug('engine', 'room state applied', { peace, blocked: blocked.length, pvp: pvpOn, chat: chatOn, approval });
  }
  // Offline there is no server room: admin toggles mutate the local state directly and refresh the HUD
  // (online always routes through coop instead, so the two paths never mix).
  const currentRoom = (): RoomState => ({ peace: peaceful, blockedStructures: [...blockedStructures], pvp, chatEnabled, suspended: false, approvalRequired });
  function applyLocalRoom(next: RoomState): void {
    applyRoomState(next);
    bridge?.hud.onRoomState(next);
  }
  // The server (which owns hearts in co-op) reports a hit — from a monster or another player. We only
  // play the damage cue; the heart count itself arrives authoritatively in the next snapshot.
  function applyHurt(by: string): void {
    flashDamage();
    debug('engine', 'hurt', { by });
  }
  function localPose(): { x: number; y: number; z: number; yaw: number; pitch: number } {
    return { x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch };
  }
  function sendCoopEdit(op: EditOp, x: number, y: number, z: number, id: number): void {
    coop?.sendEdit(op, x, y, z, id);
  }
  function debugSnapshot(): DebugSnapshot {
    return buildDebugSnapshot({
      fps,
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      chunks: chunkMeshes.size,
      tenant: brand.id,
      frontVersion: APP_VERSION,
      coop: coop ? { ping: coop.ping, state: coop.state, onlineCount: coop.onlineCount, backendVersion: coop.backendVersion } : null,
    });
  }
  bridge?.bind({
    sendChat: (text) => { if (chatEnabled) coop?.sendChat(text); },
    setAdminPeace: (on) => { if (coop) { coop.sendAdminSetPeace(on); return; } applyLocalRoom({ ...currentRoom(), peace: on }); },
    setAdminStructure: (kind, allowed) => {
      if (coop) { coop.sendAdminSetStructure(kind, allowed); return; }
      const blocked = new Set(blockedStructures);
      if (allowed) blocked.delete(kind); else blocked.add(kind);
      applyLocalRoom({ ...currentRoom(), blockedStructures: [...blocked] });
    },
    setAdminPvp: (on) => { if (coop) { coop.sendAdminSetPvp(on); return; } applyLocalRoom({ ...currentRoom(), pvp: on }); },
    setAdminChat: (on) => { if (coop) { coop.sendAdminSetChat(on); return; } applyLocalRoom({ ...currentRoom(), chatEnabled: on }); },
    kickPlayer: (id) => coop?.sendAdminKick(id),
    banPlayer: (id) => coop?.sendAdminBan(id),
    resetWorld: () => { if (coop) { coop.sendAdminResetWorld(); return; } resetLocalWorld(); },
    resetScores: () => coop?.sendAdminResetScores(),
    suspendRoom: (on) => coop?.sendAdminSuspend(on),
    setRole: (id, role) => coop?.sendAdminSetRole(id, role),
    setApprovalRequired: (on) => coop?.sendAdminSetApproval(on),
    approvePlayer: (accountId) => coop?.sendAdminApprove(accountId),
    setInfiniteResources: (on) => {
      if (coop) { coop.sendAdminSetInfinite(on); return; }
      infiniteResources = on;
      updateHotbarCounts();
    },
    returnToSpawn: () => {
      if (coop) { coop.sendRespawn(); return; }
      player.pos.copy(spawnPoint()); player.vel.set(0, 0, 0); savePos();
    },
    debugSnapshot,
  });

  // ---------- Creatures (animals to hunt, monsters to fight) ----------
  const creatures: Creature[] = [];
  const creatureGroup = new THREE.Group();
  scene.add(creatureGroup);

  function groundHeight(x: number, z: number): number {
    const gx = Math.floor(x), gz = Math.floor(z);
    return groundHeightAt({ isSolidAt: (y) => isSolid(gx, y, gz) });
  }
  function spawnCreature(typeKey: string): void {
    const def = CREATURE_DEFS[typeKey];
    if (!def) throw new Error(`unknown creature ${typeKey}`);
    const { x, z } = spawnPosition({ sizeX: SIZE_X, sizeZ: SIZE_Z, random: Math.random });
    const body = new THREE.Mesh(new THREE.BoxGeometry(...def.size), makeFaceMaterial(def.color));
    const mesh = new THREE.Group();
    mesh.add(body);
    mesh.position.set(x, groundHeight(x, z) + def.size[1] / 2, z);
    creatureGroup.add(mesh);
    creatures.push({
      typeKey, def, mesh, body,
      hp: def.hp,
      dir: Math.random() * Math.PI * 2,
      timer: 0, bob: Math.random() * Math.PI * 2, flash: 0,
    });
  }
  function populateCreatures(): void {
    for (const kind of STARTING_ROSTER) spawnCreature(kind);
  }
  function updateCreatures(dt: number): void {
    player.hurtCooldown = Math.max(0, player.hurtCooldown - dt);
    for (const cr of creatures) {
      cr.timer -= dt;
      cr.bob += dt * 6;
      cr.flash = Math.max(0, cr.flash - dt);
      const toPlayer = new THREE.Vector3().subVectors(player.pos, cr.mesh.position);
      toPlayer.y = 0;
      const dist = toPlayer.length();
      const isMonster = cr.def.kind === 'monster';
      const hostile = isMonster && !peaceful;

      const motion = stepCreatureDirection({
        toPlayerX: toPlayer.x, toPlayerZ: toPlayer.z, dist, isMonster, peaceful,
        dir: cr.dir, timer: cr.timer, random: Math.random,
      });
      cr.dir = motion.dir; cr.timer = motion.timer;

      const stepped = stepCreaturePosition({
        x: cr.mesh.position.x, z: cr.mesh.position.z, dir: cr.dir, speed: cr.def.speed, dt, sizeX: SIZE_X, sizeZ: SIZE_Z,
      });
      cr.mesh.position.x = stepped.x;
      cr.mesh.position.z = stepped.z;
      cr.mesh.position.y = groundHeight(cr.mesh.position.x, cr.mesh.position.z) + cr.def.size[1] / 2 + bobOffset(cr.bob);
      cr.mesh.rotation.y = cr.dir;
      cr.body.material.emissive = new THREE.Color(cr.flash > 0 ? '#ff0000' : '#000000');

      const verticalGap = Math.abs(player.pos.y - EYE_HEIGHT - cr.mesh.position.y);
      if (hostile && player.hurtCooldown === 0 && creatureBitesPlayer({ horizontalDistance: dist, verticalGap })) hurtPlayer();
    }
  }
  // The point-of-view damage cue: a red wash over the screen, the hearts shake, and a thud. Driven by
  // taking damage — locally offline, and by the server's Hurt message in co-op.
  function flashDamage(): void {
    blip(140, 0.18);
    const heartsEl = el('hearts');
    heartsEl.classList.add('hit');
    setTimeout(() => heartsEl.classList.remove('hit'), 300);
    const flash = el('hurtFlash');
    flash.classList.remove('show');
    void flash.offsetWidth;
    flash.classList.add('show');
  }
  function hurtPlayer(): void {
    player.hearts -= 1;
    player.hurtCooldown = 1.2;
    flashDamage();
    updateStats();
    if (player.hearts <= 0) napAndRespawn();
  }
  function napAndRespawn(): void {
    toast(t('toast.nap'));
    player.hearts = MAX_HEARTS;
    player.pos.copy(spawnPoint());
    player.vel.set(0, 0, 0);
    updateStats();
  }
  function raycastCreature(): { creature: Creature; t: number } | null {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const targets = creatures.map((cr) => ({ x: cr.mesh.position.x, y: cr.mesh.position.y, z: cr.mesh.position.z, radius: Math.max(...cr.def.size) * 0.7 }));
    const pick = sphereCastClosest({ origin: camera.position, dir, targets, maxDist: REACH });
    return pick ? { creature: creatures[pick.index], t: pick.t } : null;
  }
  function hitCreature(cr: Creature): void {
    cr.hp -= 1;
    cr.flash = FLASH_TIME;
    blip(cr.def.kind === 'monster' ? 300 : 880, 0.08);
    const knock = knockbackVector({ creatureX: cr.mesh.position.x, creatureZ: cr.mesh.position.z, playerX: player.pos.x, playerZ: player.pos.z });
    cr.mesh.position.x += knock.x;
    cr.mesh.position.z += knock.z;
    debug('engine', 'hit creature', { kind: cr.typeKey, hp: cr.hp, x: Math.round(cr.mesh.position.x), z: Math.round(cr.mesh.position.z) });
    if (cr.hp > 0) return;
    defeatCreature(cr);
  }
  function defeatCreature(cr: Creature): void {
    spawnPoof(cr.mesh.position, cr.def.color);
    player.stars += cr.def.reward;
    player.bag += 1;
    toast(t('toast.reward', { emoji: cr.def.emoji, reward: cr.def.reward }));
    blip(660, 0.12); setTimeout(() => blip(990, 0.12), 90);
    updateStats();
    creatureGroup.remove(cr.mesh);
    cr.body.geometry.dispose();
    creatures.splice(creatures.indexOf(cr), 1);
    setTimeout(() => { if (!disposed) spawnCreature(cr.typeKey); }, 4000);
  }

  // Co-op: the server owns creatures, so an attack is a request. We aim the crosshair at a snapshot
  // creature (same sphere test as the local raycast) and ask the server to apply the hit; death,
  // reward and despawn all come back authoritatively in the next snapshot.
  function raycastServerCreature(): { creature: CoopCreature; t: number } | null {
    if (!coop) return null;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const candidates = coop.getCreatures();
    const pick = sphereCastClosest({ origin: camera.position, dir, targets: candidates, maxDist: REACH });
    return pick ? { creature: candidates[pick.index], t: pick.t } : null;
  }
  function hitServerCreature(cr: CoopCreature): void {
    coop?.sendHit(cr.id);
    coop?.flashCreature(cr.id);
    spawnPoof(new THREE.Vector3(cr.x, cr.y, cr.z), creatureDefFor(cr.kind).color);
    const def = creatureDefFor(cr.kind);
    blip(def.kind === 'monster' ? 300 : 880, 0.08);
    debug('engine', 'hit request', { id: cr.id, kind: cr.kind });
  }

  // Co-op pvp: when the room has pvp on we aim the crosshair at a remote player (same sphere test as
  // creatures) and ask the server to apply the hit; the server validates pvp + range and replies with
  // Hurt to the target. Returns null when pvp is off so players never damage each other.
  function raycastRemotePlayer(): { player: CoopPlayer; t: number } | null {
    if (!coop || !pvp) return null;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const candidates = coop.getPlayers();
    const pick = sphereCastClosest({ origin: camera.position, dir, targets: candidates, maxDist: REACH });
    return pick ? { player: candidates[pick.index], t: pick.t } : null;
  }
  function attackRemotePlayer(p: CoopPlayer): void {
    coop?.sendAttackPlayer(p.id);
    spawnPoof(new THREE.Vector3(p.x, p.y, p.z), '#ff5555');
    blip(300, 0.08);
    debug('engine', 'attack player', { id: p.id });
  }

  // ---------- Poof particles ----------
  const spawnPoof = (pos: THREE.Vector3, color: string): void => poofRuntime.spawn(pos, color);
  const updatePoofs = (dt: number): void => poofRuntime.update(dt);

  // The admin wiped the world: rebuild it in place (like a fresh boot) and respawn, so every player
  // resets without being kicked back to the lobby. The server's reset already cleared its own world
  // and creatures; the local creatures (single-player) and poofs are cleared to match.
  function resetLocalWorld(): void {
    world.reset();
    buildWelcomeMonument();
    updateChunks(true);
    processMeshQueue(isTouch ? 24 : 60);
    poofRuntime.clear();
    player.pos.copy(spawnPoint());
    player.vel.set(0, 0, 0);
    savePos();
  }

  // ---------- Scoreboard ----------
  function storedBest(): number {
    const stored = localStorage.getItem(BEST_KEY);
    return stored ? Number(stored) : 0;
  }
  function recordServerScore(score: number): void {
    localStorage.setItem(BEST_KEY, String(persistedRecord({ serverScore: score, stored: storedBest() })));
  }
  function updateStats(): void {
    el('hearts').textContent = heartsLabel({ hearts: player.hearts, maxHearts: MAX_HEARTS });
    el('stars').textContent = `⭐ ${player.stars}`;
    el('bag').textContent = `🎒 ${player.bag}`;
    el('record').textContent = `🏆 ${bestScore({ stars: player.stars, stored: storedBest() })}`;
  }

  // ---------- Voxel raycast (DDA) ----------
  function raycastVoxel(maxDist = REACH): VoxelHit | null {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    return ddaRaycast({ world, origin: camera.position, dir, maxDist });
  }

  // ---------- Build / break ----------
  function primaryAction(): void {
    const block = raycastVoxel();
    const blockDistance = block ? new THREE.Vector3(block.hit[0] + 0.5, block.hit[1] + 0.5, block.hit[2] + 0.5).distanceTo(camera.position) : Infinity;
    if (coop) {
      const playerHit = raycastRemotePlayer();
      const serverHit = raycastServerCreature();
      const target = chooseCoopTarget({
        playerT: playerHit ? playerHit.t : null, creatureT: serverHit ? serverHit.t : null,
        blockDistance, hasBlock: !!block,
      });
      if (target === 'player' && playerHit) { attackRemotePlayer(playerHit.player); return; }
      if (target === 'creature' && serverHit) { hitServerCreature(serverHit.creature); return; }
      if (target === 'block' && block) breakBlock(block);
      return;
    }
    const creatureHit = raycastCreature();
    const target = chooseLocalTarget({ creatureT: creatureHit ? creatureHit.t : null, blockDistance, hasBlock: !!block });
    if (target === 'creature' && creatureHit) { hitCreature(creatureHit.creature); return; }
    if (target === 'block' && block) breakBlock(block);
  }
  function breakBlock(r: VoxelHit): void {
    // Co-op: the server counts the taps and decides the break (authoritative dig). We just send the tap
    // and chip — the block is removed + collected when the server's break edit comes back to us.
    if (coop) {
      coop.sendDig(r.hit[0], r.hit[1], r.hit[2]);
      blip(180, 0.05);
      return;
    }
    const removed = getVoxel(r.hit[0], r.hit[1], r.hit[2]);
    setVoxel(r.hit[0], r.hit[1], r.hit[2], AIR);
    remeshRegion(r.hit[0] - 1, r.hit[0] + 1, r.hit[2] - 1, r.hit[2] + 1);
    player.bag += 1;
    // Co-op banks the block server-side (it credits the broken block and pushes the new counts back);
    // offline the local inventory is authoritative, so bank + repaint here.
    if (!coop) { inventory.bank(removed); updateHotbarCounts(); }
    updateStats();
    blip(220, 0.08);
    debug('engine', 'break block', { x: r.hit[0], y: r.hit[1], z: r.hit[2], id: removed });
  }
  function placeBlock(): void {
    const r = raycastVoxel();
    if (!r) return;
    const [px, py, pz] = r.place;
    if (!inBounds(px, py, pz) || getVoxel(px, py, pz) !== AIR) return;
    if (overlapsPlayer(px, py, pz)) return;
    if (!canPlaceSelected()) { toast(t('toast.out_of_blocks')); blip(160, 0.1); return; }
    // Co-op spends the block server-side (it decrements and pushes the new counts back); offline the
    // local inventory is authoritative, so spend + repaint here.
    if (!coop && shouldSpendBlock({ infiniteResources })) { inventory.spend(selected); updateHotbarCounts(); }
    setVoxel(px, py, pz, selected);
    remeshRegion(px - 1, px + 1, pz - 1, pz + 1);
    sendCoopEdit('place', px, py, pz, selected);
    blip(selected === FACE_ID ? 720 : 520, 0.08);
    debug('engine', 'place block', { x: px, y: py, z: pz, id: selected });
  }
  // Whether the selected block can be placed: co-op reads the server-authoritative inventory + infinite
  // flag; offline reads the local BlockInventory + the local infinite toggle.
  function canPlaceSelected(): boolean {
    if (coop) return coop.infinite || coop.inventoryCount(selected) > 0;
    return canPlaceOffline({ infiniteResources, count: inventory.count(selected) });
  }
  // True if the cell would land on the local player or any remote player (no building on people).
  function overlapsPlayer(x: number, y: number, z: number): boolean {
    const p = player.pos;
    const overlaps = (feetX: number, feetY: number, feetZ: number): boolean =>
      cellOverlapsActor({ x, y, z, feetX, feetY, feetZ, radius: PLAYER_RADIUS, height: PLAYER_HEIGHT });
    if (overlaps(p.x, p.y - EYE_HEIGHT, p.z)) return true;
    if (!coop) return false;
    return coop.getColliders().some((a) => overlaps(a.x, a.y, a.z));
  }

  // ---------- Magic structures ----------
  function buildStructure(kind: StructureKind): void {
    if (blockedStructures.has(kind)) { toast(t('build.blocked')); return; }
    const aim = raycastVoxel(90);
    const { cx, cz } = structureTarget({
      aim: aim ? { x: aim.hit[0], z: aim.hit[2] } : null,
      playerX: player.pos.x, playerZ: player.pos.z, yaw: player.yaw,
    });
    const gy = groundHeight(cx, cz);
    const reach = structureReach(kind);
    const cells: EditCell[] = [];
    // Skip any cell that would land on a player so a structure can never trap someone.
    const collect = (x: number, y: number, z: number, id: number): void => {
      if (overlapsPlayer(x, y, z)) return;
      setVoxel(x, y, z, id);
      cells.push({ x, y, z, id });
    };
    if (kind === 'trophy') stampTrophy({ set: collect, cx, gy, cz });
    if (kind === 'ball') stampBall({ set: collect, cx, gy, cz, radius: 8 });
    if (kind === 'figure') stampFigure({ set: collect, cx, gy, cz });
    if (kind === 'cola') stampCola({ set: collect, cx, gy, cz });
    if (kind === 'steve') stampSteve({ set: collect, cx, gy, cz });
    remeshRegion(cx - reach, cx + reach, cz - reach, cz + reach);
    coop?.sendEditBatch(cells);
    const messages: Record<StructureKind, string> = { trophy: t('toast.built_trophy'), ball: t('toast.built_ball'), figure: t('toast.built_figure'), cola: t('toast.built_cola'), steve: t('toast.built_steve') };
    toast(messages[kind]);
    blip(680, 0.12); setTimeout(() => blip(1020, 0.14), 110);
    debug('engine', 'structure built', { kind, x: cx, y: gy, z: cz });
  }

  // ---------- Physics ----------
  const stepAxis = (axis: Axis, amount: number): void => moveAxis({ world, player, axis, amount });

  // Stop the local player from walking through remote players AND server creatures (velocity-only,
  // never adds motion) — monsters and animals are solid bodies you bump into, not ghosts.
  function blockIntoActors(): void {
    if (!coop) return;
    const players = coop.getColliders();
    const creatures = coop.getCreatures().map((c) => ({ x: c.x, y: c.y, z: c.z }));
    const actors = [...players, ...creatures];
    if (actors.length === 0) return;
    const blocked = blockVelocityIntoActors({
      x: player.pos.x,
      y: player.pos.y - EYE_HEIGHT,
      z: player.pos.z,
      vx: player.vel.x,
      vz: player.vel.z,
      radius: PLAYER_RADIUS,
      height: PLAYER_HEIGHT,
      actors,
      actorRadius: PLAYER_RADIUS,
    });
    player.vel.x = blocked.vx;
    player.vel.z = blocked.vz;
  }

  const keys: Record<string, boolean> = {};
  interface Joystick { active: boolean; x: number; y: number; id: number | null; cx: number; cy: number; r: number; }
  const joystick: Joystick = { active: false, x: 0, y: 0, id: null, cx: 0, cy: 0, r: 50 };
  const typingInField = (): boolean => document.activeElement instanceof HTMLInputElement;
  addEventListener('keydown', (e) => { if (typingInField()) return; keys[e.code] = true; handleHotkey(e); }, { signal });
  addEventListener('keyup', (e) => { keys[e.code] = false; }, { signal });

  function update(dt: number): void {
    const move = moveVector({
      yaw: player.yaw, pitch: player.pitch, fly: player.fly,
      forward: !!(keys.KeyW || keys.ArrowUp), back: !!(keys.KeyS || keys.ArrowDown),
      right: !!(keys.KeyD || keys.ArrowRight), left: !!(keys.KeyA || keys.ArrowLeft),
      joystickActive: joystick.active, joystickX: joystick.x, joystickY: joystick.y,
    });

    if (player.fly) {
      player.vel.set(move.x, move.y, move.z).multiplyScalar(FLY_SPEED);
      if (keys.Space) player.vel.y = FLY_SPEED;
      if (keys.ShiftLeft || keys.ShiftRight) player.vel.y = -FLY_SPEED;
    } else {
      player.vel.x = move.x * WALK_SPEED;
      player.vel.z = move.z * WALK_SPEED;
      player.vel.y += GRAVITY * dt;
      if (keys.Space && player.onGround) { player.vel.y = JUMP_SPEED; player.onGround = false; }
    }

    blockIntoActors();

    player.onGround = false;
    stepAxis('x', player.vel.x * dt);
    stepAxis('z', player.vel.z * dt);
    stepAxis('y', player.vel.y * dt);

    if (player.pos.y < -8) { player.pos.copy(spawnPoint()); player.vel.set(0, 0, 0); }
    clampToWorld(player.pos);

    camera.position.copy(player.pos);
    const look = lookDirection({ yaw: player.yaw, pitch: player.pitch });
    camera.lookAt(camera.position.clone().add(new THREE.Vector3(look.x, look.y, look.z)));

    const r = raycastVoxel();
    if (r) { highlight.visible = true; highlight.position.set(r.hit[0] + 0.5, r.hit[1] + 0.5, r.hit[2] + 0.5); }
    else highlight.visible = false;
  }

  // ---------- Input ----------
  function lockPointer(): void {
    if (!started || isTouch) return;
    Promise.resolve(canvas.requestPointerLock()).catch((err: unknown) => {
      debug('engine', 'pointer-lock denied', { reason: String(err) });
    });
  }
  canvas.addEventListener('click', () => { if (started && !isTouch) lockPointer(); }, { signal });
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    player.yaw -= e.movementX * 0.0022;
    player.pitch -= e.movementY * 0.0022;
    player.pitch = Math.max(-1.5, Math.min(1.5, player.pitch));
  }, { signal });
  addEventListener('mousedown', (e) => {
    if (document.pointerLockElement !== canvas) return;
    if (e.button === 0) primaryAction();
    if (e.button === 2) placeBlock();
  }, { signal });
  addEventListener('contextmenu', (e) => e.preventDefault(), { signal });

  if (isTouch) setupTouchControls();
  function setupTouchControls(): void {
    document.body.classList.add('is-touch');
    let lookId: number | null = null, lx = 0, ly = 0;
    canvas.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      if (lookId === null) { lookId = t.identifier; lx = t.clientX; ly = t.clientY; }
    }, { passive: true, signal });
    canvas.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== lookId) continue;
        player.yaw -= (t.clientX - lx) * 0.005;
        player.pitch -= (t.clientY - ly) * 0.005;
        player.pitch = Math.max(-1.5, Math.min(1.5, player.pitch));
        lx = t.clientX; ly = t.clientY;
      }
    }, { passive: true, signal });
    const endLook = (e: TouchEvent): void => { for (const t of e.changedTouches) if (t.identifier === lookId) lookId = null; };
    canvas.addEventListener('touchend', endLook, { signal });
    canvas.addEventListener('touchcancel', endLook, { signal });

    const joyEl = el('joystick');
    const knob = el('joyKnob');
    const setKnob = (dx: number, dy: number): void => { knob.style.transform = `translate(${dx}px, ${dy}px)`; };
    const moveJoy = (t: Touch): void => {
      const reading = readJoystick({ touchX: t.clientX, touchY: t.clientY, centerX: joystick.cx, centerY: joystick.cy, radius: joystick.r });
      joystick.x = reading.moveX; joystick.y = reading.moveY;
      setKnob(reading.knobX, reading.knobY);
    };
    joyEl.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      const rect = joyEl.getBoundingClientRect();
      joystick.active = true; joystick.id = t.identifier;
      joystick.cx = rect.left + rect.width / 2; joystick.cy = rect.top + rect.height / 2;
      joystick.r = rect.width / 2;
      moveJoy(t); e.preventDefault();
    }, { passive: false, signal });
    joyEl.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) if (t.identifier === joystick.id) moveJoy(t);
      e.preventDefault();
    }, { passive: false, signal });
    const endJoy = (e: TouchEvent): void => {
      for (const t of e.changedTouches) if (t.identifier === joystick.id) {
        joystick.active = false; joystick.id = null; joystick.x = 0; joystick.y = 0; setKnob(0, 0);
      }
    };
    joyEl.addEventListener('touchend', endJoy, { signal });
    joyEl.addEventListener('touchcancel', endJoy, { signal });

    const holdKey = (id: string, code: string): void => {
      const node = el(id);
      node.addEventListener('touchstart', (e) => { keys[code] = true; e.preventDefault(); }, { passive: false, signal });
      const up = (): void => { keys[code] = false; };
      node.addEventListener('touchend', up, { signal });
      node.addEventListener('touchcancel', up, { signal });
    };
    holdKey('btnUp', 'Space');
    holdKey('btnDown', 'ShiftLeft');
    const tapBtn = (id: string, fn: () => void): void => {
      el(id).addEventListener('touchstart', (e) => { fn(); e.preventDefault(); }, { passive: false, signal });
    };
    tapBtn('btnBreak', primaryAction);
    tapBtn('btnPlace', placeBlock);
  }

  function handleHotkey(e: KeyboardEvent): void {
    if (e.code === 'Escape') { hideControls(); hideBuildMenu(); return; }
    const b = BLOCKS.find((bl) => bl && bl.key === e.key);
    if (b) selectSlot(b.id);
    if (e.code === 'KeyF') toggleFly();
    if (e.code === 'KeyV') toggleControls();
    if (e.code === 'KeyB') toggleBuildMenu();
  }

  // ---------- Controls modal ----------
  let paused = false;
  const controlsEl = el('controls');
  function showControls(): void {
    paused = true;
    controlsEl.hidden = false;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  }
  function hideControls(): void {
    paused = false;
    controlsEl.hidden = true;
    if (started && !isTouch) lockPointer();
  }
  function toggleControls(): void { controlsEl.hidden ? showControls() : hideControls(); }
  el('helpBtn').addEventListener('click', (e) => { e.stopPropagation(); showControls(); }, { signal });
  el('closeControls').addEventListener('click', (e) => { e.stopPropagation(); hideControls(); }, { signal });
  controlsEl.addEventListener('click', (e) => { if (e.target === controlsEl) hideControls(); }, { signal });

  // ---------- Build menu ----------
  const buildMenuEl = el('buildMenu');
  function showBuildMenu(): void {
    paused = true;
    buildMenuEl.hidden = false;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  }
  function hideBuildMenu(): void {
    paused = false;
    buildMenuEl.hidden = true;
    if (started && !isTouch) lockPointer();
  }
  function toggleBuildMenu(): void { buildMenuEl.hidden ? showBuildMenu() : hideBuildMenu(); }
  el('buildBtn').addEventListener('click', (e) => { e.stopPropagation(); showBuildMenu(); }, { signal });
  el('closeBuild').addEventListener('click', (e) => { e.stopPropagation(); hideBuildMenu(); }, { signal });
  buildMenuEl.addEventListener('click', (e) => { if (e.target === buildMenuEl) hideBuildMenu(); }, { signal });
  buildMenuEl.querySelectorAll<HTMLButtonElement>('.buildCard').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const kind = btn.dataset.kind;
      if (!kind) throw new Error('build card missing data-kind');
      if (blockedStructures.has(kind)) return;
      buildStructure(kind as StructureKind);
      hideBuildMenu();
    }, { signal });
  });
  // Hide blocked structure cards so a player never sees what an admin has blocked room-wide;
  // unblocked ones reappear. buildStructure still guards against a stale blocked pick.
  function syncBuildMenu(): void {
    buildMenuEl.querySelectorAll<HTMLButtonElement>('.buildCard').forEach((btn) => {
      const kind = btn.dataset.kind;
      if (!kind) throw new Error('build card missing data-kind');
      btn.style.display = blockedStructures.has(kind) ? 'none' : '';
    });
  }

  // ---------- Sound ----------
  let audio: AudioContext | undefined;
  function blip(freq: number, dur: number): void {
    if (!audio) {
      const Ctor = window.AudioContext || win.webkitAudioContext;
      if (!Ctor) throw new Error('AudioContext unsupported');
      audio = new Ctor();
    }
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.value = 0.06; o.connect(g); g.connect(audio.destination);
    o.start(); g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
    o.stop(audio.currentTime + dur);
  }

  // ---------- HUD ----------
  const hotbar = el('hotbar');
  function buildHotbar(faceUrl: string): void {
    for (const b of BLOCKS) {
      if (!b) continue;
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.id = String(b.id);
      const swatch = document.createElement('div');
      swatch.className = 'swatch';
      if (b.id === FACE_ID) swatch.style.background = `center/cover url(${faceUrl})`;
      else { swatch.style.background = `center/cover url(${renderBlockCanvas(b).toDataURL()})`; swatch.style.imageRendering = 'pixelated'; }
      slot.appendChild(swatch);
      const key = document.createElement('span'); key.className = 'key'; key.textContent = b.key; slot.appendChild(key);
      const name = document.createElement('span'); name.className = 'name'; name.textContent = blockName(b); slot.appendChild(name);
      const count = document.createElement('span'); count.className = 'count'; slot.appendChild(count);
      slot.addEventListener('click', () => selectSlot(b.id), { signal });
      hotbar.appendChild(slot);
    }
    updateHotbarCounts();
  }
  // Admins build freely, so their slots show no counter; regular players see how many of each block
  // they have banked (∞ would be misleading, so it is simply hidden when resources are infinite). Co-op
  // reads the server-authoritative inventory; offline reads the local BlockInventory.
  function updateHotbarCounts(): void {
    const infinite = coop ? coop.infinite : infiniteResources;
    for (const slot of [...hotbar.children] as HTMLElement[]) {
      const id = Number(slot.dataset.id);
      const badge = slot.querySelector<HTMLElement>('.count');
      if (!badge) continue;
      const count = coop ? coop.inventoryCount(id) : inventory.count(id);
      badge.textContent = hotbarCountLabel({ infiniteResources: infinite, count });
    }
  }
  function selectSlot(id: number): void {
    selected = id;
    [...hotbar.children].forEach((s) => s.classList.toggle('active', Number((s as HTMLElement).dataset.id) === id));
    const block = blockById(id);
    if (!block) throw new Error(`unknown block ${id}`);
    toast(t('toast.block_selected', { name: blockName(block) }));
  }

  const toastEl = el('toast');
  let toastTimer: ReturnType<typeof setTimeout>;
  function toast(msg: string): void {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1200);
  }

  function toggleFly(): void {
    player.fly = !player.fly;
    el('flyBtn').classList.toggle('on', player.fly);
    toast(player.fly ? t('toast.flying') : t('toast.walking'));
    debug('engine', 'fly toggled', { fly: player.fly });
  }
  el('flyBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleFly(); }, { signal });

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }, { signal });

  // ---------- Loop ----------
  const POS_SAVE_MS = 2000;
  let started = false;
  let last = performance.now();
  let lastPosSave = last;
  function loop(now: number): void {
    if (disposed) return;
    rafId = requestAnimationFrame(loop);
    const frame = nextFrame({ now, last });
    if (frame.skip) return;
    last = frame.last;
    const dt = frame.dt;
    fps = smoothFps({ fps, dt });
    if (started && !paused) { update(dt); updateChunks(); processMeshQueue(isTouch ? 1 : 2); if (!coop) updateCreatures(dt); updatePoofs(dt); }
    if (coop) { coop.sendMove(localPose(), now); coop.update(now); }
    if (started && now - lastPosSave > POS_SAVE_MS) { savePos(); lastPosSave = now; }
    renderer.render(scene, camera);
  }

  function start(): void {
    started = true;
    el('start').style.display = 'none';
    ['#topbar', '#hotbar', '#actionRow', '#crosshair'].forEach((s) => {
      const node = document.querySelector<HTMLElement>(s);
      if (!node) throw new Error(`missing element ${s}`);
      node.style.opacity = '1';
    });
    if (isTouch) el('touchControls').style.display = 'block';
    if (!isTouch) lockPointer();
    blip(660, 0.12); setTimeout(() => blip(880, 0.14), 120);
    startCoop();
  }
  // Offline / single-player: there is no server to grant admin, so every offline player IS admin and
  // controls the room locally. Online never calls this (coop is set), so the modes can't collide.
  function grantOfflineAdmin(): void {
    bridge?.hud.onRole({ admin: true, moderator: false });
    bridge?.hud.onRoomState(currentRoom());
  }
  function startCoop(): void {
    if (coop) return;
    if (!serverUrl) { debug('coop', 'single-player (no server url)'); grantOfflineAdmin(); return; }
    if (!bridge) { debug('coop', 'single-player (no hud bridge)'); return; }
    if (bridge.resolveOffline()) {
      debug('coop', 'single-player (chosen)');
      if (!creatures.length) populateCreatures();
      grantOfflineAdmin();
      return;
    }
    const name = bridge.resolveName();
    const look = bridge.resolveAppearance();
    const claim = bridge.resolveClaim(name);
    // The authoritative score arrives in every snapshot; paint it into the engine-owned topbar
    // (stars + record) before forwarding to the React HUD.
    const hud: CoopHud = {
      ...bridge.hud,
      onScore: (score) => {
        player.stars = score;
        recordServerScore(score);
        updateStats();
        bridge.hud.onScore(score);
      },
      onRole: (role) => bridge.hud.onRole(role),
    };
    coop = createCoop({
      three: THREE,
      scene,
      url: serverUrl,
      tenant: brand.id,
      world: MAIN_WORLD,
      name,
      skin: look.skin,
      shirt: look.shirt,
      hair: look.hair,
      claim,
      hud,
      applyRemoteEdit,
      applyRemoteEditBatch,
      applyRoomState,
      applyHurt,
      onCreaturePoof: ({ x, y, z, color }) => spawnPoof(new THREE.Vector3(x, y, z), color),
      onWorldReset: resetLocalWorld,
      onSpawn: (x, y, z) => { player.pos.set(x, y, z); player.vel.set(0, 0, 0); },
      onHealth: (hp) => {
        if (hp < player.hearts) flashDamage();
        player.hearts = hp;
        updateStats();
      },
      onRespawn: (x, y, z, hp) => {
        player.pos.set(x, y, z);
        player.vel.set(0, 0, 0);
        player.hearts = hp;
        updateStats();
        toast(t('toast.nap'));
      },
      // The server pushed this player's authoritative inventory (counts + infinite flag): repaint the
      // hotbar from it.
      onInventory: updateHotbarCounts,
    });
    debug('coop', 'connecting', { url: serverUrl, tenant: brand.id, name });
  }
  el('playBtn').addEventListener('click', start, { signal });

  new THREE.TextureLoader().load(FACE_URL, (faceTex) => {
    if (disposed) return;
    faceTex.magFilter = THREE.NearestFilter;
    faceTex.colorSpace = THREE.SRGBColorSpace;
    buildMaterials({ materials, faceTexture: faceTex });
    buildWelcomeMonument();
    updateChunks(true);
    processMeshQueue(isTouch ? 24 : 60);
    if (!coopEnabled) populateCreatures();
    buildHotbar(FACE_URL);
    selectSlot(1);
    updateStats();
    el('startRecord').textContent = t('start.record_score', { score: storedBest() });
    last = performance.now();
    rafId = requestAnimationFrame(loop);
    debug('engine', 'boot complete', {
      tenant: brand.id,
      worldX: SIZE_X, worldZ: SIZE_Z, worldY: SIZE_Y,
      chunks: chunkMeshes.size,
      creatures: creatures.length,
      ms: Math.round(performance.now() - bootStart),
    });
  });

  const cleanup = (): void => {
    disposed = true;
    if (started) savePos();
    coop?.close();
    coop = null;
    cancelAnimationFrame(rafId);
    abort.abort();
    renderer.dispose();
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    win.__blGameBooted = false;
    win.__blGameCleanup = undefined;
  };
  win.__blGameCleanup = cleanup;
  // Dev-only E2E hook: lets the automated test plan read state and aim+attack without pointer lock.
  if (process.env.NODE_ENV !== 'production') {
    (win as unknown as { __blTest?: unknown }).__blTest = {
      creatures: () =>
        coop
          ? coop.getCreatures()
          : creatures.map((c) => ({ id: -1, kind: c.typeKey, x: c.mesh.position.x, y: c.mesh.position.y, z: c.mesh.position.z })),
      players: () => (coop ? coop.getPlayers() : []),
      pos: () => ({ x: player.pos.x, y: player.pos.y, z: player.pos.z }),
      stars: () => player.stars,
      hearts: () => player.hearts,
      fly: () => player.fly,
      teleport: (x: number, y: number, z: number) => { player.pos.set(x, y + EYE_HEIGHT, z); player.vel.set(0, 0, 0); },
      setFly: (on: boolean) => { player.fly = on; },
      face: (x: number, z: number) => { player.yaw = aimYaw({ targetX: x, targetZ: z, fromX: player.pos.x, fromZ: player.pos.z }); player.pitch = 0; },
      attackAt: (x: number, y: number, z: number) => {
        player.yaw = aimYaw({ targetX: x, targetZ: z, fromX: player.pos.x, fromZ: player.pos.z });
        player.pitch = aimPitch({ targetX: x, targetY: y, targetZ: z, fromX: player.pos.x, fromY: player.pos.y, fromZ: player.pos.z });
        camera.position.copy(player.pos);
        camera.lookAt(x, y, z);
        primaryAction();
      },
      rayHitAt: (x: number, y: number, z: number) => {
        camera.position.copy(player.pos);
        camera.lookAt(x, y, z);
        const r = raycastServerCreature();
        return r ? { id: r.creature.id, t: r.t } : null;
      },
      hitId: (id: number) => coop?.sendHit(id),
      digHit: (x: number, y: number, z: number) => coop?.sendDig(x, y, z),
      voxel: (x: number, y: number, z: number) => getVoxel(x, y, z),
      surfaceY: (x: number, z: number) => groundHeight(x, z),
      bag: () => player.bag,
    };
  }
  return cleanup;
}
