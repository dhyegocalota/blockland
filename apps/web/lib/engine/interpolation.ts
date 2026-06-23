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
// Tuned to the 30Hz snapshot + 20Hz move rate: ~2-3 samples of buffer, snappier than the old 120ms.
export const INTERP_DELAY_MS = 100;
// Drop samples older than this to bound memory and ignore stale history after a reconnect.
export const INTERP_BUFFER_MS = 1000;
// When a snapshot is late, dead-reckon the entity forward at its last velocity instead of freezing —
// but only up to this many ms past the newest sample. Long enough to bridge one missed snapshot,
// short enough that a wrong velocity guess never flings the entity far; past it we hold the pose.
export const EXTRAPOLATE_MAX_MS = 200;

function lerp(a: number, b: number, ratio: number): number {
  return a + (b - a) * ratio;
}

function shortestAngleDelta(a: number, b: number): number {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function lerpAngle(a: number, b: number, ratio: number): number {
  return a + shortestAngleDelta(a, b) * ratio;
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
    if (renderTime >= last.t) return this.extrapolate(renderTime, last);

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

  private extrapolate(renderTime: number, last: RemoteSample): RemotePose {
    const prev = this.samples[this.samples.length - 2];
    if (!prev) return toPose(last);
    const span = last.t - prev.t;
    if (span === 0) return toPose(last);
    const ahead = Math.min(renderTime - last.t, EXTRAPOLATE_MAX_MS);
    const ratio = ahead / span;
    return {
      x: last.x + (last.x - prev.x) * ratio,
      y: last.y + (last.y - prev.y) * ratio,
      z: last.z + (last.z - prev.z) * ratio,
      yaw: last.yaw + shortestAngleDelta(prev.yaw, last.yaw) * ratio,
      pitch: last.pitch + (last.pitch - prev.pitch) * ratio,
    };
  }
}

function toPose(sample: RemoteSample): RemotePose {
  return { x: sample.x, y: sample.y, z: sample.z, yaw: sample.yaw, pitch: sample.pitch };
}
