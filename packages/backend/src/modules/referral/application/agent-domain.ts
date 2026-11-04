/**
 * referral 模块用例：代理域申请 + 查询（POST /me/agent-domain/apply +
 * GET /me/agent-domain；首版只建申请 + 查询，审批端点归 §9 第 9 步 Admin）。
 *
 * 领域所有者：referral 模块（agent_domain 写入 + 读取；models/admin.ts
 * AgentDomainModel 为 model 定义，U(user_id) 一行 / 用户）。
 * 对应 SDD 章节：后端实施 SDD §9 第 6 步（代理域申请）、§5.2.1
 * （agent_domain U(user_id) 状态机 PENDING_REVIEW=1 → ACTIVE=2 /
 * SUSPENDED=3 / REVOKED=4 / WITHDRAWN=5）；contracts invite-agent.ts
 * （AgentDomainStatus / AgentDomainDtoSchema / ApplyAgentDomainRequestSchema）。
 *
 * 用例语义：
 * - POST /me/agent-domain/apply：U(user_id) 幂等兜底——已有域行（任何状态）
 *   → 返回既有值 `inserted: false`（200 幂等重放）；无行 → 写 PENDING_REVIEW=1
 *   `inserted: true`（201 新申请）；
 * - GET /me/agent-domain：读用户域行（无行 → null，路由层返回 200 + 空数据）；
 * - 审批 / 暂停 / 恢复 / 撤销经 §9 第 9 步 Admin 端点（AdminAgentDomainEndpoint），
 *   本用例不处理状态推进。
 *
 * 错误码映射（REF → 触发条件）：
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 域行写入失败（可重试）。
 * - `AGENT_DOMAIN_PENDING` / `SUSPENDED` / `REVOKED`：查询返回的域状态值
 *   （路由层按值映射展示文案，非抛错）。
 */

import type { AgentDomainRepo, Tx } from '../ports/referral-repository.js';

/** 代理域 DTO（wire；对齐 contracts AgentDomainDtoSchema）。 */
export interface AgentDomainDto {
  userId: string;
  status: number; // PENDING_REVIEW=1/ACTIVE=2/SUSPENDED=3/REVOKED=4/WITHDRAWN=5
  appliedAt: string;
  capabilities: string[];
}

export interface AgentDomainApplyResultDto {
  agentDomain: AgentDomainDto;
  inserted: boolean;
}

/**
 * 代理域申请 + 查询用例（构造注入 AgentDomainRepo，不用全局，SDD §4）。
 */
export class AgentDomainUseCase {
  constructor(private readonly agentDomainRepo: AgentDomainRepo) {}

  /**
   * POST /me/agent-domain/apply：申请代理域（幂等：已有域行 → 返回既有值
   * `inserted: false`；无行 → 写 PENDING_REVIEW=1 `inserted: true`）。
   */
  async apply(userId: string, capabilities: string[], tx: Tx): Promise<AgentDomainApplyResultDto> {
    const result = await this.agentDomainRepo.createAgentDomain({
      userId,
      capabilities,
      tx,
    });
    return {
      agentDomain: toAgentDomainDto(result.agentDomain, userId),
      inserted: result.inserted,
    };
  }

  /** GET /me/agent-domain：查询用户代理域（无行 → null）。 */
  async get(userId: string, tx: Tx): Promise<AgentDomainDto | null> {
    const row = await this.agentDomainRepo.findAgentDomainByUserId(userId, tx);
    if (row === null) return null;
    return toAgentDomainDto(row, userId);
  }
}

function toAgentDomainDto(
  row: { id: string; userId: string; status: number; createdAt: Date | string; capabilities: string[] },
  userId: string,
): AgentDomainDto {
  return {
    userId,
    status: row.status,
    appliedAt: typeof row.createdAt === 'string' ? row.createdAt : row.createdAt.toISOString(),
    capabilities: row.capabilities ?? [],
  };
}
