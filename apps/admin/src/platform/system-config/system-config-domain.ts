import { SystemConfigDraftStatus, SystemConfigValueKind, type SystemConfigDraftDto, type SystemConfigDraftRequestDto, type SystemConfigEntryDto } from '@gameing/admin-contracts/system-config';

export type SystemConfigFailureCode = 'INVALID_REQUEST' | 'CONFIG_NOT_FOUND' | 'INVALID_VALUE' | 'REASON_REQUIRED' | 'VALUE_UNCHANGED' | 'REQUEST_KEY_REUSED';
export type SystemConfigResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: SystemConfigFailureCode };

const failure = <T>(code: SystemConfigFailureCode): SystemConfigResult<T> => ({ ok: false, code });

export function validateSystemConfigValue(entry: SystemConfigEntryDto, rawValue: string): SystemConfigResult<string> {
  const value = rawValue.trim();
  if (entry.valueKind === SystemConfigValueKind.UNSIGNED_INTEGER) {
    if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) return failure('INVALID_VALUE');
    return { ok: true, value };
  }
  if (entry.valueKind === SystemConfigValueKind.PERCENT_INTEGER) {
    if (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > 100) return failure('INVALID_VALUE');
    return { ok: true, value };
  }
  const match = value.match(/^([1-9][0-9]*):([1-9][0-9]*)$/);
  if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))) return failure('INVALID_VALUE');
  return { ok: true, value };
}

export function createSystemConfigDraft(
  entry: SystemConfigEntryDto | null,
  request: SystemConfigDraftRequestDto,
  draftId: string,
  createdAt: string,
): SystemConfigResult<SystemConfigDraftDto> {
  if (!entry) return failure('CONFIG_NOT_FOUND');
  const reason = request.reason.trim();
  if (reason.length < 3) return failure('REASON_REQUIRED');
  const parsedValue = validateSystemConfigValue(entry, request.proposedValue);
  if (!parsedValue.ok) return parsedValue;
  if (parsedValue.value === entry.referenceValue) return failure('VALUE_UNCHANGED');
  return {
    ok: true,
    value: {
      draftId,
      requestKey: request.requestKey,
      configKey: entry.configKey,
      baseValue: entry.referenceValue,
      proposedValue: parsedValue.value,
      reason,
      status: SystemConfigDraftStatus.DRAFT,
      createdAt,
    },
  };
}

export function requestMatchesDraft(request: SystemConfigDraftRequestDto, draft: SystemConfigDraftDto): boolean {
  return request.configKey === draft.configKey
    && request.proposedValue.trim() === draft.proposedValue
    && request.reason.trim() === draft.reason;
}
