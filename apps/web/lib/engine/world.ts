// Sparse voxel store: only visited chunks allocate memory, so the world is effectively endless.
// Pure data + a per-chunk procedural base sourced from the shared Rust worldgen (via wasm). No three.js,
// no DOM. The base of a chunk is generated ONCE on first load by the injected `worldgen` (a wasm call into
// `sim::worldgen_chunk`) and cached; every hot per-voxel read (physics, raycast, meshing) then reads this
// in-memory cache — never wasm per voxel/frame.
import { AIR, CHUNK, SIZE_X, SIZE_Y, SIZE_Z, WATER_ID } from './constants';
import type { WorldgenChunk } from './online/wasm-core-loader';

export class VoxelWorld {
  private readonly chunksX = Math.ceil(SIZE_X / CHUNK);
  private readonly chunksZ = Math.ceil(SIZE_Z / CHUNK);
  private readonly chunkVolume = CHUNK * CHUNK * SIZE_Y;
  private readonly chunkData = new Map<number, Uint8Array>();
  private readonly genChunks = new Set<number>();

  // `worldgen` fills a chunk's procedural base (terrain + water + monument + decoration) from the single
  // Rust source. Required — a missing generator is a wiring bug, never silently a blank world.
  constructor(private readonly worldgen: WorldgenChunk) {}

  chunkKey(cx: number, cz: number): number {
    return cx * this.chunksZ + cz;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && x < SIZE_X && y >= 0 && y < SIZE_Y && z >= 0 && z < SIZE_Z;
  }

  private localIdx(lx: number, y: number, lz: number): number {
    return lx + lz * CHUNK + y * CHUNK * CHUNK;
  }

  rawGet(x: number, y: number, z: number): number {
    if (!this.inBounds(x, y, z)) return AIR;
    const arr = this.chunkData.get(this.chunkKey(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
    if (!arr) return AIR;
    return arr[this.localIdx(x % CHUNK, y, z % CHUNK)];
  }

  rawSet(x: number, y: number, z: number, id: number): void {
    if (!this.inBounds(x, y, z)) return;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const key = this.chunkKey(cx, cz);
    let arr = this.chunkData.get(key);
    if (!arr) { arr = new Uint8Array(this.chunkVolume); this.chunkData.set(key, arr); }
    arr[this.localIdx(x % CHUNK, y, z % CHUNK)] = id;
  }

  ensureGen(cx: number, cz: number): void {
    if (cx < 0 || cz < 0 || cx >= this.chunksX || cz >= this.chunksZ) return;
    const key = this.chunkKey(cx, cz);
    if (this.genChunks.has(key)) return;
    this.genChunks.add(key);
    this.generateChunk(cx, cz);
  }

  get(x: number, y: number, z: number): number {
    if (y < 0 || y >= SIZE_Y || x < 0 || x >= SIZE_X || z < 0 || z >= SIZE_Z) return AIR;
    this.ensureGen(Math.floor(x / CHUNK), Math.floor(z / CHUNK));
    return this.rawGet(x, y, z);
  }

  set(x: number, y: number, z: number, id: number): void {
    if (!this.inBounds(x, y, z)) return;
    this.ensureGen(Math.floor(x / CHUNK), Math.floor(z / CHUNK));
    this.rawSet(x, y, z, id);
  }

  isSolid(x: number, y: number, z: number): boolean {
    const v = this.get(x, y, z);
    return v !== AIR && v !== WATER_ID;
  }

  snapshot(): Map<number, Uint8Array> {
    return new Map(this.chunkData);
  }

  // Drop every materialized chunk so the world regenerates from its procedural base on next access.
  // Used by an in-game world reset (the admin wipe), mirroring a fresh boot without a page reload.
  reset(): void {
    this.chunkData.clear();
    this.genChunks.clear();
  }

  // Fill a chunk's procedural base from the shared Rust worldgen (one wasm call), owning a fresh copy so
  // later edits (`rawSet`) never write through to the wasm module's memory. Edits arrive separately (the
  // coop edit overlay / built structures), exactly as before — only the base source changed.
  private generateChunk(cx: number, cz: number): void {
    this.chunkData.set(this.chunkKey(cx, cz), new Uint8Array(this.worldgen(cx, cz)));
  }
}
