import { LIMITS } from './constants.js';

export type HttpsUrlCheck =
  | { ok: true; url: string }
  | {
      ok: false;
      reason:
        | 'too_long'
        | 'invalid'
        | 'not_https'
        | 'credentials'
        | 'fragment'
        | 'port'
        | 'local_host'
        | 'ip_literal';
    };

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Section 23: accept user-supplied URLs only with https scheme, no credentials, no localhost,
 * no .local host, no IP literal, no fragment and no nonstandard port. Parsed with the WHATWG URL
 * parser, never substring checks. Syntax validity never means the link was fetched or verified.
 */
export function checkHttpsUrl(raw: string): HttpsUrlCheck {
  if (raw.length > LIMITS.urlMaxChars) return { ok: false, reason: 'too_long' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };
  if (url.hash !== '' || raw.includes('#')) return { ok: false, reason: 'fragment' };
  if (url.port !== '') return { ok: false, reason: 'port' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // IP literals first: the WHATWG parser canonicalises 0x7f.1, 2130706433 etc. to dotted IPv4.
  if (host.startsWith('[') || IPV4.test(host)) return { ok: false, reason: 'ip_literal' };
  if (host === '' || !host.includes('.')) return { ok: false, reason: 'local_host' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return { ok: false, reason: 'local_host' };
  }
  return { ok: true, url: url.toString() };
}
