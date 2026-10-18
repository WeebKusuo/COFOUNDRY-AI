// Starts the local speech service for development with the settings from .env. Used by
// `npm run dev`; when speech is not set up it explains how to enable it and exits cleanly, so the
// server and web app keep running (questions then use the browser voice and answers are typed).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fromRoot, readEnvFile, root, speechDir, venvPython } from './speech-common.mjs';

const fileEnv = readEnvFile();
const env = { ...fileEnv, ...process.env };
const tag = '[speech]';

function notReady(reason) {
  console.log(
    `${tag} ${reason}\n${tag} Voice answers are off (answers are typed) and questions use the ` +
      `browser voice.\n${tag} To enable speech-to-text and the server voice: npm run speech:setup`,
  );
  process.exit(0);
}

if (env.SPEECH_PROVIDER !== 'http') {
  notReady(`Not started: SPEECH_PROVIDER=${env.SPEECH_PROVIDER ?? 'disabled'} in .env.`);
}
if (!fs.existsSync(venvPython())) {
  notReady('Not started: services/speech/.venv does not exist yet.');
}
if (!env.SPEECH_SERVICE_TOKEN || env.SPEECH_SERVICE_TOKEN.length < 32) {
  notReady('Not started: SPEECH_SERVICE_TOKEN (32+ characters) is missing in .env.');
}

let port = '8765';
let host = '127.0.0.1';
try {
  const u = new URL(env.SPEECH_SERVICE_URL ?? 'http://127.0.0.1:8765');
  port = u.port || port;
  host = u.hostname || host;
} catch {
  /* keep the defaults */
}

const childEnv = {
  ...env,
  SPEECH_HOST: env.SPEECH_HOST ?? host,
  SPEECH_PORT: env.SPEECH_PORT ?? port,
  ...(env.PIPER_VOICE ? { PIPER_VOICE: fromRoot(env.PIPER_VOICE) } : {}),
  ...(env.WHISPER_DOWNLOAD_ROOT
    ? { WHISPER_DOWNLOAD_ROOT: fromRoot(env.WHISPER_DOWNLOAD_ROOT) }
    : {}),
  PYTHONUNBUFFERED: '1',
};
if (!childEnv.PIPER_VOICE || !fs.existsSync(childEnv.PIPER_VOICE)) {
  console.log(
    `${tag} No Piper voice found (PIPER_VOICE). Speech-to-text still works; questions use the ` +
      'browser voice. Run npm run speech:setup to download one.',
  );
}

console.log(
  `${tag} Starting on http://${childEnv.SPEECH_HOST}:${childEnv.SPEECH_PORT} ` +
    `(${path.relative(root, speechDir)}). The first start may take a minute to load the model.`,
);
const child = spawn(venvPython(), ['-m', 'cofoundry_speech'], {
  cwd: speechDir,
  env: childEnv,
  stdio: 'inherit',
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => {
  if (signal || code === 0) process.exit(0);
  console.error(
    `${tag} The speech service stopped (exit code ${code}). Voice answers are unavailable until ` +
      'it runs; fix the error above and run npm run speech:dev.',
  );
  // Exit 0 so `npm run dev` keeps the server and web app running.
  process.exit(0);
});
