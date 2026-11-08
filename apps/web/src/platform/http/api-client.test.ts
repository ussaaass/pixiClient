import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, createApiClient } from './api-client';
import { IdentityEndpoint } from '@gameing/contracts/identity';

const successEnvelope = (data: unknown) => ({
  requestId: 'response-request-1',
  code: 'OK',
  message: 'OK',
  data,
  serverNow: '2026-11-07T12:00:00.000Z',
});

const validDeviceRegistration = {
  fingerprintVersion: 'v1',
  deviceCode: 'device-code-0123456789',
  deviceSummary: { platform: 'web', browser: 'test' },
};

const registeredSession = {
  accessToken: 'access-token',
  tokenType: 'Bearer',
  expiresAt: '2026-11-07T13:00:00.000Z',
  user: { userId: '123', displayName: 'Player', roleType: 1 },
  device: { deviceId: '456', trusted: true },
};

describe('createApiClient transport contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects a malformed request before calling fetch', async () => {
    const fetchPort = vi.fn();
    const client = createApiClient(fetchPort);

    await expect(client.deviceRegister({ ...validDeviceRegistration, deviceCode: 'short' }, 'idem-key')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(fetchPort).not.toHaveBeenCalled();
  });

  it('sends the registered endpoint method and path with credentials and a request ID', async () => {
    const fetchPort = vi.fn().mockResolvedValue(new Response(JSON.stringify(successEnvelope(registeredSession)), { status: 201 }));
    const client = createApiClient(fetchPort);

    await client.deviceRegister(validDeviceRegistration, 'idem-key');

    expect(fetchPort).toHaveBeenCalledTimes(1);
    const [path, init] = fetchPort.mock.calls[0]!;
    expect(path).toBe(IdentityEndpoint.deviceRegister.path);
    expect(init).toMatchObject({ method: IdentityEndpoint.deviceRegister.method, credentials: 'include' });
    const headers = new Headers(init?.headers);
    expect(headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(headers.get('Idempotency-Key')).toBe('idem-key');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init?.body).toBe(JSON.stringify(validDeviceRegistration));
  });

  it('sends production device login with an empty cookie-only DTO', async () => {
    const fetchPort = vi.fn().mockResolvedValue(new Response(JSON.stringify(successEnvelope(registeredSession)), { status: 200 }));
    const client = createApiClient(fetchPort);

    await client.deviceLogin();

    expect(fetchPort).toHaveBeenCalledOnce();
    expect(fetchPort.mock.calls[0]?.[0]).toBe(IdentityEndpoint.deviceLogin.path);
    expect(fetchPort.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(JSON.parse(String(fetchPort.mock.calls[0]?.[1]?.body))).toEqual({});
  });

  it('sends the production device-login cookie-only request without credential fields', async () => {
    const fetchPort = vi.fn().mockResolvedValue(new Response(JSON.stringify(successEnvelope(registeredSession)), { status: 200 }));
    const client = createApiClient(fetchPort);

    await client.deviceLogin();

    expect(fetchPort).toHaveBeenCalledOnce();
    expect(fetchPort.mock.calls[0]?.[0]).toBe(IdentityEndpoint.deviceLogin.path);
    expect(fetchPort.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'include' });
    const headers = new Headers(fetchPort.mock.calls[0]?.[1]?.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(fetchPort.mock.calls[0]?.[1]?.body))).toEqual({});
  });

  it('sends the refresh operation ID supplied by the caller', async () => {
    const fetchPort = vi.fn().mockResolvedValue(new Response(JSON.stringify(successEnvelope(registeredSession)), { status: 200 }));
    const client = createApiClient(fetchPort);
    const refresh = { operationId: 'operation_id_123456' };

    await client.refresh(refresh);

    expect(fetchPort).toHaveBeenCalledOnce();
    expect(fetchPort.mock.calls[0]?.[0]).toBe(IdentityEndpoint.refresh.path);
    expect(JSON.parse(String(fetchPort.mock.calls[0]?.[1]?.body))).toEqual(refresh);
  });

  it('parses a valid success envelope and returns its data', async () => {
    const fetchPort = vi.fn().mockResolvedValue(new Response(JSON.stringify(successEnvelope(registeredSession)), { status: 201 }));
    const client = createApiClient(fetchPort);

    await expect(client.deviceRegister(validDeviceRegistration, 'idem-key')).resolves.toEqual(registeredSession);
  });

  it.each([
    ['malformed JSON', '{'],
    ['invalid success envelope', JSON.stringify({ ...successEnvelope(registeredSession), extra: true })],
  ])('rejects a %s response', async (_label, responseBody) => {
    const fetchPort = vi.fn().mockResolvedValue(new Response(responseBody, { status: 201 }));
    const client = createApiClient(fetchPort);

    await expect(client.deviceRegister(validDeviceRegistration, 'idem-key')).rejects.toMatchObject({
      status: 201,
      code: 'INVALID_API_RESPONSE',
    });
  });

  it('rejects a success envelope with the wrong HTTP status', async () => {
    const fetchPort = vi.fn().mockResolvedValue(new Response(JSON.stringify(successEnvelope(registeredSession)), { status: 200 }));
    const client = createApiClient(fetchPort);

    await expect(client.deviceRegister(validDeviceRegistration, 'idem-key')).rejects.toMatchObject({
      status: 200,
      code: 'INVALID_API_RESPONSE',
    });
  });

  it('maps a valid API failure envelope to ApiRequestError', async () => {
    const failure = {
      requestId: 'server-request-42',
      code: 'IDENTIFIER_ALREADY_USED',
      message: 'Identifier already exists.',
      data: null,
      serverNow: '2026-11-07T12:00:00.000Z',
    };
    const fetchPort = vi.fn().mockResolvedValue(new Response(JSON.stringify(failure), { status: 409 }));
    const client = createApiClient(fetchPort);

    const result = client.deviceRegister(validDeviceRegistration, 'idem-key');
    await expect(result).rejects.toBeInstanceOf(ApiRequestError);
    await expect(result).rejects.toMatchObject({
      status: 409,
      code: failure.code,
      message: failure.message,
      requestId: failure.requestId,
    });
  });
});
