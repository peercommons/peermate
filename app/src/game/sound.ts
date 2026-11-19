// Game sounds (original, synthesized by tools/make-sounds.mjs). They mix with
// whatever else is playing and follow the iPhone's silent switch. Players are
// created on first use and kept, so a sound starts without loading delay.
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

const FILES = {
  move: require('../../assets/sounds/move.wav'),
  capture: require('../../assets/sounds/capture.wav'),
  check: require('../../assets/sounds/check.wav'),
  start: require('../../assets/sounds/start.wav'),
  end: require('../../assets/sounds/end.wav'),
  lowtime: require('../../assets/sounds/lowtime.wav'),
} as const;

export type SoundName = keyof typeof FILES;

const players: Partial<Record<SoundName, AudioPlayer>> = {};
let modeSet = false;

export function playSound(name: SoundName): void {
  try {
    if (!modeSet) {
      modeSet = true;
      // Don't stop the player's music or podcast; stay quiet when the phone is on silent.
      void setAudioModeAsync({ playsInSilentMode: false, interruptionMode: 'mixWithOthers', shouldPlayInBackground: false }).catch(
        () => undefined,
      );
    }
    const p = (players[name] ??= createAudioPlayer(FILES[name]));
    // A finished sound sits at its end: rewind first.
    if (p.currentTime > 0) void p.seekTo(0).then(() => p.play(), () => undefined);
    else p.play();
  } catch {
    // Sound is a nicety: never let it break a game.
  }
}

/** The sound for a move in SAN: check (and mate) over capture over a plain move. */
export function moveSound(san: string): SoundName {
  if (/[+#]/.test(san)) return 'check';
  return san.includes('x') ? 'capture' : 'move';
}
