// Co-op glue: owns the network client and the remote-player avatars inside the running game.
// The pure interpolation math lives in engine/interpolation.ts; this module is the thin three.js /
// net.ts wiring around it. It is created only when a server URL is configured — when absent the
// game never imports a live socket and stays single-player. Local pose is throttled out as `move`;
// remote `snapshot`/`edit`/`chat` come back in through typed handlers. HUD updates are pushed to the
// React layer through the injected callbacks rather than touching the DOM here.

import type * as THREE from 'three';
import { EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_RADIUS } from './engine/constants';
import type { ActorPos } from './engine/actors';
import { RemoteInterpolator } from './engine/interpolation';
import { debug } from './log';
import { createNet, type NetClient, type NetState } from './net';
import type { EditCell, EditOp, Role } from './protocol';
import type { FeedEvent, RosterMember } from './feed';
import { creatureDefFor, creatureNameKey } from './engine/creature-snapshot';
import { t } from './i18n';

// One persistent world per tenant (see apps/server model); the world name is fixed and global.
export const MAIN_WORLD = 'main';
const MOVE_SEND_HZ = 15;
const MOVE_SEND_INTERVAL_MS = 1000 / MOVE_SEND_HZ;
const AVATAR_HEIGHT = PLAYER_HEIGHT;
const MODEL_HEIGHT = 1.8; // natural height of the humanoid before scaling to AVATAR_HEIGHT
const LABEL_LIFT = 0.5;
const LABEL_PIXEL_SCALE = 0.012;
const BUBBLE_LIFT = 0.95;
const BUBBLE_PIXEL_SCALE = 0.0125;
const BUBBLE_TTL_MS = 6000;
const PANTS = '#2f3a8c'; // dark trousers, common to every character

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
}

export interface RoomState {
  peace: boolean;
  blockedStructures: string[];
  pvp: boolean;
  chatEnabled: boolean;
  approvalRequired: boolean;
}

export interface PendingApproval {
  accountId: string;
  name: string;
  email: string;
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
  onError(code: string): void;
}

export interface CoopOptions {
  three: typeof THREE;
  scene: THREE.Scene;
  url: string;
  tenant: string;
  world: string;
  name: string;
  skin: string;
  shirt: string;
  hair: string;
  claim: string;
  hud: CoopHud;
  applyRemoteEdit(args: { x: number; y: number; z: number; id: number }): void;
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
  onRespawn(x: number, y: number, z: number, hp: number): void;
}

interface Avatar {
  name: string;
  group: THREE.Group;
  label: THREE.Sprite;
  bubble: THREE.Sprite | null;
  bubbleTimer: number;
  interp: RemoteInterpolator;
}

interface ServerCreature {
  kind: string;
  group: THREE.Group;
  body: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  radius: number;
  lift: number;
  interp: RemoteInterpolator;
}

// The server reports a creature's y as `surface_y + this` (its body center floats this far above the
// top *solid block index*). The walkable surface is one block higher (index + 1), so to sit a creature
// on the ground like the local single-player model we lift it by (1 - offset) + half its height.
const SERVER_GROUND_OFFSET = 0.5;
const CREATURE_FLASH_COLOR = 0xff3333;
const CREATURE_FLASH_MS = 120;
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
  flashCreature(id: number): void;
  sendAdminSetPeace(on: boolean): void;
  sendAdminSetStructure(kind: string, allowed: boolean): void;
  sendAdminSetPvp(on: boolean): void;
  sendAdminSetChat(on: boolean): void;
  sendAdminKick(id: number): void;
  sendAdminBan(id: number): void;
  sendAttackPlayer(id: number): void;
  sendAdminResetWorld(): void;
  sendAdminSetRole(id: number, role: Role): void;
  sendAdminSetApproval(on: boolean): void;
  sendAdminApprove(accountId: string): void;
  update(now: number): void;
  getColliders(): ActorPos[];
  getCreatures(): CoopCreature[];
  getPlayers(): CoopPlayer[];
  readonly ping: number;
  readonly state: NetState;
  readonly onlineCount: number;
  readonly isAdmin: boolean;
  close(): void;
}

export function createCoop(opts: CoopOptions): CoopController {
  const { three, scene } = opts;
  const avatars = new Map<number, Avatar>();
  const creatures = new Map<number, ServerCreature>();
  let selfId: number | null = null;
  let lastMoveSentAt = 0;
  let onlineCount = 0;
  let selfPing = 0;
  let selfScore = 0;
  let admin = false;

  function makeLabel(name: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2d canvas context unavailable');
    g.font = 'bold 34px "Baloo 2", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 6;
    g.strokeStyle = '#2a1a4a';
    g.strokeText(name, 128, 32);
    g.fillStyle = '#ffffff';
    g.fillText(name, 128, 32);
    const texture = new three.CanvasTexture(canvas);
    texture.colorSpace = three.SRGBColorSpace;
    const sprite = new three.Sprite(new three.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
    sprite.scale.set(canvas.width * LABEL_PIXEL_SCALE, canvas.height * LABEL_PIXEL_SCALE, 1);
    return sprite;
  }

  function makeFaceTexture(skinColor: string): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2d canvas context unavailable');
    g.fillStyle = skinColor;
    g.fillRect(0, 0, 32, 32);
    g.fillStyle = '#2a1a1a';
    g.fillRect(8, 12, 5, 6);
    g.fillRect(19, 12, 5, 6);
    g.fillStyle = '#b5532e';
    g.fillRect(11, 23, 10, 3);
    const texture = new three.CanvasTexture(canvas);
    texture.magFilter = three.NearestFilter;
    texture.colorSpace = three.SRGBColorSpace;
    return texture;
  }

  function box(w: number, h: number, d: number, color: string, x: number, y: number): THREE.Mesh {
    const mesh = new three.Mesh(
      new three.BoxGeometry(w, h, d),
      new three.MeshLambertMaterial({ color })
    );
    mesh.position.set(x, y, 0);
    return mesh;
  }

  // A blocky Minecraft-style character: skinned head (face on the front), colored torso, arms, legs.
  function spawnAvatar(id: number, name: string, look: Appearance): Avatar {
    const group = new three.Group();
    const model = new three.Group();
    model.add(box(0.22, 0.7, 0.24, PANTS, -0.13, 0.35));
    model.add(box(0.22, 0.7, 0.24, PANTS, 0.13, 0.35));
    model.add(box(0.5, 0.6, 0.26, look.shirt, 0, 1.0));
    model.add(box(0.18, 0.6, 0.2, look.skin, -0.34, 1.0));
    model.add(box(0.18, 0.6, 0.2, look.skin, 0.34, 1.0));
    const skin = new three.MeshLambertMaterial({ color: look.skin });
    const faceMat = new three.MeshLambertMaterial({ map: makeFaceTexture(look.skin) });
    const head = new three.Mesh(new three.BoxGeometry(0.5, 0.5, 0.5), [skin, skin, skin, skin, faceMat, skin]);
    head.position.set(0, 1.55, 0);
    model.add(head);
    const hair = box(0.54, 0.16, 0.54, look.hair, 0, 1.86); // a little cap of hair on top
    model.add(hair);
    model.scale.setScalar(AVATAR_HEIGHT / MODEL_HEIGHT);
    group.add(model);
    const label = makeLabel(name);
    label.position.y = AVATAR_HEIGHT + LABEL_LIFT;
    group.add(label);
    scene.add(group);
    const avatar: Avatar = { name, group, label, bubble: null, bubbleTimer: 0, interp: new RemoteInterpolator() };
    avatars.set(id, avatar);
    debug('coop', 'avatar spawned', { id, name });
    return avatar;
  }

  function makeBubble(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 80;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2d canvas context unavailable');
    const clipped = text.length > 22 ? `${text.slice(0, 21)}…` : text;
    g.fillStyle = 'rgba(26, 16, 48, 0.86)';
    g.beginPath();
    g.roundRect(8, 8, 240, 56, 14);
    g.fill();
    g.font = 'bold 26px "Baloo 2", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText(clipped, 128, 36);
    const texture = new three.CanvasTexture(canvas);
    texture.colorSpace = three.SRGBColorSpace;
    const sprite = new three.Sprite(new three.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
    sprite.scale.set(canvas.width * BUBBLE_PIXEL_SCALE, canvas.height * BUBBLE_PIXEL_SCALE, 1);
    sprite.position.y = AVATAR_HEIGHT + LABEL_LIFT + BUBBLE_LIFT;
    return sprite;
  }

  function disposeBubble(avatar: Avatar): void {
    if (!avatar.bubble) return;
    avatar.group.remove(avatar.bubble);
    avatar.bubble.material.map?.dispose();
    avatar.bubble.material.dispose();
    avatar.bubble = null;
  }

  // A chat message floats above the speaker's head for a few seconds (Minecraft-style).
  function showBubble(id: number, text: string): void {
    const avatar = avatars.get(id);
    if (!avatar) return;
    disposeBubble(avatar);
    window.clearTimeout(avatar.bubbleTimer);
    const bubble = makeBubble(text);
    avatar.group.add(bubble);
    avatar.bubble = bubble;
    avatar.bubbleTimer = window.setTimeout(() => disposeBubble(avatar), BUBBLE_TTL_MS);
  }

  // A rename event renames the live avatar (label + roster name) for whoever currently shows the old
  // name, so the in-game name follows the persisted change even mid-session.
  function renameAvatar(oldName: string, newName: string): void {
    for (const avatar of avatars.values()) {
      if (avatar.name !== oldName) continue;
      avatar.group.remove(avatar.label);
      avatar.label.material.map?.dispose();
      avatar.label.material.dispose();
      const label = makeLabel(newName);
      label.position.y = AVATAR_HEIGHT + LABEL_LIFT;
      avatar.group.add(label);
      avatar.label = label;
      avatar.name = newName;
    }
  }

  function removeAvatar(id: number): void {
    const avatar = avatars.get(id);
    if (!avatar) return;
    window.clearTimeout(avatar.bubbleTimer);
    disposeBubble(avatar);
    scene.remove(avatar.group);
    avatar.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const material = mesh.material;
      for (const m of Array.isArray(material) ? material : [material]) {
        if (!m) continue;
        (m as THREE.MeshLambertMaterial).map?.dispose();
        m.dispose();
      }
    });
    avatars.delete(id);
    debug('coop', 'avatar removed', { id });
  }

  // A creature wears the same blocky face as the local single-player model: a flat-colored cube with
  // two eyes and a mouth drawn on, sized by its definition. The server owns motion/hp/death; here we
  // only render the latest snapshot, interpolated like a remote player.
  function makeCreatureFace(color: string): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2d canvas context unavailable');
    g.fillStyle = color;
    g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#1a1330';
    g.fillRect(4, 6, 2, 3);
    g.fillRect(10, 6, 2, 3);
    g.fillRect(6, 11, 4, 1);
    const texture = new three.CanvasTexture(canvas);
    texture.magFilter = three.NearestFilter;
    texture.colorSpace = three.SRGBColorSpace;
    return texture;
  }

  function spawnCreature(id: number, kind: string): ServerCreature {
    const def = creatureDefFor(kind);
    const group = new three.Group();
    const body = new three.Mesh(
      new three.BoxGeometry(...def.size),
      new three.MeshLambertMaterial({ map: makeCreatureFace(def.color) })
    );
    group.add(body);
    scene.add(group);
    const lift = 1 - SERVER_GROUND_OFFSET + def.size[1] / 2;
    const creature: ServerCreature = { kind, group, body, radius: Math.max(...def.size) * 0.7, lift, interp: new RemoteInterpolator() };
    creatures.set(id, creature);
    debug('coop', 'creature spawned', { id, kind });
    return creature;
  }

  function removeCreature(id: number): void {
    const creature = creatures.get(id);
    if (!creature) return;
    scene.remove(creature.group);
    creature.body.geometry.dispose();
    creature.body.material.map?.dispose();
    creature.body.material.dispose();
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
            opts.onHealth(p.hp);
            continue;
          }
          seen.add(p.id);
          if (avatars.has(p.id)) {
            avatars.get(p.id)!.interp.push({ t: performance.now(), x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch });
            continue;
          }
          const avatar = spawnAvatar(p.id, p.name, { skin: p.skin, shirt: p.shirt, hair: p.hair });
          avatar.interp.push({ t: performance.now(), x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch });
          opts.hud.onEvent({ kind: 'join', name: p.name });
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
          const at = gone.group.position;
          opts.onCreaturePoof({ x: at.x, y: at.y, z: at.z, color: creatureDefFor(gone.kind).color });
          removeCreature(id);
        }
        onlineCount = msg.players.length;
        opts.hud.onCount(onlineCount);
        opts.hud.onRoster(msg.players.map((p) => ({ id: p.id, name: p.name, self: p.id === selfId })));
        opts.hud.onPing(selfPing);
        opts.hud.onScore(selfScore);
      },
      onEdit: (msg) => opts.applyRemoteEdit({ x: msg.x, y: msg.y, z: msg.z, id: msg.id }),
      onEditBatch: (msg) => opts.applyRemoteEditBatch(msg.edits),
      onChat: (msg) => {
        showBubble(msg.from, msg.text);
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
          approvalRequired: msg.approval_required,
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
          cr.body.material.emissive.setHex(CREATURE_FLASH_COLOR);
          window.setTimeout(() => {
            const still = creatures.get(msg.id);
            if (still) still.body.material.emissive.setHex(0x000000);
          }, CREATURE_FLASH_MS);
          const at = cr.group.position;
          opts.onCreaturePoof({ x: at.x, y: at.y, z: at.z, color: creatureDefFor(cr.kind).color });
          return;
        }
        const avatar = avatars.get(msg.id);
        if (!avatar) return;
        const at = avatar.group.position;
        opts.onCreaturePoof({ x: at.x, y: at.y + PLAYER_HEIGHT / 2, z: at.z, color: PLAYER_HIT_COLOR });
      },
      onRespawn: (msg) => {
        opts.onRespawn(msg.x, msg.y, msg.z, msg.hp);
        debug('coop', 'respawn', { x: msg.x, y: msg.y, z: msg.z, hp: msg.hp });
      },
      onError: (code, message) => {
        debug('coop', 'server error', { code, msg: message });
        opts.hud.onError(code);
      },
    },
  });
  net.connect();

  return {
    sendMove(pose, now): void {
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
    sendHit(id): void {
      net.sendHit(id);
    },
    // Immediate local hit feedback: the server owns hp/death, but flashing the body red the instant
    // the player connects an attack makes hitting a server creature feel responsive.
    flashCreature(id): void {
      const creature = creatures.get(id);
      if (!creature) return;
      creature.body.material.emissive.setHex(CREATURE_FLASH_COLOR);
      window.setTimeout(() => {
        const still = creatures.get(id);
        if (still) still.body.material.emissive.setHex(0x000000);
      }, CREATURE_FLASH_MS);
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
    sendAdminBan(id): void {
      net.sendAdminBan(id);
    },
    sendAttackPlayer(id): void {
      net.sendAttackPlayer(id);
    },
    sendAdminResetWorld(): void {
      net.sendAdminResetWorld();
    },
    sendAdminSetRole(id, role): void {
      net.sendAdminSetRole(id, role);
    },
    sendAdminSetApproval(on): void {
      net.sendAdminSetApproval(on);
    },
    sendAdminApprove(accountId): void {
      net.sendAdminApprove(accountId);
    },
    update(now): void {
      for (const avatar of avatars.values()) {
        const pose = avatar.interp.sampleAt(now);
        if (!pose) continue;
        avatar.group.position.set(pose.x, pose.y - EYE_HEIGHT, pose.z);
        avatar.group.rotation.y = pose.yaw;
      }
      for (const creature of creatures.values()) {
        const pose = creature.interp.sampleAt(now);
        if (!pose) continue;
        creature.group.position.set(pose.x, pose.y + creature.lift, pose.z);
        creature.group.rotation.y = pose.yaw;
      }
    },
    getColliders(): ActorPos[] {
      return [...avatars.values()].map((a) => ({
        x: a.group.position.x,
        y: a.group.position.y,
        z: a.group.position.z,
      }));
    },
    getCreatures(): CoopCreature[] {
      return [...creatures.entries()].map(([id, c]) => ({
        id,
        kind: c.kind,
        x: c.group.position.x,
        y: c.group.position.y,
        z: c.group.position.z,
        radius: c.radius,
      }));
    },
    getPlayers(): CoopPlayer[] {
      return [...avatars.entries()].map(([id, a]) => ({
        id,
        x: a.group.position.x,
        y: a.group.position.y + PLAYER_HEIGHT / 2,
        z: a.group.position.z,
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
    close(): void {
      for (const id of [...avatars.keys()]) removeAvatar(id);
      for (const id of [...creatures.keys()]) removeCreature(id);
      net.close();
    },
  };
}
