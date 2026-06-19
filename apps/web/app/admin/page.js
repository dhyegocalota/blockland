'use client';

import { useEffect, useState } from 'react';

const EMPTY = {
  id: '', name: '', hero: '', titleA: '', titleB: '',
  tagline: '', primary: '#ffd23f', avatar: '', faceTexture: '', faceBlockName: '',
};

const FIELDS = [
  ['id', 'ID / subdomínio (a-z, 0-9, -)'],
  ['name', 'Nome da marca'],
  ['hero', 'Herói (ex.: nome da criança)'],
  ['titleA', 'Título — parte branca'],
  ['titleB', 'Título — parte colorida'],
  ['primary', 'Cor primária (hex)'],
  ['avatar', 'URL do avatar'],
  ['faceTexture', 'URL da textura do rosto'],
  ['faceBlockName', 'Nome do bloco-rosto'],
  ['tagline', 'Frase de abertura (aceita <b>)'],
];

export default function Admin() {
  const [key, setKey] = useState('');
  const [authed, setAuthed] = useState(false);
  const [tenants, setTenants] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem('bl-admin-key');
    if (saved) setKey(saved);
  }, []);

  async function load(k = key) {
    const res = await fetch('/api/admin/tenants', { headers: { 'x-admin-key': k } });
    if (res.status === 401) { setMsg('Chave inválida'); setAuthed(false); return; }
    setTenants(await res.json());
    setAuthed(true);
    setMsg('');
    localStorage.setItem('bl-admin-key', k);
  }

  async function save(e) {
    e.preventDefault();
    const res = await fetch('/api/admin/tenants', {
      method: 'POST',
      headers: { 'x-admin-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}${data.field ? ' (' + data.field + ')' : ''}`); return; }
    setMsg(`Salvo: ${data.name}`);
    setForm(EMPTY);
    load();
  }

  async function remove(id) {
    if (!confirm(`Excluir o tenant "${id}"?`)) return;
    await fetch(`/api/admin/tenants/${id}`, { method: 'DELETE', headers: { 'x-admin-key': key } });
    load();
  }

  const set = (f) => (e) => setForm({ ...form, [f]: e.target.value });

  if (!authed) {
    return (
      <main style={S.wrap}>
        <h1 style={S.h1}>🔐 Blocklandia — Admin</h1>
        <p style={{ color: '#9aa' }}>Entre com a chave de admin.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={S.input} type="password" placeholder="admin key" value={key}
            onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} />
          <button style={S.btn} onClick={() => load()}>Entrar</button>
        </div>
        {msg && <p style={{ color: '#ff7a7a' }}>{msg}</p>}
      </main>
    );
  }

  return (
    <main style={S.wrap}>
      <h1 style={S.h1}>🧱 Tenants</h1>
      {msg && <p style={{ color: '#7ad' }}>{msg}</p>}

      <div style={{ display: 'grid', gap: 8, marginBottom: 28 }}>
        {tenants.map((t) => (
          <div key={t.id} style={S.row}>
            <img src={t.avatar} alt="" width={36} height={36} style={{ borderRadius: 8, background: '#222' }} />
            <div style={{ flex: 1 }}>
              <b style={{ color: t.primary }}>{t.name}</b>
              <span style={{ color: '#789', marginLeft: 8 }}>/{t.id} · {t.hero}</span>
            </div>
            <a style={S.link} href={`/?tenant=${t.id}`} target="_blank" rel="noreferrer">abrir</a>
            <button style={S.small} onClick={() => setForm(t)}>editar</button>
            <button style={{ ...S.small, color: '#ff7a7a' }} onClick={() => remove(t.id)}>excluir</button>
          </div>
        ))}
      </div>

      <h2 style={{ ...S.h1, fontSize: 18 }}>{form.id ? `Editar / criar` : 'Novo tenant'}</h2>
      <form onSubmit={save} style={{ display: 'grid', gap: 10, maxWidth: 560 }}>
        {FIELDS.map(([f, label]) => (
          <label key={f} style={{ display: 'grid', gap: 4 }}>
            <span style={{ color: '#9aa', fontSize: 13 }}>{label}</span>
            {f === 'tagline'
              ? <textarea style={{ ...S.input, height: 70 }} value={form[f]} onChange={set(f)} />
              : <input style={S.input} value={form[f]} onChange={set(f)} />}
          </label>
        ))}
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={S.btn} type="submit">Salvar tenant</button>
          <button style={S.small} type="button" onClick={() => setForm(EMPTY)}>Limpar</button>
        </div>
      </form>
    </main>
  );
}

const S = {
  wrap: { minHeight: '100vh', background: '#0e0e16', color: '#e8e8f0', fontFamily: 'system-ui, sans-serif', padding: 28, overflowY: 'auto' },
  h1: { fontWeight: 800, marginBottom: 12 },
  input: { background: '#1a1a26', border: '1px solid #333', borderRadius: 8, color: '#fff', padding: '10px 12px', fontSize: 14 },
  btn: { background: '#3dc6ff', color: '#06121a', border: 0, borderRadius: 8, padding: '10px 18px', fontWeight: 800, cursor: 'pointer' },
  small: { background: 'transparent', color: '#9cf', border: '1px solid #345', borderRadius: 8, padding: '6px 12px', cursor: 'pointer' },
  link: { color: '#9cf', textDecoration: 'none', padding: '6px 10px', fontSize: 14 },
  row: { display: 'flex', alignItems: 'center', gap: 10, background: '#15151f', border: '1px solid #262633', borderRadius: 10, padding: 10 },
};
