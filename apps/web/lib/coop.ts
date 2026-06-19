// Co-op glue: owns the network client and the remote-player avatars inside the running game.
// The pure interpolation math lives in engine/interpolation.ts; this module is the thin three.js /
// net.ts wiring around it. It is created only when a server URL is configured — when absent the
// game never imports a live socket and stays single-player. Local pose is throttled out as `move`;
// remote `snapshot`/`edit`/`chat` come back in through typed handlers. HUD updates are pushed to the
// React layer through the injected callbacks rather than touching the DOM here.

import type * as THREE from 'three';
import { EYE_HEIGHT, PLAYER_HEIGHT } from './engine/constants';
import type { ActorPos } from './engine/actors';
import { RemoteInterpolator } from './engine/interpolation';
import { debug } from './log';
import { createNet, type NetClient, type NetState } from './net';
import type { EditCell, EditOp } from './protocol';

// One persistent world per tenant (see apps/server model); the world name is fixed and global.
export const MAIN_WORLD = 'main';
const MOVE_SEND_HZ = 15;
const MOVE_SEND_INTERVAL_MS = 1000 / MOVE_SEND_HZ;
const AVATAR_WIDTH = 0.6;
const AVATAR_HEIGHT = PLAYER_HEIGHT;
const LABEL_LIFT = 0.45;
const LABEL_PIXEL_SCALE = 0.012;

const AVATAR_COLORS = [
  '#ff5d2e', '#3dc6ff', '#6bd06b', '#ffd23f', '#b06bff', '#ff8ad0', '#ff8a3d', '#3fae9a',
];

export interface LocalPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface CoopHud {
  onState(state: NetState): void;
  onPing(ping: number): void;
  onChat(name: string, text: string): void;
  onCount(online: number): void;
}

export interface CoopOptions {
  three: typeof THREE;
  scene: THREE.Scene;
  url: string;
  tenant: string;
  world: string;
  name: string;
  hud: CoopHud;
  applyRemoteEdit(args: { x: number; y: number; z: number; id: number }): void;
  applyRemoteEditBatch(edits: EditCell[]): void;
}

interface Avatar {
  group: THREE.Group;
  label: THREE.Sprite;
  interp: RemoteInterpolator;
}

export interface CoopController {
  sendMove(pose: LocalPose, now: number): void;
  sendEdit(op: EditOp, x: number, y: number, z: number, id: number): void;
  sendEditBatch(edits: EditCell[]): void;
  sendChat(text: string): void;
  update(now: number): void;
  getColliders(): ActorPos[];
  readonly ping: number;
  readonly state: NetState;
  readonly onlineCount: number;
  close(): void;
}

export function createCoop(opts: CoopOptions): CoopController {
  const { three, scene } = opts;
  const avatars = new Map<number, Avatar>();
  let selfId: number | null = null;
  let lastMoveSentAt = 0;
  let onlineCount = 0;
  let selfPing = 0;

  function colorFor(id: number): string {
    return AVATAR_COLORS[id % AVATAR_COLORS.length];
  }

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

  function spawnAvatar(id: number, name: string): Avatar {
    const group = new three.Group();
    const body = new three.Mesh(
      new three.BoxGeometry(AVATAR_WIDTH, AVATAR_HEIGHT, AVATAR_WIDTH),
      new three.MeshLambertMaterial({ color: colorFor(id) })
    );
    body.position.y = AVATAR_HEIGHT / 2;
    group.add(body);
    const label = makeLabel(name);
    label.position.y = AVATAR_HEIGHT + LABEL_LIFT;
    group.add(label);
    scene.add(group);
    const avatar: Avatar = { group, label, interp: new RemoteInterpolator() };
    avatars.set(id, avatar);
    debug('coop', 'avatar spawned', { id, name });
    return avatar;
  }

  function removeAvatar(id: number): void {
    const avatar = avatars.get(id);
    if (!avatar) return;
    scene.remove(avatar.group);
    avatar.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
    });
    const labelMaterial = avatar.label.material;
    labelMaterial.map?.dispose();
    labelMaterial.dispose();
    avatars.delete(id);
    debug('coop', 'avatar removed', { id });
  }

  const net: NetClient = createNet({
    url: opts.url,
    tenant: opts.tenant,
    world: opts.world,
    name: opts.name,
    handlers: {
      onState: (state) => opts.hud.onState(state),
      onWelcome: (msg) => {
        selfId = msg.you;
        debug('coop', 'welcome', { you: msg.you, world: msg.world });
      },
      onSnapshot: (msg) => {
        const seen = new Set<number>();
        for (const p of msg.players) {
          if (p.id === selfId) {
            selfPing = p.ping_ms;
            continue;
          }
          seen.add(p.id);
          const avatar = avatars.get(p.id) ?? spawnAvatar(p.id, p.name);
          avatar.interp.push({ t: performance.now(), x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch });
        }
        for (const id of [...avatars.keys()]) if (!seen.has(id)) removeAvatar(id);
        onlineCount = msg.players.length;
        opts.hud.onCount(onlineCount);
        opts.hud.onPing(selfPing);
      },
      onEdit: (msg) => opts.applyRemoteEdit({ x: msg.x, y: msg.y, z: msg.z, id: msg.id }),
      onEditBatch: (msg) => opts.applyRemoteEditBatch(msg.edits),
      onChat: (msg) => opts.hud.onChat(msg.name, msg.text),
      onError: (code, message) => debug('coop', 'server error', { code, msg: message }),
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
    update(now): void {
      for (const avatar of avatars.values()) {
        const pose = avatar.interp.sampleAt(now);
        if (!pose) continue;
        avatar.group.position.set(pose.x, pose.y - EYE_HEIGHT, pose.z);
        avatar.group.rotation.y = pose.yaw;
      }
    },
    getColliders(): ActorPos[] {
      return [...avatars.values()].map((a) => ({
        x: a.group.position.x,
        y: a.group.position.y,
        z: a.group.position.z,
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
    close(): void {
      for (const id of [...avatars.keys()]) removeAvatar(id);
      net.close();
    },
  };
}
