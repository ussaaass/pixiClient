import {
  AdminMembershipStatus, AdminOperationsSource, AdminRoomStatus, AdminRoomType, AdminRoundStatus, AdminRoundSubmissionType,
  type AdminRoomDetailDto, type AdminRoomSummaryDto, type AdminRoundDetailDto, type AdminRoundSummaryDto,
} from '@gameing/admin-contracts/admin-game-operations';

// Synthetic, read-only snapshots. These are never written to room, round, or asset stores.
export const localDemoRooms: readonly AdminRoomSummaryDto[] = [
  { roomId: '81001', roomKey: 'DEMO-13-001', gameKey: 'shisanshui', gameTitle: '十三张', tierKey: 'gold', tierTitle: '黄金厅', status: AdminRoomStatus.PLAYING, phase: 'PLAYING', playerCount: 3, capacity: 4, waitSeconds: 0, rulesVersion: 'shisanshui-rules-v1', lastChangedAt: '2026-10-15T09:55:00.000Z', source: AdminOperationsSource.LOCAL_DEMO },
  { roomId: '81002', roomKey: 'DEMO-13-002', gameKey: 'shisanshui', gameTitle: '十三张', tierKey: 'bronze', tierTitle: '青铜厅', status: AdminRoomStatus.WAITING, phase: 'WAITING', playerCount: 2, capacity: 4, waitSeconds: 87, rulesVersion: 'shisanshui-rules-v1', lastChangedAt: '2026-10-15T09:54:00.000Z', source: AdminOperationsSource.LOCAL_DEMO },
  { roomId: '81003', roomKey: 'DEMO-S5-003', gameKey: 'slot5', gameTitle: '跳高高', tierKey: 'classic', tierTitle: '经典厅', status: AdminRoomStatus.PLAYING, phase: 'PLAYING', playerCount: 1, capacity: 1, waitSeconds: 0, rulesVersion: 'slot5-config-v2', lastChangedAt: '2026-10-15T09:51:00.000Z', source: AdminOperationsSource.LOCAL_DEMO },
  { roomId: '81004', roomKey: 'DEMO-13-004', gameKey: 'shisanshui', gameTitle: '十三张', tierKey: 'gold', tierTitle: '黄金厅', status: AdminRoomStatus.CLOSED, phase: 'CLOSED', playerCount: 0, capacity: 4, waitSeconds: 0, rulesVersion: 'shisanshui-rules-v1', lastChangedAt: '2026-10-15T09:42:00.000Z', source: AdminOperationsSource.LOCAL_DEMO },
];

export const localDemoRoomDetails: Readonly<Record<string, AdminRoomDetailDto>> = {
  '81001': { summary: localDemoRooms[0]!, roomType: AdminRoomType.MATCHED, heartbeatAt: '2026-10-15T09:55:00.000Z', ownerKey: 'demo-game-worker-01', checkpointVersion: 12, source: AdminOperationsSource.LOCAL_DEMO, members: [
    { userId: '91001', nickname: '演练玩家·海风', seatNo: 1, membershipStatus: AdminMembershipStatus.SEATED, joinedAt: '2026-10-15T09:45:00.000Z', connected: true },
    { userId: '91002', nickname: '演练玩家·港湾', seatNo: 2, membershipStatus: AdminMembershipStatus.SEATED, joinedAt: '2026-10-15T09:45:20.000Z', connected: true },
    { userId: '91003', nickname: '演练玩家·灯塔', seatNo: 3, membershipStatus: AdminMembershipStatus.SEATED, joinedAt: '2026-10-15T09:46:00.000Z', connected: false },
  ] },
  '81002': { summary: localDemoRooms[1]!, roomType: AdminRoomType.PRIVATE, heartbeatAt: '2026-10-15T09:54:00.000Z', ownerKey: 'demo-game-worker-02', checkpointVersion: 1, source: AdminOperationsSource.LOCAL_DEMO, members: [
    { userId: '91004', nickname: '演练玩家·星河', seatNo: 1, membershipStatus: AdminMembershipStatus.SEATED, joinedAt: '2026-10-15T09:52:33.000Z', connected: true },
    { userId: '91005', nickname: '演练停用账号', seatNo: 2, membershipStatus: AdminMembershipStatus.SEATED, joinedAt: '2026-10-15T09:53:10.000Z', connected: true },
  ] },
};

export const localDemoRounds: readonly AdminRoundSummaryDto[] = [
  { roundId: '82001', roundKey: 'DEMO-ROUND-13-001', roomId: '81001', roomKey: 'DEMO-13-001', roundNo: 3, gameKey: 'shisanshui', gameTitle: '十三张', handlerVersion: 'shisanshui-handler-v1', participantCount: 3, status: AdminRoundStatus.SETTLED, createdAt: '2026-10-15T09:50:00.000Z', settledAt: '2026-10-15T09:52:42.000Z', resultSummary: '已完成结算；对局 JSON 需对应 handler 版本解释。', source: AdminOperationsSource.LOCAL_DEMO },
  { roundId: '82002', roundKey: 'DEMO-ROUND-13-002', roomId: '81001', roomKey: 'DEMO-13-001', roundNo: 2, gameKey: 'shisanshui', gameTitle: '十三张', handlerVersion: 'shisanshui-handler-v1', participantCount: 4, status: AdminRoundStatus.SETTLED, createdAt: '2026-10-15T09:47:00.000Z', settledAt: '2026-10-15T09:49:13.000Z', resultSummary: '牌局结果摘要可用；未提供私牌或具体墩型字段。', source: AdminOperationsSource.LOCAL_DEMO },
  { roundId: '82003', roundKey: 'DEMO-ROUND-S5-001', roomId: '81003', roomKey: 'DEMO-S5-003', roundNo: 18, gameKey: 'slot5', gameTitle: '跳高高', handlerVersion: 'slot5-handler-v2', participantCount: 1, status: AdminRoundStatus.SETTLED, createdAt: '2026-10-15T09:43:00.000Z', settledAt: '2026-10-15T09:43:04.000Z', resultSummary: '已完成结算；结果摘要由对应 slot handler 解释。', source: AdminOperationsSource.LOCAL_DEMO },
];

export const localDemoRoundDetails: Readonly<Record<string, AdminRoundDetailDto>> = {
  '82001': { summary: localDemoRounds[0]!, fencingToken: 1, rulesHash: 'sha256:demo-rules-shisanshui-v1', settlementInputHash: 'sha256:demo-settlement-82001', source: AdminOperationsSource.LOCAL_DEMO, safeHandlerSummary: '本机合成摘要：三名参赛者完成提交并结算。实际牌型、私牌与 handler 原始 JSON 不在平台通用详情中解析。', assetOperationIds: ['83001', '83002', '83003'], players: [
    { userId: '91001', nickname: '演练玩家·海风', seatNo: 1, wagerCoins: '500', netCoinDelta: '-250', submissionType: AdminRoundSubmissionType.MANUAL },
    { userId: '91002', nickname: '演练玩家·港湾', seatNo: 2, wagerCoins: '500', netCoinDelta: '400', submissionType: AdminRoundSubmissionType.TIMEOUT_AUTO },
    { userId: '91003', nickname: '演练玩家·灯塔', seatNo: 3, wagerCoins: '500', netCoinDelta: '-150', submissionType: AdminRoundSubmissionType.MANUAL },
  ] },
  '82002': { summary: localDemoRounds[1]!, fencingToken: 1, rulesHash: 'sha256:demo-rules-shisanshui-v1', settlementInputHash: 'sha256:demo-settlement-82002', source: AdminOperationsSource.LOCAL_DEMO, safeHandlerSummary: null, assetOperationIds: ['83004', '83005'], players: [] },
  '82003': { summary: localDemoRounds[2]!, fencingToken: 2, rulesHash: 'sha256:demo-rules-slot5-v2', settlementInputHash: 'sha256:demo-settlement-82003', source: AdminOperationsSource.LOCAL_DEMO, safeHandlerSummary: '本机合成 slot 摘要：每局结果由 slot5-handler-v2 解释，平台不从随机符号 JSON 推导输赢。', assetOperationIds: ['83006'], players: [{ userId: '91001', nickname: '演练玩家·海风', seatNo: 1, wagerCoins: '100', netCoinDelta: '200', submissionType: AdminRoundSubmissionType.MANUAL }] },
};
