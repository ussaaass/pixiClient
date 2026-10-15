import { describe, expect, it } from 'vitest';
import { ClientPreferenceKey } from '@gameing/contracts/client-preferences';
import { createClientPreferenceApplication } from './client-preference-application';
import { LocalStorageClientPreferenceAdapter } from './local-storage-client-preference-adapter';

describe('client preference application', () => {
  it('loads defaults, updates one preference and persists the shared DTO', async () => {
    const storage = new Map<string, string>();
    const adapter = new LocalStorageClientPreferenceAdapter({
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: (key) => { storage.delete(key); },
      clear: () => storage.clear(),
      key: (index) => [...storage.keys()][index] ?? null,
      get length() { return storage.size; },
    } as Storage);
    const app = createClientPreferenceApplication(adapter);

    expect(await app.getPreferences()).toEqual({ soundEnabled: true, lowDataMode: false });
    const saved = await app.updatePreference({ key: ClientPreferenceKey.LOW_DATA_MODE, value: true });
    expect(saved).toEqual({ ok: true, value: { soundEnabled: true, lowDataMode: true } });
    expect(JSON.parse(storage.get('gameing-hall.clientPreferences.v1')!)).toEqual(saved.ok ? saved.value : null);
    expect(await app.getPreferences()).toEqual({ soundEnabled: true, lowDataMode: true });
  });

  it('migrates old preference keys and rejects malformed commands or storage failures', async () => {
    const storage = new Map([['gameing-hall.soundEnabled', 'false']]);
    const adapter = new LocalStorageClientPreferenceAdapter({
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: (key) => { storage.delete(key); },
      clear: () => storage.clear(),
      key: (index) => [...storage.keys()][index] ?? null,
      get length() { return storage.size; },
    } as Storage);
    const app = createClientPreferenceApplication(adapter);
    expect(await app.getPreferences()).toEqual({ soundEnabled: false, lowDataMode: false });
    expect(storage.has('gameing-hall.clientPreferences.v1')).toBe(true);
    expect(await app.updatePreference({ key: 'UNREGISTERED', value: true } as never)).toEqual({ ok: false, code: 'INVALID_REQUEST' });

    const failing = createClientPreferenceApplication({ load: async () => null, save: async () => { throw new Error('quota'); } });
    await failing.getPreferences();
    expect(await failing.updatePreference({ key: ClientPreferenceKey.SOUND_ENABLED, value: false })).toEqual({ ok: false, code: 'PREFERENCE_STORAGE_FAILED' });
    expect(await failing.getPreferences()).toEqual({ soundEnabled: true, lowDataMode: false });
  });

  it('serializes concurrent changes so independent settings are not lost', async () => {
    let stored: unknown;
    const app = createClientPreferenceApplication({
      load: async () => stored,
      save: async (preferences) => { await Promise.resolve(); stored = preferences; },
    });
    await app.getPreferences();
    const results = await Promise.all([
      app.updatePreference({ key: ClientPreferenceKey.SOUND_ENABLED, value: false }),
      app.updatePreference({ key: ClientPreferenceKey.LOW_DATA_MODE, value: true }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await app.getPreferences()).toEqual({ soundEnabled: false, lowDataMode: true });
  });
});
