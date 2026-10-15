import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from './app.js';

let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let baseUrl: string;

before(async () => {
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test('health endpoint returns the shared success envelope', async () => {
  const response = await fetch(`${baseUrl}/api/v1/health/live`);
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.code, 'OK');
  assert.equal(typeof body.requestId, 'string');
  assert.equal(typeof body.serverNow, 'string');
  assert.deepEqual(body.data, { status: 'live', service: 'gameing-hall-api' });
});

test('active platform announcement feed returns a shared empty snapshot instead of 404', async () => {
  const response = await fetch(`${baseUrl}/api/v1/platform/announcements/active`);
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.code, 'OK');
  assert.equal(typeof body.requestId, 'string');
  assert.equal(typeof body.serverNow, 'string');
  assert.deepEqual(body.data, { announcements: [] });
});
