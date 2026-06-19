import type { Appearance } from './coop';

// New players get a random look from these kid-friendly palettes (then can tweak it in the customizer).
export const LOOK_PALETTES: Record<keyof Appearance, string[]> = {
  skin: ['#f2c18b', '#ffdbac', '#e0ac69', '#c68642', '#8d5524', '#fce1c4'],
  shirt: ['#ff5d2e', '#3ba3ff', '#39c66b', '#ffd23f', '#b06bff', '#ff6bca', '#ff3b3b', '#22d3c5'],
  hair: ['#3a2a1a', '#1a1a1a', '#7a4a1a', '#d9a441', '#a01a1a', '#5a3fb0'],
};

export function randomLook(): Appearance {
  const pick = (options: string[]): string => options[Math.floor(Math.random() * options.length)];
  return { skin: pick(LOOK_PALETTES.skin), shirt: pick(LOOK_PALETTES.shirt), hair: pick(LOOK_PALETTES.hair) };
}
