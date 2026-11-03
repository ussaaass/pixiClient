# 业务领域速查

本文为领域导航与不变量速查，不重定义业务规则。每条规则的唯一权威来源在 `docs/04_domains/`（及 05_data）；冲突时以对应 SDD 为准并报告矛盾。

## 1. 领域划分与现状

| 领域 | 权威文档 | 已实现 | 未闭环 |
| --- | --- | --- | --- |
| 身份/会话 | `docs/04_domains/JWT登录与会话设计.md` | 浏览器 LOCAL 模式自签 ES256（dev-only） | 服务端签发/撤销、设备会话 |
| 资产账本 | `docs/04_domains/系统账户与资产记账设计.md` | 迁移 0003~0006（account/operation/hold/entry）；`packages/domain/wallet` 纯规则 | 服务端写用例、对账任务 |
| 充值/兑换/提现 | `docs/04_domains/双资产充值兑换与提现.md`、`docs/04_domains/支付渠道流水要求与直连归因.md` | 浏览器离线流程 + contracts | 真实渠道、订单锁汇、审核 |
| 邀请/返佣 | `docs/04_domains/邀请归因返佣与数据规范.md` | contracts、浏览器离线、返点比例常量 | 五级发放、冻结期、快照 |
| 客损 | `docs/04_domains/累计客损结算口径.md` | — | 代理线下结算，平台只限入口 |
| 社交 | `docs/04_domains/社交模块设计.md`、`docs/04_domains/社区论坛私信与金币集市SDD.md` | `packages/domain/social`（访问策略/帖子徽章） | 服务端、游标、限流 |
| 客服/工单 | `docs/04_domains/客服IM与用户工单设计.md` | 浏览器离线会话 | 服务端 IM |
| 房间/牌局 | `docs/02_architecture/架构评估与落地方案.md` | `packages/domain/rooms`、浏览器房间应用 | 服务端权威房间、重连 |
| 十三张 | `docs/03_game_systems/*`、`docs/01_product/十三张项目可行性与技术分析报告.md` | `games/shisanshui/rules`（含 72,072 候选确定性摆牌）+ 本地牌桌 | 联机结算 |
| 配置/代理 | `docs/04_domains/业务配置与账号代理细化.md`、`docs/04_domains/代理域设计.md` | admin 本地演示 | 真实 system_config/game_config 发布 |
| 事件/公告 | `docs/03_game_systems/平台事件与广播系统设计.md` | Koa 空列表 stub + contracts | outbox 求值、受众过滤 |

## 2. 规范实体（统一 user 表）

- 玩家/代理/Admin/系统账户全部落在 `user`，`role_type` 位标记：PLAYER=1、AGENT=2、ADMIN=4、SYSTEM=8，合法组合 1/3/4/8。
- 邀请归因：`referral_binding` 固定保存 `parent_1_user_id`~`parent_4_user_id` + 每级累计已发返点投影，不建闭包表；绑定禁止成环，唯一绑定约束。

## 3. 核心不变量（代码与测试必须逐条守住）

1. 常量/枚举非零（≥1）；`0` 只作筛选哨兵，进入领域前转 undefined。
2. 金币转账：手续费 5% 由发送方额外支付；校验“本金+手续费”的可用余额与冻结；无单笔/每日限额、无最低保留余额。
3. 赠币流水：赠币与普通金币同钱包；完成牌局按有效下注额累计（下注 500 计 500，赢面不额外计）；剩余流水未完成禁止提现与金币转出。
4. 返佣：五级（含本人）至多四个上级，10/8/5/3%；`reward_type`：1=充值返点、2=客损返点；充值返点冻结 2 天、客损返点冻结 1 天；客损在提现审核通过后计算入账。
5. 提现：默认门槛 1000 枚金币等值且为配置门槛正整数倍；身份三选一（验证邮箱 / 验证手机 / 有效用户名+密码）。
6. 系统账户守恒：充值时系统 CNY + 实付净额（扣渠道费）、系统金币 − 购买数；赠币/返点/兑换/手续费各有系统分录；实际提现不二次扣系统内部余额。系统金币发行余额可为负；玩家资产与系统 CNY 不可透支。
7. 账本不可变：`asset_operation`/`asset_entry` 无删除/改写路径，冲正用新操作（`reverses_asset_operation_id`）。
8. 汇率：TRON USDT 实时汇率按订单锁定。

## 4. 状态机要点

- `user.status`：ACTIVE=1 / DISABLED=2 / CLOSED=3。
- 资产操作：成立即 RECORDED=1，无其他状态。
- 房间/牌局：规划阶段（房间 owner 栅栏、round 事件流），以 `docs/02_architecture/架构评估与落地方案.md` 与 03_game_systems 各 SDD 为准。
- 支付订单/提现审核：规划，见 `docs/04_domains/双资产充值兑换与提现.md`；实现前不得在 UI 伪造“已到账/已审核”。

## 5. 跨域交互边界

- 每个资产写操作必须经 wallet application API；service/repository 不得直接改余额代替分录。
- 游戏 handler 只产出 `GameSettlementIntent`，由平台结算 workflow 校验后入账；机器人不得读取真人隐藏状态。
- 代理（AGENT）可管理域名/社交授权；客损用户平台限制资产入口，其祖先链可受限供币。
- 邀请归因走独立接口（Redis 存 IP + 最后有效邀请码），不经 CF；已有上级只有 Admin 可换绑。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-11-02 | 新建：按 04_domains/05_data SDD 登记领域现状、规范实体、核心不变量与跨域边界，全部规则指向权威文档，不另写第二套口径。 |
