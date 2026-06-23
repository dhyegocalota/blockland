// The three.js bodies of the co-op remote players and server creatures, dependency-inverted off the
// data-only CoopView contract. This is the ONLY place co-op touches three.js: lib/coop.ts owns the
// network protocol + interpolation and drives rendering exclusively through these hooks, handing over
// plain data (ids, names, colors, coords, text), so it stays three.js-free. The mesh builders
// (labels, chat bubbles, the blocky avatar, the creature face) and the per-entity Group/Sprite/Mesh
// lifecycle moved here verbatim from coop.ts.
import * as THREE from 'three';
import type { Appearance, CoopView } from '../../coop';
import { SWING_DURATION_MS, SWING_PEAK_RAD } from '../constants';
import { swingPose } from '../swing';
import type { CreatureDef } from '../online/creature-snapshot';
import type { GfxScene } from './gfx';
import type { HeartDropRuntime } from './heart-drop-runtime';

const AVATAR_HEIGHT = 1.7;
const MODEL_HEIGHT = 1.8; // natural height of the humanoid before scaling to AVATAR_HEIGHT
const LABEL_LIFT = 0.5;
const LABEL_PIXEL_SCALE = 0.012;
const BUBBLE_LIFT = 0.95;
const BUBBLE_PIXEL_SCALE = 0.0125;
const BUBBLE_TTL_MS = 6000;
const PANTS = '#2f3a8c'; // dark trousers, common to every character
const CREATURE_FLASH_COLOR = 0xff3333;
const CREATURE_FLASH_MS = 120;

interface AvatarMesh {
  group: THREE.Group;
  label: THREE.Sprite;
  bubble: THREE.Sprite | null;
  bubbleTimer: number;
  // The right-arm pivot (at the shoulder) and the timestamp of the last attack swing, so the arm swings
  // forward then eases back on every primary action this player performs (mirrors the first-person swing).
  armPivot: THREE.Group;
  swingStart: number;
}

interface CreatureMesh {
  group: THREE.Group;
  body: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
}

export function createCoopView({ scene, heartDropRuntime }: { scene: GfxScene; heartDropRuntime: HeartDropRuntime }): CoopView {
  const avatars = new Map<number, AvatarMesh>();
  const creatures = new Map<number, CreatureMesh>();

  function makeLabel(name: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2d canvas context unavailable');
    g.font = 'bold 34px "Comic Sans MS", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 6;
    g.strokeStyle = '#2a1a4a';
    g.strokeText(name, 128, 32);
    g.fillStyle = '#ffffff';
    g.fillText(name, 128, 32);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
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
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  function box(w: number, h: number, d: number, color: string, x: number, y: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color })
    );
    mesh.position.set(x, y, 0);
    return mesh;
  }

  // A blocky voxel character: skinned head (face on the front), colored torso, arms, legs.
  function spawnAvatar(id: number, name: string, look: Appearance): void {
    const group = new THREE.Group();
    const model = new THREE.Group();
    model.add(box(0.22, 0.7, 0.24, PANTS, -0.13, 0.35));
    model.add(box(0.22, 0.7, 0.24, PANTS, 0.13, 0.35));
    model.add(box(0.5, 0.6, 0.26, look.shirt, 0, 1.0));
    model.add(box(0.18, 0.6, 0.2, look.skin, -0.34, 1.0));
    // The right arm hangs off a shoulder pivot so a swing rotates it forward; the arm box sits below the
    // pivot, its top at the shoulder, matching the static left arm's placement at rest.
    const armPivot = new THREE.Group();
    armPivot.name = 'armPivot';
    armPivot.position.set(0.34, 1.3, 0);
    const rightArm = box(0.18, 0.6, 0.2, look.skin, 0, -0.3);
    armPivot.add(rightArm);
    model.add(armPivot);
    const skin = new THREE.MeshLambertMaterial({ color: look.skin });
    const faceMat = new THREE.MeshLambertMaterial({ map: makeFaceTexture(look.skin) });
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), [skin, skin, skin, skin, faceMat, skin]);
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
    avatars.set(id, { group, label, bubble: null, bubbleTimer: 0, armPivot, swingStart: -Infinity });
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
    g.font = 'bold 26px "Comic Sans MS", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText(clipped, 128, 36);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
    sprite.scale.set(canvas.width * BUBBLE_PIXEL_SCALE, canvas.height * BUBBLE_PIXEL_SCALE, 1);
    sprite.position.y = AVATAR_HEIGHT + LABEL_LIFT + BUBBLE_LIFT;
    return sprite;
  }

  function disposeBubble(avatar: AvatarMesh): void {
    if (!avatar.bubble) return;
    avatar.group.remove(avatar.bubble);
    avatar.bubble.material.map?.dispose();
    avatar.bubble.material.dispose();
    avatar.bubble = null;
  }

  // A chat message floats above the speaker's head for a few seconds.
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

  // A rename event renames the live avatar's label for the matching id, so the in-game name follows the
  // persisted change even mid-session.
  function renameAvatar(id: number, newName: string): void {
    const avatar = avatars.get(id);
    if (!avatar) return;
    avatar.group.remove(avatar.label);
    avatar.label.material.map?.dispose();
    avatar.label.material.dispose();
    const label = makeLabel(newName);
    label.position.y = AVATAR_HEIGHT + LABEL_LIFT;
    avatar.group.add(label);
    avatar.label = label;
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
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  function spawnCreature(id: number, def: CreatureDef): void {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(...def.size),
      new THREE.MeshLambertMaterial({ map: makeCreatureFace(def.color) })
    );
    group.add(body);
    scene.add(group);
    creatures.set(id, { group, body });
  }

  function removeCreature(id: number): void {
    const creature = creatures.get(id);
    if (!creature) return;
    scene.remove(creature.group);
    creature.body.geometry.dispose();
    creature.body.material.map?.dispose();
    creature.body.material.dispose();
    creatures.delete(id);
  }

  function flashCreature(id: number): void {
    const creature = creatures.get(id);
    if (!creature) return;
    creature.body.material.emissive.setHex(CREATURE_FLASH_COLOR);
    window.setTimeout(() => {
      const still = creatures.get(id);
      if (still) still.body.material.emissive.setHex(0x000000);
    }, CREATURE_FLASH_MS);
  }

  return {
    onPlayerJoin: (id, name, look) => spawnAvatar(id, name, look),
    onPlayerPose: (id, x, y, z, yaw) => {
      const avatar = avatars.get(id);
      if (!avatar) return;
      avatar.group.position.set(x, y, z);
      avatar.group.rotation.y = yaw;
      avatar.armPivot.rotation.x = swingPose({ tSinceStart: performance.now() - avatar.swingStart, durationMs: SWING_DURATION_MS, peakRad: SWING_PEAK_RAD });
    },
    onPlayerSwing: (id) => {
      const avatar = avatars.get(id);
      if (!avatar) return;
      avatar.swingStart = performance.now();
    },
    onPlayerChat: (id, text) => showBubble(id, text),
    onPlayerRename: (id, name) => renameAvatar(id, name),
    onPlayerLeave: (id) => removeAvatar(id),
    onCreatureSpawn: (id, def) => spawnCreature(id, def),
    onCreaturePose: (id, x, y, z, yaw) => {
      const creature = creatures.get(id);
      if (!creature) return;
      creature.group.position.set(x, y, z);
      creature.group.rotation.y = yaw;
    },
    onCreatureFlash: (id) => flashCreature(id),
    onCreatureDespawn: (id) => removeCreature(id),
    onHeartDropSpawn: (id, x, y, z) => heartDropRuntime.spawn({ id, x, y, z }),
    onHeartDropMove: (id, x, y, z) => heartDropRuntime.move({ id, x, y, z }),
    onHeartDropDespawn: (id) => heartDropRuntime.remove(id),
  };
}
