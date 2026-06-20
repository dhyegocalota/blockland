// Face-culled, per-block-type chunk meshing. Pure: a voxel accessor and bounds in, geometry buffers
// out (positions/normals/uv/indices grouped by block id). No three.js, no DOM — the caller turns
// each bucket into a THREE.Mesh.
import { AIR } from './constants';

interface Face {
  dir: [number, number, number];
  corners: [number, number, number][];
}

export interface MeshBucket {
  pos: number[];
  norm: number[];
  uv: number[];
  idxs: number[];
}

const FACES: Face[] = [
  { dir: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { dir: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { dir: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { dir: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { dir: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
  { dir: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];
const UV: [number, number][] = [[0, 0], [0, 1], [1, 1], [1, 0]];

// Build merged geometry for one chunk column. `getVoxel` reads any cell (including neighbors just
// outside the chunk, for correct edge culling); `isTransparent` decides face visibility the same
// way the renderer does. Returns one bucket per block id that produced any face.
export function meshChunkBuckets({
  getVoxel,
  isTransparent,
  x0,
  x1,
  z0,
  z1,
  sizeY,
}: {
  getVoxel: (x: number, y: number, z: number) => number;
  isTransparent: (id: number) => boolean;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  sizeY: number;
}): Map<number, MeshBucket> {
  const buckets = new Map<number, MeshBucket>();
  const bucketFor = (id: number): MeshBucket => {
    const existing = buckets.get(id);
    if (existing) return existing;
    const created: MeshBucket = { pos: [], norm: [], uv: [], idxs: [] };
    buckets.set(id, created);
    return created;
  };

  for (let y = 0; y < sizeY; y++)
    for (let z = z0; z < z1; z++)
      for (let x = x0; x < x1; x++) {
        const id = getVoxel(x, y, z);
        if (id === AIR) continue;
        const opaque = !isTransparent(id);
        for (const face of FACES) {
          const neighbor = getVoxel(x + face.dir[0], y + face.dir[1], z + face.dir[2]);
          const neighborTransparent = neighbor === AIR || isTransparent(neighbor);
          if (opaque && !neighborTransparent) continue;
          if (!opaque && neighbor !== AIR) continue;
          const bucket = bucketFor(id);
          const start = bucket.pos.length / 3;
          face.corners.forEach((corner, i) => {
            bucket.pos.push(x + corner[0], y + corner[1], z + corner[2]);
            bucket.norm.push(...face.dir);
            bucket.uv.push(UV[i][0], UV[i][1]);
          });
          bucket.idxs.push(start, start + 1, start + 2, start, start + 2, start + 3);
        }
      }

  return buckets;
}
