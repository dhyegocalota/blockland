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
  skin: string;
  shirt: string;
  hair: string;
  hud: CoopHud;
  applyRemoteEdit(args: { x: number; y: number; z: number; id: number }): void;
  applyRemoteEditBatch(edits: EditCell[]): void;
}

interface Avatar {
  group: THREE.Group;
  label: THREE.Sprite;
  bubble: THREE.Sprite | null;
  bubbleTimer: number;
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
    const avatar: Avatar = { group, label, bubble: null, bubbleTimer: 0, interp: new RemoteInterpolator() };
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

  const net: NetClient = createNet({
    url: opts.url,
    tenant: opts.tenant,
    world: opts.world,
    name: opts.name,
    skin: opts.skin,
    shirt: opts.shirt,
    hair: opts.hair,
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
          const avatar = avatars.get(p.id) ?? spawnAvatar(p.id, p.name, { skin: p.skin, shirt: p.shirt, hair: p.hair });
          avatar.interp.push({ t: performance.now(), x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch });
        }
        for (const id of [...avatars.keys()]) if (!seen.has(id)) removeAvatar(id);
        onlineCount = msg.players.length;
        opts.hud.onCount(onlineCount);
        opts.hud.onPing(selfPing);
      },
      onEdit: (msg) => opts.applyRemoteEdit({ x: msg.x, y: msg.y, z: msg.z, id: msg.id }),
      onEditBatch: (msg) => opts.applyRemoteEditBatch(msg.edits),
      onChat: (msg) => {
        showBubble(msg.from, msg.text);
        opts.hud.onChat(msg.name, msg.text);
      },
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
