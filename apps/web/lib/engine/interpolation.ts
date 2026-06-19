// Pure snapshot interpolation for remote players. The server sends discrete snapshots a few times
// per second; each remote avatar keeps a small time-ordered buffer of samples and we render it a
// fixed delay in the past, lerping between the two samples that straddle the render time. This
// hides network jitter and turns sparse updates into smooth motion. No three.js, no DOM.

export interface RemoteSample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface RemotePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

// Render this many milliseconds behind the newest sample so there is always a pair to lerp between.
export const INTERP_DELAY_MS = 120;
// Drop samples older than this to bound memory and ignore stale history after a reconnect.
export const INTERP_BUFFER_MS = 1000;

function lerp(a: number, b: number, ratio: number): number {
  return a + (b - a) * ratio;
}

function lerpAngle(a: number, b: number, ratio: number): number {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * ratio;
}

export class RemoteInterpolator {
  private samples: RemoteSample[] = [];

  push(sample: RemoteSample): void {
    const last = this.samples[this.samples.length - 1];
    if (last && sample.t <= last.t) return;
    this.samples.push(sample);
    const cutoff = sample.t - INTERP_BUFFER_MS;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
  }

  sampleAt(now: number): RemotePose | null {
    if (this.samples.length === 0) return null;
    const renderTime = now - INTERP_DELAY_MS;
    const first = this.samples[0];
    if (renderTime <= first.t) return toPose(first);
    const last = this.samples[this.samples.length - 1];
    if (renderTime >= last.t) return toPose(last);

    for (let i = 0; i < this.samples.length - 1; i++) {
      const a = this.samples[i];
      const b = this.samples[i + 1];
      if (renderTime > b.t) continue;
      const span = b.t - a.t;
      const ratio = span === 0 ? 0 : (renderTime - a.t) / span;
      return {
        x: lerp(a.x, b.x, ratio),
        y: lerp(a.y, b.y, ratio),
        z: lerp(a.z, b.z, ratio),
        yaw: lerpAngle(a.yaw, b.yaw, ratio),
        pitch: lerp(a.pitch, b.pitch, ratio),
      };
    }
    return toPose(last);
  }
}

function toPose(sample: RemoteSample): RemotePose {
  return { x: sample.x, y: sample.y, z: sample.z, yaw: sample.yaw, pitch: sample.pitch };
}
