/**
 * The server sends a per-response CSP nonce in <meta name="csp-nonce" nonce="…"> (the
 * attribute value is hidden from CSS selectors and only readable through the `nonce` property).
 * The code editor creates <style> elements at runtime; tagging every style element we create
 * with that nonce lets the strict CSP (`style-src 'self' 'nonce-…'`, no 'unsafe-inline') allow
 * them. Installed once, before the editor module loads.
 */
let installed = false;

export function installCspNonce(): string | null {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]');
  const nonce = meta?.nonce || null;
  if (installed || !nonce) return nonce;
  installed = true;
  const original = document.createElement.bind(document);
  document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
    const el = original(tagName, options);
    if (tagName.toLowerCase() === 'style') el.setAttribute('nonce', nonce);
    return el;
  }) as typeof document.createElement;
  return nonce;
}
