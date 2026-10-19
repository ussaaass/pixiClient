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

test('game directory, gameplay and difficulty preflight use shared API envelopes', async () => {
  const directoryResponse = await fetch(`${baseUrl}/api/v1/games`);
  const directory = await directoryResponse.json() as { data: Array<{ gameKey: string }> };
  const experienceResponse = await fetch(`${baseUrl}/api/v1/games/experience`);
  const experiences = await experienceResponse.json() as { data: Array<{ game: { gameKey: string }; difficultyHalls: unknown[]; subhallBackgroundAssetId: string; subhallBackgroundUrl: string }> };
  const mahjongResponse = await fetch(`${baseUrl}/api/v1/games/mahjong-hule-2/experience`);
  const mahjong = await mahjongResponse.json() as { data: { title: string; gameplay: Array<{ body: string }> } };
  const preflightResponse = await fetch(`${baseUrl}/api/v1/games/slot5/difficulties/entry/preflight`);
  const preflight = await preflightResponse.json() as { data: { availability: string; message: string } };

  assert.equal(directoryResponse.status, 200);
  assert.equal(experienceResponse.status, 200);
  assert.equal(mahjongResponse.status, 200);
  assert.equal(preflightResponse.status, 200);
  assert.equal(directory.data.length, 8);
  assert.equal(experiences.data.length, 8);
  assert.ok(experiences.data.every((item) => item.difficultyHalls.length === 3));
  assert.equal(new Set(experiences.data.map((item) => item.subhallBackgroundAssetId)).size, 8);
  assert.ok(experiences.data.every((item) => item.subhallBackgroundUrl.startsWith('/assets/game-subhalls/')));
  assert.equal(mahjong.data.title, '麻将胡了 2');
  assert.match(mahjong.data.gameplay[0]!.body, /2000 ways/);
  assert.equal(preflight.data.availability, 'MODULE_UNAVAILABLE');
  assert.match(preflight.data.message, /不会扣除资产/);
});
