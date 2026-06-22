// Golden equivalence: every Vec3 method must produce the exact same result as THREE.Vector3 for the
// same inputs (same IEEE-754 sequence). This is the proof that swapping Vector3 -> Vec3 across the
// engine keeps physics + creature AI bit-for-bit identical.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Vec3 } from './vec3';

const SAMPLES: [number, number, number][] = [
  [0, 0, 0],
  [1, 2, 3],
  [-1, -2, -3],
  [1.5, -2.25, 3.125],
  [-0, 0, -0],
  [1e-7, 1e7, -1e-3],
  [123.456, -789.012, 0.0001],
  [Math.PI, Math.E, Math.SQRT2],
];

const both = (x: number, y: number, z: number): { vec: Vec3; three: THREE.Vector3 } => ({
  vec: new Vec3(x, y, z),
  three: new THREE.Vector3(x, y, z),
});

const same = (vec: Vec3, three: THREE.Vector3): void => {
  expect(vec.x).toBe(three.x);
  expect(vec.y).toBe(three.y);
  expect(vec.z).toBe(three.z);
};

describe('Vec3 golden equivalence with THREE.Vector3', () => {
  it('constructor defaults to zero', () => {
    same(new Vec3(), new THREE.Vector3());
  });

  it('constructor stores components', () => {
    for (const [x, y, z] of SAMPLES) same(new Vec3(x, y, z), new THREE.Vector3(x, y, z));
  });

  it('set(x, y, z)', () => {
    for (const [x, y, z] of SAMPLES) {
      const { vec, three } = both(9, 9, 9);
      same(vec.set(x, y, z), three.set(x, y, z));
    }
  });

  it('set(x, y) leaves z untouched, matching THREE.Vector3 source semantics', () => {
    const vec = new Vec3(1, 2, 3);
    vec.set(4, 5);
    expect(vec.x).toBe(4);
    expect(vec.y).toBe(5);
    expect(vec.z).toBe(3);
  });

  it('copy', () => {
    for (const [x, y, z] of SAMPLES) {
      const { vec, three } = both(0, 0, 0);
      same(vec.copy({ x, y, z }), three.copy(new THREE.Vector3(x, y, z)));
    }
  });

  it('clone is an independent copy', () => {
    for (const [x, y, z] of SAMPLES) {
      const source = new Vec3(x, y, z);
      const clone = source.clone();
      same(clone, new THREE.Vector3(x, y, z).clone());
      clone.x = 42;
      expect(source.x).toBe(x);
    }
  });

  it('add', () => {
    for (const [x, y, z] of SAMPLES) {
      const a = both(1.5, -2.5, 3.5);
      same(a.vec.add({ x, y, z }), a.three.add(new THREE.Vector3(x, y, z)));
    }
  });

  it('addScaledVector', () => {
    for (const [x, y, z] of SAMPLES) {
      const scalar = 0.016;
      const a = both(10, -20, 30);
      same(a.vec.addScaledVector({ x, y, z }, scalar), a.three.addScaledVector(new THREE.Vector3(x, y, z), scalar));
    }
  });

  it('multiplyScalar', () => {
    for (const scalar of [0, 1, -1, 2.5, -0.016, 1e6]) {
      const a = both(1.5, -2.25, 3.125);
      same(a.vec.multiplyScalar(scalar), a.three.multiplyScalar(scalar));
    }
  });

  it('length', () => {
    for (const [x, y, z] of SAMPLES) {
      const { vec, three } = both(x, y, z);
      expect(vec.length()).toBe(three.length());
    }
  });

  it('distanceTo', () => {
    for (const [x, y, z] of SAMPLES) {
      const a = new Vec3(1.5, -2.25, 3.125);
      const at = new THREE.Vector3(1.5, -2.25, 3.125);
      expect(a.distanceTo({ x, y, z })).toBe(at.distanceTo(new THREE.Vector3(x, y, z)));
    }
  });

  it('distanceToSquared', () => {
    for (const [x, y, z] of SAMPLES) {
      const a = new Vec3(1.5, -2.25, 3.125);
      const at = new THREE.Vector3(1.5, -2.25, 3.125);
      expect(a.distanceToSquared({ x, y, z })).toBe(at.distanceToSquared(new THREE.Vector3(x, y, z)));
    }
  });

  it('equals', () => {
    const a = new Vec3(1, 2, 3);
    const at = new THREE.Vector3(1, 2, 3);
    expect(a.equals({ x: 1, y: 2, z: 3 })).toBe(at.equals(new THREE.Vector3(1, 2, 3)));
    expect(a.equals({ x: 1, y: 2, z: 4 })).toBe(at.equals(new THREE.Vector3(1, 2, 4)));
    const zero = new Vec3();
    const zeroThree = new THREE.Vector3();
    expect(zero.equals({ x: 0, y: 0, z: 0 })).toBe(zeroThree.equals(new THREE.Vector3()));
  });

  it('returns this for chaining, same as THREE', () => {
    const { vec, three } = both(0, 0, 0);
    same(
      vec.set(1, 1, 1).add({ x: 2, y: 2, z: 2 }).multiplyScalar(3).addScaledVector({ x: 1, y: 0, z: -1 }, 4),
      three.set(1, 1, 1).add(new THREE.Vector3(2, 2, 2)).multiplyScalar(3).addScaledVector(new THREE.Vector3(1, 0, -1), 4),
    );
  });
});
