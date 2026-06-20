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
import { ctx2d, makeCanvas, renderBlockCanvas, textureFromCanvas } from './engine/textures';
import { meshChunkBuckets } from './engine/meshing';
import { sphereCastClosest } from './engine/sphere-cast';
import { moveVector } from './engine/movement';
import { canMonsterReachPlayer, HURT_BURIED_PROBE } from './engine/hurt';
import { BlockInventory, hotbarCountLabel } from './engine/inventory';
import { parseSavedPosition, serializeSavedPosition } from './engine/saved-position';
import { POOF_COUNT, POOF_LIFE, spawnPoofVelocity, stepPoof } from './engine/poofs';
import { nextFrame, smoothFps } from './engine/frame-cap';
import {
  chunkDistanceSquared, chunkOutsideKeepRange, chunksInRadius, decodeChunkKey, playerChunk, remeshChunkRange,
} from './engine/chunk-grid';
import { STRUCTURE_KINDS, type StructureKind, structureReach, structureTarget } from './engine/structure-build';
import { bestScore, heartsLabel, roundCoordinate } from './engine/scoreboard';
import { STARTING_ROSTER, spawnPosition } from './engine/creature-spawn';
import { bobOffset, creatureBitesPlayer, FLASH_TIME, knockbackVector, stepCreaturePosition } from './engine/creature-combat';
import { chooseCoopTarget, chooseLocalTarget } from './engine/attack-target';
import { groundHeight as groundHeightAt } from './engine/terrain-column';
import { readJoystick } from './engine/joystick';
import { createCoop, MAIN_WORLD, type Appearance, type CoopController, type CoopCreature, type CoopHud, type CoopPlayer } from './coop';
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

interface Poof {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
}

export { STRUCTURE_KINDS, type StructureKind } from './engine/structure-build';

interface GameWindow extends Window {
  __blGameBooted?: boolean;
  __blGameCleanup?: (() => void) | undefined;
  webkitAudioContext?: typeof AudioContext;
}

export interface DebugSnapshot {
  fps: number;
  ping: number;
  state: string;
  online: number;
  x: number;
  y: number;
  z: number;
  chunks: number;
  tenant: string;
}

// The bridge connects the React HUD to the engine: the HUD supplies the player name (resolved at
// connect time so late edits to the name field count) and receives net status / chat updates; the
// engine exposes chat sending and a live debug snapshot for F3.
// The control surface the engine binds back to the React HUD: chat, admin commands, debug snapshot.
export interface GameApi {
  sendChat(text: string): void;
  setAdminPeace(on: boolean): void;
  setAdminStructure(kind: string, allowed: boolean): void;
  setAdminPvp(on: boolean): void;
  setAdminChat(on: boolean): void;
  kickPlayer(id: number): void;
  banPlayer(id: number): void;
  resetWorld(): void;
  setRole(id: number, role: Role): void;
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
  const FACE_URL = brand.faceTexture;
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
    if (b.id === FACE_ID) return brand.faceBlockName;
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
  function buildMaterials(faceTexture: THREE.Texture): void {
    for (const b of BLOCKS) {
      if (!b) continue;
      let tex: THREE.Texture;
      if (b.id === FACE_ID) tex = faceTexture;
      else { tex = textureFromCanvas(renderBlockCanvas(b)); }
      materials[b.id] = new THREE.MeshLambertMaterial({
        map: tex,
        transparent: !!b.transparent,
        opacity: b.transparent ? 0.78 : 1,
        side: b.transparent ? THREE.DoubleSide : THREE.FrontSide,
      });
    }
  }

  // ---------- Voxel storage (sparse: only visited chunks use memory -> endless world) ----------
  const world = new VoxelWorld();
  const chunkKey = (cx: number, cz: number): number => world.chunkKey(cx, cz);
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

  // ---------- Meshing (face-culled, merged per block type) ----------
  const isTransparent = (id: number): boolean => !!blockById(id)?.transparent;

  const worldGroup = new THREE.Group();
  const chunkMeshes = new Map<string, THREE.Mesh[]>();
  let firstChunkStreamed = false;
  function meshChunk(cxh: number, czh: number): void {
    const key = `${cxh},${czh}`;
    const old = chunkMeshes.get(key);
    if (old) old.forEach((m) => { worldGroup.remove(m); m.geometry.dispose(); });

    const x0 = cxh * CHUNK, x1 = Math.min(SIZE_X, x0 + CHUNK);
    const z0 = czh * CHUNK, z1 = Math.min(SIZE_Z, z0 + CHUNK);
    const buckets = meshChunkBuckets({ getVoxel, isTransparent, x0, x1, z0, z1, sizeY: SIZE_Y });

    const meshes: THREE.Mesh[] = [];
    for (const b of BLOCKS) {
      if (!b) continue;
      const data = buckets.get(b.id);
      if (!data) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(data.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(data.norm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(data.uv, 2));
      geo.setIndex(data.idxs);
      const mesh = new THREE.Mesh(geo, materials[b.id]);
      worldGroup.add(mesh);
      meshes.push(mesh);
    }
    chunkMeshes.set(key, meshes);
    if (firstChunkStreamed) return;
    firstChunkStreamed = true;
    debug('engine', 'first chunk streamed', { cx: cxh, cz: czh, meshes: meshes.length });
  }
  const LOAD_R = isTouch ? 4 : 6;
  let lastPlayerChunkX: number | null = null, lastPlayerChunkZ: number | null = null;
  interface QueuedChunk { cx: number; cz: number; key: number; }
  const meshQueue: QueuedChunk[] = [];
  const queuedKeys = new Set<number>();
  function updateChunks(force?: boolean): void {
    const center = playerChunk(player.pos);
    if (!force && center.cx === lastPlayerChunkX && center.cz === lastPlayerChunkZ) return;
    lastPlayerChunkX = center.cx; lastPlayerChunkZ = center.cz;
    for (const { cx, cz } of chunksInRadius({ center, radius: LOAD_R, chunksX, chunksZ })) {
      const key = chunkKey(cx, cz);
      if ((chunkMeshes as Map<unknown, THREE.Mesh[]>).has(key) || queuedKeys.has(key)) continue;
      queuedKeys.add(key);
      meshQueue.push({ cx, cz, key });
    }
    meshQueue.sort((a, b) =>
      chunkDistanceSquared({ chunk: a, center }) - chunkDistanceSquared({ chunk: b, center }));
    for (const [key, meshes] of chunkMeshes) {
      const chunk = decodeChunkKey({ key: Number(key), chunksZ });
      if (!chunkOutsideKeepRange({ chunk, center, radius: LOAD_R })) continue;
      meshes.forEach((m) => { worldGroup.remove(m); m.geometry.dispose(); });
      chunkMeshes.delete(key);
    }
  }
  function processMeshQueue(budget: number): void {
    let done = 0;
    const center = { cx: Number(lastPlayerChunkX), cz: Number(lastPlayerChunkZ) };
    while (done < budget && meshQueue.length) {
      const next = meshQueue.shift();
      if (!next) break;
      const { cx, cz, key } = next;
      queuedKeys.delete(key);
      if ((chunkMeshes as Map<unknown, THREE.Mesh[]>).has(key)) continue;
      if (chunkOutsideKeepRange({ chunk: { cx, cz }, center, radius: LOAD_R })) continue;
      meshChunk(cx, cz);
      done++;
    }
  }
  function remeshRegion(minX: number, maxX: number, minZ: number, maxZ: number): void {
    const { cx0, cx1, cz0, cz1 } = remeshChunkRange({ minX, maxX, minZ, maxZ, chunksX, chunksZ });
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++) meshChunk(cx, cz);
  }

  // ---------- Scene ----------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#9fd8ff');
  scene.fog = new THREE.Fog('#bfeaff', isTouch ? 38 : 60, isTouch ? 108 : 150);
  scene.add(worldGroup);

  const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, isTouch ? 200 : 380);
  const renderer = new THREE.WebGLRenderer({ antialias: !isTouch, powerPreference: 'high-performance' });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(isTouch ? 1 : Math.min(devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);
  const canvas = renderer.domElement;

  scene.add(new THREE.HemisphereLight('#ffffff', '#88aa66', 0.95));
  const sun = new THREE.DirectionalLight('#fff4d6', 0.9);
  sun.position.set(60, 90, 30);
  scene.add(sun);

  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(6, 16, 16), new THREE.MeshBasicMaterial({ color: '#fff3b0' }));
  sunDisc.position.set(SIZE_X / 2 + 80, 110, SIZE_Z / 2 - 90);
  scene.add(sunDisc);
  for (let i = 0; i < 70; i++) {
    const cloud = new THREE.Mesh(
      new THREE.BoxGeometry(5 + Math.random() * 6, 2, 4 + Math.random() * 5),
      new THREE.MeshLambertMaterial({ color: '#ffffff' })
    );
    cloud.position.set(Math.random() * SIZE_X, 30 + Math.random() * 10, Math.random() * SIZE_Z);
    scene.add(cloud);
  }

  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.005, 1.005, 1.005)),
    new THREE.LineBasicMaterial({ color: '#ffffff' })
  );
  highlight.visible = false;
  scene.add(highlight);

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
  // Block resources: mining a block banks one of its kind, placing spends one. Infinite by default
  // (solo sandbox + admins build freely); a co-op join flips this off for non-admin players via
  // onAdmin, so only regular multiplayer players are constrained. Magic structures are exempt.
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
  function applyRemoteEdit({ x, y, z, id }: { x: number; y: number; z: number; id: number }): void {
    if (!inBounds(x, y, z)) return;
    setVoxel(x, y, z, id);
    remeshRegion(x - 1, x + 1, z - 1, z + 1);
    unstuckPlayer();
    debug('coop', 'remote edit', { x, y, z, id });
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
  function applyRoomState({ peace, blockedStructures: blocked, pvp: pvpOn, chatEnabled: chatOn }: { peace: boolean; blockedStructures: string[]; pvp: boolean; chatEnabled: boolean }): void {
    peaceful = peace;
    pvp = pvpOn;
    chatEnabled = chatOn;
    blockedStructures.clear();
    for (const kind of blocked) blockedStructures.add(kind);
    syncBuildMenu();
    debug('engine', 'room state applied', { peace, blocked: blocked.length, pvp: pvpOn, chat: chatOn });
  }
  // Offline there is no server room: admin toggles mutate the local state directly and refresh the HUD
  // (online always routes through coop instead, so the two paths never mix).
  const currentRoom = () => ({ peace: peaceful, blockedStructures: [...blockedStructures], pvp, chatEnabled });
  function applyLocalRoom(next: { peace: boolean; blockedStructures: string[]; pvp: boolean; chatEnabled: boolean }): void {
    applyRoomState(next);
    bridge?.hud.onRoomState(next);
  }
  // A pvp hit from another player costs one heart, reusing the same damage + death path as monsters.
  function applyHurt(by: string): void {
    if (player.hurtCooldown > 0) return;
    hurtPlayer();
    debug('engine', 'hurt by player', { by });
  }
  function localPose(): { x: number; y: number; z: number; yaw: number; pitch: number } {
    return { x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch };
  }
  function sendCoopEdit(op: EditOp, x: number, y: number, z: number, id: number): void {
    coop?.sendEdit(op, x, y, z, id);
  }
  function debugSnapshot(): DebugSnapshot {
    const base = {
      fps: Math.round(fps),
      x: roundCoordinate(player.pos.x), y: roundCoordinate(player.pos.y), z: roundCoordinate(player.pos.z),
      chunks: chunkMeshes.size,
      tenant: brand.id,
    };
    if (!coop) return { ...base, ping: 0, state: 'offline', online: 1 };
    return { ...base, ping: coop.ping, state: coop.state, online: coop.onlineCount };
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
    setRole: (id, role) => coop?.sendAdminSetRole(id, role),
    setInfiniteResources: (on) => { infiniteResources = on; updateHotbarCounts(); },
    returnToSpawn: () => { player.pos.copy(spawnPoint()); player.vel.set(0, 0, 0); savePos(); },
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
  function makeFaceMaterial(color: string): THREE.MeshLambertMaterial {
    const c = makeCanvas();
    const g = ctx2d(c);
    g.fillStyle = color; g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#1a1330';
    g.fillRect(4, 6, 2, 3); g.fillRect(10, 6, 2, 3);
    g.fillRect(6, 11, 4, 1);
    g.fillRect(5, 10, 1, 1); g.fillRect(10, 10, 1, 1);
    return new THREE.MeshLambertMaterial({ map: textureFromCanvas(c) });
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
  function hurtPlayer(): void {
    player.hearts -= 1;
    player.hurtCooldown = 1.2;
    blip(140, 0.18);
    const heartsEl = el('hearts');
    heartsEl.classList.add('hit');
    setTimeout(() => heartsEl.classList.remove('hit'), 300);
    updateStats();
    if (player.hearts <= 0) napAndRespawn();
  }
  // In co-op the server owns the creatures, but each client still takes its own damage from the
  // server-synced monsters when the room is not at peace (so monsters actually attack again).
  function hurtFromServerCreatures(dt: number): void {
    player.hurtCooldown = Math.max(0, player.hurtCooldown - dt);
    if (peaceful || player.hurtCooldown > 0 || !coop) return;
    const feet = player.pos.y - EYE_HEIGHT;
    for (const cr of coop.getCreatures()) {
      if (creatureDefFor(cr.kind).kind !== 'monster') continue;
      const buried = isSolid(Math.floor(cr.x), Math.floor(cr.y + HURT_BURIED_PROBE), Math.floor(cr.z));
      const reaches = canMonsterReachPlayer({
        monster: { x: cr.x, y: cr.y, z: cr.z },
        playerX: player.pos.x, playerFeetY: feet, playerZ: player.pos.z,
        playerHeight: PLAYER_HEIGHT, buried,
      });
      if (!reaches) continue;
      hurtPlayer();
      return;
    }
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
  const poofs: Poof[] = [];
  function spawnPoof(pos: THREE.Vector3, color: string): void {
    for (let i = 0; i < POOF_COUNT; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial({ color }));
      m.position.copy(pos);
      scene.add(m);
      const v = spawnPoofVelocity(Math.random);
      poofs.push({ mesh: m, vel: new THREE.Vector3(v.x, v.y, v.z), life: POOF_LIFE });
    }
  }
  function updatePoofs(dt: number): void {
    for (let i = poofs.length - 1; i >= 0; i--) {
      const p = poofs[i];
      const step = stepPoof({ life: p.life, velocityY: p.vel.y, dt });
      p.life = step.life;
      p.vel.y = step.velocityY;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.scale.multiplyScalar(step.scaleFactor);
      if (step.dead) { scene.remove(p.mesh); p.mesh.geometry.dispose(); poofs.splice(i, 1); }
    }
  }

  // The admin wiped the world: rebuild it in place (like a fresh boot) and respawn, so every player
  // resets without being kicked back to the lobby. The server's reset already cleared its own world
  // and creatures; the local creatures (single-player) and poofs are cleared to match.
  function resetLocalWorld(): void {
    world.reset();
    buildWelcomeMonument();
    updateChunks(true);
    processMeshQueue(isTouch ? 24 : 60);
    for (const p of poofs) { scene.remove(p.mesh); p.mesh.geometry.dispose(); }
    poofs.length = 0;
    player.pos.copy(spawnPoint());
    player.vel.set(0, 0, 0);
    savePos();
  }

  // ---------- Scoreboard ----------
  function storedBest(): number {
    const stored = localStorage.getItem(BEST_KEY);
    return stored ? Number(stored) : 0;
  }
  function updateStats(): void {
    el('hearts').textContent = heartsLabel({ hearts: player.hearts, maxHearts: MAX_HEARTS });
    el('stars').textContent = `⭐ ${player.stars}`;
    el('bag').textContent = `🎒 ${player.bag}`;
    const best = bestScore({ stars: player.stars, stored: storedBest() });
    localStorage.setItem(BEST_KEY, String(best));
    el('record').textContent = `🏆 ${best}`;
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
    const removed = getVoxel(r.hit[0], r.hit[1], r.hit[2]);
    setVoxel(r.hit[0], r.hit[1], r.hit[2], AIR);
    remeshRegion(r.hit[0] - 1, r.hit[0] + 1, r.hit[2] - 1, r.hit[2] + 1);
    sendCoopEdit('break', r.hit[0], r.hit[1], r.hit[2], AIR);
    player.bag += 1;
    inventory.bank(removed);
    updateHotbarCounts();
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
    if (!infiniteResources && !inventory.canPlace(selected)) { toast(t('toast.out_of_blocks')); blip(160, 0.1); return; }
    if (!infiniteResources) { inventory.spend(selected); updateHotbarCounts(); }
    setVoxel(px, py, pz, selected);
    remeshRegion(px - 1, px + 1, pz - 1, pz + 1);
    sendCoopEdit('place', px, py, pz, selected);
    blip(selected === FACE_ID ? 720 : 520, 0.08);
    debug('engine', 'place block', { x: px, y: py, z: pz, id: selected });
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
    const lookDir = new THREE.Vector3(
      Math.sin(player.yaw) * Math.cos(player.pitch),
      Math.sin(player.pitch),
      Math.cos(player.yaw) * Math.cos(player.pitch)
    );
    camera.lookAt(camera.position.clone().add(lookDir));

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
  // they have banked (∞ would be misleading, so it is simply hidden when resources are infinite).
  function updateHotbarCounts(): void {
    for (const slot of [...hotbar.children] as HTMLElement[]) {
      const id = Number(slot.dataset.id);
      const badge = slot.querySelector<HTMLElement>('.count');
      if (!badge) continue;
      badge.textContent = hotbarCountLabel({ infiniteResources, count: inventory.count(id) });
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
    if (started && !paused) { update(dt); updateChunks(); processMeshQueue(isTouch ? 1 : 2); if (coop) hurtFromServerCreatures(dt); else updateCreatures(dt); updatePoofs(dt); }
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
    });
    debug('coop', 'connecting', { url: serverUrl, tenant: brand.id, name });
  }
  el('playBtn').addEventListener('click', start, { signal });

  new THREE.TextureLoader().load(FACE_URL, (faceTex) => {
    if (disposed) return;
    faceTex.magFilter = THREE.NearestFilter;
    faceTex.colorSpace = THREE.SRGBColorSpace;
    buildMaterials(faceTex);
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
  return cleanup;
}
