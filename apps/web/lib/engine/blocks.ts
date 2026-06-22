// Block registry as plain data plus pure texture painters that draw on a 2d context.
// No three.js, no DOM element creation: callers own the canvas and pass its context.
// Textures are deterministic: any per-pixel noise is hashed from x,y, never Math.random.

export type TexturePainter = (g: CanvasRenderingContext2D) => void;

export interface BlockDef {
  id: number;
  key: string;
  nameKey: string | null;
  transparent?: boolean;
  build: TexturePainter | null;
  // Representative tint for the dig hit-poof, so striking a block puffs in its own colour.
  color: string;
}

const TILE = 16;

// Deterministic per-pixel hash in [0, 1) so textures look identical on every load.
function noise(x: number, y: number): number {
  const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

// Fill the base tone then scatter darker/lighter single pixels, Minecraft-style grain.
export function paint(base: string, dark: string, light: string): TexturePainter {
  return (g) => {
    g.fillStyle = base;
    g.fillRect(0, 0, TILE, TILE);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = noise(x, y);
        if (n < 0.78) continue;
        g.fillStyle = n < 0.89 ? dark : light;
        g.fillRect(x, y, 1, 1);
      }
    }
  };
}

export function woodTexture(g: CanvasRenderingContext2D): void {
  g.fillStyle = '#6b5331'; g.fillRect(0, 0, TILE, TILE);              // oak bark base
  g.fillStyle = '#574326';
  for (let x = 1; x < TILE; x += 4) g.fillRect(x, 0, 2, TILE);        // vertical grain
  g.fillStyle = '#7d6038';
  for (let x = 3; x < TILE; x += 4) g.fillRect(x, 0, 1, TILE);        // grain highlight
  g.fillStyle = '#caa96b'; g.fillRect(6, 6, 4, 4);                    // pale heartwood ring
  g.fillStyle = '#9c7a4d'; g.fillRect(7, 7, 2, 2);
}

export function brickTexture(g: CanvasRenderingContext2D): void {
  g.fillStyle = '#9c5a3c'; g.fillRect(0, 0, TILE, TILE);             // clay brick base
  g.fillStyle = '#b07050';
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      if (noise(x, y) < 0.85) continue;
      g.fillRect(x, y, 1, 1);                                         // grit speckle
    }
  }
  g.fillStyle = '#c9c4b4';                                           // mortar grid
  g.fillRect(0, 7, TILE, 1); g.fillRect(0, 15, TILE, 1);
  g.fillRect(7, 0, 1, 8); g.fillRect(0, 8, 1, 8); g.fillRect(15, 8, 1, 8);
}

export function goldTexture(g: CanvasRenderingContext2D): void {
  g.fillStyle = '#fcee4b'; g.fillRect(0, 0, TILE, TILE);            // metallic gold base
  g.fillStyle = '#fff7a8';
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      if (noise(x, y) < 0.82) continue;
      g.fillRect(x, y, 2, 2);                                        // soft sheen blobs
    }
  }
  g.fillStyle = '#c9a21a';                                          // darker nuggets
  g.fillRect(2, 2, 2, 2); g.fillRect(11, 9, 2, 2); g.fillRect(7, 12, 2, 2);
}

export function rainbowTexture(g: CanvasRenderingContext2D): void {
  const colors = ['#ff5d5d', '#ffae3d', '#ffe93d', '#5dff7a', '#3dc6ff', '#9b6bff'];
  colors.forEach((col, i) => { g.fillStyle = col; g.fillRect(0, i * 3 - 1, TILE, 3); });
}

export function diamondTexture(g: CanvasRenderingContext2D): void {
  g.fillStyle = '#4aedd9'; g.fillRect(0, 0, TILE, TILE);                       // aqua base
  g.fillStyle = '#8ff7ea'; g.fillRect(0, 0, TILE, 1); g.fillRect(0, 0, 1, TILE); // bevel highlight
  g.fillStyle = '#2aa896'; g.fillRect(0, 15, TILE, 1); g.fillRect(15, 0, 1, TILE); // bevel shadow
  g.fillStyle = '#3cc8b6'; g.fillRect(2, 2, 12, 12);                           // inset face
  const gem = (x: number, y: number): void => {
    g.fillStyle = '#239182'; g.fillRect(x, y, 4, 4);                           // facet edge
    g.fillStyle = '#aef7ee'; g.fillRect(x + 1, y, 2, 1); g.fillRect(x, y + 1, 1, 2);
    g.fillStyle = '#1a6f63'; g.fillRect(x + 3, y + 2, 1, 2); g.fillRect(x + 2, y + 3, 2, 1);
    g.fillStyle = '#ffffff'; g.fillRect(x + 1, y + 1, 1, 1);                   // sparkle
  };
  gem(3, 3); gem(9, 3); gem(3, 9); gem(9, 9);
  g.fillStyle = '#eafffb'; g.fillRect(7, 7, 2, 2);                             // center shine
}

export function avaritiaTexture(g: CanvasRenderingContext2D): void {
  for (let y = 0; y < TILE; y++) {                                            // deep cosmic gradient
    const t = y / 15;
    g.fillStyle = `rgb(${18 + (t * 26) | 0}, ${5 + (t * 6) | 0}, ${38 + (t * 34) | 0})`;
    g.fillRect(0, y, TILE, 1);
  }
  const nebula = ['#ff2e7e', '#ff9b3d', '#ffe23f', '#46ff86', '#3dc6ff', '#9b6bff'];
  g.globalAlpha = 0.45;
  nebula.forEach((col, i) => { g.fillStyle = col; g.fillRect(0, (i * 3 + (i % 2)) % TILE, TILE, 2); });
  g.globalAlpha = 1;
  for (let y = 0; y < TILE; y++) {                                            // stars
    for (let x = 0; x < TILE; x++) {
      const n = noise(x, y);
      if (n < 0.88) continue;
      g.fillStyle = n < 0.96 ? '#ffffff' : '#bfe4ff';
      g.fillRect(x, y, n < 0.985 ? 1 : 2, 1);
    }
  }
}

export const BLOCKS: (BlockDef | null)[] = [
  null,
  { id: 1, key: '1', nameKey: 'block.grass', color: '#5fae3a', build: paint('#5fae3a', '#4c8b2b', '#7ac24a') },
  { id: 2, key: '2', nameKey: 'block.dirt', color: '#866043', build: paint('#866043', '#6b4c34', '#9c7250') },
  { id: 3, key: '3', nameKey: 'block.stone', color: '#7f7f7f', build: paint('#7f7f7f', '#6b6b6b', '#9a9a9a') },
  { id: 4, key: '4', nameKey: 'block.wood', color: '#6b5331', build: woodTexture },
  { id: 5, key: '5', nameKey: 'block.leaf', color: '#4c8b2b', build: paint('#4c8b2b', '#3a6e20', '#6aa83c') },
  { id: 6, key: '6', nameKey: 'block.sand', color: '#dbd3a0', build: paint('#dbd3a0', '#c8be88', '#ece4b8') },
  { id: 7, key: '7', nameKey: 'block.brick', color: '#9c5a3c', build: brickTexture },
  { id: 8, key: '8', nameKey: 'block.gold', color: '#fcee4b', build: goldTexture },
  { id: 9, key: '9', nameKey: 'block.rainbow', color: '#ffe93d', build: rainbowTexture },
  { id: 10, key: '0', nameKey: null, color: '#ffd23f', build: null },
  { id: 11, key: '-', nameKey: 'block.water', transparent: true, color: '#3f76e4', build: paint('#3f76e4', '#3667cc', '#5a8def') },
  { id: 12, key: 'c', nameKey: 'block.white', color: '#f0f0f0', build: paint('#f0f0f0', '#d8d8d8', '#ffffff') },
  { id: 13, key: 'x', nameKey: 'block.black', color: '#191919', build: paint('#191919', '#0e0e0e', '#2c2c2c') },
  { id: 14, key: 'z', nameKey: 'block.diamond', color: '#4aedd9', build: diamondTexture },
  { id: 15, key: 'i', nameKey: 'block.avaritia', color: '#9b6bff', build: avaritiaTexture },
  { id: 16, key: 'k', nameKey: 'block.bedrock', color: '#565656', build: paint('#565656', '#363636', '#787878') },
  { id: 17, key: 'l', nameKey: 'block.celeste', color: '#4aa0d5', build: paint('#4aa0d5', '#3d88ba', '#6db8e3') },
  { id: 18, key: 'r', nameKey: 'block.red', color: '#b02e26', build: paint('#b02e26', '#92241d', '#cf4a41') },
  { id: 19, key: 'j', nameKey: 'block.blue', color: '#3c44aa', build: paint('#3c44aa', '#2f3589', '#525bc6') },
];

export const blockById = (id: number): BlockDef | null => BLOCKS[id];
