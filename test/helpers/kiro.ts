// How Kiro reads the authorities of this extension, as far as tests need it.

/**
 * The name Kiro (1.5.11) shows when it asks whether to trust a remote: `hostName` of the JSON in
 * the authority's hex, if it has only the characters it accepts; else the whole authority.
 */
export function kiroTrustName(authority: string): string {
  const hex = authority.slice(authority.indexOf('+') + 1);
  const payload = JSON.parse(Buffer.from(hex, 'hex').toString('utf8')) as { hostName?: unknown };
  const name = payload.hostName;
  return typeof name === 'string' && /^[A-Za-z0-9._~:\-[\]]+(?: [A-Za-z0-9._~:\-[\]]+)*$/.test(name)
    ? name
    : authority;
}
