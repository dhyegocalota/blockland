// Hold-to-attack cadence: while the attack button is held, the loop accumulates frame time and fires a
// repeated primaryAction() every repeatMs. The first hit fires on press (in the input glue), so this only
// decides the repeats. Pure so the loop's timing is unit-tested without a real clock or DOM.

export interface AttackTick {
  attacking: boolean;
  sinceLast: number;
  repeatMs: number;
  dt: number;
}

export function attackTick({ attacking, sinceLast, repeatMs, dt }: AttackTick): { fire: boolean; sinceLast: number } {
  if (!attacking) return { fire: false, sinceLast: 0 };
  const elapsed = sinceLast + dt;
  if (elapsed < repeatMs) return { fire: false, sinceLast: elapsed };
  return { fire: true, sinceLast: elapsed - repeatMs };
}
