import { describe, expect, it } from 'vitest';
import { validateEmail, validateImage, validateIp, validateName, validateTenantId } from './validation';

describe('admin validation', () => {
  it('accepts valid tenant ids and rejects bad ones', () => {
    expect(validateTenantId('acme-1')).toBeNull();
    expect(validateTenantId('a')).toBe('admin.invalid_id');
    expect(validateTenantId('UPPER')).toBe('admin.invalid_id');
    expect(validateTenantId('with space')).toBe('admin.invalid_id');
    expect(validateTenantId('')).toBe('admin.invalid_id_required');
  });

  it('requires name and image', () => {
    expect(validateName('Acme')).toBeNull();
    expect(validateName('   ')).toBe('admin.invalid_name');
    expect(validateImage('https://x/y.png')).toBeNull();
    expect(validateImage('')).toBe('admin.invalid_image');
  });

  it('validates email format', () => {
    expect(validateEmail('maria@example.com')).toBeNull();
    expect(validateEmail('maria@no-dot')).toBe('admin.invalid_email');
    expect(validateEmail('plainword')).toBe('admin.invalid_email');
  });

  it('validates IPv4 and IPv6, rejecting junk', () => {
    expect(validateIp('1.2.3.4')).toBeNull();
    expect(validateIp('255.255.255.255')).toBeNull();
    expect(validateIp('256.0.0.1')).toBe('mod.invalid_ip');
    expect(validateIp('::1')).toBeNull();
    expect(validateIp('2001:db8::1')).toBeNull();
    expect(validateIp('not-an-ip')).toBe('mod.invalid_ip');
    expect(validateIp('')).toBe('mod.invalid_ip');
  });
});
