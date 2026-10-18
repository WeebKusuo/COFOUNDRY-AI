// Shared helpers for the local speech-service scripts (speech-setup.mjs, speech-dev.mjs).
// Pure Node, so they work the same on Windows, macOS and Linux.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const speechDir = path.join(root, 'services', 'speech');
export const venvDir = path.join(speechDir, '.venv');
export const modelsDir = path.join(speechDir, 'models');
export const envFile = path.join(root, '.env');

export const DEFAULT_VOICE = 'en_US-ljspeech-medium';
export const DEFAULT_WHISPER_MODEL = 'small.en';

export function venvPython() {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

/** Minimal .env parser: KEY=VALUE lines, # comments, optional surrounding quotes. */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      // Unquoted values end at an inline comment (" # ..."), as with Node's --env-file.
      value = value.replace(/\s+#.*$/, '');
    }
    out[key] = value;
  }
  return out;
}

export function readEnvFile(file = envFile) {
  return fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
}

/** Value of KEY in .env text (null when absent or empty). */
export function getEnvValue(text, key) {
  const v = parseEnv(text)[key];
  return v ? v : null;
}

/**
 * Sets KEY=VALUE in .env text: replaces an existing line (commented-out lines are left alone) or
 * appends one. Returns the new text.
 */
export function setEnvValue(text, key, value) {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'm');
  const line = `${key}=${value}`;
  if (re.test(text)) return text.replace(re, line);
  return `${text.replace(/\s*$/, '')}\n${line}\n`;
}

/** Absolute path for a path written relative to the repository root. */
export function fromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(root, p);
}
