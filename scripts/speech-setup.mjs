// One-time local setup of the speech service (faster-whisper speech-to-text + Piper voice):
// creates services/speech/.venv, installs the pinned Python packages, downloads the Piper voice
// and the Whisper model, and enables the service in .env (SPEECH_PROVIDER=http plus a generated
// SPEECH_SERVICE_TOKEN). Everything runs on this computer; no paid API is involved.
//
// Usage: npm run speech:setup [-- --voice en_US-ljspeech-medium] [--model small.en]
//        [--skip-models] [--no-env]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_VOICE,
  DEFAULT_WHISPER_MODEL,
  envFile,
  getEnvValue,
  modelsDir,
  root,
  setEnvValue,
  speechDir,
  venvDir,
  venvPython,
} from './speech-common.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const voice = arg('voice', DEFAULT_VOICE);
const whisperModel = arg('model', DEFAULT_WHISPER_MODEL);
const whisperRoot = path.join(modelsDir, 'whisper');

function run(cmd, args, opts = {}) {
  console.log(`\n> ${[cmd, ...args].join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: speechDir, ...opts });
  if (res.error || res.status !== 0) {
    console.error(`\nSpeech setup failed at: ${[cmd, ...args].join(' ')}`);
    if (res.error) console.error(res.error.message);
    process.exit(1);
  }
}

/** First Python >= 3.9 on PATH (python3, python, or the Windows "py -3" launcher). */
function findPython() {
  const candidates =
    process.platform === 'win32'
      ? [
          ['py', ['-3']],
          ['python', []],
          ['python3', []],
        ]
      : [
          ['python3', []],
          ['python', []],
        ];
  for (const [cmd, pre] of candidates) {
    const res = spawnSync(
      cmd,
      [...pre, '-c', 'import sys; print(sys.version_info[:2] >= (3, 9))'],
      {
        encoding: 'utf8',
      },
    );
    if (res.status === 0 && res.stdout.trim() === 'True') return [cmd, pre];
  }
  return null;
}

if (!fs.existsSync(venvPython())) {
  const py = findPython();
  if (!py) {
    console.error(
      'Python 3.9 or newer is required. Install it from https://www.python.org/ and retry.',
    );
    process.exit(1);
  }
  run(py[0], [...py[1], '-m', 'venv', venvDir]);
} else {
  console.log(`Using the existing virtualenv at ${path.relative(root, venvDir)}`);
}
run(venvPython(), [
  '-m',
  'pip',
  'install',
  '--disable-pip-version-check',
  '-r',
  'requirements.txt',
]);

const voiceFile = path.join(modelsDir, `${voice}.onnx`);
if (has('skip-models')) {
  console.log('\nSkipping model downloads (--skip-models).');
} else {
  fs.mkdirSync(modelsDir, { recursive: true });
  if (fs.existsSync(voiceFile) && fs.existsSync(`${voiceFile}.json`)) {
    console.log(`\nPiper voice already present: ${path.relative(root, voiceFile)}`);
  } else {
    run(venvPython(), ['-m', 'piper.download_voices', voice, '--data-dir', modelsDir]);
  }
  // Download the Whisper model now, so the first answer is not delayed by a large download.
  run(venvPython(), [
    '-c',
    'import sys; from faster_whisper import WhisperModel; ' +
      'WhisperModel(sys.argv[1], device="cpu", compute_type="int8", download_root=sys.argv[2]); ' +
      'print("Whisper model ready:", sys.argv[1])',
    whisperModel,
    whisperRoot,
  ]);
}

if (has('no-env')) {
  console.log('\nNot changing .env (--no-env).');
} else {
  let text = fs.existsSync(envFile)
    ? fs.readFileSync(envFile, 'utf8')
    : fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const changed = [];
  const set = (key, value) => {
    text = setEnvValue(text, key, value);
    changed.push(key);
  };
  // Only fill what is missing; your own values are kept (except SPEECH_PROVIDER, which this
  // command exists to switch on, and values you pass as options).
  const token = getEnvValue(text, 'SPEECH_SERVICE_TOKEN');
  if (getEnvValue(text, 'SPEECH_PROVIDER') !== 'http') set('SPEECH_PROVIDER', 'http');
  if (!getEnvValue(text, 'SPEECH_SERVICE_URL')) set('SPEECH_SERVICE_URL', 'http://127.0.0.1:8765');
  if (!token || token.length < 32) set('SPEECH_SERVICE_TOKEN', randomBytes(24).toString('hex'));
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  if (fs.existsSync(voiceFile) && (has('voice') || !getEnvValue(text, 'PIPER_VOICE'))) {
    set('PIPER_VOICE', rel(voiceFile));
  }
  if (has('model') || !getEnvValue(text, 'WHISPER_MODEL')) set('WHISPER_MODEL', whisperModel);
  if (!has('skip-models') && !getEnvValue(text, 'WHISPER_DOWNLOAD_ROOT')) {
    set('WHISPER_DOWNLOAD_ROOT', rel(whisperRoot));
  }
  fs.writeFileSync(envFile, text);
  console.log(
    `\nUpdated ${path.relative(root, envFile)}: ${changed.length ? changed.join(', ') : 'nothing to change'}.`,
  );
}

console.log(
  '\nSpeech service ready. `npm run dev` now starts it with the server and web app ' +
    '(or run it alone with `npm run speech:dev`).',
);
