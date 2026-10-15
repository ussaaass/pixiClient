import { describe, expect, it, vi } from 'vitest';
import { createPracticeAudio, PracticeSoundEvent } from '@gameing/shisanshui-client/practice-audio';

function fakeAudioContext(): AudioContext & { readonly spies: Record<string, ReturnType<typeof vi.fn>> } {
  const state = { value: 'suspended' as AudioContextState };
  const spies = {
    resume: vi.fn(async () => { state.value = 'running'; }),
    close: vi.fn(async () => { state.value = 'closed'; }),
    oscillatorStart: vi.fn(),
    oscillatorStop: vi.fn(),
    oscillatorConnect: vi.fn(),
    oscillatorDisconnect: vi.fn(),
    frequencySet: vi.fn(),
    gainConnect: vi.fn(),
    gainDisconnect: vi.fn(),
    gainSet: vi.fn(),
    gainRamp: vi.fn(),
  };
  const oscillator = {
    type: 'sine' as OscillatorType,
    frequency: { setValueAtTime: spies.frequencySet },
    connect: spies.oscillatorConnect,
    disconnect: spies.oscillatorDisconnect,
    start: spies.oscillatorStart,
    stop: spies.oscillatorStop,
    addEventListener: vi.fn(),
  };
  const gain = {
    gain: { setValueAtTime: spies.gainSet, exponentialRampToValueAtTime: spies.gainRamp },
    connect: spies.gainConnect,
    disconnect: spies.gainDisconnect,
  };
  let context: AudioContext;
  context = {
    get state() { return state.value; },
    currentTime: 1,
    destination: {} as AudioNode,
    resume: spies.resume,
    close: spies.close,
    createOscillator: vi.fn(() => oscillator as unknown as OscillatorNode),
    createGain: vi.fn(() => gain as unknown as GainNode),
  } as unknown as AudioContext;
  return Object.assign(context, { spies });
}

describe('practice audio adapter', () => {
  it('does not create an audio context when sound is disabled', async () => {
    const createContext = vi.fn(() => fakeAudioContext());
    const audio = createPracticeAudio(false, createContext);
    audio.play(PracticeSoundEvent.CARD_SELECT);
    await audio.dispose();
    expect(createContext).not.toHaveBeenCalled();
  });

  it('plays an event through Web Audio and closes the context when disposed', async () => {
    const context = fakeAudioContext();
    const createContext = vi.fn(() => context);
    const audio = createPracticeAudio(true, createContext);
    audio.play(PracticeSoundEvent.CARD_PLACE);

    expect(createContext).toHaveBeenCalledOnce();
    expect(context.spies.resume).toHaveBeenCalledOnce();
    expect(context.spies.oscillatorStart).toHaveBeenCalledOnce();
    expect(context.spies.oscillatorStop).toHaveBeenCalledOnce();
    expect(context.spies.gainRamp).toHaveBeenCalledTimes(2);
    await audio.dispose();
    expect(context.spies.close).toHaveBeenCalledOnce();
  });
});
