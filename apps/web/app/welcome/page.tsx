'use client';

// Simple platform landing page: pitches Blockland and points interested people to get in touch.
// Reached directly, and where the admin panel used to refuse a tenant subdomain it redirects here.
import type { CSSProperties } from 'react';
import { currentLocale } from '../../lib/i18n';
import { PLATFORM_NAME } from '../../lib/builtins';

const CONTACT_EMAIL = 'dhyego@logicbit.com.br';

const COPY = {
  'pt-BR': {
    tagline: 'Mundos de blocos 3D, white-label, feitos pra crianças.',
    body: 'Cada cliente ganha o próprio mundo: com a marca, o nome e o rosto da criança nos blocos. Construir, caçar, derrotar monstrinhos, juntar estrelas — e jogar junto com os amigos em tempo real.',
    features: ['🧱 Construa e explore um mundo gigante', '👫 Multiplayer em tempo real', '🎨 Marca e rosto personalizados', '📱 Joga no navegador e instala no celular'],
    contactLead: 'Quer um mundo desses pra sua marca ou pro seu filho?',
    contactBtn: 'Falar com a gente',
    credit: 'Feito com 🧡 por Dhyego Calota',
  },
  'en-US': {
    tagline: 'White-label 3D voxel worlds, made for kids.',
    body: "Every client gets their own world: their brand, their name, and the kid's face on the blocks. Build, hunt, beat little monsters, collect stars — and play together with friends in real time.",
    features: ['🧱 Build and explore a huge world', '👫 Real-time multiplayer', '🎨 Custom brand and face', '📱 Plays in the browser, installs on phones'],
    contactLead: 'Want a world like this for your brand or your kid?',
    contactBtn: 'Get in touch',
    credit: 'Built with 🧡 by Dhyego Calota',
  },
};

export default function Welcome() {
  const copy = COPY[currentLocale()];
  return (
    <main style={S.wrap}>
      <div style={S.card}>
        <h1 style={S.title}>{PLATFORM_NAME}</h1>
        <p style={S.tagline}>{copy.tagline}</p>
        <p style={S.body}>{copy.body}</p>
        <ul style={S.features}>
          {copy.features.map((f) => (
            <li key={f} style={S.feature}>{f}</li>
          ))}
        </ul>
        <p style={S.contactLead}>{copy.contactLead}</p>
        <a style={S.contactBtn} href={`mailto:${CONTACT_EMAIL}`}>{copy.contactBtn} →</a>
        <a style={S.email} href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        <a style={S.credit} href="https://dhyegocalota.com.br" target="_blank" rel="noopener noreferrer">
          {copy.credit}
        </a>
      </div>
    </main>
  );
}

const S: Record<string, CSSProperties> = {
  wrap: {
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    background: 'radial-gradient(circle at 50% 25%, #bfeaff, #7ec8ff 55%, #4aa3e0)',
    fontFamily: "'Baloo 2', system-ui, sans-serif", color: '#2a1a4a',
  },
  card: {
    background: '#ffffffee', borderRadius: 28, padding: '36px 32px', maxWidth: 560, width: '100%',
    textAlign: 'center', boxShadow: '0 24px 60px #0003', border: '6px solid #fff',
  },
  title: { fontSize: 'clamp(40px, 10vw, 72px)', fontWeight: 900, color: '#ff5d2e', textShadow: '0 4px 0 #2a1a4a22', lineHeight: 1 },
  tagline: { fontSize: 20, fontWeight: 800, marginTop: 10 },
  body: { fontSize: 16, fontWeight: 600, color: '#42365a', marginTop: 14, lineHeight: 1.5 },
  features: { listStyle: 'none', display: 'grid', gap: 8, margin: '20px 0', padding: 0, textAlign: 'left' },
  feature: { background: '#f1f6ff', borderRadius: 12, padding: '10px 14px', fontWeight: 800, fontSize: 15 },
  contactLead: { fontWeight: 800, fontSize: 17, marginTop: 8 },
  contactBtn: {
    display: 'inline-block', marginTop: 14, background: 'linear-gradient(#ff8a3d, #ff5d2e)', color: '#fff',
    fontWeight: 900, fontSize: 20, textDecoration: 'none', padding: '14px 34px', borderRadius: 20,
    border: '5px solid #fff', boxShadow: '0 8px 0 #c43d18',
  },
  email: { display: 'block', marginTop: 14, color: '#3a73c2', fontWeight: 800, textDecoration: 'none' },
  credit: { display: 'block', marginTop: 18, color: '#6b5a8a', fontWeight: 700, fontSize: 13, textDecoration: 'none' },
};
