/**
 * 欢迎赠币端口（device-register 首次访问幂等调用，§4）。
 *
 * 领域所有者：wallet 模块（本步只登记接口 + TODO，不实现）。
 * 对应 SDD 章节：JWT 登录与会话设计 §4 —— "首次访问没有设备凭证时自动注册并建立
 * 会话；注册 workflow 按每个账号一次、幂等调用新用户赠币用例，不增加设备/IP 级额外
 * 限制，也不承诺识别同一自然人跨账号重复注册。" AGENTS.md 赠币规则（与普通金币同
 * 钱包、按配置加流水要求）。
 *
 * TODO(wallet 模块)：本端口由 wallet 模块用例实现（`grantWelcomeGift`），identity 首步
 * 只保留接口 + 用例内 TODO 注释登记，不写 wallet 实现。幂等键 = user.id（每账号一次）。
 */

export interface WelcomeGiftPort {
  /**
   * 为新账号发放一次欢迎赠币（幂等：同一 userId 重复调用只生效一次，
   * 由 wallet 模块的 asset_operation.operation_key 唯一约束兜底）。
   * @param userId 新账号 user.id。
   */
  grantWelcomeGift(userId: string): Promise<void>;
}
