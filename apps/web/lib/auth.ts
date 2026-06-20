// Server-only client for the internal auth routes. Reuses the HMAC signer in api.ts so every
// request is signed on the Next -> Rust channel; the browser never reaches these routes directly.
// A username is owned by ONE email WITHIN A TENANT, proven by a magic-link token or a 6-digit code.
import 'server-only';
import { signedFetch } from './api';

export type AuthError = 'not_owner' | 'invalid';

export interface AuthRequestResult {
  ok: true;
  token: string;
  code: string;
  name: string;
  email: string;
}

export interface AuthRequestFailure {
  ok: false;
  error: AuthError;
}

export interface AuthVerifyResult {
  ok: true;
  tenant: string;
  name: string;
  claim: string;
  is_admin: boolean;
  is_moderator: boolean;
}

export interface AuthVerifyFailure {
  ok: false;
}

async function postAuth(path: string, body: unknown): Promise<unknown> {
  const res = await signedFetch('POST', path, body);
  if (!res.ok) throw new Error(`auth: ${path} failed (${res.status})`);
  return res.json();
}

export async function authRequest(params: {
  tenant: string;
  name: string;
  email: string;
}): Promise<AuthRequestResult | AuthRequestFailure> {
  return (await postAuth('/internal/auth/request', params)) as AuthRequestResult | AuthRequestFailure;
}

export async function authVerifyToken(token: string): Promise<AuthVerifyResult | AuthVerifyFailure> {
  return (await postAuth('/internal/auth/verify', { token })) as AuthVerifyResult | AuthVerifyFailure;
}

export async function authVerifyCode(params: {
  tenant: string;
  name: string;
  code: string;
}): Promise<AuthVerifyResult | AuthVerifyFailure> {
  return (await postAuth('/internal/auth/verify', params)) as AuthVerifyResult | AuthVerifyFailure;
}

export async function authLogout(params: {
  tenant: string;
  name: string;
  claim: string;
}): Promise<{ ok: boolean }> {
  return (await postAuth('/internal/auth/logout', params)) as { ok: boolean };
}

export type RenameError = 'name_taken' | 'invalid';

export interface AuthRenameResult {
  ok: true;
  name: string;
}

export interface AuthRenameFailure {
  ok: false;
  error: RenameError;
}

export async function authRename(params: {
  tenant: string;
  claim: string;
  newName: string;
}): Promise<AuthRenameResult | AuthRenameFailure> {
  return (await postAuth('/internal/auth/rename', params)) as AuthRenameResult | AuthRenameFailure;
}
