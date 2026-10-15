import { describe, expect, it } from 'vitest';
import { AdminRoomStatus } from '@gameing/admin-contracts/admin-game-operations';
import { createAdminGameOperationsApplication, type AdminGameOperationsRepository } from './admin-game-operations-application';
import { LocalDemoAdminGameOperationsAdapter } from './local-demo-admin-game-operations-adapter';

describe('Admin game operations read application', () => {
  const app = createAdminGameOperationsApplication(new LocalDemoAdminGameOperationsAdapter());

  it('filters and pages room summaries and loads an independently validated member snapshot', async () => {
    expect(await app.rooms({ keyword: 'DEMO-13', status: AdminRoomStatus.PLAYING, pageSize: 1 }))
      .toMatchObject({ ok: true, value: { total: 1, items: [{ roomId: '81001' }], nextCursor: null, source: 1 } });
    expect(await app.rooms({ gameKey: 'shisanshui', pageSize: 1 }))
      .toMatchObject({ ok: true, value: { total: 3, items: [{ roomId: '81001' }], nextCursor: '1' } });
    expect(await app.room('81001')).toMatchObject({ ok: true, value: { members: expect.arrayContaining([expect.objectContaining({ seatNo: 1 }), expect.objectContaining({ connected: false })]) } });
    expect(await app.room('81999')).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('filters rounds by player, game, time and keyword without interpreting handler JSON', async () => {
    expect(await app.rounds({ playerUserId: '91001' })).toMatchObject({ ok: true, value: { total: 2 } });
    expect(await app.rounds({ fromCreatedAt: '2026-10-15T09:48:00.000Z', toCreatedAt: '2026-10-15T09:59:00.000Z', gameKey: 'shisanshui' }))
      .toMatchObject({ ok: true, value: { total: 1, items: [{ roundKey: 'DEMO-ROUND-13-001' }] } });
    expect(await app.round('82001')).toMatchObject({ ok: true, value: { safeHandlerSummary: expect.stringContaining('不在平台通用详情中解析'), players: expect.arrayContaining([expect.objectContaining({ wagerCoins: '500' })]), assetOperationIds: ['83001', '83002', '83003'] } });
  });

  it('rejects zero filters, malformed ranges, invalid cursor values, and IDs beyond unsigned BIGINT', async () => {
    expect(await app.rooms({ status: 0 })).toEqual({ ok: false, code: 'INVALID_QUERY' });
    expect(await app.rooms({ cursor: '0' })).toEqual({ ok: false, code: 'INVALID_QUERY' });
    expect(await app.rounds({ fromCreatedAt: '2026-10-16T00:00:00.000Z', toCreatedAt: '2026-10-15T00:00:00.000Z' }))
      .toEqual({ ok: false, code: 'INVALID_QUERY' });
    expect(await app.round('18446744073709551616')).toEqual({ ok: false, code: 'INVALID_QUERY' });
  });

  it('rejects repository detail references outside unsigned BIGINT before exposing them', async () => {
    const base = new LocalDemoAdminGameOperationsAdapter();
    const invalid: AdminGameOperationsRepository = {
      listRooms: () => base.listRooms(), roomDetail: async () => ({ ...(await base.roomDetail('81001'))!, members: [{ ...(await base.roomDetail('81001'))!.members[0]!, userId: '18446744073709551616' }] }),
      listRounds: () => base.listRounds(), listRoundParticipantIds: (ids) => base.listRoundParticipantIds(ids),
      roundDetail: async () => ({ ...(await base.roundDetail('82001'))!, assetOperationIds: ['18446744073709551616'] }),
    };
    const invalidApp = createAdminGameOperationsApplication(invalid);
    expect(await invalidApp.room('81001')).toEqual({ ok: false, code: 'INVALID_DATA' });
    expect(await invalidApp.round('82001')).toEqual({ ok: false, code: 'INVALID_DATA' });
  });
});
