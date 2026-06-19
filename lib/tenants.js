// White-label config. The platform is generic ("Blocklandia"); each tenant brings its
// own name, colors, avatar, face texture and copy. Everything Teo-specific lives in the
// `teo` tenant — nothing about Teodoro is baked into the core anymore.

export const PLATFORM_NAME = 'Blocklandia';

export const TENANTS = {
  teo: {
    id: 'teo',
    name: 'Teocraft',
    hero: 'Teodoro',
    titleA: 'TEO',
    titleB: 'CRAFT',
    tagline:
      'O mundo mágico do <b>Teodoro</b>! Construa castelos, cace os porquinhos, derrote os monstrinhos e junte estrelas. Coloque o seu rosto em blocos pra deixar tudo do seu jeito! 🎉',
    primary: '#ffd23f',
    avatar: '/teo-avatar.png',
    faceTexture: '/teo-face.png',
    faceBlockName: 'Teo!',
  },
  demo: {
    id: 'demo',
    name: 'Blocklandia',
    hero: 'você',
    titleA: 'BLOCK',
    titleB: 'LANDIA',
    tagline:
      'Seu mundo de blocos! Construa, cace os bichinhos, derrote os monstrinhos e junte estrelas. Coloque o seu rosto em blocos pra deixar tudo do seu jeito! 🎉',
    primary: '#3dc6ff',
    avatar: '/teo-avatar.png',
    faceTexture: '/teo-face.png',
    faceBlockName: 'Eu!',
  },
};

/// Resolve the active tenant from `?tenant=` (defaults to `teo`). Server-safe.
export function resolveTenant() {
  if (typeof window === 'undefined') return TENANTS.teo;
  const id = new URLSearchParams(window.location.search).get('tenant');
  if (id && TENANTS[id]) return TENANTS[id];
  return TENANTS.teo;
}
