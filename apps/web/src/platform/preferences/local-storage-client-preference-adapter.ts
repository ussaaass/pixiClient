import type { ClientPreferenceDto } from '@gameing/contracts/client-preferences';
import { ClientPreferenceDtoSchema } from '@gameing/contracts/client-preferences';
import { Value } from '@sinclair/typebox/value';
import type { ClientPreferenceRepositoryPort } from './client-preference-application';

const STORAGE_KEY = 'gameing-hall.clientPreferences.v1';

export class LocalStorageClientPreferenceAdapter implements ClientPreferenceRepositoryPort {
  constructor(private readonly storage: Storage) {}

  async load(): Promise<unknown> {
    const serialized = this.storage.getItem(STORAGE_KEY);
    if (serialized !== null) {
      try {
        const parsed: unknown = JSON.parse(serialized);
        return Value.Check(ClientPreferenceDtoSchema, parsed) ? parsed : null;
      } catch {
        return null;
      }
    }

    const hasLegacyValue = this.storage.getItem('gameing-hall.soundEnabled') !== null
      || this.storage.getItem('gameing-hall.lowDataMode') !== null;
    const migrated: ClientPreferenceDto = {
      soundEnabled: this.storage.getItem('gameing-hall.soundEnabled') !== 'false',
      lowDataMode: this.storage.getItem('gameing-hall.lowDataMode') === 'true',
    };
    if (hasLegacyValue) await this.save(migrated);
    return migrated;
  }

  async save(preferences: ClientPreferenceDto): Promise<void> {
    if (!Value.Check(ClientPreferenceDtoSchema, preferences)) throw new TypeError('Invalid client preferences');
    this.storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  }
}
