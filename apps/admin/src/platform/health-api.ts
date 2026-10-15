import { Value } from '@sinclair/typebox/value';
import { HealthResponseSchema, type HealthResponse } from '@gameing/contracts/health';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

export async function getAdminHealth(): Promise<HealthResponse> {
  const response = await fetch(`${apiBaseUrl}/health/live`, { signal: AbortSignal.timeout(5000) });
  const body: unknown = await response.json();
  if (!response.ok || !Value.Check(HealthResponseSchema, body)) {
    throw new Error('Health endpoint returned an invalid response');
  }
  return body;
}
