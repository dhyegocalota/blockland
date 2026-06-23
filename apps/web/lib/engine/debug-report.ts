// Pure, always-on diagnostics for the intermittent online "can't break/hit but can build" bug. It keeps
// a bounded ring of recent online action events (Move/Dig/Hit/Edit sent, Edit/Error/Respawn/Health
// received, NetState changes) — each stamped with the client's player position at the time — so the data
// exists the moment the bug strikes. `formatDebugReport` turns the live connection state + the ring into
// a plain-text report the owner can paste. No DOM, no three.js: the seam is wired from net.ts/coop.ts.

import { roundCoordinate } from './scoreboard';

// Last N events kept; cheap enough to run every send/receive without throttling.
export const DEBUG_RING_CAPACITY = 80;
// How far the client-believed position may drift from the latest server-acked position before we treat
// it as the stale-position smoking gun (the server's reach checks aim from ITS position, not ours).
export const POSITION_DIVERGENCE_THRESHOLD = 2;

export enum DebugEventDir {
  Send = 'send',
  Recv = 'recv',
  State = 'state',
}

export enum DebugEventKind {
  Move = 'move',
  Dig = 'dig',
  Hit = 'hit',
  Edit = 'edit',
  EditRecv = 'edit_recv',
  Error = 'error',
  Respawn = 'respawn',
  Health = 'health',
  NetState = 'net_state',
  // A primary action (break/hit) was attempted: records what the aim found (block/creature/none) so a
  // report taken while "can't break" shows whether nothing was in reach vs a send that was dropped.
  Action = 'action',
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface DebugEvent {
  at: number;
  dir: DebugEventDir;
  kind: DebugEventKind;
  // The client's own player position when the event was recorded (the position the server SHOULD agree
  // with). Absent for state changes that carry no pose context.
  pos?: Vec3Like;
  // The acted-on cell/target for Dig/Edit/EditRecv.
  cell?: Vec3Like;
  // The wire id for Hit/Edit, or the new health for Health.
  id?: number;
  // The error code or net state string.
  text?: string;
}

// A bounded ring of events, newest appended last. Push past capacity drops the oldest. The ring stamps
// every event with its own clock so timestamps from the two seams (net.ts sends, coop.ts receives) share
// one epoch and stay comparable; the clock is injectable for deterministic tests.
export class DebugEventRing {
  private events: DebugEvent[] = [];

  constructor(
    private readonly capacity: number = DEBUG_RING_CAPACITY,
    private readonly now: () => number = Date.now,
  ) {}

  push(event: Omit<DebugEvent, 'at'>): void {
    this.events.push({ ...event, at: this.now() });
    if (this.events.length > this.capacity) this.events.shift();
  }

  list(): DebugEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}

// Process-wide ring shared by net.ts (sends) and coop.ts (receives + state). One live connection at a
// time, so a singleton is enough and keeps the always-on cost to a single small array.
export const debugReportRing = new DebugEventRing();

// Straight-line distance between the client position and the latest server-acked position for this
// player. Large values mean the server is tracking a stale pose, so its reach checks for dig/hit aim
// from the wrong place while the client thinks it is aiming fine.
export function positionDivergence({ client, server }: { client: Vec3Like; server: Vec3Like }): number {
  const dx = client.x - server.x;
  const dy = client.y - server.y;
  const dz = client.z - server.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Edge-detects crossing POSITION_DIVERGENCE_THRESHOLD so callers log a 'position diverged' warning once
// per transition (and a recovery once it falls back), never every frame.
export class DivergenceTracker {
  private diverged = false;

  constructor(private readonly threshold: number = POSITION_DIVERGENCE_THRESHOLD) {}

  update(distance: number): 'diverged' | 'recovered' | null {
    const over = distance > this.threshold;
    if (over === this.diverged) return null;
    this.diverged = over;
    return over ? 'diverged' : 'recovered';
  }
}

export interface DebugReportState {
  at: number;
  tenant: string;
  frontVersion: string;
  backendVersion: string;
  netState: string;
  ping: number;
  online: number;
  clientPos: Vec3Like;
  // The latest server-acked position for this player from the snapshot; absent before the first snapshot.
  serverPos: Vec3Like | null;
  hp: number;
  events: DebugEvent[];
}

function coord(value: number): string {
  return roundCoordinate(value).toFixed(2);
}

function vec(pos: Vec3Like): string {
  return `${coord(pos.x)}, ${coord(pos.y)}, ${coord(pos.z)}`;
}

function formatEvent(event: DebugEvent, base: number): string {
  const head = `${event.at - base}ms ${event.dir}/${event.kind}`;
  const parts: string[] = [];
  if (event.cell) parts.push(`cell=(${vec(event.cell)})`);
  if (event.id !== undefined) parts.push(`id=${event.id}`);
  if (event.text !== undefined) parts.push(event.text);
  if (event.pos) parts.push(`pos=(${vec(event.pos)})`);
  if (parts.length === 0) return head;
  return `${head} ${parts.join(' ')}`;
}

// Assembles the pasteable report. The position block is the heart of it: client vs latest server-acked
// position + their delta exposes the stale-position hypothesis (dig/hit reach is server-side).
export function formatDebugReport(state: DebugReportState): string {
  const lines: string[] = [];
  lines.push('— Blockland debug report —');
  lines.push(`at: ${state.at}`);
  lines.push(`tenant: ${state.tenant}`);
  lines.push(`front: ${state.frontVersion}`);
  lines.push(`backend: ${state.backendVersion}`);
  lines.push(`net: ${state.netState}`);
  lines.push(`ping: ${state.ping}ms`);
  lines.push(`online: ${state.online}`);
  lines.push(`hp: ${state.hp}`);
  lines.push(`client pos: ${vec(state.clientPos)}`);
  if (!state.serverPos) lines.push('server pos: (no snapshot yet)');
  if (state.serverPos) {
    lines.push(`server pos: ${vec(state.serverPos)}`);
    const delta = positionDivergence({ client: state.clientPos, server: state.serverPos });
    const stale = delta > POSITION_DIVERGENCE_THRESHOLD ? ' STALE' : '';
    lines.push(`pos delta: ${coord(delta)}${stale}`);
  }
  lines.push(`events (${state.events.length}, newest last):`);
  if (state.events.length === 0) lines.push('  (none)');
  for (const event of state.events) lines.push(`  ${formatEvent(event, state.at)}`);
  return lines.join('\n');
}
