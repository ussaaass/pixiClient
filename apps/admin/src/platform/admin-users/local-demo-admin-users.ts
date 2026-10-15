import {
  AdminUserDetailSection,
  AdminUserRewardType,
  AdminUserRoleType,
  AdminUserSource,
  AdminUserStatus,
  type AdminUserSummaryDto,
  type AdminUserDetailSectionResponseDto,
} from '@gameing/admin-contracts/admin-users';

// Synthetic records are intentionally isolated from production state and tagged LOCAL_DEMO.
export const LOCAL_DEMO_ADMIN_USER_SUMMARIES: readonly AdminUserSummaryDto[] = [
  { userId: '91001', username: 'demo_player_01', nickname: '演练玩家·海风', roleType: AdminUserRoleType.PLAYER, status: AdminUserStatus.ACTIVE, parent1UserId: '91002', createdAt: '2026-06-01T08:00:00.000Z', source: AdminUserSource.LOCAL_DEMO },
  { userId: '91002', username: 'demo_agent_01', nickname: '演练代理·港湾', roleType: AdminUserRoleType.PLAYER_AGENT, status: AdminUserStatus.ACTIVE, parent1UserId: '91003', createdAt: '2026-05-20T08:00:00.000Z', source: AdminUserSource.LOCAL_DEMO },
  { userId: '91003', username: 'demo_agent_02', nickname: '演练代理·灯塔', roleType: AdminUserRoleType.PLAYER_AGENT, status: AdminUserStatus.ACTIVE, parent1UserId: '91004', createdAt: '2026-05-10T08:00:00.000Z', source: AdminUserSource.LOCAL_DEMO },
  { userId: '91004', username: 'demo_player_02', nickname: '演练玩家·星河', roleType: AdminUserRoleType.PLAYER, status: AdminUserStatus.ACTIVE, parent1UserId: null, createdAt: '2026-05-01T08:00:00.000Z', source: AdminUserSource.LOCAL_DEMO },
  { userId: '91005', username: 'demo_closed_01', nickname: '演练停用账号', roleType: AdminUserRoleType.PLAYER, status: AdminUserStatus.DISABLED, parent1UserId: null, createdAt: '2026-04-01T08:00:00.000Z', source: AdminUserSource.LOCAL_DEMO },
];

const overviews: Record<string, AdminUserDetailSectionResponseDto> = {
  '91001': { section: AdminUserDetailSection.OVERVIEW, data: { user: LOCAL_DEMO_ADMIN_USER_SUMMARIES[0]!, rewardType: AdminUserRewardType.RECHARGE, publicCode: 'DEMO91001', emailMasked: 'd***@example.test', emailVerified: true, phoneMasked: '+86 138****0001', phoneVerified: false, lastLoginAt: '2026-10-14T11:30:00.000Z' } },
  '91002': { section: AdminUserDetailSection.OVERVIEW, data: { user: LOCAL_DEMO_ADMIN_USER_SUMMARIES[1]!, rewardType: AdminUserRewardType.RECHARGE, publicCode: 'DEMO91002', emailMasked: null, emailVerified: false, phoneMasked: '+86 139****0002', phoneVerified: true, lastLoginAt: '2026-10-15T06:15:00.000Z' } },
  '91003': { section: AdminUserDetailSection.OVERVIEW, data: { user: LOCAL_DEMO_ADMIN_USER_SUMMARIES[2]!, rewardType: AdminUserRewardType.CUSTOMER_LOSS, publicCode: 'DEMO91003', emailMasked: 'l***@example.test', emailVerified: true, phoneMasked: null, phoneVerified: false, lastLoginAt: '2026-10-12T04:20:00.000Z' } },
  '91004': { section: AdminUserDetailSection.OVERVIEW, data: { user: LOCAL_DEMO_ADMIN_USER_SUMMARIES[3]!, rewardType: AdminUserRewardType.RECHARGE, publicCode: 'DEMO91004', emailMasked: null, emailVerified: false, phoneMasked: null, phoneVerified: false, lastLoginAt: null } },
  '91005': { section: AdminUserDetailSection.OVERVIEW, data: { user: LOCAL_DEMO_ADMIN_USER_SUMMARIES[4]!, rewardType: AdminUserRewardType.CUSTOMER_LOSS, publicCode: 'DEMO91005', emailMasked: null, emailVerified: false, phoneMasked: null, phoneVerified: false, lastLoginAt: null } },
};

const rewardTypeByUserId: Record<string, (typeof AdminUserRewardType)[keyof typeof AdminUserRewardType]> = {
  '91001': AdminUserRewardType.RECHARGE,
  '91002': AdminUserRewardType.RECHARGE,
  '91003': AdminUserRewardType.CUSTOMER_LOSS,
  '91004': AdminUserRewardType.RECHARGE,
  '91005': AdminUserRewardType.CUSTOMER_LOSS,
};

const details: Record<string, Partial<Record<(typeof AdminUserDetailSection)[keyof typeof AdminUserDetailSection], AdminUserDetailSectionResponseDto>>> = {
  '91001': {
    [AdminUserDetailSection.SECURITY]: { section: AdminUserDetailSection.SECURITY, data: { userId: '91001', totpEnabled: true, deviceCount: 2, securityEvents: [{ action: 'LOGIN_SUCCESS', result: 'SUCCESS', createdAt: '2026-10-14T11:30:00.000Z' }], source: AdminUserSource.LOCAL_DEMO } },
    [AdminUserDetailSection.ASSETS]: { section: AdminUserDetailSection.ASSETS, data: { userId: '91001', accounts: [{ assetType: 'COIN', currency: 'COI', available: '12650', frozen: '500' }, { assetType: 'CNY_BALANCE', currency: 'CNY', available: '2350', frozen: '0' }], operations: [{ operationId: '92001', operationType: 'WELCOME_GRANT', assetType: 'COIN', amount: '10000', createdAt: '2026-06-01T08:00:00.000Z' }, { operationId: '92002', operationType: 'ROUND_SETTLEMENT', assetType: 'COIN', amount: '-250', createdAt: '2026-10-14T11:20:00.000Z' }], source: AdminUserSource.LOCAL_DEMO } },
    [AdminUserDetailSection.GAMES]: { section: AdminUserDetailSection.GAMES, data: { userId: '91001', rounds: [{ roundId: '93001', gameKey: 'shisanshui', status: 'SETTLED', wagerCoins: '500', netCoins: '-250', createdAt: '2026-10-14T11:20:00.000Z' }], source: AdminUserSource.LOCAL_DEMO } },
    [AdminUserDetailSection.SOCIAL]: { section: AdminUserDetailSection.SOCIAL, data: { userId: '91001', events: [{ auditId: 'demo-social-audit-1', actionCode: 'SOCIAL_PRIVATE_MESSAGE_READ', resourceType: 'SOCIAL_CONVERSATION', createdAt: '2026-10-14T11:40:00.000Z' }], source: AdminUserSource.LOCAL_DEMO } },
  },
  '91002': {
    [AdminUserDetailSection.REFERRAL]: { section: AdminUserDetailSection.REFERRAL, data: { userId: '91002', rewardType: AdminUserRewardType.RECHARGE, ancestors: [{ level: 1, userId: '91003', nickname: '演练代理·灯塔', rewardType: AdminUserRewardType.CUSTOMER_LOSS }, { level: 2, userId: '91004', nickname: '演练玩家·星河', rewardType: AdminUserRewardType.RECHARGE }], source: AdminUserSource.LOCAL_DEMO } },
  },
  '91003': {
    [AdminUserDetailSection.REFERRAL]: { section: AdminUserDetailSection.REFERRAL, data: { userId: '91003', rewardType: AdminUserRewardType.CUSTOMER_LOSS, ancestors: [{ level: 1, userId: '91004', nickname: '演练玩家·星河', rewardType: AdminUserRewardType.RECHARGE }], source: AdminUserSource.LOCAL_DEMO } },
  },
};

export function localDemoAdminUserSection(userId: string, section: string): AdminUserDetailSectionResponseDto | null {
  if (!overviews[userId]) return null;
  if (section === AdminUserDetailSection.OVERVIEW) return structuredClone(overviews[userId]!);
  const stored = details[userId]?.[section as keyof typeof AdminUserDetailSection];
  if (stored) return structuredClone(stored);
  if (section === AdminUserDetailSection.SECURITY) return { section, data: { userId, totpEnabled: false, deviceCount: 0, securityEvents: [], source: AdminUserSource.LOCAL_DEMO } };
  if (section === AdminUserDetailSection.REFERRAL) {
    return { section, data: { userId, rewardType: rewardTypeByUserId[userId]!, ancestors: [], source: AdminUserSource.LOCAL_DEMO } };
  }
  if (section === AdminUserDetailSection.ASSETS) return { section, data: { userId, accounts: [], operations: [], source: AdminUserSource.LOCAL_DEMO } };
  if (section === AdminUserDetailSection.GAMES) return { section, data: { userId, rounds: [], source: AdminUserSource.LOCAL_DEMO } };
  if (section === AdminUserDetailSection.SOCIAL) return { section, data: { userId, events: [], source: AdminUserSource.LOCAL_DEMO } };
  return null;
}
