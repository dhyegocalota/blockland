'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { t } from '../../lib/i18n';
import { tenantSubdomain } from '../../lib/tenants';
import type { Tenant, TenantTextField } from '../../lib/builtins';
import { DEFAULT_BRAND_COLOR } from '../../lib/engine/tenant-brand';
import type { ScoreEntry } from '../../lib/api';
import { AdminToastProvider, ToastKind, useAdminToast } from '../../components/AdminToast';
import AdminConfirmModal from '../../components/AdminConfirmModal';
import AdminSkeleton from '../../components/AdminSkeleton';
import AdminField from '../../components/AdminField';
import AdminButton, { AdminButtonVariant } from '../../components/AdminButton';
import { validateEmail, validateImage, validateIp, validateName, validateTenantId } from './validation';

// The /admin editor only manages id/name/image; the limit fields (play-time + modes) are admin-set
// at runtime from the in-game / lobby panels, so they sit here as inert defaults only to satisfy the
// type. The save route writes id/name/image and the server keeps the existing limit columns intact.
const EMPTY: Tenant = {
  id: '',
  name: '',
  image: '',
  playtime_limit_min: 0,
  playtime_window_h: 0,
  online_allowed: true,
  offline_allowed: true,
};

const PAGE_SIZE = 8;
// /admin is authenticated by the global ADMIN_KEY (x-admin-key header), NOT a per-tenant session
// claim, so the in-game admin WebSocket (use-lobby-admin → createNet, which requires a `claim`) is
// unusable here. Real-time is therefore a short-interval poll of the live data (online players +
// bans) while a tenant is open; every mutation also invalidates immediately so the UI never lags.
const LIVE_POLL_MS = 4000;
const ADMIN_KEY_STORAGE = 'bl-admin-key';

interface SaveResponse { name: string; error?: string; field?: string }
interface UploadResponse { url: string; error?: string }
interface OnlinePlayer { id: number; name: string; x: number; y: number; z: number; ping_ms: number }
interface RoomSnapshot { tenant: string; players: OnlinePlayer[] }
interface AdminStats { room_list: RoomSnapshot[] }
interface Account { name: string; email: string; is_admin: boolean; is_moderator: boolean }

type Loadable = 'loading' | 'ready';

const UPLOAD_ACCEPT = 'image/png,image/jpeg,image/webp';

export default function Admin() {
  return (
    <AdminToastProvider>
      <AdminApp />
    </AdminToastProvider>
  );
}

function AdminApp() {
  const toast = useAdminToast();
  const [blocked, setBlocked] = useState(false);
  const [key, setKey] = useState('');
  const [authed, setAuthed] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantsStatus, setTenantsStatus] = useState<Loadable>('loading');
  const [view, setView] = useState<'list' | 'edit'>('list');
  const [page, setPage] = useState(0);
  const [form, setForm] = useState<Tenant>(EMPTY);
  const [selected, setSelected] = useState<Tenant | null>(null);
  const [online, setOnline] = useState<OnlinePlayer[]>([]);
  const [onlineStatus, setOnlineStatus] = useState<Loadable>('loading');
  const [bans, setBans] = useState<string[]>([]);
  const [bansStatus, setBansStatus] = useState<Loadable>('loading');
  const [board, setBoard] = useState<ScoreEntry[]>([]);
  const [boardStatus, setBoardStatus] = useState<Loadable>('loading');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsStatus, setAccountsStatus] = useState<Loadable>('loading');
  const [grantEmail, setGrantEmail] = useState('');
  const [grantBusy, setGrantBusy] = useState(false);
  const [banIp, setBanIp] = useState('');
  const [banBusy, setBanBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [idError, setIdError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  const keyRef = useRef(key);
  keyRef.current = key;

  const error = useCallback((message: string) => toast.show({ kind: ToastKind.Error, message }), [toast]);
  const success = useCallback((message: string) => toast.show({ kind: ToastKind.Success, message }), [toast]);

  const loadTenants = useCallback(async (adminKey: string) => {
    setTenantsStatus('loading');
    const res = await fetch('/api/admin/tenants', { headers: { 'x-admin-key': adminKey } });
    if (res.status === 401) { error(t('admin.invalid_key')); setAuthed(false); return false; }
    setTenants((await res.json()) as Tenant[]);
    setTenantsStatus('ready');
    setAuthed(true);
    localStorage.setItem(ADMIN_KEY_STORAGE, adminKey);
    return true;
  }, [error]);

  useEffect(() => {
    if (tenantSubdomain()) {
      setBlocked(true);
      window.location.replace('/welcome');
      return;
    }
    const saved = localStorage.getItem(ADMIN_KEY_STORAGE);
    if (saved) { setKey(saved); loadTenants(saved); }
    const prev = { overflow: document.body.style.overflow, height: document.body.style.height };
    document.body.style.overflow = 'auto';
    document.body.style.height = 'auto';
    return () => { document.body.style.overflow = prev.overflow; document.body.style.height = prev.height; };
  }, [loadTenants]);

  async function authenticate() {
    setAuthBusy(true);
    await loadTenants(key);
    setAuthBusy(false);
  }

  function logout() {
    localStorage.removeItem(ADMIN_KEY_STORAGE);
    setKey('');
    setAuthed(false);
    setTenants([]);
    setView('list');
  }

  const loadOnline = useCallback(async (tenant: string, quiet = false) => {
    if (!quiet) setOnlineStatus('loading');
    const res = await fetch(`/api/admin/online?tenant=${encodeURIComponent(tenant)}`, { headers: { 'x-admin-key': keyRef.current } });
    if (!res.ok) { error(t('mod.error', { error: String(res.status) })); return; }
    const stats = (await res.json()) as AdminStats;
    setOnline(stats.room_list.flatMap((room) => room.players));
    setOnlineStatus('ready');
  }, [error]);

  const loadBans = useCallback(async (quiet = false) => {
    if (!quiet) setBansStatus('loading');
    const res = await fetch('/api/admin/bans', { headers: { 'x-admin-key': keyRef.current } });
    if (!res.ok) { error(t('mod.error', { error: String(res.status) })); return; }
    setBans((await res.json()) as string[]);
    setBansStatus('ready');
  }, [error]);

  const loadBoard = useCallback(async (tenant: string) => {
    setBoardStatus('loading');
    const res = await fetch(`/api/leaderboard/${tenant}`);
    if (!res.ok) { error(t('mod.error', { error: String(res.status) })); return; }
    setBoard((await res.json()) as ScoreEntry[]);
    setBoardStatus('ready');
  }, [error]);

  const loadAccounts = useCallback(async (tenant: string) => {
    setAccountsStatus('loading');
    const res = await fetch(`/api/admin/accounts/${tenant}`, { headers: { 'x-admin-key': keyRef.current } });
    if (!res.ok) { error(t('mod.error', { error: String(res.status) })); return; }
    setAccounts((await res.json()) as Account[]);
    setAccountsStatus('ready');
  }, [error]);

  // Real-time-where-possible: while a tenant is open, re-poll the live data (online players + bans)
  // on a short interval. No WebSocket — the key-authed admin has no per-tenant claim (see LIVE_POLL_MS).
  useEffect(() => {
    if (!selected) return;
    const timer = setInterval(() => {
      loadOnline(selected.id, true);
      loadBans(true);
    }, LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [selected, loadOnline, loadBans]);

  function selectTenant(tenant: Tenant) {
    setSelected(tenant);
    setOnline([]);
    setBoard([]);
    setAccounts([]);
    setGrantEmail('');
    setBanIp('');
    loadOnline(tenant.id);
    loadBans();
    loadAccounts(tenant.id);
    loadBoard(tenant.id);
  }

  function deselectTenant() {
    setSelected(null);
    setGrantEmail('');
    setBanIp('');
  }

  async function moderate(action: 'ban' | 'unban', ip: string) {
    const res = await fetch(`/api/admin/${action}`, {
      method: 'POST',
      headers: { 'x-admin-key': keyRef.current, 'content-type': 'application/json' },
      body: JSON.stringify({ ip }),
    });
    if (!res.ok) { error(t('mod.error', { error: String(res.status) })); return false; }
    setBans((await res.json()) as string[]);
    return true;
  }

  async function submitBan() {
    if (validateIp(banIp) !== null) return;
    setBanBusy(true);
    const ok = await moderate('ban', banIp.trim());
    setBanBusy(false);
    if (!ok) return;
    success(t('mod.banned', { ip: banIp.trim() }));
    setBanIp('');
  }

  async function setAdmin(target: { name: string } | { email: string }, admin: boolean) {
    if (!selected) return false;
    const res = await fetch('/api/admin/set-admin', {
      method: 'POST',
      headers: { 'x-admin-key': keyRef.current, 'content-type': 'application/json' },
      body: JSON.stringify({ tenant: selected.id, admin, ...target }),
    });
    if (!res.ok) { error(t('mod.error', { error: String(res.status) })); return false; }
    setAccounts((await res.json()) as Account[]);
    return true;
  }

  async function setModerator(target: { name: string }, moderator: boolean) {
    if (!selected) return;
    const res = await fetch('/api/admin/set-moderator', {
      method: 'POST',
      headers: { 'x-admin-key': keyRef.current, 'content-type': 'application/json' },
      body: JSON.stringify({ tenant: selected.id, moderator, ...target }),
    });
    if (!res.ok) { error(t('mod.error', { error: String(res.status) })); return; }
    setAccounts((await res.json()) as Account[]);
  }

  async function grantAdminByEmail() {
    if (validateEmail(grantEmail) !== null) return;
    setGrantBusy(true);
    const ok = await setAdmin({ email: grantEmail.trim() }, true);
    setGrantBusy(false);
    if (!ok) return;
    success(t('accounts.granted', { email: grantEmail.trim() }));
    setGrantEmail('');
  }

  function startEdit(tenant: Tenant) { setForm(tenant); setView('edit'); }
  function startNew() { setForm(EMPTY); setView('edit'); }
  function backToList() { setForm(EMPTY); setView('list'); }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (idError || nameError || imageError) return;
    setSaveBusy(true);
    const res = await fetch('/api/admin/tenants', {
      method: 'POST',
      headers: { 'x-admin-key': keyRef.current, 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });
    const data = (await res.json()) as SaveResponse;
    setSaveBusy(false);
    if (!res.ok) { error(t('admin.error', { error: `${data.error}${data.field ? ' (' + data.field + ')' : ''}` })); return; }
    success(t('admin.saved', { name: data.name }));
    await loadTenants(keyRef.current);
    backToList();
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    const res = await fetch(`/api/admin/tenants/${deleting}`, { method: 'DELETE', headers: { 'x-admin-key': keyRef.current } });
    setDeleteBusy(false);
    setDeleting(null);
    if (!res.ok) { error(t('admin.error', { error: String(res.status) })); return; }
    success(t('admin.deleted', { id: deleting }));
    await loadTenants(keyRef.current);
    backToList();
  }

  const setField = (field: TenantTextField) => (value: string) => setForm((current) => ({ ...current, [field]: value }));

  async function upload(file: File) {
    if (validateTenantId(form.id) !== null) { error(t('admin.upload_needs_id')); return; }
    const data = new FormData();
    data.set('tenantId', form.id);
    data.set('kind', 'image');
    data.set('file', file);
    setUploadBusy(true);
    const res = await fetch('/api/admin/uploads', { method: 'POST', headers: { 'x-admin-key': keyRef.current }, body: data });
    const result = (await res.json()) as UploadResponse;
    setUploadBusy(false);
    if (!res.ok) { error(t('admin.error', { error: String(result.error) })); return; }
    setForm((current) => ({ ...current, image: result.url }));
    success(t('admin.uploaded'));
  }

  function pickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) upload(file);
    event.target.value = '';
  }

  if (blocked) return null;

  if (!authed) {
    return (
      <main className="adminApp">
        <div className="adminLogin">
          <h1 className="adminTitle">{t('admin.login_title')}</h1>
          <p className="adminSubtle">{t('admin.login_hint')}</p>
          <div className="adminLoginRow">
            <input className="adminInput" type="password" placeholder={t('admin.key_placeholder')} value={key}
              onChange={(event) => setKey(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && authenticate()} />
            <AdminButton onClick={authenticate} busy={authBusy} disabled={key.trim() === ''}>{t('admin.enter')}</AdminButton>
          </div>
        </div>
      </main>
    );
  }

  if (view === 'edit') {
    const editing = form.id !== '' && tenants.some((tenant) => tenant.id === form.id);
    const invalid = idError !== null || nameError !== null || imageError !== null;
    return (
      <main className="adminApp">
        <button className="adminBtnGhost" onClick={backToList}>{t('admin.back')}</button>
        <h1 className="adminTitle adminTitleSpaced">{editing ? t('admin.edit_tenant') : t('admin.new_tenant')}</h1>
        <form onSubmit={save} className="adminForm">
          <AdminField label={t('admin.field_id')} rule={t('admin.rule_id')} value={form.id}
            validate={validateTenantId} onChange={setField('id')} onValidity={setIdError} />
          <AdminField label={t('admin.field_name')} rule={t('admin.rule_name')} value={form.name}
            validate={validateName} onChange={setField('name')} onValidity={setNameError} />
          <AdminField label={t('admin.field_image')} rule={t('admin.rule_image')} value={form.image}
            validate={validateImage} onChange={setField('image')} onValidity={setImageError} />
          <label className="adminUpload">
            <span className="adminFieldLabel">{t('admin.upload_label')}</span>
            <input className="adminFile" type="file" accept={UPLOAD_ACCEPT} onChange={pickFile} disabled={uploadBusy} />
            {uploadBusy && <span className="adminSubtle">{t('admin.uploading')}</span>}
          </label>
          {form.image !== '' && <img className="adminPreview" src={form.image} alt="" />}
          <div className="adminFormActions">
            <AdminButton type="submit" busy={saveBusy} disabled={invalid}>{t('admin.save_tenant')}</AdminButton>
            {editing && (
              <AdminButton variant={AdminButtonVariant.Danger} onClick={() => setDeleting(form.id)}>{t('admin.delete')}</AdminButton>
            )}
            <AdminButton variant={AdminButtonVariant.Ghost} onClick={backToList}>{t('admin.back')}</AdminButton>
          </div>
        </form>
        <AdminConfirmModal open={deleting !== null} title={t('admin.delete_title')}
          message={t('admin.confirm_delete', { id: deleting ?? '' })} confirmLabel={t('admin.delete')}
          busy={deleteBusy} onConfirm={confirmDelete} onCancel={() => setDeleting(null)} />
      </main>
    );
  }

  if (selected) {
    const banInvalid = validateIp(banIp) !== null;
    const grantInvalid = validateEmail(grantEmail) !== null;
    return (
      <main className="adminApp">
        <div className="adminHeader">
          <button className="adminBtnGhost" onClick={deselectTenant}>{t('admin.back_to_tenants')}</button>
          <img className="adminAvatar" src={selected.image} alt="" width={40} height={40} />
          <h1 className="adminTitle adminHeaderTitle">{t('admin.managing', { name: selected.name })}</h1>
          <button className="adminBtnGhost" onClick={() => startEdit(selected)}>{t('admin.edit')}</button>
        </div>

        <section className="adminCard">
          <div className="adminSectionHead">
            <h2 className="adminSectionTitle">{t('mod.online_title')}</h2>
            <span className="adminLiveDot" title={t('admin.live')} />
            <AdminButton variant={AdminButtonVariant.Ghost} onClick={() => loadOnline(selected.id)}>{t('mod.refresh')}</AdminButton>
          </div>
          {onlineStatus === 'loading' && <AdminSkeleton rows={3} />}
          {onlineStatus === 'ready' && online.length === 0 && <p className="adminEmpty">{t('mod.online_empty')}</p>}
          {onlineStatus === 'ready' && online.length > 0 && (
            <table className="adminTable">
              <thead><tr>
                <th>{t('mod.col_name')}</th><th>{t('mod.col_position')}</th><th>{t('mod.col_ping')}</th>
              </tr></thead>
              <tbody>
                {online.map((player) => (
                  <tr key={player.id}>
                    <td>{player.name}</td>
                    <td>{Math.round(player.x)}, {Math.round(player.y)}, {Math.round(player.z)}</td>
                    <td>{player.ping_ms}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="adminCard">
          <div className="adminSectionHead">
            <h2 className="adminSectionTitle">{t('mod.bans_title')}</h2>
            <span className="adminLiveDot" title={t('admin.live')} />
            <AdminButton variant={AdminButtonVariant.Ghost} onClick={() => loadBans()}>{t('mod.refresh')}</AdminButton>
          </div>
          <p className="adminSubtle">{t('mod.bans_note')}</p>
          <div className="adminInlineForm">
            <input className={banIp !== '' && banInvalid ? 'adminInput invalid' : 'adminInput'} placeholder={t('mod.ip_placeholder')}
              value={banIp} onChange={(event) => setBanIp(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && submitBan()} />
            <AdminButton variant={AdminButtonVariant.Danger} onClick={submitBan} busy={banBusy} disabled={banInvalid}>{t('mod.ban')}</AdminButton>
          </div>
          {banIp !== '' && banInvalid && <span className="adminFieldError">{t('mod.invalid_ip')}</span>}
          {bansStatus === 'loading' && <AdminSkeleton rows={2} />}
          {bansStatus === 'ready' && bans.length === 0 && <p className="adminEmpty">{t('mod.bans_empty')}</p>}
          {bansStatus === 'ready' && bans.length > 0 && (
            <div className="adminBanList">
              {bans.map((ip) => (
                <div key={ip} className="adminBanRow">
                  <code>{ip}</code>
                  <AdminButton variant={AdminButtonVariant.Ghost} onClick={() => moderate('unban', ip)}>{t('mod.unban')}</AdminButton>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="adminCard">
          <div className="adminSectionHead">
            <h2 className="adminSectionTitle">{t('accounts.title')}</h2>
            <AdminButton variant={AdminButtonVariant.Ghost} onClick={() => loadAccounts(selected.id)}>{t('mod.refresh')}</AdminButton>
          </div>
          <div className="adminInlineForm">
            <input className={grantEmail !== '' && grantInvalid ? 'adminInput invalid' : 'adminInput'} placeholder={t('accounts.grant_email_placeholder')}
              value={grantEmail} onChange={(event) => setGrantEmail(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && grantAdminByEmail()} />
            <AdminButton onClick={grantAdminByEmail} busy={grantBusy} disabled={grantInvalid}>{t('accounts.grant_email_button')}</AdminButton>
          </div>
          {grantEmail !== '' && grantInvalid && <span className="adminFieldError">{t('admin.invalid_email')}</span>}
          {accountsStatus === 'loading' && <AdminSkeleton rows={3} />}
          {accountsStatus === 'ready' && accounts.length === 0 && <p className="adminEmpty">{t('accounts.empty')}</p>}
          {accountsStatus === 'ready' && accounts.length > 0 && (
            <table className="adminTable">
              <thead><tr>
                <th>{t('accounts.col_name')}</th><th>{t('accounts.col_email')}</th>
                <th>{t('accounts.col_admin')}</th><th>{t('accounts.col_moderator')}</th><th></th>
              </tr></thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.email}>
                    <td>{account.name}</td>
                    <td>{account.email}</td>
                    <td>{account.is_admin ? t('accounts.is_admin') : t('accounts.not_admin')}</td>
                    <td>{account.is_moderator ? t('accounts.is_moderator') : t('accounts.not_admin')}</td>
                    <td>
                      <div className="adminRowActions">
                        <button className="adminBtnGhost" onClick={() => setAdmin({ name: account.name }, !account.is_admin)}>
                          {account.is_admin ? t('accounts.remove_admin') : t('accounts.make_admin')}
                        </button>
                        <button className="adminBtnGhost" onClick={() => setModerator({ name: account.name }, !account.is_moderator)}>
                          {account.is_moderator ? t('accounts.remove_moderator') : t('accounts.make_moderator')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="adminCard">
          <div className="adminSectionHead">
            <h2 className="adminSectionTitle">{t('leaderboard.title')}</h2>
            <AdminButton variant={AdminButtonVariant.Ghost} onClick={() => loadBoard(selected.id)}>{t('mod.refresh')}</AdminButton>
          </div>
          {boardStatus === 'loading' && <AdminSkeleton rows={3} />}
          {boardStatus === 'ready' && board.length === 0 && <p className="adminEmpty">{t('leaderboard.empty')}</p>}
          {boardStatus === 'ready' && board.length > 0 && (
            <table className="adminTable">
              <thead><tr>
                <th>{t('leaderboard.col_rank')}</th><th>{t('leaderboard.col_name')}</th><th>{t('leaderboard.col_score')}</th>
              </tr></thead>
              <tbody>
                {board.map((entry, index) => (
                  <tr key={`${entry.name}-${index}`}>
                    <td>{index + 1}</td><td>{entry.name}</td><td>{entry.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    );
  }

  const pageCount = Math.max(1, Math.ceil(tenants.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const shown = tenants.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  return (
    <main className="adminApp">
      <div className="adminHeader">
        <h1 className="adminTitle adminHeaderTitle">{t('admin.tenants_title')}</h1>
        <AdminButton onClick={startNew}>{t('admin.new_tenant')}</AdminButton>
        <button className="adminBtnGhost" onClick={logout}>{t('admin.logout')}</button>
      </div>
      <p className="adminSubtle">{t('admin.pick_tenant_hint')}</p>

      {tenantsStatus === 'loading' && <AdminSkeleton rows={5} />}
      {tenantsStatus === 'ready' && (
        <div className="adminTenantList">
          {shown.map((tenant) => (
            <button key={tenant.id} className="adminTenantRow" onClick={() => selectTenant(tenant)}>
              <img className="adminAvatar" src={tenant.image} alt="" width={40} height={40} />
              <div className="adminTenantMeta">
                <b style={{ color: DEFAULT_BRAND_COLOR }}>{tenant.name}</b>
                <span className="adminTenantId">/{tenant.id}</span>
              </div>
              <span className="adminTenantManage">{t('admin.manage')}</span>
            </button>
          ))}
        </div>
      )}

      {tenantsStatus === 'ready' && pageCount > 1 && (
        <div className="adminPager">
          <button className="adminBtnGhost" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>{t('admin.prev')}</button>
          <span className="adminSubtle">{t('admin.page_of', { page: safePage + 1, total: pageCount })}</span>
          <button className="adminBtnGhost" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>{t('admin.next')}</button>
        </div>
      )}
    </main>
  );
}
