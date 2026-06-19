// Built-in tenants: used to seed the database on first run and as an offline fallback
// if the store is unreachable. Everything tenant-specific lives here as plain data.

export const PLATFORM_NAME = 'Blocklandia';
export const DEFAULT_TENANT = process.env.NEXT_PUBLIC_DEFAULT_TENANT || 'teo';

export const BUILTIN_TENANTS = {
  teo: {
    id: 'teo',
    name: 'Teocraft',
    hero: 'Teodoro',
    titleA: 'TEO',
    titleB: 'CRAFT',
    tagline:
      'O mundo mágico do <b>Teodoro</b>! Construa castelos, cace os porquinhos, derrote os monstrinhos e junte estrelas. Coloque o seu rosto em blocos pra deixar tudo do seu jeito! 🎉',
    primary: '#ffd23f',
    avatar: '/tenants/teo/avatar.png',
    faceTexture: '/tenants/teo/face.png',
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
    avatar: '/tenants/demo/avatar.png',
    faceTexture: '/tenants/demo/face.png',
    faceBlockName: 'Eu!',
  },
};

export const TENANT_FIELDS = [
  'id',
  'name',
  'hero',
  'titleA',
  'titleB',
  'tagline',
  'primary',
  'avatar',
  'faceTexture',
  'faceBlockName',
];
