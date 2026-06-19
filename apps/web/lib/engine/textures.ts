// Procedural block textures: a 16x16 canvas painted by each block's `build`, wrapped as a
// nearest-filtered THREE texture. Touches the DOM canvas and a passed BlockDef only — no scene,
// renderer or closure state.
import * as THREE from 'three';
import type { BlockDef } from './blocks';

const TEXTURE_SIZE = 16;

export function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  return canvas;
}

export function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2d canvas context unavailable');
  return context;
}

export function textureFromCanvas(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function renderBlockCanvas(block: BlockDef): HTMLCanvasElement {
  if (!block.build) throw new Error(`block ${block.id} has no texture builder`);
  const canvas = makeCanvas();
  block.build(ctx2d(canvas));
  return canvas;
}
