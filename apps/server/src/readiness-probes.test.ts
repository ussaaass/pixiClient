import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from './app.js';
import { probeMysql } from './infrastructure/database/mysql-probe.js';
import { probeRedis } from './infrastructure/redis/redis-probe.js';
import { createLogger, createMemorySink } from './infrastructure/logging/logger.js';

let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let baseUrl: string;

before(async () => {
  const sink = createMemorySink();
  const logger = createLogger({ level: 'debug', sink: sink.sink, base: { service: 'gameing-hall-api' } });
  const app = createApp({
    logger,
    readinessChecks: [
      { name: 'mysql', probe: async () => 'not configured' },
      { name: 'redis', probe: () => probeRedis({ host: '127.0.0.1', port: 1 }) },
    ],
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('probeMysql reports "credentials missing" when MYSQL_USER is not set', async () => {
  const previous = process.env.MYSQL_USER;
  delete process.env.MYSQL_USER;
  try {
    const detail = await probeMysql();
    assert.equal(detail, 'credentials missing');
  } finally {
    if (previous !== undefined) process.env.MYSQL_USER = previous;
  }
});

test('probeRedis reports a non-null string when the port is unreachable', async () => {
  const detail = await probeRedis({ host: '127.0.0.1', port: 1 });
  assert.equal(typeof detail, 'string');
});

test('GET /health/ready returns 503 SERVICE_UNAVAILABLE when any probe reports not-ready', async () => {
  const response = await fetch(`${baseUrl}/api/v1/health/ready`);
  assert.equal(response.status, 503);
  const body = (await response.json()) as {
    code: string;
    data: { status: string; checks: Array<{ name: string; ready: boolean }> };
  };
  assert.equal(body.code, 'SERVICE_UNAVAILABLE');
  assert.equal(body.data.status, 'not_ready');
  const mysqlCheck = body.data.checks.find((entry) => entry.name === 'mysql');
  assert.ok(mysqlCheck);
  assert.equal(mysqlCheck.ready, false);
});
