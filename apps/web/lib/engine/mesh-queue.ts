// Pure mesh-queue bookkeeping: which candidate chunks are new enough to enqueue (not already meshed
// nor already queued), the nearest-first ordering, and whether a dequeued chunk is still worth
// meshing (not meshed in the meantime, not evicted past the keep range). The three.js mesh build and
// the Map/Set mutations stay in the glue; these decisions are numbers only, unit-tested.

import { type ChunkCoord, chunkDistanceSquared, chunkOutsideKeepRange } from './chunk-grid';

export interface QueuedChunk {
  cx: number;
  cz: number;
  key: number;
}

// The candidates that should join the queue: skip any already meshed or already queued.
export function enqueueChunks({
  candidates, isMeshed, isQueued,
}: {
  candidates: QueuedChunk[];
  isMeshed: (key: number) => boolean;
  isQueued: (key: number) => boolean;
}): QueuedChunk[] {
  return candidates.filter(({ key }) => !isMeshed(key) && !isQueued(key));
}

// Nearest-first ordering, mutating the queue in place to mirror the engine's Array.sort.
export function sortQueueByDistance({ queue, center }: { queue: QueuedChunk[]; center: ChunkCoord }): void {
  queue.sort((a, b) =>
    chunkDistanceSquared({ chunk: a, center }) - chunkDistanceSquared({ chunk: b, center }));
}

// A dequeued chunk is still worth meshing unless it was meshed while it waited, or drifted out of the
// keep range as the player moved.
export function shouldMeshDequeued({
  chunk, center, radius, isMeshed,
}: {
  chunk: QueuedChunk;
  center: ChunkCoord;
  radius: number;
  isMeshed: (key: number) => boolean;
}): boolean {
  if (isMeshed(chunk.key)) return false;
  return !chunkOutsideKeepRange({ chunk, center, radius });
}
