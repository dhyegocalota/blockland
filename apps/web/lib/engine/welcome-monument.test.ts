import { describe, expect, it } from 'vitest';
import { FACE_ID, GOLD_ID } from './constants';
import { welcomeMonumentCells } from './welcome-monument';

describe('welcomeMonumentCells', () => {
  it('stacks a two-cell face column above the ground top', () => {
    const cells = welcomeMonumentCells({ cx: 100, cz: 200, top: 10 });
    expect(cells.slice(0, 2)).toEqual([
      { x: 100, y: 11, z: 200, id: FACE_ID },
      { x: 100, y: 12, z: 200, id: FACE_ID },
    ]);
  });

  it('rings the face with a four-cell gold cross at the base', () => {
    const cells = welcomeMonumentCells({ cx: 100, cz: 200, top: 10 });
    expect(cells.slice(2)).toEqual([
      { x: 99, y: 11, z: 200, id: GOLD_ID },
      { x: 101, y: 11, z: 200, id: GOLD_ID },
      { x: 100, y: 11, z: 199, id: GOLD_ID },
      { x: 100, y: 11, z: 201, id: GOLD_ID },
    ]);
  });

  it('stamps exactly six cells', () => {
    expect(welcomeMonumentCells({ cx: 0, cz: 0, top: 0 })).toHaveLength(6);
  });
});
