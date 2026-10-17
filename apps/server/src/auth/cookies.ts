import type { Request, Response } from 'express';

/**
 * Section 22 cookie contract. Production: __Host-cofoundry; HttpOnly; Secure; SameSite=Lax;
 * Path=/; no Domain. Development/test: cofoundry-dev without Secure (localhost only).
 * Session tokens never go to localStorage or response bodies.
 */
export interface CookieSettings {
  name: string;
  secure: boolean;
}

export function cookieSettings(isProduction: boolean): CookieSettings {
  return isProduction
    ? { name: '__Host-cofoundry', secure: true }
    : { name: 'cofoundry-dev', secure: false };
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
}

function serialize(settings: CookieSettings, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${settings.name}=${value}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (settings.secure) parts.push('Secure');
  return parts.join('; ');
}

export function setSessionCookie(
  res: Response,
  settings: CookieSettings,
  token: string,
  maxAgeSeconds: number,
): void {
  res.append('Set-Cookie', serialize(settings, token, maxAgeSeconds));
}

export function clearSessionCookie(res: Response, settings: CookieSettings): void {
  res.append('Set-Cookie', serialize(settings, '', 0));
}
