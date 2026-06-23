// Co-op glue: owns the network client and the remote-player/creature state inside the running game.
// The pure interpolation math lives in engine/interpolation.ts; this module is the thin net.ts wiring
// around it. It is created only when a server URL is configured — when absent the game never imports a
// live socket and stays single-player. Local pose is throttled out as `move`; remote
// `snapshot`/`edit`/`chat` come back in through typed handlers. HUD updates are pushed to the React
// layer through the injected callbacks rather than touching the DOM here. All three.js rendering is
// dependency-inverted onto the injected CoopView (engine/rendering/coop-view.ts), driven with plain
// data so this module stays three.js-free.

import { EYE_HEIGHT, HEART_PICKUP_RADIUS, PLAYER_HEIGHT, PLAYER_RADIUS } from './engine/constants';
import type { ActorPos } from './engine/actors';
import { RemoteInterpolator } from './engine/interpolation';
import { debug, warn } from './log';
import {
  DebugEventDir, DebugEventKind, DivergenceTracker, debugReportRing, positionDivergence, type Vec3Like,
} from './engine/debug-report';
import { createNet, type NetClient, type NetState } from './net';
import type { EditCell, EditOp, Role } from './protocol';
import type { FeedEvent, RosterMember } from './feed';
import { creatureDefFor, creatureNameKey, type CreatureDef } from './engine/online/creature-snapshot';
import { t } from './i18n';

// One persistent world per tenant (see apps/server model); the world name is fixed and global.
export const MAIN_WORLD = 'main';
// Match the 30Hz server tick more closely so remote players get more position samples (smoother).
const MOVE_SEND_HZ = 20;
const MOVE_SEND_INTERVAL_MS = 1000 / MOVE_SEND_HZ;

export interface Appearance {
  skin: string;
  shirt: string;
  hair: string;
}

export interface LocalPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface RosterEntry extends RosterMember {
  self: boolean;
  admin: boolean;
  moderator: boolean;
}

export interface RoomState {
  peace: boolean;
  blockedStructures: string[];
  pvp: boolean;
  chatEnabled: boolean;
  suspended: boolean;
  approvalRequired: boolean;
  // Per-tenant play-time budget (minutes within a rolling window of hours; 0 = unlimited) and which
  // game modes the tenant allows, mirrored live so the admin panels edit them without a rejoin.
  playtimeLimitMin: number;
  playtimeWindowH: number;
  onlineAllowed: boolean;
  offlineAllowed: boolean;
}

export interface PendingApproval {
  accountId: string;
  name: string;
  email: string;
}

export interface Banned {
  ip: string;
  name: string;
}

export interface Report {
  by: string;
  target: string;
}

// The data-only rendering hooks coop drives. Every method takes plain data (ids, names, colors,
// coords, text) — no three.js types — so coop stays three.js-free; engine/rendering/coop-view.ts owns
// the meshes behind it. Called at the exact points coop used to build/move/dispose a mesh.
export interface CoopView {
  onPlayerJoin(id: number, name: string, look: Appearance): void;
  onPlayerPose(id: number, x: number, y: number, z: number, yaw: number): void;
  // A remote player performed a primary action: swing that avatar's arm (purely cosmetic).
  onPlayerSwing(id: number): void;
  onPlayerChat(id: number, text: string): void;
  onPlayerRename(id: number, name: string): void;
  onPlayerLeave(id: number): void;
  onCreatureSpawn(id: number, def: CreatureDef): void;
  onCreaturePose(id: number, x: number, y: number, z: number, yaw: number): void;
  onCreatureFlash(id: number): void;
  onCreatureDespawn(id: number): void;
  // A server-owned heart pickup appeared/moved/vanished in the snapshot; the view renders a bobbing
  // red heart at its position and removes it when the drop is gone.
  onHeartDropSpawn(id: number, x: number, y: number, z: number): void;
  onHeartDropMove(id: number, x: number, y: number, z: number): void;
  onHeartDropDespawn(id: number): void;
}

export interface CoopHud {
  onState(state: NetState): void;
  onPing(ping: number): void;
  onChat(name: string, text: string): void;
  onCount(online: number): void;
  onRoster(players: RosterEntry[]): void;
  onEvent(event: FeedEvent): void;
  onScore(score: number): void;
  onRole(role: { admin: boolean; moderator: boolean }): void;
  onRoomState(room: RoomState): void;
  onPendingApprovals(pending: PendingApproval[]): void;
  onBans(bans: Banned[]): void;
  onError(code: string): void;
}

export interface CoopOptions {
  view: CoopView;
  url: string;
  tenant: string;
  world: string;
  name: string;
  skin: string;
  shirt: string;
  hair: string;
  claim: string;
  hud: CoopHud;
  applyRemoteEdit(args: { x: number; y: number; z: number; id: number; mine: boolean }): void;
  applyRemoteEditBatch(edits: EditCell[]): void;
  applyRoomState(room: RoomState): void;
  applyHurt(by: string): void;
  // A server creature just vanished from the snapshot (it was defeated): puff it where it stood.
  onCreaturePoof(args: { x: number; y: number; z: number; color: string }): void;
  // The admin reset the world: rebuild it in place + respawn, without a page reload.
  onWorldReset(): void;
  // The server's authoritative spawn for this player (from Welcome). The engine snaps the local player
  // onto it so the server's anti-cheat baseline and the client agree from the first move.
  onSpawn(x: number, y: number, z: number): void;
  // The server owns hearts: every snapshot carries this player's current health, and a Respawn message
  // recenters them with full health on death or the back-to-spawn button.
  onHealth(hp: number): void;
  // A heart drop vanished within pickup range of this player — they collected it. Fired even at full
  // health (when hp doesn't change) so picking up a heart online always makes a sound, like offline.
  onHeartCollected(): void;
  onRespawn(x: number, y: number, z: number, hp: number): void;
  // The server owns block resources in co-op: it pushes this player's authoritative counts + infinite
  // flag on join and on every change. The engine repaints the hotbar from coop's stored counts.
  onInventory(): void;
}

interface Avatar {
  name: string;
  x: number;
  y: number;
  z: number;
  interp: RemoteInterpolator;
}

interface ServerCreature {
  kind: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  lift: number;
  interp: RemoteInterpolator;
}

// The server reports a creature's y as `surface_y + this` (its body center floats this far above the
// top *solid block index*). The walkable surface is one block higher (index + 1), so to sit a creature
// on the ground like the local single-player model we lift it by (1 - offset) + half its height.
const SERVER_GROUND_OFFSET = 0.5;
// A heart drop's server y is the dead creature's body center (surface_y + SERVER_GROUND_OFFSET); lift it
// onto the walkable surface and a touch above so it floats clear of the ground like the local hearts.
const HEART_DROP_LIFT = 1 - SERVER_GROUND_OFFSET + 0.4;
const PLAYER_HIT_COLOR = '#ff5555';

// What the engine raycasts against to aim an attack: world position, the wire id to send in `hit`,
// and the hit sphere radius derived from the creature's model size.
export interface CoopCreature {
  id: number;
  kind: string;
  x: number;
  y: number;
  z: number;
  radius: number;
}

// A remote player the engine can raycast against to aim a pvp attack: its wire id (sent in
// `attack_player`), world position and a hit sphere sized to the avatar.
export interface CoopPlayer {
  id: number;
  x: number;
  y: number;
  z: number;
  radius: number;
}

export interface CoopController {
  sendMove(pose: LocalPose, now: number): void;
  sendEdit(op: EditOp, x: number, y: number, z: number, id: number): void;
  sendEditBatch(edits: EditCell[]): void;
  sendChat(text: string): void;
  sendHit(id: number): void;
  sendRespawn(): void;
  sendDig(x: number, y: number, z: number): void;
  flashCreature(id: number): void;
  sendAdminSetPeace(on: boolean): void;
  sendAdminSetStructure(kind: string, allowed: boolean): void;
  sendAdminSetPvp(on: boolean): void;
  sendAdminSetChat(on: boolean): void;
  sendAdminKick(id: number): void;
  sendAdminBan(id: number): void;
  sendAdminReport(id: number): void;
  sendAttackPlayer(id: number): void;
  sendAdminResetWorld(): void;
  sendAdminResetScores(): void;
  sendAdminSuspend(on: boolean): void;
  sendAdminSetRole(id: number, role: Role): void;
  sendAdminSetInfinite(on: boolean): void;
  inventoryCount(id: number): number;
  readonly infinite: boolean;
  sendAdminSetApproval(on: boolean): void;
  sendAdminApprove(accountId: string): void;
  sendAdminReject(accountId: string): void;
  sendAdminBanPending(accountId: string): void;
  sendAdminUnban(ip: string): void;
  sendAdminSetLimits(playtimeLimitMin: number, playtimeWindowH: number): void;
  sendAdminSetModes(onlineAllowed: boolean, offlineAllowed: boolean): void;
  update(now: number): void;
  getColliders(): ActorPos[];
  getCreatures(): CoopCreature[];
  getPlayers(): CoopPlayer[];
  readonly ping: number;
  readonly state: NetState;
  readonly onlineCount: number;
  readonly isAdmin: boolean;
  readonly backendVersion: string;
  // The latest server-acked position for this player from the snapshot (null before the first one). The
  // debug report compares it to the client position to expose a stale server-side pose.
  readonly serverPos: Vec3Like | null;
  close(): void;
}

export function createCoop(opts: CoopOptions): CoopController {
  const { view } = opts;
  const avatars = new Map<number, Avatar>();
  const creatures = new Map<number, ServerCreature>();
  // Server-owned heart drops, keyed by id. Static (no interpolation) — the snapshot is the source of
  // truth: spawn a mesh when one first appears, drop it when it leaves the snapshot.
  const heartDrops = new Map<number, { x: number; y: number; z: number }>();
  // Static identity (name + look) per player id, fed by the Roster message. The per-tick Snapshot is
  // slim (dynamics only); avatars are spawned + the HUD roster is named from here.
  const identities = new Map<number, Appearance & { name: string; admin: boolean; moderator: boolean }>();
  let selfId: number | null = null;
  let backendVersion = '';
  let lastMoveSentAt = 0;
  // The last local pose handed to sendMove and the latest server-acked position for this player from the
  // snapshot. Their delta is the stale-position signal the debug report prints and the divergence tracker
  // watches; the report reads selfServerPos directly.
  let lastLocalPose: Vec3Like = { x: 0, y: 0, z: 0 };
  let selfServerPos: Vec3Like | null = null;
  const divergence = new DivergenceTracker();
  let onlineCount = 0;
  let selfPing = 0;
  let selfScore = 0;
  let admin = false;
  // Server-authoritative block resources for this player: counts per block id + the infinite flag.
  // The server pushes them; the engine reads them through inventoryCount/infinite to paint the hotbar.
  const inventory = new Map<number, number>();
  let infinite = true;
  // Health only enters the diagnostics ring on change (it rides every 30Hz snapshot otherwise).
  let lastRecordedHp: number | null = null;

  // Warns once when the server-acked position drifts past the threshold from the client position (the
  // dig/hit reach checks aim from the server pose, so this is the smoking gun for the "can't break/hit"
  // bug) and once when it recovers. The snapshot already feeds selfServerPos for the report itself.
  function trackDivergence(serverPos: Vec3Like): void {
    const distance = positionDivergence({ client: lastLocalPose, server: serverPos });
    const transition = divergence.update(distance);
    if (!transition) return;
    if (transition === 'diverged') { warn('action', 'position diverged', { distance, client: lastLocalPose, server: serverPos }); return; }
    debug('action', 'position recovered', { distance });
  }

  function recordHealth(hp: number): void {
    if (hp === lastRecordedHp) return;
    lastRecordedHp = hp;
    debugReportRing.push({ dir: DebugEventDir.Recv, kind: DebugEventKind.Health, id: hp });
  }

  function spawnAvatar(id: number, name: string, look: Appearance): Avatar {
    view.onPlayerJoin(id, name, look);
    const avatar: Avatar = { name, x: 0, y: 0, z: 0, interp: new RemoteInterpolator() };
    avatars.set(id, avatar);
    debug('coop', 'avatar spawned', { id, name });
    return avatar;
  }

  // A rename event renames the live avatar (label + roster name) for whoever currently shows the old
  // name, so the in-game name follows the persisted change even mid-session.
  function renameAvatar(oldName: string, newName: string): void {
    for (const [id, avatar] of avatars) {
      if (avatar.name !== oldName) continue;
      view.onPlayerRename(id, newName);
      avatar.name = newName;
    }
  }

  function removeAvatar(id: number): void {
    if (!avatars.has(id)) return;
    view.onPlayerLeave(id);
    avatars.delete(id);
    debug('coop', 'avatar removed', { id });
  }

  function spawnCreature(id: number, kind: string): ServerCreature {
    const def = creatureDefFor(kind);
    view.onCreatureSpawn(id, def);
    const lift = 1 - SERVER_GROUND_OFFSET + def.size[1] / 2;
    const creature: ServerCreature = { kind, x: 0, y: 0, z: 0, radius: Math.max(...def.size) * 0.7, lift, interp: new RemoteInterpolator() };
    creatures.set(id, creature);
    debug('coop', 'creature spawned', { id, kind });
    return creature;
  }

  function removeCreature(id: number): void {
    if (!creatures.has(id)) return;
    view.onCreatureDespawn(id);
    creatures.delete(id);
    debug('coop', 'creature removed', { id });
  }

  const net: NetClient = createNet({
    url: opts.url,
    tenant: opts.tenant,
    world: opts.world,
    name: opts.name,
    skin: opts.skin,
    shirt: opts.shirt,
    hair: opts.hair,
    claim: opts.claim,
    handlers: {
      onState: (state) => opts.hud.onState(state),
      onWelcome: (msg) => {
        backendVersion = msg.version;
        selfId = msg.you;
        admin = msg.admin;
        opts.onSpawn(msg.spawn[0], msg.spawn[1], msg.spawn[2]);
        opts.hud.onRole({ admin: msg.admin, moderator: msg.moderator });
        debug('coop', 'welcome', { you: msg.you, world: msg.world, admin: msg.admin, moderator: msg.moderator });
      },
      onSnapshot: (msg) => {
        const seen = new Set<number>();
        for (const p of msg.players) {
          if (p.id === selfId) {
            selfPing = p.ping_ms;
            selfScore = p.score;
            selfServerPos = { x: p.x, y: p.y, z: p.z };
            trackDivergence(selfServerPos);
            recordHealth(p.hp);
            opts.onHealth(p.hp);
            continue;
          }
          seen.add(p.id);
          if (avatars.has(p.id)) {
            avatars.get(p.id)!.interp.push({ t: performance.now(), x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch });
            continue;
          }
          // Identity arrives via Roster; until it does (a tick before the join roster) skip the spawn.
          const identity = identities.get(p.id);
          if (!identity) continue;
          const avatar = spawnAvatar(p.id, identity.name, { skin: identity.skin, shirt: identity.shirt, hair: identity.hair });
          avatar.interp.push({ t: performance.now(), x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch });
          opts.hud.onEvent({ kind: 'join', name: identity.name });
        }
        for (const id of [...avatars.keys()]) {
          if (seen.has(id)) continue;
          opts.hud.onEvent({ kind: 'leave', name: avatars.get(id)!.name });
          removeAvatar(id);
        }
        const liveCreatures = new Set<number>();
        for (const c of msg.creatures) {
          liveCreatures.add(c.id);
          const existing = creatures.get(c.id);
          const creature = existing ? existing : spawnCreature(c.id, c.kind);
          creature.interp.push({ t: performance.now(), x: c.x, y: c.y, z: c.z, yaw: c.yaw, pitch: 0 });
        }
        for (const id of [...creatures.keys()]) {
          if (liveCreatures.has(id)) continue;
          const gone = creatures.get(id)!;
          opts.onCreaturePoof({ x: gone.x, y: gone.y, z: gone.z, color: creatureDefFor(gone.kind).color });
          removeCreature(id);
        }
        const liveHearts = new Set<number>();
        for (const heart of msg.hearts) {
          liveHearts.add(heart.id);
          const y = heart.y + HEART_DROP_LIFT;
          if (heartDrops.has(heart.id)) { view.onHeartDropMove(heart.id, heart.x, y, heart.z); continue; }
          heartDrops.set(heart.id, { x: heart.x, y: heart.y, z: heart.z });
          view.onHeartDropSpawn(heart.id, heart.x, y, heart.z);
        }
        for (const [id, pos] of [...heartDrops]) {
          if (liveHearts.has(id)) continue;
          // A drop that vanished within pickup range of us was collected by us — sound the cue even at
          // full health (server consumed it without changing hp). Otherwise it was a far pickup/expiry.
          if (selfServerPos) {
            const dx = selfServerPos.x - pos.x, dz = selfServerPos.z - pos.z;
            if (Math.sqrt(dx * dx + dz * dz) <= HEART_PICKUP_RADIUS) opts.onHeartCollected();
          }
          view.onHeartDropDespawn(id);
          heartDrops.delete(id);
        }
        onlineCount = msg.players.length;
        opts.hud.onCount(onlineCount);
        opts.hud.onRoster(
          msg.players
            .filter((p) => identities.has(p.id))
            .map((p) => {
              const identity = identities.get(p.id)!;
              return { id: p.id, name: identity.name, self: p.id === selfId, admin: identity.admin, moderator: identity.moderator };
            }),
        );
        opts.hud.onPing(selfPing);
        opts.hud.onScore(selfScore);
      },
      onEdit: (msg) => {
        const mine = msg.by === selfId;
        debugReportRing.push({ dir: DebugEventDir.Recv, kind: DebugEventKind.EditRecv, cell: { x: msg.x, y: msg.y, z: msg.z }, id: msg.id, text: mine ? 'mine' : undefined });
        debug('action', 'edit recv', { x: msg.x, y: msg.y, z: msg.z, id: msg.id, mine });
        opts.applyRemoteEdit({ x: msg.x, y: msg.y, z: msg.z, id: msg.id, mine });
      },
      onEditBatch: (msg) => opts.applyRemoteEditBatch(msg.edits),
      onChat: (msg) => {
        if (avatars.has(msg.from)) view.onPlayerChat(msg.from, msg.text);
        opts.hud.onChat(msg.name, msg.text);
      },
      onEvent: (msg) => {
        if (msg.kind === 'kill') {
          opts.hud.onEvent({ kind: 'kill', name: msg.name, detail: t(creatureNameKey(msg.detail)) });
          return;
        }
        if (msg.kind === 'reset') {
          opts.hud.onEvent({ kind: 'reset', name: msg.name });
          opts.onWorldReset();
          return;
        }
        if (msg.kind === 'reset_scores') {
          opts.hud.onEvent({ kind: 'reset_scores', name: msg.name });
          return;
        }
        if (msg.kind === 'server_down') {
          opts.hud.onEvent({ kind: 'server_down', name: msg.name });
          return;
        }
        if (msg.kind === 'admin') {
          opts.hud.onEvent({ kind: 'admin', name: msg.name, detail: msg.detail });
          return;
        }
        if (msg.kind === 'rename') renameAvatar(msg.detail, msg.name);
        opts.hud.onEvent({ kind: 'rename', name: msg.name, detail: msg.detail });
      },
      onRoomState: (msg) => {
        const room: RoomState = {
          peace: msg.peace,
          blockedStructures: msg.blocked_structures,
          pvp: msg.pvp,
          chatEnabled: msg.chat_enabled,
          suspended: msg.suspended,
          approvalRequired: msg.approval_required,
          playtimeLimitMin: msg.playtime_limit_min,
          playtimeWindowH: msg.playtime_window_h,
          onlineAllowed: msg.online_allowed,
          offlineAllowed: msg.offline_allowed,
        };
        opts.applyRoomState(room);
        opts.hud.onRoomState(room);
        debug('coop', 'room state', { peace: msg.peace, blocked: msg.blocked_structures.length, pvp: msg.pvp, chat: msg.chat_enabled, approval: msg.approval_required });
      },
      onPendingApprovals: (msg) => {
        const pending = msg.pending.map((p) => ({ accountId: p.account_id, name: p.name, email: p.email }));
        opts.hud.onPendingApprovals(pending);
        debug('coop', 'pending approvals', { count: pending.length });
      },
      onBans: (msg) => {
        const bans = msg.bans.map((b) => ({ ip: b.ip, name: b.name }));
        opts.hud.onBans(bans);
        debug('coop', 'bans', { count: bans.length });
      },
      onHurt: (msg) => {
        opts.applyHurt(msg.by);
        debug('coop', 'hurt', { by: msg.by });
      },
      onRole: (msg) => {
        opts.hud.onRole({ admin: msg.admin, moderator: msg.moderator });
        debug('coop', 'role changed', { admin: msg.admin, moderator: msg.moderator });
      },
      // Another player's attack landed: play the same hit effect (flash + puff) every client sees.
      onAttack: (msg) => {
        if (msg.kind === 'creature') {
          const cr = creatures.get(msg.id);
          if (!cr) return;
          view.onCreatureFlash(msg.id);
          opts.onCreaturePoof({ x: cr.x, y: cr.y, z: cr.z, color: creatureDefFor(cr.kind).color });
          return;
        }
        const avatar = avatars.get(msg.id);
        if (!avatar) return;
        opts.onCreaturePoof({ x: avatar.x, y: avatar.y + PLAYER_HEIGHT / 2, z: avatar.z, color: PLAYER_HIT_COLOR });
      },
      // Another player performed a primary action: swing their avatar's arm so everyone sees the attack.
      onSwing: (msg) => {
        if (!avatars.has(msg.id)) return;
        view.onPlayerSwing(msg.id);
      },
      onRespawn: (msg) => {
        debugReportRing.push({ dir: DebugEventDir.Recv, kind: DebugEventKind.Respawn, cell: { x: msg.x, y: msg.y, z: msg.z }, id: msg.hp });
        opts.onRespawn(msg.x, msg.y, msg.z, msg.hp);
        debug('coop', 'respawn', { x: msg.x, y: msg.y, z: msg.z, hp: msg.hp });
      },
      onInventory: (msg) => {
        inventory.clear();
        for (const item of msg.items) inventory.set(item.id, item.count);
        infinite = msg.infinite;
        opts.onInventory();
        debug('coop', 'inventory', { items: msg.items.length, infinite: msg.infinite });
      },
      onRoster: (msg) => {
        identities.clear();
        for (const p of msg.players) identities.set(p.id, { name: p.name, skin: p.skin, shirt: p.shirt, hair: p.hair, admin: p.admin, moderator: p.moderator });
        debug('coop', 'roster', { players: msg.players.length });
      },
      onError: (code, message) => {
        debugReportRing.push({ dir: DebugEventDir.Recv, kind: DebugEventKind.Error, text: code });
        debug('action', 'server error', { code, msg: message });
        opts.hud.onError(code);
      },
    },
  });
  net.connect();

  return {
    sendMove(pose, now): void {
      lastLocalPose = { x: pose.x, y: pose.y, z: pose.z };
      if (now - lastMoveSentAt < MOVE_SEND_INTERVAL_MS) return;
      lastMoveSentAt = now;
      net.sendMove(pose.x, pose.y, pose.z, pose.yaw, pose.pitch);
    },
    sendEdit(op, x, y, z, id): void {
      net.sendEdit(op, x, y, z, id);
    },
    sendEditBatch(edits): void {
      net.sendEditBatch(edits);
    },
    sendChat(text): void {
      net.sendChat(text);
    },
    sendRespawn(): void {
      net.sendRespawn();
    },
    sendDig(x, y, z): void {
      net.sendDig(x, y, z);
    },
    sendHit(id): void {
      net.sendHit(id);
    },
    // Immediate local hit feedback: the server owns hp/death, but flashing the body red the instant
    // the player connects an attack makes hitting a server creature feel responsive.
    flashCreature(id): void {
      if (!creatures.has(id)) return;
      view.onCreatureFlash(id);
    },
    sendAdminSetPeace(on): void {
      net.sendAdminSetPeace(on);
    },
    sendAdminSetStructure(kind, allowed): void {
      net.sendAdminSetStructure(kind, allowed);
    },
    sendAdminSetPvp(on): void {
      net.sendAdminSetPvp(on);
    },
    sendAdminSetChat(on): void {
      net.sendAdminSetChat(on);
    },
    sendAdminKick(id): void {
      net.sendAdminKick(id);
    },
    sendAdminReport(id): void {
      net.sendAdminReport(id);
    },
    sendAdminBan(id): void {
      net.sendAdminBan(id);
    },
    sendAttackPlayer(id): void {
      net.sendAttackPlayer(id);
    },
    sendAdminResetWorld(): void {
      net.sendAdminResetWorld();
    },
    sendAdminResetScores(): void {
      net.sendAdminResetScores();
    },
    sendAdminSuspend(on): void {
      net.sendAdminSuspend(on);
    },
    sendAdminSetRole(id, role): void {
      net.sendAdminSetRole(id, role);
    },
    sendAdminSetInfinite(on): void {
      net.sendAdminSetInfinite(on);
    },
    inventoryCount(id): number {
      const count = inventory.get(id);
      if (count === undefined) return 0;
      return count;
    },
    sendAdminSetApproval(on): void {
      net.sendAdminSetApproval(on);
    },
    sendAdminApprove(accountId): void {
      net.sendAdminApprove(accountId);
    },
    sendAdminReject(accountId): void {
      net.sendAdminReject(accountId);
    },
    sendAdminBanPending(accountId): void {
      net.sendAdminBanPending(accountId);
    },
    sendAdminUnban(ip): void {
      net.sendAdminUnban(ip);
    },
    sendAdminSetLimits(playtimeLimitMin, playtimeWindowH): void {
      net.sendAdminSetLimits(playtimeLimitMin, playtimeWindowH);
    },
    sendAdminSetModes(onlineAllowed, offlineAllowed): void {
      net.sendAdminSetModes(onlineAllowed, offlineAllowed);
    },
    update(now): void {
      for (const [id, avatar] of avatars) {
        const pose = avatar.interp.sampleAt(now);
        if (!pose) continue;
        avatar.x = pose.x;
        avatar.y = pose.y - EYE_HEIGHT;
        avatar.z = pose.z;
        view.onPlayerPose(id, avatar.x, avatar.y, avatar.z, pose.yaw);
      }
      for (const [id, creature] of creatures) {
        const pose = creature.interp.sampleAt(now);
        if (!pose) continue;
        creature.x = pose.x;
        creature.y = pose.y + creature.lift;
        creature.z = pose.z;
        view.onCreaturePose(id, creature.x, creature.y, creature.z, pose.yaw);
      }
    },
    getColliders(): ActorPos[] {
      return [...avatars.values()].map((a) => ({ x: a.x, y: a.y, z: a.z }));
    },
    getCreatures(): CoopCreature[] {
      return [...creatures.entries()].map(([id, c]) => ({
        id,
        kind: c.kind,
        x: c.x,
        y: c.y,
        z: c.z,
        radius: c.radius,
      }));
    },
    getPlayers(): CoopPlayer[] {
      return [...avatars.entries()].map(([id, a]) => ({
        id,
        x: a.x,
        y: a.y + PLAYER_HEIGHT / 2,
        z: a.z,
        radius: Math.max(PLAYER_RADIUS, PLAYER_HEIGHT / 2),
      }));
    },
    get ping(): number {
      return selfPing;
    },
    get state(): NetState {
      return net.state;
    },
    get onlineCount(): number {
      return onlineCount;
    },
    get isAdmin(): boolean {
      return admin;
    },
    get backendVersion(): string {
      return backendVersion;
    },
    get infinite(): boolean {
      return infinite;
    },
    get serverPos(): Vec3Like | null {
      return selfServerPos;
    },
    close(): void {
      for (const id of [...avatars.keys()]) removeAvatar(id);
      for (const id of [...creatures.keys()]) removeCreature(id);
      for (const id of [...heartDrops.keys()]) { view.onHeartDropDespawn(id); heartDrops.delete(id); }
      net.close();
    },
  };
}
