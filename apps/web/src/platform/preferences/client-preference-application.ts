import { Value } from '@sinclair/typebox/value';
import {
  ClientPreferenceDtoSchema,
  UpdateClientPreferenceRequestSchema,
  type ClientPreferenceDto,
  type UpdateClientPreferenceRequestDto,
} from '@gameing/contracts/client-preferences';
import { DEFAULT_CLIENT_PREFERENCES, updateClientPreference } from './preferences-domain';

export interface ClientPreferenceRepositoryPort {
  load(): Promise<unknown>;
  save(preferences: ClientPreferenceDto): Promise<void>;
}

export type ClientPreferenceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: 'INVALID_REQUEST' | 'PREFERENCE_STORAGE_FAILED' };

export interface ClientPreferenceApplication {
  getPreferences(): Promise<ClientPreferenceDto>;
  updatePreference(request: UpdateClientPreferenceRequestDto): Promise<ClientPreferenceResult<ClientPreferenceDto>>;
}

export function createClientPreferenceApplication(repository: ClientPreferenceRepositoryPort): ClientPreferenceApplication {
  let current = { ...DEFAULT_CLIENT_PREFERENCES };
  let commandQueue = Promise.resolve();

  return {
    async getPreferences() {
      const query = commandQueue.then(async () => {
        const stored = await repository.load();
        current = Value.Check(ClientPreferenceDtoSchema, stored)
          ? { ...(stored as ClientPreferenceDto) }
          : { ...DEFAULT_CLIENT_PREFERENCES };
        return { ...current };
      });
      commandQueue = query.then(() => undefined, () => undefined);
      return query;
    },

    async updatePreference(request) {
      if (!Value.Check(UpdateClientPreferenceRequestSchema, request)) return { ok: false, code: 'INVALID_REQUEST' };
      const command = commandQueue.then(async (): Promise<ClientPreferenceResult<ClientPreferenceDto>> => {
        const updated = updateClientPreference(current, request);
        try {
          await repository.save(updated);
        } catch {
          return { ok: false, code: 'PREFERENCE_STORAGE_FAILED' };
        }
        current = updated;
        return { ok: true, value: { ...current } };
      });
      commandQueue = command.then(() => undefined, () => undefined);
      return command;
    },
  };
}
