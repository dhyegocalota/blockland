import * as THREE from 'three';
import { PLATFORM_NAME, type Brand } from './tenants';
import { t } from './i18n';
import { debug } from './log';
import {
  AIR, CHUNK, EYE_HEIGHT, FACE_ID, FLY_SPEED, GRAVITY, JUMP_SPEED, PLAYER_HEIGHT,
  PLAYER_RADIUS, REACH, SIZE_X, SIZE_Y, SIZE_Z, WALK_SPEED,
} from './engine/constants';
import { BLOCKS, type BlockDef, blockById } from './engine/blocks';
import { heightAt } from './engine/worldgen';
import { VoxelWorld } from './engine/world';
import { type Axis, moveAxis } from './engine/physics';
import { blockVelocityIntoActors } from './engine/actors';
import { type VoxelHit, raycastVoxel as ddaRaycast } from './engine/raycast';
import { stampBall, stampCola, stampFigure, stampSteve, stampTrophy } from './engine/structures';
import { CREATURE_DEFS, type CreatureDef, stepCreatureDirection } from './engine/creatures';
import { createCoop, MAIN_WORLD, type CoopController, type CoopHud } from './coop';
import type { EditCell, EditOp } from './protocol';

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

type StructureKind = 'trophy' | 'ball' | 'figure' | 'cola' | 'steve';

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
export interface CoopBridge {
  resolveName(): string;
  hud: CoopHud;
  bind(api: { sendChat(text: string): void; debugSnapshot(): DebugSnapshot }): void;
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

  // ---------- Procedural texture helpers ----------
  function makeCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    return c;
  }
  function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
    const g = c.getContext('2d');
    if (!g) throw new Error('2d canvas context unavailable');
    return g;
  }
  function textureFromCanvas(c: HTMLCanvasElement): THREE.CanvasTexture {
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  function renderBlockCanvas(b: BlockDef): HTMLCanvasElement {
    if (!b.build) throw new Error(`block ${b.id} has no texture builder`);
    const c = makeCanvas();
    b.build(ctx2d(c));
    return c;
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
  interface Face { dir: number[]; corners: number[][]; }
  interface MeshBucket { pos: number[]; norm: number[]; uv: number[]; idxs: number[]; }
  const FACES: Face[] = [
    { dir: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { dir: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
    { dir: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
    { dir: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { dir: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
    { dir: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
  ];
  const UV = [[0, 0], [0, 1], [1, 1], [1, 0]];

  const worldGroup = new THREE.Group();
  const chunkMeshes = new Map<string, THREE.Mesh[]>();
  let firstChunkStreamed = false;
  function meshChunk(cxh: number, czh: number): void {
    const key = `${cxh},${czh}`;
    const old = chunkMeshes.get(key);
    if (old) old.forEach((m) => { worldGroup.remove(m); m.geometry.dispose(); });
    const buckets: Record<number, MeshBucket> = {};
    for (const b of BLOCKS) { if (b) buckets[b.id] = { pos: [], norm: [], uv: [], idxs: [] }; }

    const x0 = cxh * CHUNK, x1 = Math.min(SIZE_X, x0 + CHUNK);
    const z0 = czh * CHUNK, z1 = Math.min(SIZE_Z, z0 + CHUNK);
    for (let y = 0; y < SIZE_Y; y++)
      for (let z = z0; z < z1; z++)
        for (let x = x0; x < x1; x++) {
          const id = getVoxel(x, y, z);
          if (id === AIR) continue;
          const bucket = buckets[id];
          const opaque = !blockById(id)?.transparent;
          for (const f of FACES) {
            const neighbor = getVoxel(x + f.dir[0], y + f.dir[1], z + f.dir[2]);
            const neighborTransparent = neighbor === AIR || blockById(neighbor)?.transparent;
            if (opaque && !neighborTransparent) continue;
            if (!opaque && neighbor !== AIR) continue;
            const start = bucket.pos.length / 3;
            f.corners.forEach((c, i) => {
              bucket.pos.push(x + c[0], y + c[1], z + c[2]);
              bucket.norm.push(...f.dir);
              bucket.uv.push(UV[i][0], UV[i][1]);
            });
            bucket.idxs.push(start, start + 1, start + 2, start, start + 2, start + 3);
          }
        }

    const meshes: THREE.Mesh[] = [];
    for (const b of BLOCKS) {
      if (!b) continue;
      const data = buckets[b.id];
      if (!data.pos.length) continue;
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
    const pcx = Math.floor(player.pos.x / CHUNK), pcz = Math.floor(player.pos.z / CHUNK);
    if (!force && pcx === lastPlayerChunkX && pcz === lastPlayerChunkZ) return;
    lastPlayerChunkX = pcx; lastPlayerChunkZ = pcz;
    for (let dz = -LOAD_R; dz <= LOAD_R; dz++)
      for (let dx = -LOAD_R; dx <= LOAD_R; dx++) {
        const cx = pcx + dx, cz = pcz + dz;
        if (cx < 0 || cz < 0 || cx >= chunksX || cz >= chunksZ) continue;
        const key = chunkKey(cx, cz);
        if ((chunkMeshes as Map<unknown, THREE.Mesh[]>).has(key) || queuedKeys.has(key)) continue;
        queuedKeys.add(key);
        meshQueue.push({ cx, cz, key });
      }
    meshQueue.sort((a, b) => ((a.cx - pcx) ** 2 + (a.cz - pcz) ** 2) - ((b.cx - pcx) ** 2 + (b.cz - pcz) ** 2));
    for (const [key, meshes] of chunkMeshes) {
      const cx = Math.floor(Number(key) / chunksZ), cz = Number(key) % chunksZ;
      if (Math.abs(cx - pcx) > LOAD_R + 1 || Math.abs(cz - pcz) > LOAD_R + 1) {
        meshes.forEach((m) => { worldGroup.remove(m); m.geometry.dispose(); });
        chunkMeshes.delete(key);
      }
    }
  }
  function processMeshQueue(budget: number): void {
    let done = 0;
    const lastCx = Number(lastPlayerChunkX), lastCz = Number(lastPlayerChunkZ);
    while (done < budget && meshQueue.length) {
      const next = meshQueue.shift();
      if (!next) break;
      const { cx, cz, key } = next;
      queuedKeys.delete(key);
      if ((chunkMeshes as Map<unknown, THREE.Mesh[]>).has(key)) continue;
      if (Math.abs(cx - lastCx) > LOAD_R + 1 || Math.abs(cz - lastCz) > LOAD_R + 1) continue;
      meshChunk(cx, cz);
      done++;
    }
  }
  function remeshRegion(minX: number, maxX: number, minZ: number, maxZ: number): void {
    const cx0 = Math.max(0, Math.floor(minX / CHUNK)), cx1 = Math.min(chunksX - 1, Math.floor(maxX / CHUNK));
    const cz0 = Math.max(0, Math.floor(minZ / CHUNK)), cz1 = Math.min(chunksZ - 1, Math.floor(maxZ / CHUNK));
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
  const spawnPoint = (): THREE.Vector3 => new THREE.Vector3(SIZE_X / 2, heightAt(SIZE_X >> 1, SIZE_Z >> 1) + 4, SIZE_Z / 2 + 4);
  const player: Player = {
    pos: spawnPoint(),
    vel: new THREE.Vector3(),
    yaw: Math.PI, pitch: -0.2,
    onGround: false, fly: false,
    hearts: MAX_HEARTS, stars: 0, bag: 0, hurtCooldown: 0,
  };
  let selected = 1;
  let peaceful = true;
  let coop: CoopController | null = null;
  let fps = 0;

  // ---------- Co-op (remote players) — only when a server URL is configured ----------
  const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL;
  function applyRemoteEdit({ x, y, z, id }: { x: number; y: number; z: number; id: number }): void {
    if (!inBounds(x, y, z)) return;
    setVoxel(x, y, z, id);
    remeshRegion(x - 1, x + 1, z - 1, z + 1);
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
    debug('coop', 'remote edit batch', { count: edits.length });
  }
  function localPose(): { x: number; y: number; z: number; yaw: number; pitch: number } {
    return { x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch };
  }
  function sendCoopEdit(op: EditOp, x: number, y: number, z: number, id: number): void {
    coop?.sendEdit(op, x, y, z, id);
  }
  function debugSnapshot(): DebugSnapshot {
    const round = (n: number): number => Math.round(n * 10) / 10;
    const base = {
      fps: Math.round(fps),
      x: round(player.pos.x), y: round(player.pos.y), z: round(player.pos.z),
      chunks: chunkMeshes.size,
      tenant: brand.id,
    };
    if (!coop) return { ...base, ping: 0, state: 'offline', online: 1 };
    return { ...base, ping: coop.ping, state: coop.state, online: coop.onlineCount };
  }
  bridge?.bind({ sendChat: (text) => coop?.sendChat(text), debugSnapshot });

  // ---------- Creatures (animals to hunt, monsters to fight) ----------
  const creatures: Creature[] = [];
  const creatureGroup = new THREE.Group();
  scene.add(creatureGroup);

  function groundHeight(x: number, z: number): number {
    const gx = Math.floor(x), gz = Math.floor(z);
    for (let y = SIZE_Y - 1; y >= 0; y--) if (isSolid(gx, y, gz)) return y + 1;
    return 0;
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
  const SPAWN_RANGE = 80;
  function spawnCreature(typeKey: string): void {
    const def = CREATURE_DEFS[typeKey];
    if (!def) throw new Error(`unknown creature ${typeKey}`);
    const cx = SIZE_X / 2, cz = SIZE_Z / 2;
    const x = Math.max(2, Math.min(SIZE_X - 2, cx + (Math.random() - 0.5) * 2 * SPAWN_RANGE));
    const z = Math.max(2, Math.min(SIZE_Z - 2, cz + (Math.random() - 0.5) * 2 * SPAWN_RANGE));
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
    for (let i = 0; i < 3; i++) spawnCreature('pig');
    for (let i = 0; i < 2; i++) spawnCreature('chicken');
    for (let i = 0; i < 2; i++) spawnCreature('cow');
    for (let i = 0; i < 2; i++) spawnCreature('slime');
    spawnCreature('spider');
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

      cr.mesh.position.x += Math.sin(cr.dir) * cr.def.speed * dt;
      cr.mesh.position.z += Math.cos(cr.dir) * cr.def.speed * dt;
      cr.mesh.position.x = Math.max(1, Math.min(SIZE_X - 1, cr.mesh.position.x));
      cr.mesh.position.z = Math.max(1, Math.min(SIZE_Z - 1, cr.mesh.position.z));
      cr.mesh.position.y = groundHeight(cr.mesh.position.x, cr.mesh.position.z) + cr.def.size[1] / 2 + Math.abs(Math.sin(cr.bob)) * 0.12;
      cr.mesh.rotation.y = cr.dir;
      cr.body.material.emissive = new THREE.Color(cr.flash > 0 ? '#ff0000' : '#000000');

      const verticalGap = Math.abs(player.pos.y - EYE_HEIGHT - cr.mesh.position.y);
      if (hostile && dist < 1.0 && verticalGap < 1.6 && player.hurtCooldown === 0) hurtPlayer();
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
  function napAndRespawn(): void {
    toast(t('toast.nap'));
    player.hearts = MAX_HEARTS;
    player.pos.copy(spawnPoint());
    player.vel.set(0, 0, 0);
    updateStats();
  }
  function raycastCreature(): { creature: Creature; t: number } | null {
    const origin = camera.position.clone();
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    let best: Creature | null = null, bestT = REACH;
    for (const cr of creatures) {
      const oc = new THREE.Vector3().subVectors(cr.mesh.position, origin);
      const tca = oc.dot(dir);
      if (tca < 0) continue;
      const d2 = oc.lengthSq() - tca * tca;
      const radius = Math.max(...cr.def.size) * 0.7;
      if (d2 > radius * radius) continue;
      if (tca < bestT) { bestT = tca; best = cr; }
    }
    return best ? { creature: best, t: bestT } : null;
  }
  function hitCreature(cr: Creature): void {
    cr.hp -= 1;
    cr.flash = 0.18;
    blip(cr.def.kind === 'monster' ? 300 : 880, 0.08);
    const knock = new THREE.Vector3().subVectors(cr.mesh.position, player.pos).setY(0).normalize().multiplyScalar(1.2);
    cr.mesh.position.add(knock);
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

  // ---------- Poof particles ----------
  const poofs: Poof[] = [];
  function spawnPoof(pos: THREE.Vector3, color: string): void {
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial({ color }));
      m.position.copy(pos);
      scene.add(m);
      poofs.push({ mesh: m, vel: new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 4 + 1, (Math.random() - 0.5) * 4), life: 0.7 });
    }
  }
  function updatePoofs(dt: number): void {
    for (let i = poofs.length - 1; i >= 0; i--) {
      const p = poofs[i];
      p.life -= dt;
      p.vel.y -= 9 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.scale.multiplyScalar(1 - dt * 1.5);
      if (p.life <= 0) { scene.remove(p.mesh); p.mesh.geometry.dispose(); poofs.splice(i, 1); }
    }
  }

  // ---------- Scoreboard ----------
  function bestScore(): number {
    const stored = localStorage.getItem(BEST_KEY);
    return stored ? Number(stored) : 0;
  }
  function updateStats(): void {
    el('hearts').textContent = '❤️'.repeat(player.hearts) + '🖤'.repeat(MAX_HEARTS - player.hearts);
    el('stars').textContent = `⭐ ${player.stars}`;
    el('bag').textContent = `🎒 ${player.bag}`;
    const best = Math.max(player.stars, bestScore());
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
    const creatureHit = raycastCreature();
    const blockDist = block ? new THREE.Vector3(block.hit[0] + 0.5, block.hit[1] + 0.5, block.hit[2] + 0.5).distanceTo(camera.position) : Infinity;
    if (creatureHit && creatureHit.t <= blockDist) { hitCreature(creatureHit.creature); return; }
    if (block) breakBlock(block);
  }
  function breakBlock(r: VoxelHit): void {
    const removed = getVoxel(r.hit[0], r.hit[1], r.hit[2]);
    setVoxel(r.hit[0], r.hit[1], r.hit[2], AIR);
    remeshRegion(r.hit[0] - 1, r.hit[0] + 1, r.hit[2] - 1, r.hit[2] + 1);
    sendCoopEdit('break', r.hit[0], r.hit[1], r.hit[2], AIR);
    player.bag += 1;
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
    setVoxel(px, py, pz, selected);
    remeshRegion(px - 1, px + 1, pz - 1, pz + 1);
    sendCoopEdit('place', px, py, pz, selected);
    blip(selected === FACE_ID ? 720 : 520, 0.08);
    debug('engine', 'place block', { x: px, y: py, z: pz, id: selected });
  }
  function overlapsPlayer(x: number, y: number, z: number): boolean {
    const p = player.pos;
    return x + 1 > p.x - PLAYER_RADIUS && x < p.x + PLAYER_RADIUS &&
      z + 1 > p.z - PLAYER_RADIUS && z < p.z + PLAYER_RADIUS &&
      y + 1 > p.y - EYE_HEIGHT && y < p.y - EYE_HEIGHT + PLAYER_HEIGHT;
  }

  // ---------- Magic structures ----------
  function buildStructure(kind: StructureKind): void {
    const margin = 12;
    const aim = raycastVoxel(90);
    let targetX: number, targetZ: number;
    if (aim) {
      targetX = aim.hit[0]; targetZ = aim.hit[2];
    } else {
      const forwardX = Math.sin(player.yaw), forwardZ = Math.cos(player.yaw);
      targetX = player.pos.x + forwardX * 24; targetZ = player.pos.z + forwardZ * 24;
    }
    const cx = Math.max(margin, Math.min(SIZE_X - margin, Math.round(targetX)));
    const cz = Math.max(margin, Math.min(SIZE_Z - margin, Math.round(targetZ)));
    const gy = groundHeight(cx, cz);
    const reach = kind === 'ball' ? 9 : kind === 'cola' ? 6 : 4;
    const cells: EditCell[] = [];
    const collect = (x: number, y: number, z: number, id: number): void => { setVoxel(x, y, z, id); cells.push({ x, y, z, id }); };
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

  // Stop the local player from walking through remote players (velocity-only, never adds motion).
  function blockIntoPlayers(): void {
    if (!coop) return;
    const actors = coop.getColliders();
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
    const flat = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
    const right = new THREE.Vector3(flat.z, 0, -flat.x);
    const forward = player.fly
      ? new THREE.Vector3(Math.sin(player.yaw) * Math.cos(player.pitch), Math.sin(player.pitch), Math.cos(player.yaw) * Math.cos(player.pitch))
      : flat;
    const move = new THREE.Vector3();
    if (keys.KeyW || keys.ArrowUp) move.add(forward);
    if (keys.KeyS || keys.ArrowDown) move.sub(forward);
    if (keys.KeyD || keys.ArrowRight) move.sub(right);
    if (keys.KeyA || keys.ArrowLeft) move.add(right);
    if (joystick.active) {
      move.add(forward.clone().multiplyScalar(-joystick.y));
      move.add(right.clone().multiplyScalar(-joystick.x));
    }
    if (move.lengthSq() > 0) move.normalize();

    if (player.fly) {
      player.vel.copy(move).multiplyScalar(FLY_SPEED);
      if (keys.Space) player.vel.y = FLY_SPEED;
      if (keys.ShiftLeft || keys.ShiftRight) player.vel.y = -FLY_SPEED;
    } else {
      player.vel.x = move.x * WALK_SPEED;
      player.vel.z = move.z * WALK_SPEED;
      player.vel.y += GRAVITY * dt;
      if (keys.Space && player.onGround) { player.vel.y = JUMP_SPEED; player.onGround = false; }
    }

    blockIntoPlayers();

    player.onGround = false;
    stepAxis('x', player.vel.x * dt);
    stepAxis('z', player.vel.z * dt);
    stepAxis('y', player.vel.y * dt);

    if (player.pos.y < -8) { player.pos.copy(spawnPoint()); player.vel.set(0, 0, 0); }

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
      let dx = t.clientX - joystick.cx, dy = t.clientY - joystick.cy;
      const len = Math.hypot(dx, dy) || 1;
      const clamped = Math.min(len, joystick.r);
      dx = dx / len * clamped; dy = dy / len * clamped;
      joystick.x = dx / joystick.r; joystick.y = dy / joystick.r;
      setKnob(dx, dy);
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
    const b = BLOCKS.find((bl) => bl && bl.key === e.key);
    if (b) selectSlot(b.id);
    if (e.code === 'KeyF') toggleFly();
    if (e.code === 'KeyV') toggleControls();
    if (e.code === 'KeyP') togglePeace();
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
  buildMenuEl.querySelectorAll<HTMLElement>('.buildCard').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const kind = btn.dataset.kind;
      if (!kind) throw new Error('build card missing data-kind');
      buildStructure(kind as StructureKind);
      hideBuildMenu();
    }, { signal });
  });

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
      slot.addEventListener('click', () => selectSlot(b.id), { signal });
      hotbar.appendChild(slot);
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

  const modeBtn = el('modeBtn');
  function togglePeace(): void {
    peaceful = !peaceful;
    modeBtn.classList.toggle('on', peaceful);
    modeBtn.textContent = peaceful ? t('hud.peace_on') : t('hud.peace_off');
    toast(peaceful ? t('toast.peace_on') : t('toast.peace_off'));
    debug('engine', 'peace toggled', { peaceful });
  }
  modeBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePeace(); }, { signal });
  modeBtn.classList.toggle('on', peaceful);
  modeBtn.textContent = peaceful ? t('hud.peace_on') : t('hud.peace_off');

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }, { signal });

  // ---------- Loop ----------
  let started = false;
  let last = performance.now();
  function loop(now: number): void {
    if (disposed) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (dt > 0) fps = fps * 0.9 + (1 / dt) * 0.1;
    if (started && !paused) { update(dt); updateChunks(); processMeshQueue(isTouch ? 1 : 2); updateCreatures(dt); updatePoofs(dt); }
    if (coop) { coop.sendMove(localPose(), now); coop.update(now); }
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(loop);
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
  function startCoop(): void {
    if (coop) return;
    if (!serverUrl) { debug('coop', 'single-player (no server url)'); return; }
    if (!bridge) { debug('coop', 'single-player (no hud bridge)'); return; }
    const name = bridge.resolveName();
    coop = createCoop({
      three: THREE,
      scene,
      url: serverUrl,
      tenant: brand.id,
      world: MAIN_WORLD,
      name,
      hud: bridge.hud,
      applyRemoteEdit,
      applyRemoteEditBatch,
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
    populateCreatures();
    buildHotbar(FACE_URL);
    selectSlot(1);
    updateStats();
    el('startRecord').textContent = t('start.record_score', { score: bestScore() });
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
