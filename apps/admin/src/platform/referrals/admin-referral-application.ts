import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import {
  AdminReferralBindingSource,
  AdminReferralMigrationStatus,
  AdminReferralRewardStatus,
  AdminReferralRewardType,
  AdminReferralSource,
  AdminReferralDetailSchema,
  AdminReferralListResponseSchema,
  AdminReferralQuerySchema,
  AdminReferralPreviewSchema,
  AdminReferralRebindRequestSchema,
  AdminReferralRebindResponseSchema,
  AdminSocialMigrationProcessResponseSchema,
  type AdminReferralDetailDto,
  type AdminReferralEventDto,
  type AdminReferralListItemDto,
  type AdminReferralPreviewDto,
  type AdminReferralQueryDto,
  type AdminReferralRebindRequestDto,
  type AdminSocialMigrationTaskDto,
} from '@gameing/admin-contracts/admin-referrals';
import type { AdminReferralWorkspaceRepository, AdminReferralWorkspaceSnapshot } from './admin-referral-types';

const DEMO_TOTP = '246810';
const PAGE_SIZE = 10;
const now = () => new Date().toISOString();
const parentKeys = ['parent1UserId', 'parent2UserId', 'parent3UserId', 'parent4UserId'] as const;
type Ancestors = AdminReferralListItemDto['ancestors'];
type Counts = AdminSocialMigrationTaskDto['contentCounts'];

function ancestors(...ids: Array<string | null>): Ancestors {
  return { parent1UserId: ids[0] ?? null, parent2UserId: ids[1] ?? null, parent3UserId: ids[2] ?? null, parent4UserId: ids[3] ?? null };
}
function asArray(value: Ancestors): Array<string | null> { return parentKeys.map((key) => value[key]); }
function benefits(): AdminReferralListItemDto['benefitsCents'] { return { parent1Cents: '0', parent2Cents: '0', parent3Cents: '0', parent4Cents: '0' }; }
function item(userId: string, nickname: string, chain: Ancestors, domain: string | null = null, source: AdminReferralListItemDto['bindingSource'] = AdminReferralBindingSource.INVITE_CODE, rewardType: AdminReferralListItemDto['rewardType'] = AdminReferralRewardType.RECHARGE): AdminReferralListItemDto {
  return { userId, nickname, username: `demo_${userId}`, ancestors: chain, benefitsCents: benefits(), rewardType, bindingSource: source, boundAt: '2026-10-15T09:00:00.000Z', currentDomainName: domain, source: AdminReferralSource.LOCAL_DEMO };
}
function initialSnapshot(): AdminReferralWorkspaceSnapshot {
  const bindings = [
    item('94001', '演练用户·目标', ancestors('94002', '94003', '94004', '94005')),
    item('94002', '演练代理·旧直属', ancestors('94003', '94004', '94005', null), '海风域'),
    item('94003', '演练代理·二级', ancestors('94004', '94005', null, null), '海风域'),
    item('94004', '演练代理·三级', ancestors('94005', null, null, null), '海风域'),
    item('94005', '演练代理·四级', ancestors(null, null, null, null), '海风域'),
    item('94100', '演练代理·新直属', ancestors('94101', '94102', null, null), '星桥域', AdminReferralBindingSource.ADMIN),
    item('94101', '演练代理·新二级', ancestors('94102', null, null, null), '星桥域'),
    item('94102', '演练代理·新三级', ancestors(null, null, null, null), '星桥域'),
    item('94011', '演练下线·一代', ancestors('94001', '94002', '94003', '94004')),
    item('94012', '演练下线·二代', ancestors('94011', '94001', '94002', '94003')),
    item('94013', '演练下线·三代', ancestors('94012', '94011', '94001', '94002')),
    item('94014', '演练下线·四代', ancestors('94013', '94012', '94011', '94001'), null, AdminReferralBindingSource.INVITE_CODE, AdminReferralRewardType.CUSTOMER_LOSS),
  ];
  const snap = ancestors('94002', '94003', '94004', '94005');
  return {
    key: 'workspace', revision: 1, bindings,
    allocations: [{ allocationId: '95001', orderId: '96001', sourceUserId: '94001', sourceNickname: '演练用户·目标', beneficiaryUserId: '94002', beneficiaryNickname: '演练代理·旧直属', ancestorDepth: 1, rewardType: AdminReferralRewardType.RECHARGE, rewardStatus: AdminReferralRewardStatus.POSTED, rewardCents: '1200', ancestrySnapshot: snap, createdAt: '2026-10-13T10:00:00.000Z', unlockAt: '2026-10-15T10:00:00.000Z', skipReason: null }],
    events: [], migrationTasks: [], rebindReceipts: {},
    socialCountsByUser: {
      '94001': { topics: 2, posts: 8, replies: 13, friendships: 6, conversations: 3, messages: 26 },
      '94011': { topics: 1, posts: 3, replies: 4, friendships: 3, conversations: 2, messages: 11 },
      '94012': { topics: 0, posts: 2, replies: 5, friendships: 1, conversations: 1, messages: 4 },
      '94013': { topics: 0, posts: 1, replies: 2, friendships: 1, conversations: 1, messages: 3 },
    },
  };
}

function equalChain(a: Ancestors, b: Ancestors): boolean { return parentKeys.every((key) => a[key] === b[key]); }
function resolveChain(snapshot: AdminReferralWorkspaceSnapshot, userId: string, override?: { userId: string; parentId: string }): Ancestors {
  const visited = new Set([userId]);
  const ids: Array<string | null> = [];
  let current: string | null = userId;
  for (let depth = 0; depth < 4; depth += 1) {
    const row: AdminReferralListItemDto | undefined = current ? snapshot.bindings.find((candidate) => candidate.userId === current) : undefined;
    const parentId: string | null = current && override?.userId === current ? override.parentId : row?.ancestors.parent1UserId ?? null;
    if (!parentId) { ids.push(null); current = null; continue; }
    if (visited.has(parentId)) throw new Error('REFERRAL_CYCLE');
    if (!snapshot.bindings.some((candidate) => candidate.userId === parentId)) throw new Error('PARENT_NOT_FOUND');
    visited.add(parentId); ids.push(parentId); current = parentId;
  }
  return ancestors(...ids);
}
function domainFor(snapshot: AdminReferralWorkspaceSnapshot, userId: string, override?: { userId: string; parentId: string }): string | null {
  let current: string | null = userId;
  const visited = new Set<string>();
  for (let depth = 0; current && depth <= 4; depth += 1) {
    if (visited.has(current)) throw new Error('REFERRAL_CYCLE');
    visited.add(current);
    const row = snapshot.bindings.find((candidate) => candidate.userId === current);
    if (row?.currentDomainName) return row.currentDomainName;
    current = current === userId && override ? override.parentId : row?.ancestors.parent1UserId ?? null;
  }
  return null;
}
function counts(snapshot: AdminReferralWorkspaceSnapshot, userId: string): Counts { return snapshot.socialCountsByUser[userId] ?? { topics: 0, posts: 0, replies: 0, friendships: 0, conversations: 0, messages: 0 }; }
function validate<T>(schema: TSchema, value: T): boolean { return Value.Check(schema, value); }
function resultError(code: string): never { throw new Error(code); }

export function createAdminReferralApplication(repository: AdminReferralWorkspaceRepository) {
  async function load(): Promise<AdminReferralWorkspaceSnapshot> {
    const snapshot = await repository.read();
    return snapshot;
  }
  return {
    demoTotp: DEMO_TOTP,
    async list(query: AdminReferralQueryDto = {}, cursor?: string) {
      if (!validate(AdminReferralQuerySchema, { ...query, ...(cursor ? { cursor } : {}) })) return resultError('INVALID_QUERY');
      const snapshot = await load();
      let rows = [...snapshot.bindings].sort((a, b) => Number(a.userId) - Number(b.userId));
      const keyword = query.keyword?.trim().toLowerCase();
      if (keyword) rows = rows.filter((row) => row.nickname.toLowerCase().includes(keyword) || row.userId.includes(keyword) || row.username?.toLowerCase().includes(keyword));
      if (query.parent1UserId) rows = rows.filter((row) => row.ancestors.parent1UserId === query.parent1UserId);
      if (query.bindingSource) rows = rows.filter((row) => row.bindingSource === query.bindingSource);
      if (query.rewardType) rows = rows.filter((row) => row.rewardType === query.rewardType);
      const total = rows.length; const offset = cursor ? Number(cursor) : 0; const page = rows.slice(offset, offset + (query.pageSize ?? PAGE_SIZE));
      const response = { items: page, total, nextCursor: offset + page.length < total ? String(offset + page.length) : null, source: AdminReferralSource.LOCAL_DEMO };
      if (!validate(AdminReferralListResponseSchema, response)) return resultError('CONTRACT_INVALID');
      return response;
    },
    async detail(userId: string): Promise<AdminReferralDetailDto> {
      const snapshot = await load(); const binding = snapshot.bindings.find((row) => row.userId === userId);
      if (!binding) return resultError('NOT_FOUND');
      const ids = asArray(binding.ancestors).filter((id): id is string => Boolean(id));
      const value: AdminReferralDetailDto = {
        binding,
        ancestors: ids.map((id, index) => { const row = snapshot.bindings.find((candidate) => candidate.userId === id)!; return { userId: id, nickname: row.nickname, rewardType: row.rewardType, level: index + 1, domainName: row.currentDomainName }; }),
        allocations: snapshot.allocations.filter((allocation) => allocation.sourceUserId === userId || allocation.beneficiaryUserId === userId),
        events: snapshot.events.filter((event) => event.userId === userId), migrationTasks: snapshot.migrationTasks.filter((task) => task.userId === userId), source: AdminReferralSource.LOCAL_DEMO,
      };
      if (!validate(AdminReferralDetailSchema, value)) return resultError('CONTRACT_INVALID');
      return value;
    },
    async preview(userId: string, newParent1UserId: string): Promise<AdminReferralPreviewDto> {
      const snapshot = await load();
      const target = snapshot.bindings.find((row) => row.userId === userId); const parent = snapshot.bindings.find((row) => row.userId === newParent1UserId);
      if (!target || !parent) return resultError('NOT_FOUND');
      if (userId === newParent1UserId) return resultError('SELF_PARENT');
      if (snapshot.migrationTasks.some((task) => task.status === AdminReferralMigrationStatus.PENDING && task.userId === userId)) return resultError('MIGRATION_PENDING');
      const override = { userId, parentId: newParent1UserId };
      const nextTarget = resolveChain(snapshot, userId, override);
      if (equalChain(target.ancestors, nextTarget)) return resultError('NO_CHANGE');
      const affectedUsers = snapshot.bindings.flatMap((row) => {
        const nextAncestors = resolveChain(snapshot, row.userId, override);
        if (equalChain(row.ancestors, nextAncestors)) return [];
        return [{ userId: row.userId, nickname: row.nickname, previousAncestors: row.ancestors, nextAncestors, sourceDomainName: domainFor(snapshot, row.userId), targetDomainName: domainFor(snapshot, row.userId, override), socialCounts: counts(snapshot, row.userId) }];
      });
      const value: AdminReferralPreviewDto = { previewKey: `preview-${snapshot.revision}-${userId}-${newParent1UserId}`, workspaceRevision: snapshot.revision, userId, targetNickname: target.nickname, newParent1UserId, newParentNickname: parent.nickname, previousAncestors: target.ancestors, nextAncestors: nextTarget, affectedUsers, historicalAllocationsUnchanged: true, source: AdminReferralSource.LOCAL_DEMO };
      if (!validate(AdminReferralPreviewSchema, value)) return resultError('CONTRACT_INVALID');
      return value;
    },
    async rebind(request: AdminReferralRebindRequestDto) {
      if (!validate(AdminReferralRebindRequestSchema, request)) return resultError('INVALID_REQUEST');
      if (request.totpCode !== DEMO_TOTP) return resultError('TOTP_INVALID');
      return repository.transact((current) => {
        const previousReceipt = current.rebindReceipts[request.requestKey];
        if (previousReceipt) return { next: current, result: previousReceipt };
        if (request.workspaceRevision !== current.revision || request.previewKey !== `preview-${current.revision}-${request.userId}-${request.newParent1UserId}`) return resultError('PREVIEW_STALE');
        const target = current.bindings.find((row) => row.userId === request.userId); if (!target) return resultError('NOT_FOUND');
        const override = { userId: request.userId, parentId: request.newParent1UserId };
        const changed = current.bindings.flatMap((row) => {
          const nextAncestors = resolveChain(current, row.userId, override);
          return equalChain(row.ancestors, nextAncestors) ? [] : [{ row, nextAncestors }];
        });
        if (!changed.length) return resultError('NO_CHANGE');
        const stamp = now();
        const events: AdminReferralEventDto[] = changed.map(({ row, nextAncestors }, index) => ({ eventId: String(97000 + current.events.length + index + 1), requestKey: `${request.requestKey}-${row.userId}`, userId: row.userId, adminUserId: '90001', previousAncestors: row.ancestors, nextAncestors, reason: request.reason, sourceType: AdminReferralBindingSource.ADMIN, createdAt: stamp }));
        let nextTaskNumber = current.migrationTasks.length;
        const tasks: AdminSocialMigrationTaskDto[] = changed.flatMap(({ row }) => {
          const sourceDomainName = domainFor(current, row.userId); const targetDomainName = domainFor(current, row.userId, override);
          if (sourceDomainName === targetDomainName) return [];
          nextTaskNumber += 1;
          return [{ taskId: String(98000 + nextTaskNumber), requestKey: `${request.requestKey}-migration-${row.userId}`, userId: row.userId, nickname: row.nickname, sourceDomainName, targetDomainName, contentCounts: counts(current, row.userId), status: AdminReferralMigrationStatus.PENDING, retryCount: 0, failureReason: null, createdAt: stamp, completedAt: null }];
        });
        const bindings = current.bindings.map((row) => {
          const item = changed.find((entry) => entry.row.userId === row.userId);
          return item ? { ...row, ancestors: item.nextAncestors, benefitsCents: benefits(), bindingSource: AdminReferralBindingSource.ADMIN, boundAt: stamp } : row;
        });
        const value = { requestKey: request.requestKey, affectedCount: changed.length, eventIds: events.map((event) => event.eventId), migrationTasks: tasks, source: AdminReferralSource.LOCAL_DEMO };
        if (!validate(AdminReferralRebindResponseSchema, value)) return resultError('CONTRACT_INVALID');
        const next: AdminReferralWorkspaceSnapshot = { ...current, revision: current.revision + 1, bindings, events: [...current.events, ...events], migrationTasks: [...current.migrationTasks, ...tasks], rebindReceipts: { ...current.rebindReceipts, [request.requestKey]: value } };
        return { next, result: value };
      });
    },
    async processMigration(taskId: string) {
      return repository.transact((current) => {
        const task = current.migrationTasks.find((candidate) => candidate.taskId === taskId);
        if (!task) return resultError('NOT_FOUND');
        if (task.status !== AdminReferralMigrationStatus.PENDING) return resultError('TASK_ALREADY_PROCESSED');
        const completed: AdminSocialMigrationTaskDto = { ...task, status: AdminReferralMigrationStatus.COMPLETED, completedAt: now(), failureReason: null };
        const next = { ...current, revision: current.revision + 1, migrationTasks: current.migrationTasks.map((candidate) => candidate.taskId === taskId ? completed : candidate) };
        const value = { task: completed, remainingPendingTasks: next.migrationTasks.filter((candidate) => candidate.status === AdminReferralMigrationStatus.PENDING).length, source: AdminReferralSource.LOCAL_DEMO };
        if (!validate(AdminSocialMigrationProcessResponseSchema, value)) return resultError('CONTRACT_INVALID');
        return { next, result: value };
      });
    },
  };
}

export { initialSnapshot as createInitialAdminReferralWorkspace };
