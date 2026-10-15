import { ClientPreferenceKey, type ClientPreferenceDto, type UpdateClientPreferenceRequestDto } from '@gameing/contracts/client-preferences';

export const DEFAULT_CLIENT_PREFERENCES: ClientPreferenceDto = {
  soundEnabled: true,
  lowDataMode: false,
};

export function updateClientPreference(
  current: ClientPreferenceDto,
  request: UpdateClientPreferenceRequestDto,
): ClientPreferenceDto {
  switch (request.key) {
    case ClientPreferenceKey.SOUND_ENABLED:
      return { ...current, soundEnabled: request.value };
    case ClientPreferenceKey.LOW_DATA_MODE:
      return { ...current, lowDataMode: request.value };
  }
}
