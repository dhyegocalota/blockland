// The running game's shared world of references — the richer sibling of EngineContext that the
// builder threads through every runtime module (actions, creatures, hud, the loop, coop wiring).
// Following the EngineContext convention: modules read/write the live game through this typed object
// instead of closing over engine-local variables, which is what lets each concern live in its own
// module while still calling across boundaries (break -> poof -> stats) exactly as the closure did.
//
// The builder constructs one instance, then each createX(runtime) factory fills its slice of the
// function fields. Fields are late-bound by design: a module may read runtime.spawnPoof before the
// module that assigns it has run, because every call happens at game time, never at wire time.
import type * as THREE from 'three';
import type { Brand } from '../tenants';
import type { BlockDef } from './blocks';
import type { VoxelWorld } from './world';
import type { VoxelHit } from './raycast';
import type { CreatureDef } from './creatures';
import type { StructureKind } from './structures';
import type { BlockInventory } from './inventory';
import type { EngineState } from './engine-state';
import type { ChunkMesher } from './chunk-mesher';
import type { PoofRuntime } from './poofs-runtime';
import type { ViewRenderer } from './renderers';
import type { DebugSnapshot } from './debug-snapshot';
import type { CoopController, CoopCreature, CoopPlayer, RoomState } from '../coop';
import type { CoopBridge } from './api';
import type { EditCell, EditOp } from '../protocol';

export interface Creature {
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

  // ---- Three.js handles ----
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;

  // ---- Voxel world ----
  world: VoxelWorld;
  chunkMeshes: Map<string, THREE.Mesh[]>;
  materials: Record<number, THREE.MeshLambertMaterial>;

  // ---- Runtimes ----
  mesher: ChunkMesher;
  poofRuntime: PoofRuntime;
  view: ViewRenderer;

  // ---- State ----
  state: EngineState;
  inventory: BlockInventory;
  blockedStructures: Set<string>;
  creatures: Creature[];
  creatureGroup: THREE.Group;
  coop: CoopController | null;

  // ---- World helpers ----
  inBounds(x: number, y: number, z: number): boolean;
  getVoxel(x: number, y: number, z: number): number;
  setVoxel(x: number, y: number, z: number, id: number): void;
  isSolid(x: number, y: number, z: number): boolean;
  blockName(b: BlockDef): string;
  el(id: string): HTMLElement;
  spawnPoint(): THREE.Vector3;
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

  // ---- Poofs (filled by creature-runtime) ----
  spawnPoof(pos: THREE.Vector3, color: string): void;
  updatePoofs(dt: number): void;

  // ---- Creatures (filled by creature-runtime) ----
  spawnCreature(typeKey: string): void;
  populateCreatures(): void;
  updateCreatures(dt: number): void;
  flashDamage(): void;
  hurtPlayer(): void;
  napAndRespawn(): void;
  raycastCreature(): { creature: Creature; t: number } | null;
  hitCreature(cr: Creature): void;
  defeatCreature(cr: Creature): void;
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
  buildWelcomeMonument(): void;
  resetLocalWorld(): void;

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
  grantOfflineAdmin(): void;
  startCoop(): void;
  bindApi(): void;

  // ---- Loop (filled by game-loop) ----
  blockIntoActors(): void;
  update(dt: number): void;
  start(): void;
  loop(now: number): void;

  // ---- Loop bookkeeping (mutable scalars the loop owns) ----
  last: number;
  lastPosSave: number;
  audio: AudioContext | undefined;
}
