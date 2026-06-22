// The composition root: a small fluent builder that wires the running game out of the cohesive runtime
// modules (actions, creature-runtime, hud, game-loop, coop-wiring). It owns the boot-level glue the
// modules share — the scene, the voxel-world accessors, spawn/save, the chunk mesher / poof / view
// runtimes — assembles them onto one GameRuntime, picks the offline-vs-online plan (see
// builder-plan.ts) and returns the running engine's cleanup. game-engine.ts's initGame is a thin call
// into `GameEngine.builder()`. Modules never import game-engine.ts; the builder is the only wirer.
import { gfx, type GfxMaterial, type GfxChunkMesh } from './rendering/gfx';
import { Vec3 } from './vec3';
import { PLATFORM_NAME, type Brand } from '../tenants';
import { t } from '../i18n';
import { debug } from '../log';
import { CHUNK, DEFAULT_APP_VERSION, EYE_HEIGHT, FACE_ID, SIZE_X, SIZE_Y, SIZE_Z, SPAWN_OFFSET_Z } from './constants';
import { type BlockDef } from './blocks';
import { heightAt } from './worldgen';
import { VoxelWorld } from './world';
import { BlockInventory } from './inventory';
import { clearFeetAbove } from './actors';
import { parseSavedPosition, serializeSavedPosition } from './saved-position';
import { faceBlockNameFor } from './tenant-brand';
import { groundHeight as groundHeightAt } from './terrain-column';
import { aimPitch, aimYaw } from './aim';
import { type EngineContext } from './context';
import { createEngineState } from './engine-state';
import { createViewRenderer } from './rendering/renderers';
import { createScene } from './rendering/scene-setup';
import { createChunkMesher } from './rendering/chunk-mesher';
import { createPoofRuntime } from './rendering/poofs-runtime';
import { createCreatureGroup, loadFaceTexture } from './rendering/face-texture';
import { resolveCoopPlan, type EngineMode } from './builder-plan';
import { createActions } from './actions';
import { createCreatureView } from './rendering/creature-view';
import { createCreatureSimulation } from './offline/creature-simulation';
import { createCreatureTargeting } from './online/creature-targeting';
import { createHud } from './rendering/hud';
import { createGameLoop } from './game-loop';
import { createCoopWiring } from './online/coop-wiring';
import { createOfflineMode } from './offline/offline-mode';
import type { CoopBridge } from './api';
import type { GameRuntime } from './runtime';

// Web build identifier shown in the debug panel — the deploy's short commit SHA, "dev" when running locally.
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? DEFAULT_APP_VERSION;

interface GameWindow extends Window {
  __blGameBooted?: boolean;
  __blGameCleanup?: (() => void) | undefined;
}

export class GameEngineBuilder {
  private brand: Brand | null = null;
  private bridge: CoopBridge | undefined = undefined;
  private mode: EngineMode = 'online';

  forTenant(brand: Brand): this {
    this.brand = brand;
    return this;
  }

  withBridge(bridge: CoopBridge | undefined): this {
    this.bridge = bridge;
    return this;
  }

  offline(): this {
    this.mode = 'offline';
    return this;
  }

  online(): this {
    this.mode = 'online';
    return this;
  }

  build(): (() => void) | undefined {
    const brand = this.brand;
    if (!brand) throw new Error('GameEngine.builder requires forTenant(brand)');
    if (typeof window === 'undefined') return undefined;
    const win = window as unknown as GameWindow;
    if (win.__blGameBooted) return win.__blGameCleanup;
    win.__blGameBooted = true;
    const bootStart = performance.now();
    const { bridge } = this;
    const faceUrl = brand.image;
    const faceBlockName = faceBlockNameFor(brand.name);
    if (typeof document !== 'undefined') document.title = `${brand.name} — ${PLATFORM_NAME}`;

    const abort = new AbortController();
    const signal = abort.signal;
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    const chunksX = Math.ceil(SIZE_X / CHUNK);
    const chunksZ = Math.ceil(SIZE_Z / CHUNK);

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL;
    const plan = resolveCoopPlan({ serverUrl, hasBridge: !!bridge, mode: this.mode });

    // ---------- Voxel storage (sparse: only visited chunks use memory -> endless world) ----------
    const world = new VoxelWorld();
    const materials: Record<number, GfxMaterial> = {};

    // ---------- Scene + meshing (streamed chunk meshes around the player) ----------
    const { scene, camera, renderer, canvas, worldGroup, highlight } = createScene({ isTouch });
    const chunkMeshes = new Map<string, GfxChunkMesh[]>();
    const ctx: EngineContext = { isTouch, scene, worldGroup, world, materials, chunkMeshes, chunksX, chunksZ };
    const mesher = createChunkMesher(ctx);
    const poofRuntime = createPoofRuntime({ scene });
    const view = createViewRenderer({ camera, highlight, renderer, scene });

    // ---------- Player state ----------
    const posKey = `bl-pos:${brand.id}`;
    const savedPos = parseSavedPosition(localStorage.getItem(posKey));
    // The engine's mutable runtime state (player, keys, joystick, room flags, loop bookkeeping). Room
    // flags default to the offline sandbox (peaceful, infinite resources, no gates).
    const spawnPoint = (): Vec3 => {
      const sx = SIZE_X >> 1, sz = (SIZE_Z >> 1) + SPAWN_OFFSET_Z;
      const feet = clearFeetAbove({ feet: heightAt(sx, sz) + 1, isSolid: (y) => world.isSolid(sx, y, sz) });
      return new Vec3(SIZE_X / 2, feet + EYE_HEIGHT, SIZE_Z / 2 + SPAWN_OFFSET_Z);
    };
    const state = createEngineState({ spawn: savedPos ? new Vec3(savedPos.x, savedPos.y, savedPos.z) : spawnPoint() });
    const creatureGroup = createCreatureGroup(scene);

    const runtime = {
      brand, bridge, faceUrl, faceBlockName,
      bestKey: `bl-best-${brand.id}`, posKey, appVersion: APP_VERSION,
      isTouch, signal, bootStart, coopEnabled: plan.coopEnabled, serverUrl,
      gfx, scene, camera, renderer, canvas,
      world, chunkMeshes, materials,
      mesher, poofRuntime, view,
      state, inventory: new BlockInventory(),
      blockedStructures: new Set<string>(), creatures: [], creatureGroup, coop: null,
      last: 0, lastPosSave: 0, audio: undefined,
    } as unknown as GameRuntime;

    runtime.inBounds = (x, y, z) => world.inBounds(x, y, z);
    runtime.getVoxel = (x, y, z) => world.get(x, y, z);
    runtime.setVoxel = (x, y, z, id) => world.set(x, y, z, id);
    runtime.isSolid = (x, y, z) => world.isSolid(x, y, z);
    // ---------- Block names (i18n key, except the tenant face block) ----------
    runtime.blockName = (b: BlockDef): string => {
      if (b.id === FACE_ID) return faceBlockName;
      if (!b.nameKey) throw new Error(`block ${b.id} has no name key`);
      return t(b.nameKey);
    };
    runtime.el = (id: string): HTMLElement => {
      const node = document.getElementById(id);
      if (!node) throw new Error(`missing element #${id}`);
      return node;
    };
    runtime.spawnPoint = spawnPoint;
    runtime.savePos = (): void => { localStorage.setItem(posKey, serializeSavedPosition(state.player.pos)); };
    runtime.groundHeight = (x: number, z: number): number => {
      const gx = Math.floor(x), gz = Math.floor(z);
      return groundHeightAt({ isSolidAt: (y) => world.isSolid(gx, y, gz) });
    };
    runtime.updateChunks = (force?: boolean): void => mesher.updateChunks({ playerPos: state.player.pos, force });
    runtime.processMeshQueue = (budget: number): void => mesher.processMeshQueue(budget);
    runtime.remeshRegion = (minX, maxX, minZ, maxZ): void => mesher.remeshRegion(minX, maxX, minZ, maxZ);

    createHud(runtime);
    createActions(runtime);
    createCreatureView(runtime);
    createCreatureSimulation(runtime);
    createCreatureTargeting(runtime);
    createOfflineMode(runtime);
    createCoopWiring(runtime);
    createGameLoop(runtime);

    runtime.bindApi();

    const player = state.player;
    runtime.el('playBtn').addEventListener('click', runtime.start, { signal });

    loadFaceTexture({
      url: faceUrl,
      materials,
      cancelled: () => state.disposed,
      onReady: () => {
        runtime.updateChunks(true);
        runtime.processMeshQueue(isTouch ? 24 : 60);
        if (plan.populateAtBoot) runtime.populateCreatures();
        runtime.buildHotbar(faceUrl);
        runtime.selectSlot(1);
        runtime.updateStats();
        runtime.el('startRecord').textContent = t('start.record_score', { score: runtime.storedBest() });
        runtime.last = performance.now();
        state.rafId = requestAnimationFrame(runtime.loop);
        debug('engine', 'boot complete', {
          tenant: brand.id,
          worldX: SIZE_X, worldZ: SIZE_Z, worldY: SIZE_Y,
          chunks: chunkMeshes.size,
          creatures: runtime.creatures.length,
          ms: Math.round(performance.now() - bootStart),
        });
      },
    });

    const cleanup = (): void => {
      state.disposed = true;
      if (state.started) runtime.savePos();
      runtime.coop?.close();
      runtime.coop = null;
      cancelAnimationFrame(state.rafId);
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
          runtime.coop
            ? runtime.coop.getCreatures()
            : runtime.creatures.map((c) => ({ id: -1, kind: c.typeKey, x: c.pos.x, y: c.pos.y, z: c.pos.z })),
        players: () => (runtime.coop ? runtime.coop.getPlayers() : []),
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
          camera.position.set(player.pos.x, player.pos.y, player.pos.z);
          camera.lookAt(x, y, z);
          runtime.primaryAction();
        },
        rayHitAt: (x: number, y: number, z: number) => {
          camera.position.set(player.pos.x, player.pos.y, player.pos.z);
          camera.lookAt(x, y, z);
          const r = runtime.raycastServerCreature();
          return r ? { id: r.creature.id, t: r.t } : null;
        },
        hitId: (id: number) => runtime.coop?.sendHit(id),
        digHit: (x: number, y: number, z: number) => runtime.coop?.sendDig(x, y, z),
        voxel: (x: number, y: number, z: number) => world.get(x, y, z),
        surfaceY: (x: number, z: number) => runtime.groundHeight(x, z),
        bag: () => player.bag,
      };
    }
    return cleanup;
  }
}

export const GameEngine = {
  builder(): GameEngineBuilder {
    return new GameEngineBuilder();
  },
};
