'use client';

import { useEffect, useState, type CSSProperties, type ChangeEvent, type FormEvent } from 'react';
import { t } from '../../lib/i18n';
import type { Tenant } from '../../lib/builtins';
import type { ScoreEntry } from '../../lib/api';

const EMPTY: Tenant = {
  id: '', name: '', hero: '', titleA: '', titleB: '',
  tagline: '', primary: '#ffd23f', avatar: '', faceTexture: '', faceBlockName: '',
};

const FIELDS: [keyof Tenant, string][] = [
  ['id', 'admin.field_id'],
  ['name', 'admin.field_name'],
  ['hero', 'admin.field_hero'],
  ['titleA', 'admin.field_titleA'],
  ['titleB', 'admin.field_titleB'],
  ['primary', 'admin.field_primary'],
  ['avatar', 'admin.field_avatar'],
  ['faceTexture', 'admin.field_face_texture'],
  ['faceBlockName', 'admin.field_face_block_name'],
  ['tagline', 'admin.field_tagline'],
];

const PAGE_SIZE = 8;

interface SaveResponse { name: string; error?: string; field?: string }
interface UploadResponse { url: string; error?: string }
interface OnlinePlayer { id: number; name: string; x: number; y: number; z: number; ping_ms: number }
interface RoomSnapshot { tenant: string; players: OnlinePlayer[] }
interface AdminStats { room_list: RoomSnapshot[] }
interface OnlineRow { tenant: string; player: OnlinePlayer }

const UPLOAD_FIELD: Partial<Record<keyof Tenant, 'avatar' | 'face'>> = {
  avatar: 'avatar',
  faceTexture: 'face',
};

const UPLOAD_ACCEPT = 'image/png,image/jpeg,image/webp';
const TENANT_ID = /^[a-z0-9-]{2,32}$/;

// The admin panel must live on the root domain, never on a tenant subdomain (teo.localhost, ...).
function onTenantSubdomain(): boolean {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return false;
  if (host.endsWith('.localhost')) return true;
  const parts = host.split('.');
  return parts.length >= 3 && parts[0] !== 'www';
}

export default function Admin() {
  const [blocked, setBlocked] = useState(false);
  const [key, setKey] = useState('');
  const [authed, setAuthed] = useState(false);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [view, setView] = useState<'list' | 'edit'>('list');
  const [page, setPage] = useState(0);
  const [form, setForm] = useState<Tenant>(EMPTY);
  const [msg, setMsg] = useState('');
  const [online, setOnline] = useState<OnlineRow[]>([]);
  const [bans, setBans] = useState<string[]>([]);
  const [boardTenant, setBoardTenant] = useState('');
  const [board, setBoard] = useState<ScoreEntry[]>([]);

  // Let the admin page scroll (the game's global CSS pins body overflow to hidden).
  useEffect(() => {
    setBlocked(onTenantSubdomain());
    const saved = localStorage.getItem('bl-admin-key');
    if (saved) setKey(saved);
    const prev = { overflow: document.body.style.overflow, height: document.body.style.height };
    document.body.style.overflow = 'auto';
    document.body.style.height = 'auto';
    return () => { document.body.style.overflow = prev.overflow; document.body.style.height = prev.height; };
  }, []);

  async function load(k = key) {
    const res = await fetch('/api/admin/tenants', { headers: { 'x-admin-key': k } });
    if (res.status === 401) { setMsg(t('admin.invalid_key')); setAuthed(false); return; }
    setTenants((await res.json()) as Tenant[]);
    setAuthed(true);
    setMsg('');
    localStorage.setItem('bl-admin-key', k);
    loadOnline(k);
    loadBans(k);
  }

  async function loadOnline(k = key) {
    const res = await fetch('/api/admin/online', { headers: { 'x-admin-key': k } });
    if (!res.ok) { setMsg(t('mod.error', { error: String(res.status) })); return; }
    const stats = (await res.json()) as AdminStats;
    setOnline(stats.room_list.flatMap((room) => room.players.map((player) => ({ tenant: room.tenant, player }))));
  }

  async function loadBans(k = key) {
    const res = await fetch('/api/admin/bans', { headers: { 'x-admin-key': k } });
    if (!res.ok) { setMsg(t('mod.error', { error: String(res.status) })); return; }
    setBans((await res.json()) as string[]);
  }

  async function moderate(action: 'ban' | 'unban', ip: string) {
    const res = await fetch(`/api/admin/${action}`, {
      method: 'POST',
      headers: { 'x-admin-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ ip }),
    });
    if (!res.ok) { setMsg(t('mod.error', { error: String(res.status) })); return; }
    setBans((await res.json()) as string[]);
  }

  function promptBan() {
    const ip = prompt(t('mod.ban_prompt'));
    if (ip) moderate('ban', ip.trim());
  }

  async function loadBoard() {
    if (boardTenant.trim() === '') return;
    const res = await fetch(`/api/leaderboard/${boardTenant.trim()}`);
    if (!res.ok) { setMsg(t('mod.error', { error: String(res.status) })); return; }
    setBoard((await res.json()) as ScoreEntry[]);
  }

  function startEdit(tenant: Tenant) { setForm(tenant); setMsg(''); setView('edit'); }
  function startNew() { setForm(EMPTY); setMsg(''); setView('edit'); }
  function backToList() { setForm(EMPTY); setMsg(''); setView('list'); }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const res = await fetch('/api/admin/tenants', {
      method: 'POST',
      headers: { 'x-admin-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });
    const data = (await res.json()) as SaveResponse;
    if (!res.ok) { setMsg(t('admin.error', { error: `${data.error}${data.field ? ' (' + data.field + ')' : ''}` })); return; }
    await load();
    backToList();
  }

  async function remove(id: string) {
    if (!confirm(t('admin.confirm_delete', { id }))) return;
    await fetch(`/api/admin/tenants/${id}`, { method: 'DELETE', headers: { 'x-admin-key': key } });
    await load();
    backToList();
  }

  const set = (field: keyof Tenant) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [field]: e.target.value });

  async function upload(field: keyof Tenant, kind: 'avatar' | 'face', file: File) {
    if (!TENANT_ID.test(form.id)) { setMsg(t('admin.upload_needs_id')); return; }
    const data = new FormData();
    data.set('tenantId', form.id);
    data.set('kind', kind);
    data.set('file', file);
    setMsg(t('admin.uploading'));
    const res = await fetch('/api/admin/uploads', { method: 'POST', headers: { 'x-admin-key': key }, body: data });
    const result = (await res.json()) as UploadResponse;
    if (!res.ok) { setMsg(t('admin.error', { error: String(result.error) })); return; }
    setForm((current) => ({ ...current, [field]: result.url }));
    setMsg(t('admin.uploaded'));
  }

  const pickFile = (field: keyof Tenant, kind: 'avatar' | 'face') => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload(field, kind, file);
    e.target.value = '';
  };

  if (blocked) {
    return (
      <main style={S.wrap}>
        <h1 style={S.h1}>{t('admin.root_only_title')}</h1>
        <p style={{ color: '#9aa' }}>{t('admin.root_only_hint')}</p>
      </main>
    );
  }

  if (!authed) {
    return (
      <main style={S.wrap}>
        <h1 style={S.h1}>{t('admin.login_title')}</h1>
        <p style={{ color: '#9aa' }}>{t('admin.login_hint')}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={S.input} type="password" placeholder={t('admin.key_placeholder')} value={key}
            onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} />
          <button style={S.btn} onClick={() => load()}>{t('admin.enter')}</button>
        </div>
        {msg && <p style={{ color: '#ff7a7a' }}>{msg}</p>}
      </main>
    );
  }

  if (view === 'edit') {
    const editing = form.id !== '' && tenants.some((tenant) => tenant.id === form.id);
    return (
      <main style={S.wrap}>
        <button style={S.small} onClick={backToList}>{t('admin.back')}</button>
        <h1 style={{ ...S.h1, marginTop: 14 }}>{editing ? t('admin.edit_tenant') : t('admin.new_tenant')}</h1>
        {msg && <p style={{ color: '#7ad' }}>{msg}</p>}
        <form onSubmit={save} style={{ display: 'grid', gap: 10, maxWidth: 560 }}>
          {FIELDS.map(([f, labelKey]) => (
            <label key={f} style={{ display: 'grid', gap: 4 }}>
              <span style={{ color: '#9aa', fontSize: 13 }}>{t(labelKey)}</span>
              {f === 'tagline'
                ? <textarea style={{ ...S.input, height: 70 }} value={form[f]} onChange={set(f)} />
                : <input style={S.input} value={form[f]} onChange={set(f)} />}
              {UPLOAD_FIELD[f] && (
                <input style={S.file} type="file" accept={UPLOAD_ACCEPT} onChange={pickFile(f, UPLOAD_FIELD[f]!)} />
              )}
            </label>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button style={S.btn} type="submit">{t('admin.save_tenant')}</button>
            {editing && (
              <button style={{ ...S.small, color: '#ff7a7a' }} type="button" onClick={() => remove(form.id)}>{t('admin.delete')}</button>
            )}
            <button style={S.small} type="button" onClick={backToList}>{t('admin.back')}</button>
          </div>
        </form>
      </main>
    );
  }

  const pageCount = Math.max(1, Math.ceil(tenants.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const shown = tenants.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  return (
    <main style={S.wrap}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 style={{ ...S.h1, flex: 1, marginBottom: 0 }}>{t('admin.tenants_title')}</h1>
        <button style={S.btn} onClick={startNew}>{t('admin.new_tenant')}</button>
      </div>
      {msg && <p style={{ color: '#7ad' }}>{msg}</p>}

      <div style={{ display: 'grid', gap: 8, margin: '16px 0 10px' }}>
        {shown.map((tenant) => (
          <div key={tenant.id} style={S.row}>
            <img src={tenant.avatar} alt="" width={36} height={36} style={{ borderRadius: 8, background: '#222' }} />
            <div style={{ flex: 1 }}>
              <b style={{ color: tenant.primary }}>{tenant.name}</b>
              <span style={{ color: '#789', marginLeft: 8 }}>/{tenant.id} · {tenant.hero}</span>
            </div>
            <a style={S.link} href={`/?tenant=${tenant.id}`} target="_blank" rel="noreferrer">{t('admin.open')}</a>
            <button style={S.small} onClick={() => startEdit(tenant)}>{t('admin.edit')}</button>
          </div>
        ))}
      </div>

      {pageCount > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 30 }}>
          <button style={S.small} disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>{t('admin.prev')}</button>
          <span style={{ color: '#9aa', fontSize: 13 }}>{t('admin.page_of', { page: safePage + 1, total: pageCount })}</span>
          <button style={S.small} disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>{t('admin.next')}</button>
        </div>
      )}

      <h2 style={{ ...S.h1, fontSize: 18, marginTop: 20 }}>{t('mod.title')}</h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <b style={{ flex: 1 }}>{t('mod.online_title')}</b>
        <button style={S.small} onClick={() => loadOnline()}>{t('mod.refresh')}</button>
        <button style={{ ...S.small, color: '#ff7a7a' }} onClick={promptBan}>{t('mod.ban')}</button>
      </div>
      {online.length === 0
        ? <p style={{ color: '#789', marginBottom: 28 }}>{t('mod.online_empty')}</p>
        : (
          <table style={S.table}>
            <thead><tr>
              <th style={S.th}>{t('mod.col_tenant')}</th>
              <th style={S.th}>{t('mod.col_name')}</th>
              <th style={S.th}>{t('mod.col_position')}</th>
              <th style={S.th}>{t('mod.col_ping')}</th>
            </tr></thead>
            <tbody>
              {online.map(({ tenant, player }) => (
                <tr key={`${tenant}-${player.id}`}>
                  <td style={S.td}>{tenant}</td>
                  <td style={S.td}>{player.name}</td>
                  <td style={S.td}>{Math.round(player.x)}, {Math.round(player.y)}, {Math.round(player.z)}</td>
                  <td style={S.td}>{player.ping_ms}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '28px 0 10px' }}>
        <b style={{ flex: 1 }}>{t('mod.bans_title')}</b>
        <button style={S.small} onClick={() => loadBans()}>{t('mod.refresh')}</button>
      </div>
      {bans.length === 0
        ? <p style={{ color: '#789', marginBottom: 28 }}>{t('mod.bans_empty')}</p>
        : (
          <div style={{ display: 'grid', gap: 8, marginBottom: 28 }}>
            {bans.map((ip) => (
              <div key={ip} style={S.row}>
                <code style={{ flex: 1, color: '#e8e8f0' }}>{ip}</code>
                <button style={S.small} onClick={() => moderate('unban', ip)}>{t('mod.unban')}</button>
              </div>
            ))}
          </div>
        )}

      <h2 style={{ ...S.h1, fontSize: 18, marginTop: 8 }}>{t('leaderboard.title')}</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, maxWidth: 560 }}>
        <input style={{ ...S.input, flex: 1 }} placeholder={t('leaderboard.tenant_label')}
          value={boardTenant} onChange={(e) => setBoardTenant(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && loadBoard()} />
        <button style={S.btn} onClick={loadBoard}>{t('leaderboard.load')}</button>
      </div>
      {board.length === 0
        ? <p style={{ color: '#789' }}>{t('leaderboard.empty')}</p>
        : (
          <table style={S.table}>
            <thead><tr>
              <th style={S.th}>{t('leaderboard.col_rank')}</th>
              <th style={S.th}>{t('leaderboard.col_name')}</th>
              <th style={S.th}>{t('leaderboard.col_score')}</th>
            </tr></thead>
            <tbody>
              {board.map((entry, index) => (
                <tr key={`${entry.name}-${index}`}>
                  <td style={S.td}>{index + 1}</td>
                  <td style={S.td}>{entry.name}</td>
                  <td style={S.td}>{entry.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </main>
  );
}

const S: Record<string, CSSProperties> = {
  wrap: { minHeight: '100vh', background: '#0e0e16', color: '#e8e8f0', fontFamily: 'system-ui, sans-serif', padding: 28 },
  h1: { fontWeight: 800, marginBottom: 12 },
  input: { background: '#1a1a26', border: '1px solid #333', borderRadius: 8, color: '#fff', padding: '10px 12px', fontSize: 14 },
  btn: { background: '#3dc6ff', color: '#06121a', border: 0, borderRadius: 8, padding: '10px 18px', fontWeight: 800, cursor: 'pointer' },
  small: { background: 'transparent', color: '#9cf', border: '1px solid #345', borderRadius: 8, padding: '6px 12px', cursor: 'pointer' },
  link: { color: '#9cf', textDecoration: 'none', padding: '6px 10px', fontSize: 14 },
  file: { color: '#9aa', fontSize: 12 },
  row: { display: 'flex', alignItems: 'center', gap: 10, background: '#15151f', border: '1px solid #262633', borderRadius: 10, padding: 10 },
  table: { width: '100%', maxWidth: 720, borderCollapse: 'collapse', marginBottom: 28, background: '#15151f', border: '1px solid #262633', borderRadius: 10, overflow: 'hidden' },
  th: { textAlign: 'left', color: '#9aa', fontSize: 13, padding: '10px 12px', borderBottom: '1px solid #262633' },
  td: { color: '#e8e8f0', fontSize: 14, padding: '8px 12px', borderBottom: '1px solid #1d1d28' },
};
