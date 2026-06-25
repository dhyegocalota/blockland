// Pure, real-time field validators for the /admin forms. Each returns an i18n message KEY when the
// value is invalid, or null when it is acceptable — so the UI can both block submit and show the rule.
const TENANT_ID = /^[a-z0-9-]{2,32}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;

export function validateTenantId(value: string): string | null {
  if (value.trim() === '') return 'admin.invalid_id_required';
  if (!TENANT_ID.test(value)) return 'admin.invalid_id';
  return null;
}

export function validateName(value: string): string | null {
  if (value.trim() === '') return 'admin.invalid_name';
  return null;
}

export function validateImage(value: string): string | null {
  if (value.trim() === '') return 'admin.invalid_image';
  return null;
}

export function validateEmail(value: string): string | null {
  if (!EMAIL.test(value.trim())) return 'admin.invalid_email';
  return null;
}

export function validateIp(value: string): string | null {
  const ip = value.trim();
  if (ip === '') return 'mod.invalid_ip';
  const ipv4 = ip.match(IPV4);
  if (ipv4) {
    const octetsInRange = ipv4.slice(1).every((octet) => Number(octet) <= 255);
    if (octetsInRange) return null;
    return 'mod.invalid_ip';
  }
  if (IPV6.test(ip)) return null;
  return 'mod.invalid_ip';
}
