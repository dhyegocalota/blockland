// Pure attack-swing easing: maps the time since a swing started to a forward rotation angle (radians)
// the rendering layer applies to the first-person held tool and to a remote avatar's arm. The angle
// rises from rest to a peak then eases back to rest, so a tapped attack reads as a quick lunge. Bounded
// to [0, peak]; before the swing (t < 0) and after it ends (t >= duration) it returns 0 (rest).

export interface SwingPose {
  tSinceStart: number;
  durationMs: number;
  peakRad: number;
}

export function swingPose({ tSinceStart, durationMs, peakRad }: SwingPose): number {
  if (tSinceStart <= 0) return 0;
  if (tSinceStart >= durationMs) return 0;
  const progress = tSinceStart / durationMs;
  return Math.sin(progress * Math.PI) * peakRad;
}
