// Block registry as plain data plus pure texture painters that draw on a 2d context.
// No three.js, no DOM element creation: callers own the canvas and pass its context.

export type TexturePainter = (g: CanvasRenderingContext2D) => void;

export interface BlockDef {
  id: number;
  key: string;
  nameKey: string | null;
  transparent?: boolean;
  build: TexturePainter | null;
}

export function paint(base: string, dark: string, light: string): TexturePainter {
  return (g) => {
    g.fillStyle = base; g.fillRect(0, 0, 16, 16);
    for (let i = 0; i < 46; i++) {
      const x = Math.floor(Math.random() * 16);
      const y = Math.floor(Math.random() * 16);
      g.fillStyle = Math.random() > 0.5 ? dark : light;
      g.fillRect(x, y, 1, 1);
    }
  };
}

export function woodTexture(g: CanvasRenderingContext2D): void {
  g.fillStyle = '#9c6b3f'; g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#7a4f2b';
  for (let x = 1; x < 16; x += 4) g.fillRect(x, 0, 2, 16);
  g.fillStyle = '#b3855a';
  for (let x = 3; x < 16; x += 4) g.fillRect(x, 0, 1, 16);
}

export function brickTexture(g: CanvasRenderingContext2D): void {
  g.fillStyle = '#c0563f'; g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#e8e0d0';
  g.fillRect(0, 7, 16, 1); g.fillRect(0, 15, 16, 1);
  g.fillRect(7, 0, 1, 8); g.fillRect(0, 8, 1, 8); g.fillRect(15, 8, 1, 8);
}

export function goldTexture(g: CanvasRenderingContext2D): void {
  g.fillStyle = '#ffd23f'; g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#ffe98a';
  for (let i = 0; i < 22; i++) g.fillRect(Math.floor(Math.random() * 16), Math.floor(Math.random() * 16), 2, 2);
  g.fillStyle = '#caa018';
  g.fillRect(2, 2, 2, 2); g.fillRect(11, 9, 2, 2); g.fillRect(7, 12, 2, 2);
}

export function rainbowTexture(g: CanvasRenderingContext2D): void {
  const colors = ['#ff5d5d', '#ffae3d', '#ffe93d', '#5dff7a', '#3dc6ff', '#9b6bff'];
  colors.forEach((col, i) => { g.fillStyle = col; g.fillRect(0, i * 3 - 1, 16, 3); });
}

export function diamondTexture(g: CanvasRenderingContext2D): void {
  g.fillStyle = '#54cfd6'; g.fillRect(0, 0, 16, 16);                       // aqua base
  g.fillStyle = '#8fe9ee'; g.fillRect(0, 0, 16, 1); g.fillRect(0, 0, 1, 16); // bevel highlight
  g.fillStyle = '#2f9aa6'; g.fillRect(0, 15, 16, 1); g.fillRect(15, 0, 1, 16); // bevel shadow
  g.fillStyle = '#3fb3bd'; g.fillRect(2, 2, 12, 12);                       // inset face
  const gem = (x: number, y: number): void => {
    g.fillStyle = '#2b8a96'; g.fillRect(x, y, 4, 4);                       // facet edge
    g.fillStyle = '#aef2f6'; g.fillRect(x + 1, y, 2, 1); g.fillRect(x, y + 1, 1, 2);
    g.fillStyle = '#1f6f7a'; g.fillRect(x + 3, y + 2, 1, 2); g.fillRect(x + 2, y + 3, 2, 1);
    g.fillStyle = '#ffffff'; g.fillRect(x + 1, y + 1, 1, 1);               // sparkle
  };
  gem(3, 3); gem(9, 3); gem(3, 9); gem(9, 9);
  g.fillStyle = '#eafeff'; g.fillRect(7, 7, 2, 2);                         // center shine
}

export function avaritiaTexture(g: CanvasRenderingContext2D): void {
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

export const BLOCKS: (BlockDef | null)[] = [
  null,
  { id: 1, key: '1', nameKey: 'block.grass', build: paint('#6bd06b', '#4fb04f', '#86e886') },
  { id: 2, key: '2', nameKey: 'block.dirt', build: paint('#9c6b43', '#7d5232', '#b3825a') },
  { id: 3, key: '3', nameKey: 'block.stone', build: paint('#9b9ba3', '#7d7d85', '#b6b6bd') },
  { id: 4, key: '4', nameKey: 'block.wood', build: woodTexture },
  { id: 5, key: '5', nameKey: 'block.leaf', build: paint('#54c25a', '#3c9c42', '#74e07a') },
  { id: 6, key: '6', nameKey: 'block.sand', build: paint('#f0dca0', '#dcc585', '#fbeec0') },
  { id: 7, key: '7', nameKey: 'block.brick', build: brickTexture },
  { id: 8, key: '8', nameKey: 'block.gold', build: goldTexture },
  { id: 9, key: '9', nameKey: 'block.rainbow', build: rainbowTexture },
  { id: 10, key: '0', nameKey: null, build: null },
  { id: 11, key: '-', nameKey: 'block.water', transparent: true, build: paint('#3aa0ee', '#2f8fdc', '#5cb6f5') },
  { id: 12, key: 'c', nameKey: 'block.white', build: paint('#f4f4f8', '#dfe2ea', '#ffffff') },
  { id: 13, key: 'x', nameKey: 'block.black', build: paint('#2b2b33', '#16161c', '#3a3a44') },
  { id: 14, key: 'z', nameKey: 'block.diamond', build: diamondTexture },
  { id: 15, key: 'i', nameKey: 'block.avaritia', build: avaritiaTexture },
  { id: 16, key: 'k', nameKey: 'block.bedrock', build: paint('#565659', '#36363a', '#79797e') },
  { id: 17, key: 'l', nameKey: 'block.celeste', build: paint('#75aadb', '#5f97cc', '#9cc6ea') },
  { id: 18, key: 'r', nameKey: 'block.red', build: paint('#e0241f', '#bf1c18', '#f1564f') },
  { id: 19, key: 'j', nameKey: 'block.blue', build: paint('#33449c', '#27357d', '#4a5cc0') },
];

export const blockById = (id: number): BlockDef | null => BLOCKS[id];
