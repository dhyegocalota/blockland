// The running game's shared world of references — the richer sibling of EngineContext that the
// builder threads through every runtime module (actions, creatures, hud, the loop, coop wiring).
// Following the EngineContext convention: modules read/write the live game through this typed object
// instead of closing over engine-local variables, which is what lets each concern live in its own
// module while still calling across boundaries (break -> poof -> stats) exactly as the closure did.
//
// The builder constructs one instance, then each createX(runtime) factory fills its slice of the
// function fields. Fields are late-bound by design: a module may read runtime.spawnPoof before the
// module that assigns it has run, because every call happens at game time, never at wire time.
import type {
  GfxScene, GfxCamera, GfxRenderer, GfxGroup, GfxChunkMesh, GfxMaterial, GfxCreatureBody,
} from './rendering/gfx';
import type { Vec3 } from './vec3';
import type { Brand } from '../tenants';
import type { BlockDef } from './blocks';
import type { VoxelWorld } from './world';
import type { VoxelHit } from './raycast';
import type { CreatureDef } from './offline/creatures';
import type { StructureKind } from './structures';
import type { BlockInventory } from './inventory';
import type { EngineState } from './engine-state';
import type { ChunkMesher } from './rendering/chunk-mesher';
import type { PoofRuntime } from './rendering/poofs-runtime';
import type { HeartDropRuntime } from './rendering/heart-drop-runtime';
import type { HeartDrop } from './heart-drop';
import type { ViewRenderer } from './rendering/renderers';
import type { DebugSnapshot } from './debug-snapshot';
import type { CoopController, CoopCreature, CoopPlayer, CoopView, RoomState } from '../coop';
import type { CoopBridge } from './api';
import type { EditCell, EditOp } from '../protocol';

export interface Creature {
  // Stable per-creature id; seeds the deterministic orbit direction when it circles the player.
  id: number;
  typeKey: string;
  def: CreatureDef;
  // The authoritative position the offline AI reads/writes; rendering syncs cr.mesh from it each tick.
  pos: Vec3;
  mesh: GfxGroup;
  body: GfxCreatureBody;
  hp: number;
  dir: number;
  timer: number;
  bob: number;
  flash: number;
}

export interface GameRuntime {
  // ---- Tenant / boot ----
  brand: Brand;
  bridge: CoopBridge | undefined;
  faceUrl: string;
  faceBlockName: string;
  bestKey: string;
  posKey: string;
  appVersion: string;
  isTouch: boolean;
  signal: AbortSignal;
  bootStart: number;
  coopEnabled: boolean;
  serverUrl: string | undefined;

  // ---- Three.js handles (owned/created by rendering) ----
  scene: GfxScene;
  camera: GfxCamera;
  renderer: GfxRenderer;
  canvas: HTMLCanvasElement;

  // ---- Voxel world ----
  world: VoxelWorld;
  chunkMeshes: Map<string, GfxChunkMesh[]>;
  materials: Record<number, GfxMaterial>;

  // ---- Runtimes ----
  mesher: ChunkMesher;
  poofRuntime: PoofRuntime;
  heartDropRuntime: HeartDropRuntime;
  view: ViewRenderer;

  // ---- State ----
  state: EngineState;
  inventory: BlockInventory;
  blockedStructures: Set<string>;
  creatures: Creature[];
  // Offline-only hearts dropped by defeated creatures, awaiting pickup or TTL expiry. Co-op heart drops
  // are server-owned and live in coop.ts; these are the single-player mirror.
  heartDrops: HeartDrop[];
  creatureGroup: GfxGroup;
  coop: CoopController | null;
  // The data-only rendering hooks for co-op entities, implemented by rendering/coop-view and handed to
  // createCoop so the network controller stays three.js-free.
  coopView: CoopView;

  // ---- World helpers ----
  inBounds(x: number, y: number, z: number): boolean;
  getVoxel(x: number, y: number, z: number): number;
  setVoxel(x: number, y: number, z: number, id: number): void;
  isSolid(x: number, y: number, z: number): boolean;
  blockName(b: BlockDef): string;
  el(id: string): HTMLElement;
  spawnPoint(): Vec3;
  savePos(): void;
  groundHeight(x: number, z: number): number;
  updateChunks(force?: boolean): void;
  processMeshQueue(budget: number): void;
  remeshRegion(minX: number, maxX: number, minZ: number, maxZ: number): void;

  // ---- Sound + HUD (filled by hud) ----
  blip(freq: number, dur: number): void;
  chime(): void;
  toast(msg: string): void;
  updateStats(): void;
  updateHotbarCounts(): void;
  buildHotbar(faceUrl: string): void;
  selectSlot(id: number): void;
  syncBuildMenu(): void;
  showControls(): void;
  hideControls(): void;
  toggleControls(): void;
  showBuildMenu(): void;
  hideBuildMenu(): void;
  toggleBuildMenu(): void;
  toggleFly(): void;
  handleHotkey(e: KeyboardEvent): void;
  lockPointer(): void;
  resizeViewport(): void;
  setupTouchControls(): void;
  typingInField(): boolean;

  // ---- Creature view + poofs + damage cue (filled by rendering/creature-view) ----
  // The camera's world-space forward, read off the live three.js camera by rendering so the crosshair
  // raycasts stay pure (and bit-for-bit identical to camera.getWorldDirection).
  cameraForward(): Vec3;
  spawnPoof(pos: Vec3, color: string): void;
  updatePoofs(dt: number): void;
  buildCreatureBody(def: CreatureDef, x: number, y: number, z: number): {
    mesh: GfxGroup;
    body: GfxCreatureBody;
  };
  syncCreatureMesh(cr: Creature, transform: { x: number; y: number; z: number; rotationY: number; flashing: boolean }): void;
  knockbackCreatureMesh(cr: Creature, delta: { x: number; z: number }): void;
  disposeCreatureMesh(cr: Creature): void;
  flashDamage(): void;

  // ---- Single-player creatures (filled by offline/creature-simulation) ----
  spawnCreature(typeKey: string): void;
  populateCreatures(): void;
  updateCreatures(dt: number): void;
  hurtPlayer(): void;
  napAndRespawn(): void;
  raycastCreature(): { creature: Creature; t: number } | null;
  hitCreature(cr: Creature): void;
  defeatCreature(cr: Creature): void;
  // Advance the offline heart drops: bob their meshes, let a damaged player walking over one collect it
  // for +1 heart, and drop any past its TTL. `now` is the rAF clock in ms (bob phase + TTL reference).
  updateHeartDrops(now: number): void;

  // ---- Co-op targeting (filled by online/creature-targeting) ----
  raycastServerCreature(): { creature: CoopCreature; t: number } | null;
  hitServerCreature(cr: CoopCreature): void;
  raycastRemotePlayer(): { player: CoopPlayer; t: number } | null;
  attackRemotePlayer(p: CoopPlayer): void;

  // ---- Actions (filled by actions) ----
  raycastVoxel(maxDist?: number): VoxelHit | null;
  primaryAction(): void;
  breakBlock(r: VoxelHit): void;
  placeBlock(): void;
  canPlaceSelected(): boolean;
  overlapsPlayer(x: number, y: number, z: number): boolean;
  buildStructure(kind: StructureKind): void;
  resetLocalWorld(): void;
  resetLocalScores(): void;

  // ---- Scoreboard ----
  storedBest(): number;
  recordServerScore(score: number): void;

  // ---- Coop wiring (filled by coop-wiring) ----
  unstuckPlayer(): void;
  applyRemoteEdit(args: { x: number; y: number; z: number; id: number; mine: boolean }): void;
  applyRemoteEditBatch(edits: EditCell[]): void;
  applyRoomState(room: RoomState): void;
  currentRoom(): RoomState;
  applyLocalRoom(next: RoomState): void;
  applyHurt(by: string): void;
  localPose(): { x: number; y: number; z: number; yaw: number; pitch: number };
  sendCoopEdit(op: EditOp, x: number, y: number, z: number, id: number): void;
  debugSnapshot(): DebugSnapshot;
  debugReport(): string;
  grantOfflineAdmin(): void;
  enterOfflineMode(): void;
  startCoop(): void;
  bindApi(): void;

  // ---- Loop (filled by game-loop) ----
  blockIntoActors(): void;
  // Hold-to-attack press/release, shared by the desktop mouse binds and the mobile attack button: press
  // fires the first hit and starts the repeat, release stops it.
  attackDown(): void;
  attackUp(): void;
  update(dt: number): void;
  start(): void;
  loop(now: number): void;

  // ---- Loop bookkeeping (mutable scalars the loop owns) ----
  last: number;
  lastPosSave: number;
  audio: AudioContext | undefined;
}
