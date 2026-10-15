# 数据库设计规范与 Sequelize 方案

本文为最新数据库约束，覆盖旧文档中的 create_at/update_at、Kysely 与部分表/引用字段草案。用户指定的 ORM“sequenlize”按正式库名 Sequelize 实施。当前仅设计，未生成迁移或初始化依赖。

## 1. 全表硬约束

| 项目 | 规范 |
| --- | --- |
| 主键 | 每张表都有 id，类型 BIGINT UNSIGNED，主键、非空、自增 |
| 常量 | 所有状态、类型、来源、动作、策略等常量/枚举值均为正整数，从 1 开始；任何业务常量不得取 0 |
| 状态 | 每张表都有 status，正整数常量，从 1 开始；其他状态字段同样拒绝 0 |
| 时间 | 每张表有 created_at/updated_at/deleted_at，全部 MySQL DATETIME(3) |
| 空值 | created_at/updated_at 非空；未删除的 deleted_at 为 NULL |
| 表名 | 小写 snake_case；首版统一采用单数实体名，如 user、asset_account、order |
| 引用字段 | 保存 abc 表的 id，字段命名为 abc_id，类型同样 BIGINT UNSIGNED；同一行对同一表有多个角色引用时使用 `<role>_abc_id`，如 parent_1_user_id、admin_user_id |
| 注释 | 每张表和每个字段均须有非空、有意义的 MySQL COMMENT，包括公共字段/关联表/迁移历史 |
| ORM | Sequelize；MySQL 方言驱动 mysql2，不再采用 Kysely |

`0` 保留为查询筛选 DTO 中“未选择/不筛选”的哨兵值；筛选 DTO 在进入领域逻辑前将其转换为未指定条件，不将其当作业务枚举传递或持久化。可选外键在数据库用 `NULL` 表达缺失。所有常量/枚举（含状态、类型、来源、动作和策略）均从 1 起，具体取值由各领域定义，数据库 CHECK/DTO/转换流程验证允许集合，而非只判断 `>0`。金额为 0、计数为 0、闭包 depth=0、流水剩余为 0、排序序号为 0 等普通数值在业务允许时合法；不能把常量规则误用到数量值。

id 的生成建议统一数据库 AUTO_INCREMENT；首版共享 MySQL 写入权威，不为方便擅自追加 Snowflake 服务。金额与 ID 类型分开，BIGINT UNSIGNED 的主键要求不意味着账本有符号 delta 也必须 UNSIGNED。资产 amount/delta 采用有符号精确整数：系统金币发行余额和玩家金币/人民币资产可因合法、已审计操作为负；系统人民币不得为负，负玩家余额不得消费或提现，见 [系统账户设计](../04_domains/系统账户与资产记账设计.md)。

## 2. 引用命名及同表多角色

首版统一身份表使用 `user`，因此普通用户引用字段为 `user_id`。外键字段一律包含被引用的实际表名，不自行缩写；当同一行对 `user` 表存在多个语义不同的引用角色时，按 `<role>_user_id` 命名，例如 `parent_1_user_id`、`admin_user_id`、`target_admin_user_id`。这类字段仍明确引用 `user.id`，不能省略 `_user_id` 中的目标表名。JSON 内保存其他表 ID 也必须遵循相同命名规则。前后端 DTO 可以使用明确映射后的 camelCase，不把业务 requestId/commandId 当数据库引用主键。

同一行多个角色引用同一目标表时，角色前缀是正式命名规则，不是例外。是否拆关联表由关系是否具有独立生命周期、参与方数量是否可变及领域语义决定，不仅由字段命名决定：

| 业务 | 设计 |
| --- | --- |
| 转账双方 | 不建 transfer/participant 表；一项转账是一个 `asset_operation`，发送方扣款与收款方入账是挂在同一操作下的 `asset_entry`，双方由各自 `asset_account_id` 确定，操作快照记入 `extra` |
| 代理上下级 | `referral_binding` 固定保存直属至第四级的 `parent_1_user_id`…`parent_4_user_id`，同时保存每级累计已发返点投影；不建邻接、成员或闭包表 |
| 管理操作人员 | 操作记录用角色化外键（如 admin_user_id）引用统一 user 表，并由领域校验 ADMIN role_type；修改前后值进入 admin_audit_event，不建 config_actor |
| 游戏专属结算明细 | 由游戏 handler 写入版本化 JSON 结果快照；通用 schema 不建牌型/轮次/角色比较表 |

关系表按领域需要保存，不为方便泛化而机械增加参与方表。转账双方分录必须在同一个数据库事务内完成并满足金额守恒；引用当前代理链的操作须锁定 `referral_binding` 并保存发生时链路快照。绑定最多四级上级、禁止成环，由绑定用例在事务内校验并以 `user_id` 唯一绑定约束保障。

FK 是否为空由业务决定，统一创建对应索引；高频服务端关联以显式 foreignKey/targetKey 配置，禁止 ORM 自动补出 UserId 或重复字段。钱包/流水/奖励/审计引用优先 RESTRICT，不因删除用户级联删财务历史。

## 3. Sequelize 选型与边界

本次查阅官方文档仍将 v6 标为 stable、v7 标为 alpha，因此首版使用初始化时最新受支持稳定版 Sequelize；不把 alpha 当“最新 LTS”。锁定具体版本与 mysql2 版本，实际初始化时再核实。[Sequelize v6](https://sequelize.org/docs/v6/)、[v7 状态](https://sequelize.org/docs/v7/other-topics/upgrade/)

Model 定义位于 backend infrastructure/database/models，仓储引用模型，domain 不引用 Sequelize Model/Transaction。跨域 UnitOfWork 使用同一个 sequelize.transaction 的 Transaction，显式传到全部查询、更新和锁定读，不在域用例中嵌套创建独立事务。Sequelize 不会默认给所有操作自动建立事务。[Sequelize 事务](https://sequelize.org/docs/v6/other-topics/transactions/)

关系、资金锁及幂等继续依靠数据库约束和统一锁顺序。必要的 SELECT FOR UPDATE/CHECK/精确计算可用 sequelize.query，参数绑定且仍传同一个 transaction；不能绕回第二个 mysql2 连接池或 Kysely。外部支付/链 RPC/Socket 调用仍在资金锁事务之外。

## 4. 公共 Model 规划示例

```ts
import { DataTypes, Model } from 'sequelize';

export const UserStatus = { ACTIVE: 1, DISABLED: 2 } as const;

class UserModel extends Model {
  declare id: string;
  declare status: number;
  declare created_at: Date;
  declare updated_at: Date;
  declare deleted_at: Date | null;
}

// sequelize 为基础设施注入的统一实例；以下是规划示例。
UserModel.init({
  id: {
    type: DataTypes.BIGINT.UNSIGNED,
    primaryKey: true,
    autoIncrement: true,
    allowNull: false,
    comment: '用户主键，API 使用十进制字符串',
  },
  status: {
    type: DataTypes.SMALLINT.UNSIGNED,
    allowNull: false,
    defaultValue: UserStatus.ACTIVE,
    validate: { isIn: [[UserStatus.ACTIVE, UserStatus.DISABLED]] },
    comment: '用户状态，取值见 UserStatus 常量',
  },
  created_at: {
    type: DataTypes.DATE(3), allowNull: false, comment: '创建时间，UTC',
  },
  updated_at: {
    type: DataTypes.DATE(3), allowNull: false, comment: '最后更新时间，UTC',
  },
  deleted_at: {
    type: DataTypes.DATE(3), allowNull: true, comment: '删除时间，未删除为 NULL',
  },
}, {
  sequelize,
  modelName: 'UserModel',
  tableName: 'user',
  freezeTableName: true,
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  deletedAt: 'deleted_at',
  paranoid: true,
  comment: '统一用户账号，含系统账户身份',
});
```

此例省略业务字段、数据库 CHECK 与引用索引；迁移须完整创建，不能拿模型校验代替数据库约束。Sequelize 支持显式表名、字段 comment、BIGINT.UNSIGNED 与 MySQL DATETIME 精度；timestamps 默认由 ORM 更新，raw SQL 必须显式写 updated_at，不能假设数据库自动替它更新。[模型定义](https://sequelize.org/docs/v6/core-concepts/model-basics/)、[命名策略](https://sequelize.org/docs/v6/other-topics/naming-strategies/)

所有实例启用 UTC 日期策略；时区不烘焙为客户端所在地。不可变 asset_entry/审计事件禁用 destroy/update 路径，deleted_at 永远 NULL、updated_at 固定等于 created_at；普通表可 paranoid 查询，但对账查询不因默认过滤看不到业务历史。

## 5. 大 ID、迁移和验收

数据库 ID/金额经 mysql2 大整数配置读取为精确值，禁止先转换 JS Number；接口、JWT sub、缓存与 Socket 使用十进制字符串。仅 declare id:string 不会改变驱动行为，必须验证大于 Number.MAX_SAFE_INTEGER 的插入返回、查询、关联和 JSON 序列化；BIGINT UNSIGNED 上限测试同样需要真实 MySQL。

正式结构变化通过 migration，不在应用启动时 sync({alter:true})/sync({force:true})。sequelize-cli 默认元信息表不满足全部公共字段规范，不能例外保留无 id/注释的 SequelizeMeta。[Sequelize 迁移](https://sequelize.org/docs/v6/other-topics/migrations/)

建议用 Umzug 执行 Sequelize QueryInterface 迁移，并实现规范化 migration_history 存储：具有 id、name、checksum、status、三个时间及注释，所有应用/回滚保存事件；不靠物理删历史来表达撤销。[Umzug 自定义存储](https://github.com/sequelize/umzug)

迁移由独立单一部署任务执行。MySQL DDL 的提交行为需要逐项核验，不能以包裹 ORM transaction 宣称一批 DDL 全部可回滚；失败后检查真实结构/元信息，显式恢复。新增/回填/切换/移除分别迁移，迁移 checksum 变更拒绝默默覆盖。

规划 schema-check 基于 information_schema 和模型元数据检查全表 id/状态/三时间、类型、注释、snake_case、引用字段名称和索引；领域常量定义检查不得包含 0。候选表清单注明领域所有者。检查空注释或“字段1”式无意义占位失败。模型、迁移和规范单元样例保持一致，财务约束另外以 MySQL 集成测试验证。

## 6. Model 与表的逐项评审清单

每个候选实体先回答是否需要持久化，再按下列项目评审；清单用于发现缺口，不是要求每个功能都新增表：

1. **领域归属与业务事实：** 谁拥有该实体，哪条用例创建/读取/更新它？它记录的是权威事实、查询投影还是临时状态？投影是否能从权威事实重建？
2. **扩表必要性：** 是否有独立身份或生命周期，或需要独立唯一约束、并发控制、访问隔离、保留策略？能否合理复用现有表、少量列、关系表、带版本 JSON 或可丢失/重建的 Redis 状态？不能仅因页面、消息种类、报表指标或代码模块而拆表。
3. **生命周期与删除：** 状态迁移是什么，何时更新 `updated_at`，是否允许软删除，历史是否不可变？实体被删除/停用时关联记录如何处理？默认不级联删除，资金和审计历史不得随业务资料删除。
4. **字段与命名：** 是否具备五个公共字段和全部字段注释？引用字段是否按目标表命名，多角色引用是否采用 `<role>_<table>_id`？金额、比例、时区、精度、可空和默认值是否明确？
5. **完整性与并发：** 唯一性、外键、CHECK、索引、幂等键、锁顺序和事务边界分别由哪一层保证？会不会依赖先查后写而产生竞态？索引是否服务于已说明的查询，而非预先堆叠？
6. **Sequelize 与迁移：** Model、migration、数据库约束及 DTO 是否对齐？事务是否显式传递同一 Transaction？大整数是否保持精确？注释、默认值、索引名及回滚/前滚方式是否核实？
7. **运维与验收：** 数据量和增长依据是什么？保留/清理策略是什么？如何重建或对账？哪些 schema-check 或集成用例能证明约束成立？

未能说明领域所有者、真实用例或扩表必要性的候选表，先留在设计决议中，不进入首版 schema。模拟计算数据按 SDD 约束仅驻留内存/临时计算进程，不为轮次、样本、虚拟资金或报告摘要预建表。

## 7. 当前规范化表名示例

| 领域 | 核心表名 |
| --- | --- |
| 身份 | user（含身份凭证、联系信息、TOTP 及 Admin 权限 JSON）、device（含当前设备凭证）、recovery_credential（保留二维码凭证历史）；短期 session/refresh 状态保存在 Redis |
| 资产 | asset_account、asset_operation、asset_entry、asset_hold、coin_exchange；转账参与方由同一 operation 下的分录表达 |
| 支付 | product、order、payment_provider、payment_channel、payment_event、external_settlement、payout_account、withdrawal、payout_attempt |
| 代理 | referral_binding、referral_binding_event、referral_reward_allocation；固定保存直属至第四级祖先 |
| 流水/客损 | gift_grant 保存赠币要求、round_player 保存下注事实、turnover_state 保存单用户剩余流水；客损在线下结算 |
| 管理/配置 | user（ADMIN role_type 与 permission code JSON）、admin_permission（路径目录）、admin_audit_event、system_config、game_config |
| 大厅/准入 | game、game_tier、game_entry |
| 运行/迁移 | room（含owner栅栏字段）、round、round_player、round_event、outbox、migration_history |

完整、当前的实体字段及功能映射以 [数据库设计 SDD](./数据库设计SDD.md) 为准；本节只展示代表性命名。旧版复数表、独立转账参与方及平台客损表不能直接生成迁移。资产 schema 以 SDD 的统一 asset_account 设计为准。


## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-10-10 | 按项目约束新增变更历史区块；未改动原有正文。 |
| 2026-10-10 | 按文档性质归档并更新相关链接。 |
| 2026-10-10 | 明确同表多角色引用的 `<role>_<table>_id` 命名规则。 |
| 2026-10-10 | 固化 Model/表逐项评审清单，并统一主键与 DATETIME(3) 硬约束。 |
| 2026-10-10 | 规定所有业务常量/枚举不使用 0，并定义查询筛选 DTO 的 0 哨兵语义。 |
