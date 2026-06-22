// Bundles ONE tenant into the build as the offline source. Fetches the public proxy
// GET ${SITE_URL}/api/tenants/<id> and writes it to apps/web/public/tenant.json, which
// resolveTenant() reads when the data API is unreachable. The file is a generated build
// artifact (gitignored), NOT hardcoded content. Run before `next build` (or locally now).
//   SITE_URL=http://localhost:3000 BUNDLE_TENANT=acme node scripts/bundle-tenant.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DEFAULT_SITE_URL = 'http://localhost:3000';
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public');

function tenantId() {
  const id = process.env.BUNDLE_TENANT;
  if (!id) throw new Error('bundle-tenant: BUNDLE_TENANT is not set');
  return id;
}

async function main() {
  const id = tenantId();
  const siteUrl = process.env.SITE_URL || DEFAULT_SITE_URL;
  const endpoint = `${siteUrl}/api/tenants/${encodeURIComponent(id)}`;
  const response = await fetch(endpoint, { cache: 'no-store' });
  if (!response.ok) throw new Error(`bundle-tenant: ${endpoint} returned ${response.status}`);
  const tenant = await response.json();
  mkdirSync(PUBLIC_DIR, { recursive: true });
  const out = join(PUBLIC_DIR, 'tenant.json');
  writeFileSync(out, `${JSON.stringify(tenant, null, 2)}\n`);
  console.log(`[bundle-tenant] wrote ${out} (${tenant.id} — ${tenant.name})`);
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
