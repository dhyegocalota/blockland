// A minimal, three.js-free 3D vector owning the engine's position/velocity math. It is a verbatim
// port of the THREE.Vector3 methods the engine actually uses (set/copy/clone/add/addScaledVector/
// multiplyScalar/length/distanceTo/equals), each body matching three.js's source semantics exactly so
// swapping Vector3 -> Vec3 keeps the IEEE-754 sequence — and thus physics + creature AI — bit-for-bit
// identical. The golden vec3.test.ts proves the equivalence against THREE.Vector3.
export class Vec3 {
  x: number;
  y: number;
  z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set(x: number, y: number, z?: number): this {
    if (z === undefined) z = this.z;
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  copy(v: { x: number; y: number; z: number }): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }

  add(v: { x: number; y: number; z: number }): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  addScaledVector(v: { x: number; y: number; z: number }, s: number): this {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  multiplyScalar(scalar: number): this {
    this.x *= scalar;
    this.y *= scalar;
    this.z *= scalar;
    return this;
  }

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }

  distanceToSquared(v: { x: number; y: number; z: number }): number {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }

  distanceTo(v: { x: number; y: number; z: number }): number {
    return Math.sqrt(this.distanceToSquared(v));
  }

  equals(v: { x: number; y: number; z: number }): boolean {
    return ((v.x === this.x) && (v.y === this.y) && (v.z === this.z));
  }
}
