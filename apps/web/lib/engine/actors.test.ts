import { describe, expect, it } from 'vitest';
import { blockVelocityIntoActors } from './actors';

const base = { radius: 0.3, height: 1.7, actorRadius: 0.3 };
// Player at origin, a peer just ahead on +x (within the 0.6 combined radius).
const peerAhead = [{ x: 0.4, y: 0, z: 0 }];

describe('blockVelocityIntoActors', () => {
  it('leaves velocity untouched when no actor is near', () => {
    const out = blockVelocityIntoActors({ x: 0, y: 0, z: 0, vx: 5, vz: 0, ...base, actors: [{ x: 20, y: 0, z: 20 }] });
    expect(out).toEqual({ vx: 5, vz: 0 });
  });

  it('cancels velocity that walks into a peer', () => {
    const out = blockVelocityIntoActors({ x: 0, y: 0, z: 0, vx: 4, vz: 0, ...base, actors: peerAhead });
    expect(out.vx).toBeCloseTo(0, 5);
    expect(out.vz).toBeCloseTo(0, 5);
  });

  it('allows moving away from a peer', () => {
    const out = blockVelocityIntoActors({ x: 0, y: 0, z: 0, vx: -4, vz: 0, ...base, actors: peerAhead });
    expect(out.vx).toBeCloseTo(-4, 5);
  });

  it('preserves sliding tangentially along a peer', () => {
    const out = blockVelocityIntoActors({ x: 0, y: 0, z: 0, vx: 0, vz: 4, ...base, actors: peerAhead });
    expect(out.vz).toBeCloseTo(4, 5);
  });

  it('ignores peers that are vertically separated (flying overhead)', () => {
    const out = blockVelocityIntoActors({ x: 0, y: 0, z: 0, vx: 4, vz: 0, ...base, actors: [{ x: 0.4, y: 5, z: 0 }] });
    expect(out).toEqual({ vx: 4, vz: 0 });
  });

  it('does not block at an exact overlap (lets players step apart)', () => {
    const out = blockVelocityIntoActors({ x: 0, y: 0, z: 0, vx: 4, vz: 1, ...base, actors: [{ x: 0, y: 0, z: 0 }] });
    expect(out).toEqual({ vx: 4, vz: 1 });
  });
});
