import { BrowserVoice, SpeechPlayer } from './audio';

/** One player per tab, so audio unlocked by a click on the readiness page stays unlocked. */
export const speechPlayer = new SpeechPlayer();

/** On-device browser voice, used when the server voice is unavailable or fails. */
export const browserVoice = new BrowserVoice();

export type VoiceSource = 'server' | 'browser' | 'none';

/**
 * Speaks one interviewer line: the server voice (Piper) when the server offers it, otherwise —
 * or if it fails — the browser's on-device voice. Resolves with the source used ('none' when
 * neither could play; the question is always shown as text too).
 */
export async function speakLine(
  serverAvailable: boolean,
  fetchAudio: () => Promise<ArrayBuffer>,
  text: string,
): Promise<VoiceSource> {
  if (serverAvailable) {
    try {
      await speechPlayer.play(await fetchAudio());
      return 'server';
    } catch {
      /* fall back to the browser voice below */
    }
  }
  try {
    await browserVoice.speak(text);
    return 'browser';
  } catch {
    return 'none';
  }
}

/** Output level of whichever voice is speaking (for the avatar). */
export function voiceLevel(): number {
  return Math.max(speechPlayer.level(), browserVoice.level());
}

export function stopVoices(): void {
  speechPlayer.stop();
  browserVoice.stop();
}
