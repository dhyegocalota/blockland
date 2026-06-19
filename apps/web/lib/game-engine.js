import * as THREE from 'three';
import { PLATFORM_NAME } from './tenants';

export function initGame(brand) {
  if (typeof window === 'undefined') return undefined;
  if (window.__blGameBooted) return window.__blGameCleanup;
  window.__blGameBooted = true;
  const FACE_URL = brand.faceTexture;
  const BEST_KEY = `bl-best-${brand.id}`;
  if (typeof document !== 'undefined') document.title = `${brand.name} — ${PLATFORM_NAME}`;

  const abort = new AbortController();
  const signal = abort.signal;
  let disposed = false;
  let rafId = 0;
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  // ---------- World constants ----------
  const SIZE_X = 16384;
  const SIZE_Z = 16384;
  const SIZE_Y = 24;
  const CHUNK = 32;
  const chunksX = Math.ceil(SIZE_X / CHUNK);
  const chunksZ = Math.ceil(SIZE_Z / CHUNK);
  const GROUND = 6;
  const GRAVITY = -26;
  const JUMP_SPEED = 8.6;
  const WALK_SPEED = 5.4;
  const FLY_SPEED = 9;
  const PLAYER_RADIUS = 0.3;
  const PLAYER_HEIGHT = 1.7;
  const EYE_HEIGHT = 1.55;
  const REACH = 7;

  // ---------- Block definitions ----------
  const AIR = 0;
  const BLOCKS = [
    null,
    { id: 1, name: 'Grama', key: '1', build: (c) => paint(c, '#6bd06b', '#4fb04f', '#86e886') },
    { id: 2, name: 'Terra', key: '2', build: (c) => paint(c, '#9c6b43', '#7d5232', '#b3825a') },
    { id: 3, name: 'Pedra', key: '3', build: (c) => paint(c, '#9b9ba3', '#7d7d85', '#b6b6bd') },
    { id: 4, name: 'Madeira', key: '4', build: woodTexture },
    { id: 5, name: 'Folha', key: '5', build: (c) => paint(c, '#54c25a', '#3c9c42', '#74e07a') },
    { id: 6, name: 'Areia', key: '6', build: (c) => paint(c, '#f0dca0', '#dcc585', '#fbeec0') },
    { id: 7, name: 'Tijolo', key: '7', build: brickTexture },
    { id: 8, name: 'Ouro', key: '8', build: goldTexture },
    { id: 9, name: 'Arco-íris', key: '9', build: rainbowTexture },
    { id: 10, name: brand.faceBlockName, key: '0', build: null },
    { id: 11, name: 'Água', key: '-', transparent: true, build: (c) => paint(c, '#3aa0ee', '#2f8fdc', '#5cb6f5') },
    { id: 12, name: 'Branco', key: 'c', build: (c) => paint(c, '#f4f4f8', '#dfe2ea', '#ffffff') },
    { id: 13, name: 'Preto', key: 'x', build: (c) => paint(c, '#2b2b33', '#16161c', '#3a3a44') },
    { id: 14, name: 'Diamante', key: 'z', build: diamondTexture },
    { id: 15, name: 'Avaritia', key: 'i', build: avaritiaTexture },
    { id: 16, name: 'Bedrock', key: 'k', build: (c) => paint(c, '#565659', '#36363a', '#79797e') },
    { id: 17, name: 'Celeste', key: 'l', build: (c) => paint(c, '#75aadb', '#5f97cc', '#9cc6ea') },
    { id: 18, name: 'Vermelho', key: 'r', build: (c) => paint(c, '#e0241f', '#bf1c18', '#f1564f') },
    { id: 19, name: 'Azul', key: 'j', build: (c) => paint(c, '#33449c', '#27357d', '#4a5cc0') },
  ];
  const BEDROCK_ID = 16;
  const CELESTE_ID = 17;
  const RED_ID = 18;
  const BLUE_ID = 19;
  const SKIN_ID = 6;
  const HAIR_ID = 2;
  const CYAN_ID = 14;
  const FACE_ID = 10;
  const WATER_ID = 11;
  const GRASS_ID = 1;
  const GOLD_ID = 8;
  const WHITE_ID = 12;
  const BLACK_ID = 13;
  const blockById = (id) => BLOCKS[id];

  // ---------- Procedural texture helpers ----------
  function makeCanvas() {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    return c;
  }
  function paint(c, base, dark, light) {
    const g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, 16, 16);
    for (let i = 0; i < 46; i++) {
      const x = Math.floor(Math.random() * 16);
      const y = Math.floor(Math.random() * 16);
      g.fillStyle = Math.random() > 0.5 ? dark : light;
      g.fillRect(x, y, 1, 1);
    }
  }
  function woodTexture(c) {
    const g = c.getContext('2d');
    g.fillStyle = '#9c6b3f'; g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#7a4f2b';
    for (let x = 1; x < 16; x += 4) g.fillRect(x, 0, 2, 16);
    g.fillStyle = '#b3855a';
    for (let x = 3; x < 16; x += 4) g.fillRect(x, 0, 1, 16);
  }
  function brickTexture(c) {
    const g = c.getContext('2d');
    g.fillStyle = '#c0563f'; g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#e8e0d0';
    g.fillRect(0, 7, 16, 1); g.fillRect(0, 15, 16, 1);
    g.fillRect(7, 0, 1, 8); g.fillRect(0, 8, 1, 8); g.fillRect(15, 8, 1, 8);
  }
  function goldTexture(c) {
    const g = c.getContext('2d');
    g.fillStyle = '#ffd23f'; g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#ffe98a';
    for (let i = 0; i < 22; i++) g.fillRect(Math.floor(Math.random() * 16), Math.floor(Math.random() * 16), 2, 2);
    g.fillStyle = '#caa018';
    g.fillRect(2, 2, 2, 2); g.fillRect(11, 9, 2, 2); g.fillRect(7, 12, 2, 2);
  }
  function rainbowTexture(c) {
    const g = c.getContext('2d');
    const colors = ['#ff5d5d', '#ffae3d', '#ffe93d', '#5dff7a', '#3dc6ff', '#9b6bff'];
    colors.forEach((col, i) => { g.fillStyle = col; g.fillRect(0, i * 3 - 1, 16, 3); });
  }
  function diamondTexture(c) {
    const g = c.getContext('2d');
    g.fillStyle = '#54cfd6'; g.fillRect(0, 0, 16, 16);                       // aqua base
    g.fillStyle = '#8fe9ee'; g.fillRect(0, 0, 16, 1); g.fillRect(0, 0, 1, 16); // bevel highlight
    g.fillStyle = '#2f9aa6'; g.fillRect(0, 15, 16, 1); g.fillRect(15, 0, 1, 16); // bevel shadow
    g.fillStyle = '#3fb3bd'; g.fillRect(2, 2, 12, 12);                       // inset face
    const gem = (x, y) => {
      g.fillStyle = '#2b8a96'; g.fillRect(x, y, 4, 4);                       // facet edge
      g.fillStyle = '#aef2f6'; g.fillRect(x + 1, y, 2, 1); g.fillRect(x, y + 1, 1, 2);
      g.fillStyle = '#1f6f7a'; g.fillRect(x + 3, y + 2, 1, 2); g.fillRect(x + 2, y + 3, 2, 1);
      g.fillStyle = '#ffffff'; g.fillRect(x + 1, y + 1, 1, 1);               // sparkle
    };
    gem(3, 3); gem(9, 3); gem(3, 9); gem(9, 9);
    g.fillStyle = '#eafeff'; g.fillRect(7, 7, 2, 2);                         // center shine
  }
  function avaritiaTexture(c) {
    const g = c.getContext('2d');
    for (let y = 0; y < 16; y++) {                                          // deep cosmic gradient
      const t = y / 15;
      g.fillStyle = `rgb(${18 + (t * 26) | 0}, ${5 + (t * 6) | 0}, ${38 + (t * 34) | 0})`;
      g.fillRect(0, y, 16, 1);
    }
    const nebula = ['#ff2e7e', '#ff9b3d', '#ffe23f', '#46ff86', '#3dc6ff', '#9b6bff'];
    g.globalAlpha = 0.45;
    nebula.forEach((col, i) => { g.fillStyle = col; g.fillRect(0, (i * 3 + (i % 2)) % 16, 16, 2); });
    g.globalAlpha = 1;
    for (let i = 0; i < 30; i++) {                                          // stars
      g.fillStyle = Math.random() > 0.35 ? '#ffffff' : '#bfe4ff';
      const s = Math.random() > 0.85 ? 2 : 1;
      g.fillRect(Math.floor(Math.random() * 16), Math.floor(Math.random() * 16), s, s);
    }
  }
  function textureFromCanvas(c) {
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ---------- Materials ----------
  const materials = {};
  function buildMaterials(faceTexture) {
    for (const b of BLOCKS) {
      if (!b) continue;
      let tex;
      if (b.id === FACE_ID) tex = faceTexture;
      else { const c = makeCanvas(); b.build(c); tex = textureFromCanvas(c); }
      materials[b.id] = new THREE.MeshLambertMaterial({
        map: tex,
        transparent: !!b.transparent,
        opacity: b.transparent ? 0.78 : 1,
        side: b.transparent ? THREE.DoubleSide : THREE.FrontSide,
      });
    }
  }

  // ---------- Voxel storage (sparse: only visited chunks use memory -> endless world) ----------
  const CHUNK_VOLUME = CHUNK * CHUNK * SIZE_Y;
  const chunkData = new Map();
  const genChunks = new Set();
  const chunkKey = (cx, cz) => cx * chunksZ + cz;
  const inBounds = (x, y, z) => x >= 0 && x < SIZE_X && y >= 0 && y < SIZE_Y && z >= 0 && z < SIZE_Z;
  const localIdx = (lx, y, lz) => lx + lz * CHUNK + y * CHUNK * CHUNK;
  function rawGet(x, y, z) {
    if (!inBounds(x, y, z)) return AIR;
    const arr = chunkData.get(chunkKey(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
    if (!arr) return AIR;
    return arr[localIdx(x % CHUNK, y, z % CHUNK)];
  }
  function rawSet(x, y, z, id) {
    if (!inBounds(x, y, z)) return;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const key = chunkKey(cx, cz);
    let arr = chunkData.get(key);
    if (!arr) { arr = new Uint8Array(CHUNK_VOLUME); chunkData.set(key, arr); }
    arr[localIdx(x % CHUNK, y, z % CHUNK)] = id;
  }

  const WATER_LEVEL = GROUND - 1;
  function ensureGen(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= chunksX || cz >= chunksZ) return;
    const key = chunkKey(cx, cz);
    if (genChunks.has(key)) return;
    genChunks.add(key);
    generateChunk(cx, cz);
  }
  function getVoxel(x, y, z) {
    if (y < 0 || y >= SIZE_Y || x < 0 || x >= SIZE_X || z < 0 || z >= SIZE_Z) return AIR;
    ensureGen(Math.floor(x / CHUNK), Math.floor(z / CHUNK));
    return rawGet(x, y, z);
  }
  function setVoxel(x, y, z, id) {
    if (!inBounds(x, y, z)) return;
    ensureGen(Math.floor(x / CHUNK), Math.floor(z / CHUNK));
    rawSet(x, y, z, id);
  }
  const isSolid = (x, y, z) => { const v = getVoxel(x, y, z); return v !== AIR && v !== WATER_ID; };

  // ---------- Procedural world (biomes + varied terrain) ----------
  function heightAt(x, z) {
    const h = Math.sin(x * 0.05) * 1.4 + Math.cos(z * 0.045) * 1.4
      + Math.sin((x + z) * 0.02) * 2.6
      + Math.sin(x * 0.013) * Math.cos(z * 0.017) * 4.2;
    return Math.max(2, Math.min(SIZE_Y - 5, GROUND + Math.round(h)));
  }
  function biomeAt(x, z) {
    const v = Math.sin(x * 0.0125) * 1.2 + Math.cos(z * 0.011) * 1.2 + Math.sin((x - z) * 0.006) * 1.4;
    if (v < -1.1) return 'desert';
    if (v < 0.2) return 'plains';
    if (v < 1.3) return 'forest';
    return 'snow';
  }
  function surfaceBlock(biome, top) {
    if (top <= WATER_LEVEL + 1) return 6;                       // sandy shore
    if (top >= GROUND + 7) return top >= GROUND + 9 ? 12 : 3;   // mountain rock + snowy peak
    if (biome === 'desert') return 6;
    if (biome === 'snow') return 12;
    return 1;
  }
  function placeTree(x, top, z, x0, z0, biome) {
    const trunk = 3 + Math.floor(Math.random() * 3);
    for (let t = 1; t <= trunk; t++) rawSet(x, top + t, z, 4);
    const leaf = biome === 'snow' ? 12 : 5;
    const cy = top + trunk;
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++)
        for (let dy = 0; dy <= 2; dy++) {
          const lx = x + dx, lz = z + dz;
          if (lx < x0 || lx >= x0 + CHUNK || lz < z0 || lz >= z0 + CHUNK) continue;
          if (Math.abs(dx) + Math.abs(dz) + dy > 3) continue;
          if (rawGet(lx, cy + dy, lz) === AIR) rawSet(lx, cy + dy, lz, leaf);
        }
  }
  function generateChunk(cx, cz) {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    for (let x = x0; x < x0 + CHUNK && x < SIZE_X; x++)
      for (let z = z0; z < z0 + CHUNK && z < SIZE_Z; z++) {
        const top = heightAt(x, z);
        const biome = biomeAt(x, z);
        for (let y = 0; y <= top; y++) {
          let id = 3;
          if (y >= top - 2) id = 2;
          if (y === top) id = surfaceBlock(biome, top);
          if (y === 0) id = BEDROCK_ID;
          rawSet(x, y, z, id);
        }
        for (let y = top + 1; y <= WATER_LEVEL; y++) rawSet(x, y, z, WATER_ID);
      }
    decorateChunk(cx, cz);
  }
  function decorateChunk(cx, cz) {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    for (let i = 0; i < 30; i++) {
      const x = x0 + 2 + Math.floor(Math.random() * (CHUNK - 4));
      const z = z0 + 2 + Math.floor(Math.random() * (CHUNK - 4));
      const top = heightAt(x, z);
      if (top <= WATER_LEVEL) continue;
      const biome = biomeAt(x, z);
      const density = biome === 'forest' ? 0.75 : biome === 'plains' ? 0.22 : biome === 'snow' ? 0.16 : 0.02;
      if (Math.random() < density) { placeTree(x, top, z, x0, z0, biome); continue; }
      if (biome !== 'desert' && Math.random() < 0.1 && rawGet(x, top + 1, z) === AIR) rawSet(x, top + 1, z, 9);
    }
    for (const [chance, id] of [[0.5, 8], [0.28, 14], [0.08, 15]]) {
      if (Math.random() >= chance) continue;
      const x = x0 + Math.floor(Math.random() * CHUNK);
      const z = z0 + Math.floor(Math.random() * CHUNK);
      const top = heightAt(x, z);
      if (top > WATER_LEVEL && rawGet(x, top + 1, z) === AIR) rawSet(x, top + 1, z, id);
    }
  }
  function buildWelcomeMonument() {
    const cx = SIZE_X >> 1, cz = SIZE_Z >> 1;
    const top = heightAt(cx, cz);
    setVoxel(cx, top + 1, cz, FACE_ID);
    setVoxel(cx, top + 2, cz, FACE_ID);
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) setVoxel(cx + dx, top + 1, cz + dz, 8);
  }

  // ---------- Meshing (face-culled, merged per block type) ----------
  const FACES = [
    { dir: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { dir: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
    { dir: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
    { dir: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { dir: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
    { dir: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
  ];
  const UV = [[0, 0], [0, 1], [1, 1], [1, 0]];

  const worldGroup = new THREE.Group();
  const chunkMeshes = new Map();
  function meshChunk(cxh, czh) {
    const key = `${cxh},${czh}`;
    const old = chunkMeshes.get(key);
    if (old) old.forEach((m) => { worldGroup.remove(m); m.geometry.dispose(); });
    const buckets = {};
    for (const b of BLOCKS) { if (b) buckets[b.id] = { pos: [], norm: [], uv: [], idxs: [] }; }

    const x0 = cxh * CHUNK, x1 = Math.min(SIZE_X, x0 + CHUNK);
    const z0 = czh * CHUNK, z1 = Math.min(SIZE_Z, z0 + CHUNK);
    for (let y = 0; y < SIZE_Y; y++)
      for (let z = z0; z < z1; z++)
        for (let x = x0; x < x1; x++) {
          const id = getVoxel(x, y, z);
          if (id === AIR) continue;
          const bucket = buckets[id];
          const opaque = !blockById(id).transparent;
          for (const f of FACES) {
            const neighbor = getVoxel(x + f.dir[0], y + f.dir[1], z + f.dir[2]);
            const neighborTransparent = neighbor === AIR || blockById(neighbor)?.transparent;
            if (opaque && !neighborTransparent) continue;
            if (!opaque && neighbor !== AIR) continue;
            const start = bucket.pos.length / 3;
            f.corners.forEach((c, i) => {
              bucket.pos.push(x + c[0], y + c[1], z + c[2]);
              bucket.norm.push(...f.dir);
              bucket.uv.push(UV[i][0], UV[i][1]);
            });
            bucket.idxs.push(start, start + 1, start + 2, start, start + 2, start + 3);
          }
        }

    const meshes = [];
    for (const b of BLOCKS) {
      if (!b) continue;
      const data = buckets[b.id];
      if (!data.pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(data.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(data.norm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(data.uv, 2));
      geo.setIndex(data.idxs);
      const mesh = new THREE.Mesh(geo, materials[b.id]);
      worldGroup.add(mesh);
      meshes.push(mesh);
    }
    chunkMeshes.set(key, meshes);
  }
  const LOAD_R = isTouch ? 4 : 6;
  let lastPlayerChunkX = null, lastPlayerChunkZ = null;
  const meshQueue = [];
  const queuedKeys = new Set();
  function updateChunks(force) {
    const pcx = Math.floor(player.pos.x / CHUNK), pcz = Math.floor(player.pos.z / CHUNK);
    if (!force && pcx === lastPlayerChunkX && pcz === lastPlayerChunkZ) return;
    lastPlayerChunkX = pcx; lastPlayerChunkZ = pcz;
    for (let dz = -LOAD_R; dz <= LOAD_R; dz++)
      for (let dx = -LOAD_R; dx <= LOAD_R; dx++) {
        const cx = pcx + dx, cz = pcz + dz;
        if (cx < 0 || cz < 0 || cx >= chunksX || cz >= chunksZ) continue;
        const key = chunkKey(cx, cz);
        if (chunkMeshes.has(key) || queuedKeys.has(key)) continue;
        queuedKeys.add(key);
        meshQueue.push({ cx, cz, key });
      }
    meshQueue.sort((a, b) => ((a.cx - pcx) ** 2 + (a.cz - pcz) ** 2) - ((b.cx - pcx) ** 2 + (b.cz - pcz) ** 2));
    for (const [key, meshes] of chunkMeshes) {
      const cx = Math.floor(key / chunksZ), cz = key % chunksZ;
      if (Math.abs(cx - pcx) > LOAD_R + 1 || Math.abs(cz - pcz) > LOAD_R + 1) {
        meshes.forEach((m) => { worldGroup.remove(m); m.geometry.dispose(); });
        chunkMeshes.delete(key);
      }
    }
  }
  function processMeshQueue(budget) {
    let done = 0;
    while (done < budget && meshQueue.length) {
      const { cx, cz, key } = meshQueue.shift();
      queuedKeys.delete(key);
      if (chunkMeshes.has(key)) continue;
      if (Math.abs(cx - lastPlayerChunkX) > LOAD_R + 1 || Math.abs(cz - lastPlayerChunkZ) > LOAD_R + 1) continue;
      meshChunk(cx, cz);
      done++;
    }
  }
  function remeshRegion(minX, maxX, minZ, maxZ) {
    const cx0 = Math.max(0, Math.floor(minX / CHUNK)), cx1 = Math.min(chunksX - 1, Math.floor(maxX / CHUNK));
    const cz0 = Math.max(0, Math.floor(minZ / CHUNK)), cz1 = Math.min(chunksZ - 1, Math.floor(maxZ / CHUNK));
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++) meshChunk(cx, cz);
  }

  // ---------- Scene ----------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#9fd8ff');
  scene.fog = new THREE.Fog('#bfeaff', isTouch ? 38 : 60, isTouch ? 108 : 150);
  scene.add(worldGroup);

  const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, isTouch ? 200 : 380);
  const renderer = new THREE.WebGLRenderer({ antialias: !isTouch, powerPreference: 'high-performance' });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(isTouch ? 1 : Math.min(devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);
  const canvas = renderer.domElement;

  scene.add(new THREE.HemisphereLight('#ffffff', '#88aa66', 0.95));
  const sun = new THREE.DirectionalLight('#fff4d6', 0.9);
  sun.position.set(60, 90, 30);
  scene.add(sun);

  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(6, 16, 16), new THREE.MeshBasicMaterial({ color: '#fff3b0' }));
  sunDisc.position.set(SIZE_X / 2 + 80, 110, SIZE_Z / 2 - 90);
  scene.add(sunDisc);
  for (let i = 0; i < 70; i++) {
    const cloud = new THREE.Mesh(
      new THREE.BoxGeometry(5 + Math.random() * 6, 2, 4 + Math.random() * 5),
      new THREE.MeshLambertMaterial({ color: '#ffffff' })
    );
    cloud.position.set(Math.random() * SIZE_X, 30 + Math.random() * 10, Math.random() * SIZE_Z);
    scene.add(cloud);
  }

  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.005, 1.005, 1.005)),
    new THREE.LineBasicMaterial({ color: '#ffffff' })
  );
  highlight.visible = false;
  scene.add(highlight);

  // ---------- Player state ----------
  const MAX_HEARTS = 3;
  const spawnPoint = () => new THREE.Vector3(SIZE_X / 2, heightAt(SIZE_X >> 1, SIZE_Z >> 1) + 4, SIZE_Z / 2 + 4);
  const player = {
    pos: spawnPoint(),
    vel: new THREE.Vector3(),
    yaw: Math.PI, pitch: -0.2,
    onGround: false, fly: false,
    hearts: MAX_HEARTS, stars: 0, bag: 0, hurtCooldown: 0,
  };
  let selected = 1;
  let peaceful = true;

  // ---------- Creatures (animals to hunt, monsters to fight) ----------
  const CREATURES = {
    pig: { kind: 'animal', color: '#ff9bbf', size: [0.8, 0.7, 1.0], hp: 2, speed: 2.2, reward: 2, emoji: '🐷', name: 'Porquinho' },
    chicken: { kind: 'animal', color: '#fffbe0', size: [0.6, 0.7, 0.6], hp: 1, speed: 2.6, reward: 1, emoji: '🐔', name: 'Galinha' },
    cow: { kind: 'animal', color: '#d8c5a8', size: [0.9, 0.9, 1.2], hp: 3, speed: 1.8, reward: 3, emoji: '🐮', name: 'Vaquinha' },
    slime: { kind: 'monster', color: '#5bd86a', size: [0.8, 0.8, 0.8], hp: 2, speed: 2.4, reward: 3, emoji: '👾', name: 'Geleia' },
    spider: { kind: 'monster', color: '#5a4a6a', size: [1.1, 0.6, 1.1], hp: 3, speed: 3.0, reward: 5, emoji: '🕷️', name: 'Aranha' },
  };
  const creatures = [];
  const creatureGroup = new THREE.Group();
  scene.add(creatureGroup);

  function groundHeight(x, z) {
    const gx = Math.floor(x), gz = Math.floor(z);
    for (let y = SIZE_Y - 1; y >= 0; y--) if (isSolid(gx, y, gz)) return y + 1;
    return 0;
  }
  function makeFaceMaterial(color) {
    const c = makeCanvas();
    const g = c.getContext('2d');
    g.fillStyle = color; g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#1a1330';
    g.fillRect(4, 6, 2, 3); g.fillRect(10, 6, 2, 3);
    g.fillRect(6, 11, 4, 1);
    g.fillRect(5, 10, 1, 1); g.fillRect(10, 10, 1, 1);
    return new THREE.MeshLambertMaterial({ map: textureFromCanvas(c) });
  }
  const SPAWN_RANGE = 80;
  function spawnCreature(typeKey) {
    const def = CREATURES[typeKey];
    const cx = SIZE_X / 2, cz = SIZE_Z / 2;
    const x = Math.max(2, Math.min(SIZE_X - 2, cx + (Math.random() - 0.5) * 2 * SPAWN_RANGE));
    const z = Math.max(2, Math.min(SIZE_Z - 2, cz + (Math.random() - 0.5) * 2 * SPAWN_RANGE));
    const body = new THREE.Mesh(new THREE.BoxGeometry(...def.size), makeFaceMaterial(def.color));
    const mesh = new THREE.Group();
    mesh.add(body);
    mesh.position.set(x, groundHeight(x, z) + def.size[1] / 2, z);
    creatureGroup.add(mesh);
    creatures.push({
      typeKey, def, mesh, body,
      hp: def.hp,
      dir: Math.random() * Math.PI * 2,
      timer: 0, bob: Math.random() * Math.PI * 2, flash: 0,
    });
  }
  function populateCreatures() {
    for (let i = 0; i < 3; i++) spawnCreature('pig');
    for (let i = 0; i < 2; i++) spawnCreature('chicken');
    for (let i = 0; i < 2; i++) spawnCreature('cow');
    for (let i = 0; i < 2; i++) spawnCreature('slime');
    spawnCreature('spider');
  }
  function updateCreatures(dt) {
    player.hurtCooldown = Math.max(0, player.hurtCooldown - dt);
    for (const cr of creatures) {
      cr.timer -= dt;
      cr.bob += dt * 6;
      cr.flash = Math.max(0, cr.flash - dt);
      const toPlayer = new THREE.Vector3().subVectors(player.pos, cr.mesh.position);
      toPlayer.y = 0;
      const dist = toPlayer.length();
      const isMonster = cr.def.kind === 'monster';
      const hostile = isMonster && !peaceful;

      if (hostile && dist < 11) cr.dir = Math.atan2(toPlayer.x, toPlayer.z);
      else if (!isMonster && dist < 4) cr.dir = Math.atan2(-toPlayer.x, -toPlayer.z);
      else if (cr.timer <= 0) { cr.dir = Math.random() * Math.PI * 2; cr.timer = 1.5 + Math.random() * 2; }

      cr.mesh.position.x += Math.sin(cr.dir) * cr.def.speed * dt;
      cr.mesh.position.z += Math.cos(cr.dir) * cr.def.speed * dt;
      cr.mesh.position.x = Math.max(1, Math.min(SIZE_X - 1, cr.mesh.position.x));
      cr.mesh.position.z = Math.max(1, Math.min(SIZE_Z - 1, cr.mesh.position.z));
      cr.mesh.position.y = groundHeight(cr.mesh.position.x, cr.mesh.position.z) + cr.def.size[1] / 2 + Math.abs(Math.sin(cr.bob)) * 0.12;
      cr.mesh.rotation.y = cr.dir;
      cr.body.material.emissive = new THREE.Color(cr.flash > 0 ? '#ff0000' : '#000000');

      const verticalGap = Math.abs(player.pos.y - EYE_HEIGHT - cr.mesh.position.y);
      if (hostile && dist < 1.0 && verticalGap < 1.6 && player.hurtCooldown === 0) hurtPlayer();
    }
  }
  function hurtPlayer() {
    player.hearts -= 1;
    player.hurtCooldown = 1.2;
    blip(140, 0.18);
    const heartsEl = document.getElementById('hearts');
    heartsEl.classList.add('hit');
    setTimeout(() => heartsEl.classList.remove('hit'), 300);
    updateStats();
    if (player.hearts <= 0) napAndRespawn();
  }
  function napAndRespawn() {
    toast('😴 Você cochilou! Voltando pra base...');
    player.hearts = MAX_HEARTS;
    player.pos.copy(spawnPoint());
    player.vel.set(0, 0, 0);
    updateStats();
  }
  function raycastCreature() {
    const origin = camera.position.clone();
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    let best = null, bestT = REACH;
    for (const cr of creatures) {
      const oc = new THREE.Vector3().subVectors(cr.mesh.position, origin);
      const tca = oc.dot(dir);
      if (tca < 0) continue;
      const d2 = oc.lengthSq() - tca * tca;
      const radius = Math.max(...cr.def.size) * 0.7;
      if (d2 > radius * radius) continue;
      if (tca < bestT) { bestT = tca; best = cr; }
    }
    return best ? { creature: best, t: bestT } : null;
  }
  function hitCreature(cr) {
    cr.hp -= 1;
    cr.flash = 0.18;
    blip(cr.def.kind === 'monster' ? 300 : 880, 0.08);
    const knock = new THREE.Vector3().subVectors(cr.mesh.position, player.pos).setY(0).normalize().multiplyScalar(1.2);
    cr.mesh.position.add(knock);
    if (cr.hp > 0) return;
    defeatCreature(cr);
  }
  function defeatCreature(cr) {
    spawnPoof(cr.mesh.position, cr.def.color);
    player.stars += cr.def.reward;
    player.bag += 1;
    toast(`${cr.def.emoji} +${cr.def.reward} ⭐`);
    blip(660, 0.12); setTimeout(() => blip(990, 0.12), 90);
    updateStats();
    creatureGroup.remove(cr.mesh);
    cr.body.geometry.dispose();
    creatures.splice(creatures.indexOf(cr), 1);
    setTimeout(() => { if (!disposed) spawnCreature(cr.typeKey); }, 4000);
  }

  // ---------- Poof particles ----------
  const poofs = [];
  function spawnPoof(pos, color) {
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial({ color }));
      m.position.copy(pos);
      scene.add(m);
      poofs.push({ mesh: m, vel: new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 4 + 1, (Math.random() - 0.5) * 4), life: 0.7 });
    }
  }
  function updatePoofs(dt) {
    for (let i = poofs.length - 1; i >= 0; i--) {
      const p = poofs[i];
      p.life -= dt;
      p.vel.y -= 9 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.scale.multiplyScalar(1 - dt * 1.5);
      if (p.life <= 0) { scene.remove(p.mesh); p.mesh.geometry.dispose(); poofs.splice(i, 1); }
    }
  }

  // ---------- Scoreboard ----------
  function bestScore() {
    const stored = localStorage.getItem(BEST_KEY);
    return stored ? Number(stored) : 0;
  }
  function updateStats() {
    document.getElementById('hearts').textContent = '❤️'.repeat(player.hearts) + '🖤'.repeat(MAX_HEARTS - player.hearts);
    document.getElementById('stars').textContent = `⭐ ${player.stars}`;
    document.getElementById('bag').textContent = `🎒 ${player.bag}`;
    const best = Math.max(player.stars, bestScore());
    localStorage.setItem(BEST_KEY, String(best));
    document.getElementById('record').textContent = `🏆 ${best}`;
  }

  // ---------- Voxel raycast (DDA) ----------
  function raycastVoxel(maxDist = REACH) {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const origin = camera.position.clone();
    let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
    const step = [Math.sign(dir.x), Math.sign(dir.y), Math.sign(dir.z)];
    const tDelta = [Math.abs(1 / dir.x), Math.abs(1 / dir.y), Math.abs(1 / dir.z)];
    const tMax = [
      step[0] > 0 ? (x + 1 - origin.x) / dir.x : (origin.x - x) / -dir.x,
      step[1] > 0 ? (y + 1 - origin.y) / dir.y : (origin.y - y) / -dir.y,
      step[2] > 0 ? (z + 1 - origin.z) / dir.z : (origin.z - z) / -dir.z,
    ];
    let face = [0, 0, 0];
    for (let i = 0; i < maxDist * 3; i++) {
      if (isSolid(x, y, z)) return { hit: [x, y, z], place: [x + face[0], y + face[1], z + face[2]] };
      if (tMax[0] < tMax[1] && tMax[0] < tMax[2]) { x += step[0]; if (tMax[0] > maxDist) break; tMax[0] += tDelta[0]; face = [-step[0], 0, 0]; }
      else if (tMax[1] < tMax[2]) { y += step[1]; if (tMax[1] > maxDist) break; tMax[1] += tDelta[1]; face = [0, -step[1], 0]; }
      else { z += step[2]; if (tMax[2] > maxDist) break; tMax[2] += tDelta[2]; face = [0, 0, -step[2]]; }
    }
    return null;
  }

  // ---------- Build / break ----------
  function primaryAction() {
    const block = raycastVoxel();
    const creatureHit = raycastCreature();
    const blockDist = block ? new THREE.Vector3(block.hit[0] + 0.5, block.hit[1] + 0.5, block.hit[2] + 0.5).distanceTo(camera.position) : Infinity;
    if (creatureHit && creatureHit.t <= blockDist) { hitCreature(creatureHit.creature); return; }
    if (block) breakBlock(block);
  }
  function breakBlock(r) {
    setVoxel(r.hit[0], r.hit[1], r.hit[2], AIR);
    remeshRegion(r.hit[0] - 1, r.hit[0] + 1, r.hit[2] - 1, r.hit[2] + 1);
    player.bag += 1;
    updateStats();
    blip(220, 0.08);
  }
  function placeBlock() {
    const r = raycastVoxel();
    if (!r) return;
    const [px, py, pz] = r.place;
    if (!inBounds(px, py, pz) || getVoxel(px, py, pz) !== AIR) return;
    if (overlapsPlayer(px, py, pz)) return;
    setVoxel(px, py, pz, selected);
    remeshRegion(px - 1, px + 1, pz - 1, pz + 1);
    blip(selected === FACE_ID ? 720 : 520, 0.08);
  }
  function overlapsPlayer(x, y, z) {
    const p = player.pos;
    return x + 1 > p.x - PLAYER_RADIUS && x < p.x + PLAYER_RADIUS &&
      z + 1 > p.z - PLAYER_RADIUS && z < p.z + PLAYER_RADIUS &&
      y + 1 > p.y - EYE_HEIGHT && y < p.y - EYE_HEIGHT + PLAYER_HEIGHT;
  }

  // ---------- Magic structures ----------
  function fillSquare(cx, cz, y, half, id) {
    for (let dx = -half; dx <= half; dx++)
      for (let dz = -half; dz <= half; dz++) setVoxel(cx + dx, y, cz + dz, id);
  }
  function stampTrophy(cx, gy, cz) {
    fillSquare(cx, cz, gy, 2, GOLD_ID);
    fillSquare(cx, cz, gy + 1, 2, GRASS_ID);
    fillSquare(cx, cz, gy + 2, 1, GOLD_ID);
    for (let y = gy + 3; y <= gy + 6; y++) setVoxel(cx, y, cz, GOLD_ID);
    stampSphere(cx, gy + 9, cz, 3, () => GOLD_ID);
  }
  function ballPatchCenters() {
    const centers = [[0, 1, 0], [0, -1, 0]];
    for (let k = 0; k < 5; k++) { const a = (k * 2 * Math.PI) / 5; centers.push([Math.cos(a) * 0.72, 0.5, Math.sin(a) * 0.72]); }
    for (let k = 0; k < 5; k++) { const a = ((k + 0.5) * 2 * Math.PI) / 5; centers.push([Math.cos(a) * 0.72, -0.5, Math.sin(a) * 0.72]); }
    return centers.map((c) => { const l = Math.hypot(...c); return [c[0] / l, c[1] / l, c[2] / l]; });
  }
  function stampBall(cx, gy, cz, radius) {
    const centers = ballPatchCenters();
    const cy = gy + radius;
    stampSphere(cx, cy, cz, radius, (dx, dy, dz) => {
      const len = Math.hypot(dx, dy, dz) || 1;
      const nx = dx / len, ny = dy / len, nz = dz / len;
      const black = centers.some((p) => nx * p[0] + ny * p[1] + nz * p[2] > 0.9);
      return black ? BLACK_ID : WHITE_ID;
    });
  }
  function stampSphere(cx, cy, cz, radius, pick) {
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -radius; dy <= radius; dy++)
        for (let dz = -radius; dz <= radius; dz++) {
          if (Math.hypot(dx, dy, dz) > radius + 0.3) continue;
          setVoxel(cx + dx, cy + dy, cz + dz, pick(dx, dy, dz));
        }
  }
  function stampFigure(cx, gy, cz) {
    const set = (dx, dy, dz, id) => setVoxel(cx + dx, gy + dy, cz + dz, id);
    for (let dy = 0; dy <= 2; dy++) { set(-1, dy, 0, WHITE_ID); set(1, dy, 0, WHITE_ID); } // legs/socks
    set(-1, 0, 0, BLACK_ID); set(1, 0, 0, BLACK_ID);                                       // boots
    for (let dy = 3; dy <= 6; dy++) {                                                        // Argentina striped jersey
      set(-1, dy, 0, CELESTE_ID); set(0, dy, 0, WHITE_ID); set(1, dy, 0, CELESTE_ID);
    }
    for (let dy = 3; dy <= 5; dy++) { set(-2, dy, 0, CELESTE_ID); set(2, dy, 0, CELESTE_ID); } // arms
    set(0, 7, 0, WHITE_ID);                                                                  // neck
    set(0, 8, 0, FACE_ID);                                                                     // the player face
  }
  function stampCola(cx, gy, cz) {
    const R = 4, H = 17;
    for (let dy = 0; dy < H; dy++) {
      let id = RED_ID;
      if (dy === 0 || dy >= H - 2) id = 3;          // silvery top + bottom rim
      if (dy >= 7 && dy <= 9) id = WHITE_ID;          // white band
      const r = (dy === 0 || dy === H - 1) ? R - 1 : R;
      for (let dx = -r; dx <= r; dx++)
        for (let dz = -r; dz <= r; dz++) {
          if (dx * dx + dz * dz > r * r + 1) continue;
          setVoxel(cx + dx, gy + dy, cz + dz, id);
        }
    }
    setVoxel(cx, gy + H, cz, 3);                      // little pull-tab knob
  }
  function stampSteve(cx, gy, cz) {
    const set = (dx, dy, dz, id) => setVoxel(cx + dx, gy + dy, cz + dz, id);
    for (let dz = 0; dz <= 1; dz++) {
      for (let dy = 0; dy <= 3; dy++) { set(-1, dy, dz, BLUE_ID); set(1, dy, dz, BLUE_ID); } // jeans legs
      set(-1, 0, dz, BEDROCK_ID); set(1, 0, dz, BEDROCK_ID);                                   // shoes
      for (let dy = 4; dy <= 7; dy++) for (let dx = -1; dx <= 1; dx++) set(dx, dy, dz, CYAN_ID); // cyan shirt
      for (let dy = 4; dy <= 6; dy++) { set(-2, dy, dz, SKIN_ID); set(2, dy, dz, SKIN_ID); }   // bare arms
      for (let dy = 8; dy <= 9; dy++) for (let dx = -1; dx <= 1; dx++) set(dx, dy, dz, SKIN_ID); // head
    }
    for (let dx = -1; dx <= 1; dx++) for (let dz = 0; dz <= 1; dz++) set(dx, 10, dz, HAIR_ID);  // brown hair
    set(-1, 9, 1, HAIR_ID); set(1, 9, 1, HAIR_ID);                                              // hair back sides
  }
  function buildStructure(kind) {
    const margin = 12;
    const aim = raycastVoxel(90);
    let targetX, targetZ;
    if (aim) {
      targetX = aim.hit[0]; targetZ = aim.hit[2];
    } else {
      const forwardX = Math.sin(player.yaw), forwardZ = Math.cos(player.yaw);
      targetX = player.pos.x + forwardX * 24; targetZ = player.pos.z + forwardZ * 24;
    }
    const cx = Math.max(margin, Math.min(SIZE_X - margin, Math.round(targetX)));
    const cz = Math.max(margin, Math.min(SIZE_Z - margin, Math.round(targetZ)));
    const gy = groundHeight(cx, cz);
    const reach = kind === 'ball' ? 9 : kind === 'cola' ? 6 : 4;
    if (kind === 'trophy') stampTrophy(cx, gy, cz);
    if (kind === 'ball') stampBall(cx, gy, cz, 8);
    if (kind === 'figure') stampFigure(cx, gy, cz);
    if (kind === 'cola') stampCola(cx, gy, cz);
    if (kind === 'steve') stampSteve(cx, gy, cz);
    remeshRegion(cx - reach, cx + reach, cz - reach, cz + reach);
    const messages = { trophy: '🏆 Taça da Copa construída!', ball: '⚽ Bola gigante 2026 construída!', figure: '🃏 Figurinha craque!', cola: '🥤 Refri gigante da Copa!', steve: '🧍 Estátua do Steve!' };
    toast(messages[kind]);
    blip(680, 0.12); setTimeout(() => blip(1020, 0.14), 110);
  }

  // ---------- Physics ----------
  function collide() {
    const p = player.pos;
    const minX = Math.floor(p.x - PLAYER_RADIUS), maxX = Math.floor(p.x + PLAYER_RADIUS);
    const minZ = Math.floor(p.z - PLAYER_RADIUS), maxZ = Math.floor(p.z + PLAYER_RADIUS);
    const feet = p.y - EYE_HEIGHT;
    const minY = Math.floor(feet), maxY = Math.floor(feet + PLAYER_HEIGHT);
    for (let x = minX; x <= maxX; x++)
      for (let y = minY; y <= maxY; y++)
        for (let z = minZ; z <= maxZ; z++)
          if (isSolid(x, y, z)) return true;
    return false;
  }
  function moveAxis(axis, amount) {
    const before = player.pos[axis];
    player.pos[axis] += amount;
    if (!collide()) return;
    if (axis === 'y' && amount < 0) {
      const feet = player.pos.y - EYE_HEIGHT;
      player.pos.y = Math.floor(feet) + 1 + EYE_HEIGHT + 1e-3;
      player.onGround = true;
      player.vel.y = 0;
      return;
    }
    player.pos[axis] = before;
    if (axis === 'y') player.vel.y = 0;
    else player.vel[axis] = 0;
  }

  const keys = {};
  const joystick = { active: false, x: 0, y: 0, id: null, cx: 0, cy: 0, r: 50 };
  addEventListener('keydown', (e) => { keys[e.code] = true; handleHotkey(e); }, { signal });
  addEventListener('keyup', (e) => { keys[e.code] = false; }, { signal });

  function update(dt) {
    const flat = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
    const right = new THREE.Vector3(flat.z, 0, -flat.x);
    const forward = player.fly
      ? new THREE.Vector3(Math.sin(player.yaw) * Math.cos(player.pitch), Math.sin(player.pitch), Math.cos(player.yaw) * Math.cos(player.pitch))
      : flat;
    const move = new THREE.Vector3();
    if (keys.KeyW || keys.ArrowUp) move.add(forward);
    if (keys.KeyS || keys.ArrowDown) move.sub(forward);
    if (keys.KeyD || keys.ArrowRight) move.sub(right);
    if (keys.KeyA || keys.ArrowLeft) move.add(right);
    if (joystick.active) {
      move.add(forward.clone().multiplyScalar(-joystick.y));
      move.add(right.clone().multiplyScalar(-joystick.x));
    }
    if (move.lengthSq() > 0) move.normalize();

    if (player.fly) {
      player.vel.copy(move).multiplyScalar(FLY_SPEED);
      if (keys.Space) player.vel.y = FLY_SPEED;
      if (keys.ShiftLeft || keys.ShiftRight) player.vel.y = -FLY_SPEED;
    } else {
      player.vel.x = move.x * WALK_SPEED;
      player.vel.z = move.z * WALK_SPEED;
      player.vel.y += GRAVITY * dt;
      if (keys.Space && player.onGround) { player.vel.y = JUMP_SPEED; player.onGround = false; }
    }

    player.onGround = false;
    moveAxis('x', player.vel.x * dt);
    moveAxis('z', player.vel.z * dt);
    moveAxis('y', player.vel.y * dt);

    if (player.pos.y < -8) { player.pos.copy(spawnPoint()); player.vel.set(0, 0, 0); }

    camera.position.copy(player.pos);
    const lookDir = new THREE.Vector3(
      Math.sin(player.yaw) * Math.cos(player.pitch),
      Math.sin(player.pitch),
      Math.cos(player.yaw) * Math.cos(player.pitch)
    );
    camera.lookAt(camera.position.clone().add(lookDir));

    const r = raycastVoxel();
    if (r) { highlight.visible = true; highlight.position.set(r.hit[0] + 0.5, r.hit[1] + 0.5, r.hit[2] + 0.5); }
    else highlight.visible = false;
  }

  // ---------- Input ----------
  canvas.addEventListener('click', () => { if (started && !isTouch) canvas.requestPointerLock(); }, { signal });
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    player.yaw -= e.movementX * 0.0022;
    player.pitch -= e.movementY * 0.0022;
    player.pitch = Math.max(-1.5, Math.min(1.5, player.pitch));
  }, { signal });
  addEventListener('mousedown', (e) => {
    if (document.pointerLockElement !== canvas) return;
    if (e.button === 0) primaryAction();
    if (e.button === 2) placeBlock();
  }, { signal });
  addEventListener('contextmenu', (e) => e.preventDefault(), { signal });

  if (isTouch) setupTouchControls();
  function setupTouchControls() {
    document.body.classList.add('is-touch');
    let lookId = null, lx = 0, ly = 0;
    canvas.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      if (lookId === null) { lookId = t.identifier; lx = t.clientX; ly = t.clientY; }
    }, { passive: true, signal });
    canvas.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== lookId) continue;
        player.yaw -= (t.clientX - lx) * 0.005;
        player.pitch -= (t.clientY - ly) * 0.005;
        player.pitch = Math.max(-1.5, Math.min(1.5, player.pitch));
        lx = t.clientX; ly = t.clientY;
      }
    }, { passive: true, signal });
    const endLook = (e) => { for (const t of e.changedTouches) if (t.identifier === lookId) lookId = null; };
    canvas.addEventListener('touchend', endLook, { signal });
    canvas.addEventListener('touchcancel', endLook, { signal });

    const joyEl = document.getElementById('joystick');
    const knob = document.getElementById('joyKnob');
    const setKnob = (dx, dy) => { knob.style.transform = `translate(${dx}px, ${dy}px)`; };
    const moveJoy = (t) => {
      let dx = t.clientX - joystick.cx, dy = t.clientY - joystick.cy;
      const len = Math.hypot(dx, dy) || 1;
      const clamped = Math.min(len, joystick.r);
      dx = dx / len * clamped; dy = dy / len * clamped;
      joystick.x = dx / joystick.r; joystick.y = dy / joystick.r;
      setKnob(dx, dy);
    };
    joyEl.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      const rect = joyEl.getBoundingClientRect();
      joystick.active = true; joystick.id = t.identifier;
      joystick.cx = rect.left + rect.width / 2; joystick.cy = rect.top + rect.height / 2;
      joystick.r = rect.width / 2;
      moveJoy(t); e.preventDefault();
    }, { passive: false, signal });
    joyEl.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) if (t.identifier === joystick.id) moveJoy(t);
      e.preventDefault();
    }, { passive: false, signal });
    const endJoy = (e) => {
      for (const t of e.changedTouches) if (t.identifier === joystick.id) {
        joystick.active = false; joystick.id = null; joystick.x = 0; joystick.y = 0; setKnob(0, 0);
      }
    };
    joyEl.addEventListener('touchend', endJoy, { signal });
    joyEl.addEventListener('touchcancel', endJoy, { signal });

    const holdKey = (id, code) => {
      const el = document.getElementById(id);
      el.addEventListener('touchstart', (e) => { keys[code] = true; e.preventDefault(); }, { passive: false, signal });
      const up = () => { keys[code] = false; };
      el.addEventListener('touchend', up, { signal });
      el.addEventListener('touchcancel', up, { signal });
    };
    holdKey('btnUp', 'Space');
    holdKey('btnDown', 'ShiftLeft');
    const tapBtn = (id, fn) => {
      document.getElementById(id).addEventListener('touchstart', (e) => { fn(); e.preventDefault(); }, { passive: false, signal });
    };
    tapBtn('btnBreak', primaryAction);
    tapBtn('btnPlace', placeBlock);
  }

  function handleHotkey(e) {
    const b = BLOCKS.find((bl) => bl && bl.key === e.key);
    if (b) selectSlot(b.id);
    if (e.code === 'KeyF') toggleFly();
    if (e.code === 'KeyV') toggleControls();
    if (e.code === 'KeyP') togglePeace();
    if (e.code === 'KeyB') toggleBuildMenu();
  }

  // ---------- Controls modal ----------
  let paused = false;
  const controlsEl = document.getElementById('controls');
  function showControls() {
    paused = true;
    controlsEl.hidden = false;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  }
  function hideControls() {
    paused = false;
    controlsEl.hidden = true;
    if (started && !isTouch) canvas.requestPointerLock();
  }
  function toggleControls() { controlsEl.hidden ? showControls() : hideControls(); }
  document.getElementById('helpBtn').addEventListener('click', (e) => { e.stopPropagation(); showControls(); }, { signal });
  document.getElementById('closeControls').addEventListener('click', (e) => { e.stopPropagation(); hideControls(); }, { signal });

  // ---------- Build menu ----------
  const buildMenuEl = document.getElementById('buildMenu');
  function showBuildMenu() {
    paused = true;
    buildMenuEl.hidden = false;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  }
  function hideBuildMenu() {
    paused = false;
    buildMenuEl.hidden = true;
    if (started && !isTouch) canvas.requestPointerLock();
  }
  function toggleBuildMenu() { buildMenuEl.hidden ? showBuildMenu() : hideBuildMenu(); }
  document.getElementById('buildBtn').addEventListener('click', (e) => { e.stopPropagation(); showBuildMenu(); }, { signal });
  document.getElementById('closeBuild').addEventListener('click', (e) => { e.stopPropagation(); hideBuildMenu(); }, { signal });
  buildMenuEl.querySelectorAll('.buildCard').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); buildStructure(btn.dataset.kind); hideBuildMenu(); }, { signal });
  });

  // ---------- Sound ----------
  let audio;
  function blip(freq, dur) {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.value = 0.06; o.connect(g); g.connect(audio.destination);
    o.start(); g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
    o.stop(audio.currentTime + dur);
  }

  // ---------- HUD ----------
  const hotbar = document.getElementById('hotbar');
  function buildHotbar(faceUrl) {
    for (const b of BLOCKS) {
      if (!b) continue;
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.id = b.id;
      const swatch = document.createElement('div');
      swatch.className = 'swatch';
      if (b.id === FACE_ID) swatch.style.background = `center/cover url(${faceUrl})`;
      else { const c = makeCanvas(); b.build(c); swatch.style.background = `center/cover url(${c.toDataURL()})`; swatch.style.imageRendering = 'pixelated'; }
      slot.appendChild(swatch);
      const key = document.createElement('span'); key.className = 'key'; key.textContent = b.key; slot.appendChild(key);
      const name = document.createElement('span'); name.className = 'name'; name.textContent = b.name; slot.appendChild(name);
      slot.addEventListener('click', () => selectSlot(b.id), { signal });
      hotbar.appendChild(slot);
    }
  }
  function selectSlot(id) {
    selected = id;
    [...hotbar.children].forEach((s) => s.classList.toggle('active', +s.dataset.id === id));
    toast(`Bloco: ${blockById(id).name}`);
  }

  const toastEl = document.getElementById('toast');
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1200);
  }

  function toggleFly() {
    player.fly = !player.fly;
    document.getElementById('flyBtn').classList.toggle('on', player.fly);
    toast(player.fly ? '✈️ Voando!' : '🚶 Andando');
  }
  document.getElementById('flyBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleFly(); }, { signal });

  const modeBtn = document.getElementById('modeBtn');
  function togglePeace() {
    peaceful = !peaceful;
    modeBtn.classList.toggle('on', peaceful);
    modeBtn.textContent = peaceful ? '🕊️ Paz: ON' : '⚔️ Paz: OFF';
    toast(peaceful ? '🕊️ Modo paz! Monstros não atacam' : '⚔️ Monstros bravos de novo!');
  }
  modeBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePeace(); }, { signal });
  modeBtn.classList.toggle('on', peaceful);
  modeBtn.textContent = peaceful ? '🕊️ Paz: ON' : '⚔️ Paz: OFF';

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }, { signal });

  // ---------- Loop ----------
  let started = false;
  let last = performance.now();
  function loop(now) {
    if (disposed) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (started && !paused) { update(dt); updateChunks(); processMeshQueue(isTouch ? 1 : 2); updateCreatures(dt); updatePoofs(dt); }
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(loop);
  }

  function start() {
    started = true;
    document.getElementById('start').style.display = 'none';
    ['#topbar', '#hotbar', '#actionRow', '#crosshair'].forEach((s) => { document.querySelector(s).style.opacity = 1; });
    if (isTouch) document.getElementById('touchControls').style.display = 'block';
    if (!isTouch) canvas.requestPointerLock();
    blip(660, 0.12); setTimeout(() => blip(880, 0.14), 120);
  }
  document.getElementById('playBtn').addEventListener('click', start, { signal });

  new THREE.TextureLoader().load(FACE_URL, (faceTex) => {
    if (disposed) return;
    faceTex.magFilter = THREE.NearestFilter;
    faceTex.colorSpace = THREE.SRGBColorSpace;
    buildMaterials(faceTex);
    buildWelcomeMonument();
    updateChunks(true);
    processMeshQueue(isTouch ? 24 : 60);
    populateCreatures();
    buildHotbar(FACE_URL);
    selectSlot(1);
    updateStats();
    document.getElementById('startRecord').textContent = `🏆 Recorde: ${bestScore()}`;
    last = performance.now();
    rafId = requestAnimationFrame(loop);
  });

  const cleanup = () => {
    disposed = true;
    cancelAnimationFrame(rafId);
    abort.abort();
    renderer.dispose();
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    window.__blGameBooted = false;
    window.__blGameCleanup = undefined;
  };
  window.__blGameCleanup = cleanup;
  return cleanup;
}
