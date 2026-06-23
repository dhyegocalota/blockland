import { describe, expect, it } from 'vitest';
import { canCollectHeart, heartBobOffset, heartDropExpired, type HeartDrop } from './heart-drop';
import { HEART_DROP_TTL_MS, HEART_PICKUP_RADIUS, MAX_HEARTS } from './constants';
import { Vec3 } from './vec3';

function dropAt(x: number, y: number, z: number, spawnedAt = 0): HeartDrop {
  return { id: 1, pos: new Vec3(x, y, z), spawnedAt };
}

describe('canCollectHeart', () => {
  it('collects a heart within radius while below max', () => {
    const drop = dropAt(0, 0, 0);
    expect(canCollectHeart({ drop, playerPos: new Vec3(HEART_PICKUP_RADIUS - 0.1, 0, 0), hearts: MAX_HEARTS - 1 })).toBe(true);
  });

  it('leaves the heart for a full-hearted player', () => {
    const drop = dropAt(0, 0, 0);
    expect(canCollectHeart({ drop, playerPos: new Vec3(0, 0, 0), hearts: MAX_HEARTS })).toBe(false);
  });

  it('ignores a drop out of radius', () => {
    const drop = dropAt(0, 0, 0);
    expect(canCollectHeart({ drop, playerPos: new Vec3(HEART_PICKUP_RADIUS + 0.1, 0, 0), hearts: 1 })).toBe(false);
  });
});

describe('heartDropExpired', () => {
  it('keeps a fresh drop', () => {
    const drop = dropAt(0, 0, 0, 1000);
    expect(heartDropExpired({ drop, now: 1000 + HEART_DROP_TTL_MS })).toBe(false);
  });

  it('expires a drop past its TTL', () => {
    const drop = dropAt(0, 0, 0, 1000);
    expect(heartDropExpired({ drop, now: 1000 + HEART_DROP_TTL_MS + 1 })).toBe(true);
  });
});

describe('heartBobOffset', () => {
  it('rests at zero at t=0 and stays bounded', () => {
    expect(heartBobOffset(0)).toBe(0);
    expect(Math.abs(heartBobOffset(123.4))).toBeLessThanOrEqual(0.18);
  });
});
