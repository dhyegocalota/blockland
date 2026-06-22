import { describe, expect, it } from 'vitest';
import {
  BEDROCK_ID, BLACK_ID, BLUE_ID, CELESTE_ID, FACE_ID,
  GOLD_ID, GRASS_ID, RED_ID, SKIN_ID, WHITE_ID,
} from './constants';
import {
  STRUCTURE_DEFS, STRUCTURE_KINDS, type SetVoxel, stampBall, stampBottle, stampFigure, stampHero, stampTrophy, structureDef,
} from './structures';
import { messages } from '../i18n/catalog';

const SILVER_ID = 3;

function voxelKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function recorder(): { set: SetVoxel; cells: Map<string, number> } {
  const cells = new Map<string, number>();
  const set: SetVoxel = (x, y, z, id) => { cells.set(voxelKey(x, y, z), id); };
  return { set, cells };
}

function countById(cells: Map<string, number>, id: number): number {
  let total = 0;
  for (const value of cells.values()) if (value === id) total++;
  return total;
}

describe('stampTrophy', () => {
  const origin = { cx: 100, gy: 7, cz: 200 };

  it('lays a gold base square at gy', () => {
    const { set, cells } = recorder();
    stampTrophy({ set, ...origin });
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++)
        expect(cells.get(voxelKey(origin.cx + dx, origin.gy, origin.cz + dz))).toBe(GOLD_ID);
  });

  it('lays a grass layer at gy+1', () => {
    const { set, cells } = recorder();
    stampTrophy({ set, ...origin });
    expect(cells.get(voxelKey(origin.cx, origin.gy + 1, origin.cz))).toBe(GRASS_ID);
    expect(cells.get(voxelKey(origin.cx + 2, origin.gy + 1, origin.cz + 2))).toBe(GRASS_ID);
  });

  it('raises a gold stem from gy+3 to gy+6', () => {
    const { set, cells } = recorder();
    stampTrophy({ set, ...origin });
    for (let y = origin.gy + 3; y <= origin.gy + 6; y++)
      expect(cells.get(voxelKey(origin.cx, y, origin.cz))).toBe(GOLD_ID);
  });

  it('crowns it with a gold sphere centered at gy+9', () => {
    const { set, cells } = recorder();
    stampTrophy({ set, ...origin });
    expect(cells.get(voxelKey(origin.cx, origin.gy + 9, origin.cz))).toBe(GOLD_ID);
    expect(cells.get(voxelKey(origin.cx + 3, origin.gy + 9, origin.cz))).toBe(GOLD_ID);
  });

  it('writes only gold and grass ids', () => {
    const { set, cells } = recorder();
    stampTrophy({ set, ...origin });
    const ids = [...new Set(cells.values())].sort((a, b) => a - b);
    expect(ids).toEqual([GRASS_ID, GOLD_ID].sort((a, b) => a - b));
  });
});

describe('stampBall', () => {
  const origin = { cx: 0, gy: 10, cz: 0, radius: 3 };

  it('paints a soccer ball using only white and black', () => {
    const { set, cells } = recorder();
    stampBall({ set, ...origin });
    const ids = [...new Set(cells.values())].sort((a, b) => a - b);
    expect(ids).toEqual([WHITE_ID, BLACK_ID].sort((a, b) => a - b));
  });

  it('contains both white and black voxels', () => {
    const { set, cells } = recorder();
    stampBall({ set, ...origin });
    expect(countById(cells, WHITE_ID)).toBeGreaterThan(0);
    expect(countById(cells, BLACK_ID)).toBeGreaterThan(0);
  });

  it('is centered at gy + radius', () => {
    const { set, cells } = recorder();
    stampBall({ set, ...origin });
    const top = origin.gy + origin.radius + origin.radius;
    expect(cells.has(voxelKey(origin.cx, top, origin.cz))).toBe(true);
    expect(cells.has(voxelKey(origin.cx, origin.gy, origin.cz))).toBe(true);
  });

  it('stays inside the bounding sphere', () => {
    const { set, cells } = recorder();
    stampBall({ set, ...origin });
    const center = origin.gy + origin.radius;
    for (const key of cells.keys()) {
      const [x, y, z] = key.split(',').map(Number);
      const distance = Math.hypot(x - origin.cx, y - center, z - origin.cz);
      expect(distance).toBeLessThanOrEqual(origin.radius + 0.3);
    }
  });

  it('puts black patches at the poles', () => {
    const { set, cells } = recorder();
    stampBall({ set, ...origin });
    const center = origin.gy + origin.radius;
    expect(cells.get(voxelKey(origin.cx, center + origin.radius, origin.cz))).toBe(BLACK_ID);
    expect(cells.get(voxelKey(origin.cx, center - origin.radius, origin.cz))).toBe(BLACK_ID);
  });
});

describe('stampFigure', () => {
  const origin = { cx: 5, gy: 6, cz: -5 };

  it('places the player face block at the head', () => {
    const { set, cells } = recorder();
    stampFigure({ set, ...origin });
    expect(cells.get(voxelKey(origin.cx, origin.gy + 8, origin.cz))).toBe(FACE_ID);
  });

  it('places exactly one face block', () => {
    const { set, cells } = recorder();
    stampFigure({ set, ...origin });
    expect(countById(cells, FACE_ID)).toBe(1);
  });

  it('puts black boots over white legs', () => {
    const { set, cells } = recorder();
    stampFigure({ set, ...origin });
    expect(cells.get(voxelKey(origin.cx - 1, origin.gy, origin.cz))).toBe(BLACK_ID);
    expect(cells.get(voxelKey(origin.cx + 1, origin.gy, origin.cz))).toBe(BLACK_ID);
    expect(cells.get(voxelKey(origin.cx - 1, origin.gy + 1, origin.cz))).toBe(WHITE_ID);
    expect(cells.get(voxelKey(origin.cx - 1, origin.gy + 2, origin.cz))).toBe(WHITE_ID);
  });

  it('weaves a celeste/white/celeste striped jersey', () => {
    const { set, cells } = recorder();
    stampFigure({ set, ...origin });
    for (let dy = 3; dy <= 6; dy++) {
      expect(cells.get(voxelKey(origin.cx - 1, origin.gy + dy, origin.cz))).toBe(CELESTE_ID);
      expect(cells.get(voxelKey(origin.cx, origin.gy + dy, origin.cz))).toBe(WHITE_ID);
      expect(cells.get(voxelKey(origin.cx + 1, origin.gy + dy, origin.cz))).toBe(CELESTE_ID);
    }
  });

  it('extends celeste arms from dy 3 to 5', () => {
    const { set, cells } = recorder();
    stampFigure({ set, ...origin });
    for (let dy = 3; dy <= 5; dy++) {
      expect(cells.get(voxelKey(origin.cx - 2, origin.gy + dy, origin.cz))).toBe(CELESTE_ID);
      expect(cells.get(voxelKey(origin.cx + 2, origin.gy + dy, origin.cz))).toBe(CELESTE_ID);
    }
  });

  it('puts a white neck under the head', () => {
    const { set, cells } = recorder();
    stampFigure({ set, ...origin });
    expect(cells.get(voxelKey(origin.cx, origin.gy + 7, origin.cz))).toBe(WHITE_ID);
  });
});

describe('stampBottle', () => {
  const origin = { cx: -20, gy: 6, cz: 30 };
  const HEIGHT = 17;

  it('uses a blue body in the mid section', () => {
    const { set, cells } = recorder();
    stampBottle({ set, ...origin });
    expect(cells.get(voxelKey(origin.cx, origin.gy + 4, origin.cz))).toBe(BLUE_ID);
  });

  it('keeps the body a single blue tone with no contrasting band', () => {
    const { set, cells } = recorder();
    stampBottle({ set, ...origin });
    for (let dy = 1; dy <= HEIGHT - 3; dy++)
      expect(cells.get(voxelKey(origin.cx, origin.gy + dy, origin.cz))).toBe(BLUE_ID);
  });

  it('caps silver rims at the bottom and top', () => {
    const { set, cells } = recorder();
    stampBottle({ set, ...origin });
    expect(cells.get(voxelKey(origin.cx, origin.gy, origin.cz))).toBe(SILVER_ID);
    expect(cells.get(voxelKey(origin.cx, origin.gy + HEIGHT - 1, origin.cz))).toBe(SILVER_ID);
  });

  it('caps the bottle with a silver cap knob', () => {
    const { set, cells } = recorder();
    stampBottle({ set, ...origin });
    expect(cells.get(voxelKey(origin.cx, origin.gy + HEIGHT, origin.cz))).toBe(SILVER_ID);
  });

  it('writes only blue and silver ids', () => {
    const { set, cells } = recorder();
    stampBottle({ set, ...origin });
    const ids = [...new Set(cells.values())].sort((a, b) => a - b);
    expect(ids).toEqual([SILVER_ID, BLUE_ID].sort((a, b) => a - b));
  });

  it('clips the body to a circular cross-section', () => {
    const { set, cells } = recorder();
    stampBottle({ set, ...origin });
    expect(cells.has(voxelKey(origin.cx + 4, origin.gy + 4, origin.cz + 4))).toBe(false);
  });
});

describe('stampHero', () => {
  const origin = { cx: 50, gy: 6, cz: 50 };

  it('puts skin-tone head voxels at dy 8..9 (except where back hair overlays)', () => {
    const { set, cells } = recorder();
    stampHero({ set, ...origin });
    const isBackHairCell = (dx: number, dy: number, dz: number): boolean =>
      dy === 9 && dz === 1 && (dx === -1 || dx === 1);
    for (let dz = 0; dz <= 1; dz++)
      for (let dy = 8; dy <= 9; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const expected = isBackHairCell(dx, dy, dz) ? GOLD_ID : SKIN_ID;
          expect(cells.get(voxelKey(origin.cx + dx, origin.gy + dy, origin.cz + dz))).toBe(expected);
        }
  });

  it('stands on bedrock boots under green trouser legs', () => {
    const { set, cells } = recorder();
    stampHero({ set, ...origin });
    for (let dz = 0; dz <= 1; dz++) {
      expect(cells.get(voxelKey(origin.cx - 1, origin.gy, origin.cz + dz))).toBe(BEDROCK_ID);
      expect(cells.get(voxelKey(origin.cx + 1, origin.gy, origin.cz + dz))).toBe(BEDROCK_ID);
      for (let dy = 1; dy <= 3; dy++) {
        expect(cells.get(voxelKey(origin.cx - 1, origin.gy + dy, origin.cz + dz))).toBe(GRASS_ID);
        expect(cells.get(voxelKey(origin.cx + 1, origin.gy + dy, origin.cz + dz))).toBe(GRASS_ID);
      }
    }
  });

  it('puts a red shirt across the torso at dy 4..7', () => {
    const { set, cells } = recorder();
    stampHero({ set, ...origin });
    for (let dz = 0; dz <= 1; dz++)
      for (let dy = 4; dy <= 7; dy++)
        for (let dx = -1; dx <= 1; dx++)
          expect(cells.get(voxelKey(origin.cx + dx, origin.gy + dy, origin.cz + dz))).toBe(RED_ID);
  });

  it('puts bare skin arms at the sides for dy 4..6', () => {
    const { set, cells } = recorder();
    stampHero({ set, ...origin });
    for (let dz = 0; dz <= 1; dz++)
      for (let dy = 4; dy <= 6; dy++) {
        expect(cells.get(voxelKey(origin.cx - 2, origin.gy + dy, origin.cz + dz))).toBe(SKIN_ID);
        expect(cells.get(voxelKey(origin.cx + 2, origin.gy + dy, origin.cz + dz))).toBe(SKIN_ID);
      }
  });

  it('crowns the head with blond hair at dy 10', () => {
    const { set, cells } = recorder();
    stampHero({ set, ...origin });
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = 0; dz <= 1; dz++)
        expect(cells.get(voxelKey(origin.cx + dx, origin.gy + 10, origin.cz + dz))).toBe(GOLD_ID);
  });

  it('adds hair on the back sides at dy 9', () => {
    const { set, cells } = recorder();
    stampHero({ set, ...origin });
    expect(cells.get(voxelKey(origin.cx - 1, origin.gy + 9, origin.cz + 1))).toBe(GOLD_ID);
    expect(cells.get(voxelKey(origin.cx + 1, origin.gy + 9, origin.cz + 1))).toBe(GOLD_ID);
  });
});

describe('STRUCTURE_DEFS registry', () => {
  it('drives STRUCTURE_KINDS from its keys', () => {
    expect(STRUCTURE_KINDS).toEqual(Object.keys(STRUCTURE_DEFS));
    expect(STRUCTURE_KINDS).toEqual(['trophy', 'ball', 'figure', 'bottle', 'hero']);
  });

  it('keeps the per-kind remesh reach', () => {
    expect(structureDef('ball').reach).toBe(9);
    expect(structureDef('bottle').reach).toBe(6);
    expect(structureDef('trophy').reach).toBe(4);
    expect(structureDef('figure').reach).toBe(4);
    expect(structureDef('hero').reach).toBe(4);
  });

  it('exposes label, toast and emoji for every kind', () => {
    for (const kind of STRUCTURE_KINDS) {
      const def = structureDef(kind);
      expect(def.labelKey).toBe(`build.${kind}`);
      expect(def.builtToastKey).toBe(`toast.built_${kind}`);
      expect(def.emoji.length).toBeGreaterThan(0);
    }
  });

  it('has its label and toast strings in both locales', () => {
    for (const kind of STRUCTURE_KINDS) {
      const def = structureDef(kind);
      expect(messages['pt-BR'][def.labelKey]).toBeTruthy();
      expect(messages['en-US'][def.labelKey]).toBeTruthy();
      expect(messages['pt-BR'][def.builtToastKey]).toBeTruthy();
      expect(messages['en-US'][def.builtToastKey]).toBeTruthy();
    }
  });

  it('stamps at least one voxel for every kind', () => {
    for (const kind of STRUCTURE_KINDS) {
      const { set, cells } = recorder();
      structureDef(kind).stamp({ set, cx: 100, gy: 7, cz: 200 });
      expect(cells.size).toBeGreaterThan(0);
    }
  });

  it('stamps the ball at radius 8 through the registry', () => {
    const { set, cells } = recorder();
    structureDef('ball').stamp({ set, cx: 0, gy: 0, cz: 0 });
    expect(cells.has(voxelKey(0, 16, 0))).toBe(true);
    expect(cells.has(voxelKey(0, 0, 0))).toBe(true);
  });
});

describe('stamp origins', () => {
  it('keeps trophy shape translation-invariant', () => {
    const first = recorder();
    const second = recorder();
    stampTrophy({ set: first.set, cx: 0, gy: 0, cz: 0 });
    stampTrophy({ set: second.set, cx: 1000, gy: 5, cz: -1000 });
    const shift = (key: string): string => {
      const [x, y, z] = key.split(',').map(Number);
      return voxelKey(x + 1000, y + 5, z - 1000);
    };
    expect(second.cells.size).toBe(first.cells.size);
    for (const [key, id] of first.cells) expect(second.cells.get(shift(key))).toBe(id);
  });
});
