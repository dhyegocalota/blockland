// Sparse voxel store: only visited chunks allocate memory, so the world is effectively endless.
// Pure data + procedural generation (via worldgen). No three.js, no DOM.
import { AIR, CHUNK, SIZE_X, SIZE_Y, SIZE_Z, WATER_ID, WATER_LEVEL, WOOD_ID } from './constants';
import { type Biome, baseVoxel, biomeAt, heightAt } from './worldgen';

export class VoxelWorld {
  private readonly chunksX = Math.ceil(SIZE_X / CHUNK);
  private readonly chunksZ = Math.ceil(SIZE_Z / CHUNK);
  private readonly chunkVolume = CHUNK * CHUNK * SIZE_Y;
  private readonly chunkData = new Map<number, Uint8Array>();
  private readonly genChunks = new Set<number>();

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

  private placeTree(x: number, top: number, z: number, x0: number, z0: number, biome: Biome): void {
    const trunk = 3 + Math.floor(Math.random() * 3);
    for (let t = 1; t <= trunk; t++) this.rawSet(x, top + t, z, WOOD_ID);
    const leaf = biome === 'snow' ? 12 : 5;
    const cy = top + trunk;
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++)
        for (let dy = 0; dy <= 2; dy++) {
          const lx = x + dx, lz = z + dz;
          if (lx < x0 || lx >= x0 + CHUNK || lz < z0 || lz >= z0 + CHUNK) continue;
          if (Math.abs(dx) + Math.abs(dz) + dy > 3) continue;
          if (this.rawGet(lx, cy + dy, lz) === AIR) this.rawSet(lx, cy + dy, lz, leaf);
        }
  }

  private generateChunk(cx: number, cz: number): void {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    for (let x = x0; x < x0 + CHUNK && x < SIZE_X; x++)
      for (let z = z0; z < z0 + CHUNK && z < SIZE_Z; z++) {
        const top = heightAt(x, z);
        for (let y = 0; y <= top; y++) this.rawSet(x, y, z, baseVoxel(x, y, z));
        for (let y = top + 1; y <= WATER_LEVEL; y++) this.rawSet(x, y, z, WATER_ID);
      }
    this.decorateChunk(cx, cz);
  }

  private decorateChunk(cx: number, cz: number): void {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    for (let i = 0; i < 30; i++) {
      const x = x0 + 2 + Math.floor(Math.random() * (CHUNK - 4));
      const z = z0 + 2 + Math.floor(Math.random() * (CHUNK - 4));
      const top = heightAt(x, z);
      if (top <= WATER_LEVEL) continue;
      const biome = biomeAt(x, z);
      const density = biome === 'forest' ? 0.75 : biome === 'plains' ? 0.22 : biome === 'snow' ? 0.16 : 0.02;
      if (Math.random() < density) { this.placeTree(x, top, z, x0, z0, biome); continue; }
      if (biome !== 'desert' && Math.random() < 0.1 && this.rawGet(x, top + 1, z) === AIR) this.rawSet(x, top + 1, z, 9);
    }
    for (const [chance, id] of [[0.5, 8], [0.28, 14], [0.08, 15]]) {
      if (Math.random() >= chance) continue;
      const x = x0 + Math.floor(Math.random() * CHUNK);
      const z = z0 + Math.floor(Math.random() * CHUNK);
      const top = heightAt(x, z);
      if (top > WATER_LEVEL && this.rawGet(x, top + 1, z) === AIR) this.rawSet(x, top + 1, z, id);
    }
  }
}
