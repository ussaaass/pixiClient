export const PracticeSoundEvent = {
  CARD_SELECT: 'CARD_SELECT',
  CARD_PLACE: 'CARD_PLACE',
  CARD_RETURN: 'CARD_RETURN',
  AUTO_ARRANGE: 'AUTO_ARRANGE',
  REDEAL: 'REDEAL',
  ROUND_WIN: 'ROUND_WIN',
  ROUND_LOSS: 'ROUND_LOSS',
  ROUND_TIE: 'ROUND_TIE',
  INVALID_ACTION: 'INVALID_ACTION',
} as const;

export type PracticeSoundEvent = typeof PracticeSoundEvent[keyof typeof PracticeSoundEvent];

export interface PracticeAudioPort {
  play(event: PracticeSoundEvent): void;
  dispose(): Promise<void>;
}

interface Tone {
  readonly frequency: number;
  readonly delaySeconds?: number;
  readonly durationSeconds?: number;
  readonly waveform?: OscillatorType;
}

const EVENT_TONES: Readonly<Record<PracticeSoundEvent, readonly Tone[]>> = {
  [PracticeSoundEvent.CARD_SELECT]: [{ frequency: 740, durationSeconds: 0.045 }],
  [PracticeSoundEvent.CARD_PLACE]: [{ frequency: 520, durationSeconds: 0.065, waveform: 'triangle' }],
  [PracticeSoundEvent.CARD_RETURN]: [{ frequency: 420, durationSeconds: 0.065, waveform: 'triangle' }],
  [PracticeSoundEvent.AUTO_ARRANGE]: [
    { frequency: 520, durationSeconds: 0.07 },
    { frequency: 660, delaySeconds: 0.055, durationSeconds: 0.08 },
  ],
  [PracticeSoundEvent.REDEAL]: [
    { frequency: 620, delaySeconds: 0, durationSeconds: 0.045 },
    { frequency: 560, delaySeconds: 0.045, durationSeconds: 0.045 },
    { frequency: 700, delaySeconds: 0.09, durationSeconds: 0.07 },
  ],
  [PracticeSoundEvent.ROUND_WIN]: [
    { frequency: 523, durationSeconds: 0.23, waveform: 'triangle' },
    { frequency: 659, delaySeconds: 0.07, durationSeconds: 0.24, waveform: 'triangle' },
    { frequency: 784, delaySeconds: 0.14, durationSeconds: 0.31, waveform: 'triangle' },
  ],
  [PracticeSoundEvent.ROUND_LOSS]: [
    { frequency: 392, durationSeconds: 0.18, waveform: 'sine' },
    { frequency: 330, delaySeconds: 0.1, durationSeconds: 0.27, waveform: 'sine' },
  ],
  [PracticeSoundEvent.ROUND_TIE]: [
    { frequency: 494, durationSeconds: 0.18, waveform: 'triangle' },
    { frequency: 494, delaySeconds: 0.12, durationSeconds: 0.18, waveform: 'triangle' },
  ],
  [PracticeSoundEvent.INVALID_ACTION]: [{ frequency: 196, durationSeconds: 0.11, waveform: 'square' }],
};

export function createPracticeAudio(enabled: boolean, createContext: () => AudioContext = () => new window.AudioContext({ latencyHint: 'interactive' })): PracticeAudioPort {
  let context: AudioContext | undefined;
  let unavailable = false;

  function playTone(tone: Tone): void {
    if (unavailable) return;
    try {
      context ??= createContext();
      if (context.state === 'suspended') void context.resume().catch(() => undefined);
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const startAt = context.currentTime + (tone.delaySeconds ?? 0);
      const duration = tone.durationSeconds ?? 0.08;
      oscillator.type = tone.waveform ?? 'sine';
      oscillator.frequency.setValueAtTime(tone.frequency, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.075, startAt + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + duration + 0.015);
      oscillator.addEventListener('ended', () => {
        oscillator.disconnect();
        gain.disconnect();
      }, { once: true });
    } catch {
      unavailable = true;
      void context?.close().catch(() => undefined);
      context = undefined;
    }
  }

  return {
    play(event) {
      if (!enabled || unavailable) return;
      EVENT_TONES[event].forEach(playTone);
    },
    async dispose() {
      const current = context;
      context = undefined;
      if (current && current.state !== 'closed') await current.close();
    },
  };
}
