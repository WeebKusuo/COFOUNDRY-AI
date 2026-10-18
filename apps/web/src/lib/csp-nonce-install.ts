// Side-effect module: import it FIRST wherever the CSP nonce hook must be active before other
// modules evaluate (ES imports are hoisted, so a call placed between imports runs too late).
import { installCspNonce } from './csp-nonce';

installCspNonce();
