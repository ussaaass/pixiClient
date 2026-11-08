# 项目状态

本文件记录当前可验证状态和最近施工结果。更早的历史见下表；当摘要与新证据冲突时，优先核实当前代码、测试和架构决策，不据旧摘要推断已经闭环。

## 当前状态

- Goal round 58：SETTLED replay 重算并核验 round/player input hash，要求 settlement COMMITTED 并校验结果快照摘要及权威手牌/摆牌；round-player 归一化兼容精确 `{ userId, status }` 投影与已知完整行字段 allowlist，继续拒绝未知键。测试修正 makeSettlement status 参数并补齐 full-row replay fixture。round-settle + rooms adapter suites 89/89、backend typecheck、scoped ESLint、git diff --check 与 Graphify 更新通过；未运行 MySQL 并发集成/E2E。
- Goal round 57：round-settle 对 PREPARED settlement 返回行进行写入意图/round/status/id/hash/snapshot 绑定校验，兼容 plain row 与 Sequelize Model `getDataValue`；唯一键重放 reread 与 SETTLED replay 都在返回 DTO 前校验结果摘要绑定；Sequelize commit 条件更新要求 affectedRows=1 并读回 COMMITTED。round-settle 与 rooms adapter suites 86/86 通过，backend typecheck 通过。scoped ESLint 尚未通过终验（Docker 命令链因容器内无 git 而未运行 diff 部分）；宿主机 git diff --check 与 Graphify 更新通过。无 MySQL 并发集成/E2E。\n- Goal round 55：round-settle 玩家集合防御按路径分层：SETTLING 强制完整规则/资金行字段，SETTLED replay 接受精确 userId/status 投影且要求四人均已结算；普通对象/稠密数组/唯一规范 ID 和 trap 拒绝仍共同约束。补充最小 replay 成功用例；历史验证 settle 49/49，不能覆盖后续修改。
- Round 136 撤回 Round 135 对 REVERSED 流水自动放行的错误推断：规则/SDD未定义可放行语义，adapter 对 REVERSED+正余额继续 fail closed；更新状态测试与文档决策记录。上一轮81/81不代表 REVERSED 的业务行为获批。
- Round 134 收紧 round-settle 持久化 wagerCoins 校验为正数规范十进制（BIGINT 范围），拦截损坏/零下注快照；新增零、前导零、负值、越界回归，保证规则计算与账务前 fail closed。round-settle/start + turnover adapter 定向测试 79/79，backend typecheck、scoped ESLint、Prettier 通过。
- API-GAP-032（2026-11-08）：新增 registration_operation 幂等墓碑及 AES-GCM 短期 replay，匿名 PLAYER/device/player COIN+CNY accounts/welcome gift 共享 SQL transaction；设备 cookie 按凭证固定 90 天，server registration 默认由 `AUTH_DEVICE_REGISTER_ENABLED` gate 关闭，保持部署 fail closed。Redis session 以 Lua 原子检查 sid tombstone；migration 0022 将注册 replay bundle 持久关联到 session id，logout 清除 SQL 密文后再完成撤销，避免已撤销 sid 仍因 registration replay bundle 重新投影。Redis 丢失、其他 session 来源、并发延迟投影和全用户撤销栅栏仍未完成。迁移 0020/0021/0022 完成 compose MySQL up/status/down/up/status；registration/logout/repository/session tests 14/14、auth routes 20/20、backend/server typecheck、opt-in refresh Redis Lua integration 2/2 通过；Graphify 与宿主 diff check 已做。仍缺 MySQL/Redis uncertain-ACK/并发故障注入、浏览器 cookie/E2E、welcome gift+system asset 部署准备证明；不得宣称 production flow 完成或启用 gate。
- Round 133 复核阶段 0 玩家入口与阶段 1 牌局依赖：匿名 device-register 仍由 auth route 固定 503 拒绝，因 deviceCode 只作识别、独立安全秘密、幂等注册及 SQL/Redis 故障恢复尚未形成可用协议；没有猜造生产凭证。继续验证流水 adapter 的 FOR UPDATE、事务透传、扣减/钳零完成、缺失行及输入门禁。其余见上一条 Round 132。
- Round 132 补齐 round-settle 成功时逐玩家按 wagerCoins 消费流水的回归；新增 Sequelize wallet adapter consumeTurnover 测试，覆盖 FOR UPDATE 与事务透传、部分扣减、超额钳零并 COMPLETE、缺失行无流水门槛、正金额/事务门禁。round-settle/start + adapter 定向测试 79/79，backend typecheck、scoped ESLint、Prettier 通过；未运行真实 MySQL 并发集成。权威发牌/私有手牌及公平审计仍受 SDD 未决决策阻塞。
- Round 131：round-settle 成功分支按持久化 round_player.wagerCoins 调用 wallet `consumeTurnover`，在牌局财务事务内锁行扣减 turnover_state，扣到 0 后标记 COMPLETE，单局幂等 replay 不消费流水。定向测试、backend typecheck 通过；权威发牌/私有手牌及公平审计仍受 SDD 未决决策阻塞。
- Round 129：后端已改为水数请求，由冻结档位 stake policy 派生 wager 与 max-loss 并写入 round 快照；建房路由按 game/tier 查询 game_config 并冻结策略。定向测试 85/85，backend 与 server typecheck 通过。运营配置发布、权威发牌/私有手牌/公平审计及用户端联机闭环仍未实现。
- Round 128 round-settle 校验 SETTLING 持久 round fencingToken 与调用请求均在 BIGINT UNSIGNED 范围内；越界请求 FENCING_CONFLICT、损坏存储快照 STORAGE_UNAVAILABLE，均在 settlement/账务前 fail closed。新增边界回归；round-settle/start/submit 定向测试 106/106、backend typecheck、scoped ESLint、Prettier 和 diff check 通过。
- Round 127 round-settle 将 request 和锁读 SETTLING round 的 fencingToken 校验到 BIGINT UNSIGNED 上限；超限请求拒绝，损坏存储 token 以 STORAGE_UNAVAILABLE 拒绝，在规则、settlement 写入与账务前 fail closed。新增请求和存储 token 越界回归；round-settle/round-start/round-submit 定向测试 106/106、backend typecheck、scoped ESLint、Prettier 与 diff check 通过。
- Round 126 round-start 校验 `maxRoundNoByRoom` 的运行时返回类型与 BigInt 范围，确保 roundNo 可以安全递增；MAX、负值和非 BigInt 在创建 round/占款前 STORAGE_UNAVAILABLE fail closed。三类回归及定向 101/101、backend typecheck、scoped ESLint、Prettier、diff check 通过。
- Round 125 round-start 在 maxRoundNo 返回后、createRound 和资金操作前验证 roundNo 序列为 BigInt 0≤n<BIGINT UNSIGNED max；负数、错误类型及耗尽序列 STORAGE_UNAVAILABLE fail closed，阻止 maxNo+1 溢出。新增 max/负值/非法类型回归；round-start/round-submit/round-settle 定向测试 101/101、backend typecheck、scoped ESLint、Prettier 与 diff check 通过。
- Round 124 round-start 将请求 fencingToken 的 BIGINT UNSIGNED 上限校验放在 room 锁读之前；超限 token 直接以 INVALID_SUBMISSION 拒绝，不发生数据库/钱包访问。新增请求上限+1 不触及 repository 回归；相关定向测试 98/98、backend typecheck、scoped ESLint、Prettier、diff check 通过。
- Round 123 round-start 将请求与持久化 room fencingToken 限制到 BIGINT UNSIGNED 最大值 18446744073709551615；拒绝溢出 token，防止 token bump 越界并破坏 fencing 序列；补上限+1 与拒绝状态/资金副作用回归。round-start/round-submit/round-settle 定向测试 98/98、backend typecheck、scoped ESLint、Prettier 与 diff check 通过。
- Round 122 round-start 在 room ACTIVE 状态迁移、round 查找及资金操作之前校验四个 SEATED membership 的 seatNo 互异；防止脏快照出现多人共用权威座位。新增重复 seat 回归；round-start/round-submit/round-settle 定向测试 97/97、backend typecheck、scoped ESLint、Prettier 与 diff check 通过。
- Round 121 room-join 检查 `game_entry` QUEUED→SEATED 条件 UPDATE 的 affectedRows：零行竞争拒绝成功响应；受影响为 1 后校验重读行存在、用户/状态/房间归属及仍有效。用例和 adapter 回归通过；room-join/room-create/round-start + adapter 测试 80/80、backend typecheck、scoped ESLint、Prettier 与 diff check 通过。
- Round 120 room-join 检查 game_entry QUEUED→SEATED 条件 UPDATE 的 affectedRows；0 行竞争返回 GAME_ENTRY_NOT_FOUND，不再在最终查库行看似正确时误报成功；成功写入后核验非空行、用户/状态/roomId 归属及未过期；room-join/room-create/round-start 与 Sequelize rooms adapter 定向测试 80/80、backend typecheck、scoped ESLint、Prettier 和 diff check 通过。
- Round 119 round-submit 将 Sequelize/领域返回的有效 `Date` 或字符串 submittedAt 规范化为 ISO 字符串再返回契约 DTO；非法/空日期 fail closed，补充 Date 对象回归；round-submit/round-start/round-settle 定向测试 96/96、backend typecheck、scoped ESLint、Prettier 与 diff check 通过。
- Round 118 round-submit 以 post-submit 的 round_player 状态集合判定 SETTLING 前，校验成员数恰为 4、user ID 合法且去重、状态属于 RoundPlayerStatus；损坏列表以 STORAGE_UNAVAILABLE 拒绝并不触发 markRoundSettling。新增数量、重复 user、非法 status 回归；round-submit/round-start/round-settle 定向测试 94/94、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 更新通过。
- Round 117 room-join 对当前有效 game_entry 增加 ID/user 归属门禁，且 SEATED entry 的 roomId 必须和当前请求一致；坏资格持久快照在 claim 前或重放 DTO 返回前拒绝，新增入座与重放损坏 entry 回归；room-join/room-create/round-start 定向测试 73/73、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 更新通过。
- Round 116 round-submit 在读取参与者列表和提交写入前校验锁定 round 的 ID、roundKey、有效 RoundStatus 与规范 fencingToken；坏持久快照以 STORAGE_UNAVAILABLE fail closed，覆盖四类错误字段；round-submit/round-start/round-settle 定向测试 91/91、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 更新通过。
- Round 115 round-submit 在 submitRound 返回后验证 round_player ID 为规范正十进制字符串、submittedAt 为有效时间戳；损坏返回在事件追加及 post-submit 状态扫描前 fail closed。新增坏 ID/日期回归；round-submit/round-start/round-settle 定向测试 87/87、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 更新通过。
- Round 114 round-start 在 ACTIVE round 幂等重放及 createRound duplicate 返回 DTO 前校验 round ID、非空 key、已登记 RoundStatus 和规范 fencingToken；损坏快照在 round-player 查询/资金处理前以 STORAGE_UNAVAILABLE 拒绝。新增四类 replay 与两类 create-conflict 快照回归；round-start/room-join/round-settle 定向测试 84/84、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 更新通过。
- Round 113 round-start 在状态迁移前检查 room fencingToken 快照为规范正十进制串、rulesSnapshot 为非 null 非数组对象；损坏持久 room 状态以 STORAGE_UNAVAILABLE 拒绝，阻断 BigInt 转换异常与错误规则快照入 round 路径。新增坏 token/rules 快照回归；round-start/room-join/round-settle 定向测试 78/78、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 更新通过。
- Round 111 room-join 对 QUEUED/SEATED entry 的 expiresAt 快照要求可解析为有限时刻；坏日期以 STORAGE_UNAVAILABLE 拒绝，避免 Invalid Date 的 NaN 比较绕过过期门禁。加入与同房重放两条路径共用校验，新增坏日期的新入座与同房重放回归；room-join/room-create/round-start 定向测试 58/58、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 更新通过。
- Round 110 room-join 校验 joinRoom 的返回 membership 与请求 room/user、ID/座位合法性一致，且 seatNo 必须等于锁内 seatedCount+1 分配位置；损坏 repository 返回在 game-entry lookup/claim 前拒绝。新增异常 insert-result 回归。room-join/room-create/round-start 定向测试 57/57、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 更新通过。
- Round 108 room-create 在幂等重放返回 DTO 前验证持久 room 快照的正 ID、六位 room code、有效房间状态、正整数容量和非空 ownerKey；损坏数据 fail closed，且不继续创建 game-entry。五类损坏重放快照回归已覆盖；room-create/room-join/round-start 定向测试 56/56、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 更新通过。状态快照要求属于已定义 RoomStatus 枚举，不允许任意非零整数。
- Round 107 room-create 增加仓储前输入形状门禁：user/game/tier ID 采用规范正十进制串，capacity/roomType 为正整数，ownerKey 非空且 rulesSnapshot 为对象；坏输入不生成房间码、不执行 room/game-entry 写入。该项只属格式检查，服务端可信 game/tier rules/config 仍待定义并接入。room-create/room-join/round-start 定向测试 51/51、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 更新通过。
- Round 106 round-start 在房间状态迁移、活动局幂等读取及资金调用前检查已入座 membership 的 ID、user ID 和 seatNo 快照；缺失/非规范 ID 或超界座位均以 STORAGE_UNAVAILABLE 拒绝。为此修复早期 fixture 曾有数次定向测试失败，现已对齐真实十进制持久 ID 与成员快照。room-start/room-join/round-settle/round-submit 定向测试 87/87、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。
- Round 105 room-join 额外校验锁定 room 的 capacity 为正整数，并要求 seatedCount 是 0..capacity 的整数；失效存储快照在 membership 重放检查或 seat 写入前拒绝。增加非法 capacity 与超容量 seatedCount 回归。room-join/round-start/round-settle/round-submit 测试 83/83、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。
- Round 104 room-join 对幂等重放返回的 persisted membership 增加一致性门禁：roomId/userId 必须匹配请求，membership ID 为规范正十进制 ID，seatNo 在 capacity 内。五种损坏快照均在 game-entry 读取、seat count 与 join 写入前拒绝。room-join/round-start/round-settle/round-submit 定向测试 78/78、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。
- Round 102 round-settle 在运行 scoring 和账户/账本 I/O 前，校验参与者 maxLossHoldCoins 为正的规范十进制字符串、assetHoldId 为合法正十进制 ID；无效值以 STORAGE_UNAVAILABLE fail closed。新增五类损坏字段用例并断言 scoring 与 ledger 零调用。round-settle/round-submit 测试 46/46、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。
- Round 101 移除 round-submit snapshot 初始化处对已规范化 arrangement 的重复 `structuredClone`：`normalizeArrangement` 已逐槽读取自身数据描述符并生成独立数组副本，因此重复 clone 没有额外隔离效果。保留仓储改写来源数组仍不影响提交快照的回归。
- Round 97 补强 round-submit 输入门禁：逐个 pile 槽位通过自有数据属性描述符取值并即时执行数字/范围检查，不执行 getter；新增 accessor card-slot 回归，断言拒绝且 getter 未运行。定向测试、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 待本轮验证。
- Round 94 收紧 round-submit 的 arrangement 结构检查：Reflect.ownKeys 拒绝隐藏额外自有属性，属性描述符与稠密数组检查拒绝 getter 和稀疏/扩展数组，避免校验读取与后续快照/哈希读取不一致；仓储访问前拒绝回归覆盖。round-submit 测试 12/12、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。
- Round 93 复核结算并发唯一键重放：重放分支在读取账户、排序加锁和校验完整快照之后才可识别唯一键冲突；因此重放虽不重复 ledger 写入，仍依赖当前所有账户可读且锁接口可用。按 SDD 结算锁顺序先锁账户再争 settlement 唯一键，保留该 fail-closed 事务语义；测试明确区分“读取/锁”与“资金写入”并确认不重复账本写。round-settle 30/30、backend typecheck、scoped ESLint、Prettier、diff check 通过。权威发牌/私有状态加密仍受 SDD 未决随机性、密钥和披露决策阻塞，未伪造输入实现。
- Round 90 round-settle 在调用唯一 settlement 持久化前，按账户 ID 锁定并验证玩家及系统 COI 快照数量、账户关联、归属和类型；坏快照的回归明确断言 settleRound 未调用。settlement 唯一键冲突仍读取并验证既有行，幂等重放不重复资金写入。round-settle 30/30、backend typecheck、scoped ESLint、Prettier 与 diff check 通过。
- Round 89 round-settle 锁定所有玩家及系统 COI 后，不再仅信任 lockAccountsByIds 的调用成功；校验锁结果完整且账户归属、资产类型、账户类型都与预期一致，在 hold 检查、占款释放与账本分录前 fail closed。回归验证缺失锁快照无后续 ledger 操作。
- Round 87 复核 Round 86 开局锁账户改动：排序比较器现在对相同 ID 返回 0；锁接口若异常返回缺行/空行则 fail closed，防止不完整的锁结果被当作已保护快照。增加按账户数值顺序锁定先于逐玩家资金操作的回归。定向房间测试 68/68、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。
- Round 86 修复 round-start 余额 TOCTOU：对四个玩家 COI 账户一次性按 ID 排序加锁，校验锁定账户归属/类型后只以锁后 amount/frozenAmount 做可用余额门禁，再入账占款；权威下注/占款金额仍依赖产品可信配置。round-start/round-settle/round-submit/rooms adapter 67/67，backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。
- Round 85 复核发现当前 round-submit 只有客户端传入 arrangement，没有服务端持有手牌来源；不得用客户端自带13张牌伪造 server ownership 校验。纯 arrangement 结构/范围/重复门禁保留，heldCards 权威校验依赖 server-authoritative dealing 尚待闭环。round-submit/round-settle/round-start/rooms adapter 定向测试 67/67，backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。
- Round 84 纠正上一轮误记：并发唯一键 replay 允许四名 round_player 为 SUBMITTED 或 SETTLED，settled round replay 才强制全部 SETTLED；统一复用行/结果校验并补有效并发 replay 成功、无账本副作用测试。
- Round 83 将并发唯一键命中的结算重放纳入与 SETTLED replay 相同的行归属、四人集合、有效参与者状态、water 守恒验证，防止另一实例创建后返回的快照绕过 replay 守卫。并发 replay 损坏 water 快照无副作用回归通过；round-start/round-settle/rooms adapter 56/56，backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。
- Round 82 在分录前读取并核验所有 GAME hold 与玩家账户、round 快照额度及 hold key 一致，避免释放异常/串联占款后照常入账。
- Round 80 settlement scoring 输出中每名玩家的负 water 不得低于 `-maxLossHoldCoins`，最大亏损占款形成的负债风险边界在规则执行后、settlement 持久化前验证。
- Round 81 settled replay additionally requires every round_player status SETTLED; Round 79 verifies settlement row belongs to locked round; Round 78 requires exactly four unique round_player userIds.
- Round 77 将 scoring water 边界收紧为 JS safe integer；不安全整数在持久化/账本前拒绝，避免 BigInt 转换隐藏浮点精度损失。settled replay 同样验证快照字段与守恒。
- Round 73 的 review 发现 `/rounds` start replay 查询包含 SETTLING，但该状态应通过结算端点处理；现只对 PREPARING/ACTIVE 返回幂等成功，避免混淆业务动作，增加状态门禁测试。

- 房间/牌局用例包含成员授权、fencing、幂等和资金侧门禁；Round 70 为 round-start 所有既有 round replay 返回路径增加了 round_player / 当前 SEATED membership 对照，要求四人数量、userId、membership ID 与 seatNo 一一匹配且 seatNo 唯一。
- API-GAP-035 增加限缩恢复权 claim：caller-owned transaction 按 room→round 锁、仅投影 roomId、ACTIVE room/round + token 一致性检查后双表 CAS 递增 fencing token 并转 RECOVERING；PREPARING/SETTLING/终态 fail closed。focused tests 17/17、backend typecheck、Graphify 在原分支通过；当前集成复验待执行。未完成 worker lease/failure detection/scheduling、handler replay/private-card recovery、timeout policy、settlement 或生产恢复 E2E。
- Round 68 settlement 防止重复玩家 userId/playerId 集合进入规则/账本处理；Round 74 进一步要求 scoring water 总和为零，先于 settlement 持久化与账本访问 fail closed。Round 69/70 start replay 防止参与者或座位快照漂移。
- 生产匿名身份注册仍受凭证 bootstrap 协议阻塞；不得自行发明 device secret 的 wire 传输/挑战协议。
- 服务端权威发牌、私有牌状态加密与争议审计、正式 game/tier 定价与 scoring config snapshot 仍未完成；不声称联机游戏端到端闭环。
- 资产、支付、返佣、提现等未完备项以其领域 SDD 与测试事实为准；缺少 provider 或产品决策时保持 fail closed。

## 最近验证

- Round 70：rooms round-start、round-settle、Sequelize rooms adapter 定向测试 **43/43**；backend typecheck、相关 ESLint、Prettier、`git diff --check`、Graphify 更新通过。round-start 为 createRound 唯一键命中 replay 路径增加相同参与者快照验证。
- Round 69：开局 active round replay 检查当前房间入座与 round_player 成员/座位快照一致。
- Round 68：settlement round-player / scoring 输出 ID 唯一性 fail-closed 检查。

## 变更历史

| 日期 | 变更 |
| 2026-11-08 | API-GAP-032 provisioning：新增 migration 0021、SQL permanent key/hash tombstone + AES-GCM 24h replay、匿名玩家/device/wallet/gift 同事务用例、90d device cookie 和默认 disabled gate。MySQL 0020/0021 up/status/down/up/status；Docker registration 2/2、wallet ensure 6/6、auth routes 19/19、backend/server typecheck 通过。仍未做 MySQL/Redis 故障注入与真实浏览器验收，生产 gate 保持关闭。 |
| 2026-11-08 | API-GAP-035 rooms 恢复 fencing claim 经集成并入 main：ACTIVE room/round 同事务按 room→round 锁、双表 expected-token CAS 递增并转 RECOVERING；不含 worker/replay/timeout/结算/财务副作用。集成分支既有 focused suite 17/17；归档 main 上完整复验记录于合并提交后。 |
| 2026-11-07 | Goal round 54 settle round_player 授权前快照校验覆盖数组稠密性、成员字段/原型/反射异常；adapter+submit+settle 定向155/155、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 52 replay 分支校验返回 row 的 round/user/type/status、规范 ID 与有效 submittedAt；错绑快照 STORAGE_UNAVAILABLE。adapter+submit/settle 151/151、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 51 adapter 要求 submit 更新恰好一行并验证重读快照匹配轮次/用户/状态/key/hash/type；异常 fail closed。新增回归，定向145/145、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 50 submitRound 返回对象拒绝额外 enumerable fields，严格限定 inserted/roundPlayer；新增异常返回回归，定向测试138/138、backend typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 49 确认 arrangement 根最终快照门禁在 lockRound 仓储触达前；动态根描述符回归与 adapter+submit/settle 136/136、typecheck、lint、Prettier通过。 |
| 2026-11-07 | Goal round 48 所有牌堆快照完成后复核 arrangement 根键/字段引用/flags 稳定；定向测试136/136、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 47 arrangement 初始 ownKeys 和 descriptor-map 反射操作之间校验键集合稳定；新增顺序变化 Proxy 回归，定向测试135/135、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 46 arrangement 根 descriptor 二次快照核对 pile 引用及属性标志稳定；定向测试135/135、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 45 根 arrangement descriptors 进行二次快照，验证 pile 引用身份稳定；新增变化 descriptor Proxy 测试，定向测试134/134、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 44 pile descriptor-map 反射阶段 trap 归一化为 INVALID_SUBMISSION；定向测试133/133、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 43 确认牌堆槽位仅约束 enumerable data descriptor，不额外拒绝冻结数组；新增非枚举槽位测试，定向测试132/132、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 42 牌堆卡槽描述符读取前后复核 ownKeys 稳定，拒绝变化 Proxy；定向测试131/131、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 41 arrangement 根 ownKeys 经 descriptor 归一化后重新核验集合稳定；新增 Proxy 键变化测试，定向测试130/130、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 40 牌堆 Proxy 键快照需与描述符键集合一致，拒绝自相矛盾 ownKeys 结果；定向测试129/129、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 39 arrangement 原型/牌堆描述符与 ownKeys trap 失败关闭为 INVALID_SUBMISSION；定向测试128/128、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 38 round、round_player 与成员状态必需字段统一拒绝 non-enumerable data properties；定向测试126/126、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 37 快照 getPrototypeOf trap 失败关闭；Date 验证改用原生 getTime 并拒绝 Date Proxy；定向测试124/124、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 36 round/round_player snapshot descriptor trap 归一化为 STORAGE_UNAVAILABLE，避免底层 Proxy 异常泄漏；定向测试122/122、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 35 锁读 round 与提交返回 round_player 快照强制普通对象、精确 enumerable data fields，拒绝额外存储属性；定向测试120/120、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 34 玩家数组 ownKeys 集合受限于精确规范索引，并在校验后无序比较复核，新增索引替换 Proxy 回归；定向测试118/118、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 33 校验后比较玩家数组 ownKeys 快照，捕获校验期间 Proxy 集合形状变化；定向测试117/117、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 32 玩家数组槽 descriptor 改为单次读取和直接值归一化；定向测试116/116、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 31 round-player 集合/成员限定为普通数组、普通对象及精确字段形状，拒绝额外元数据属性；定向测试116/116、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 30 round-player 槽描述符快照复用，避免迭代器在校验后重新触碰输入数组；定向测试115/115、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 29 玩家集合验证后立即归一化为内部快照，避免通过检查后再遍历恶意 Proxy/被篡改集合；定向测试115/115、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 28 round-player 集合的 Proxy 反射异常转 STORAGE_UNAVAILABLE 并在提交前停止；定向测试115/115、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 27 submitRound 返回强制普通对象与精确 enumerable data fields，hostile Proxy trap 归一化为 STORAGE_UNAVAILABLE 且不追加事件；定向测试114/114、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 26 submitRound 返回 DTO 改为自有数据描述符读取，拒绝 accessor 且不执行 getter；定向测试113/113、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 25 输入字段与牌堆 descriptor 支持冻结对象，只要求自有 enumerable 数据属性；对调用方 arrangement 做 descriptor 读取并复制快照；定向测试112/112、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 24 round-submit 输入字段强制标准 enumerable/configurable/writable own data descriptor；定向测试109/109、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 23 牌值严格要求 Number.isSafeInteger number，杜绝对象 coercion 进入归一化；定向测试108/108、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 22 round-submit 入口捕获 hostile input/arrangement Proxy 反射异常，归一化为 INVALID_SUBMISSION 并保持仓储零调用；定向测试107/107、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 21 round-submit input 严格仅接受必需字符串 ownKeys，拒绝额外 Symbol key；定向测试106/106、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 20 round-submit use-case input 校验拒绝 accessor 与额外 key，不执行 getter 且在 repository 前失败；定向测试105/105、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 19 卡槽数字索引描述符强制 enumerable/configurable/writable，拒绝非标准数据属性；定向测试104/104、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 18 pile 数字索引要求 canonical key（无前导零）且严格在规范范围，拒绝 `01`/越界 key；定向测试103/103、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 17 pile ownKeys 限制为 length/数字索引，额外 metadata 属性在 repository 前拒绝；定向测试102/102、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 16 pile length 强制原生数据属性与规范长度，拒绝 accessor/伪造长度；定向测试101/101、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 15 arrangement / piles 强制普通对象与原生 Array 原型，拒绝 null/custom prototype 输入；定向测试100/100、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 14 arrangement 根对象 pile 字段改为描述符读取，root accessor 不执行且 INVALID_SUBMISSION；定向测试99/99、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 13 lockRound round 快照核心字段使用数据属性描述符安全读取，accessor 不执行且失败关闭；定向测试98/98、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 12 round_player 集合读取改用数据属性描述符，userId/status accessor 不执行且失败关闭；定向测试97/97、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 11 新提交 round_event payload_ciphertext 强制绑定 32-byte submissionHash，长度异常在 append 前拒绝；定向测试96/96、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 10 校验 submitRound inserted/replay 与 ACTIVE/SETTLING 状态一致，回放错态在事件追加前拒绝；定向测试95/95、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 9 submitRound 返回 roundPlayer 必需字段采用 Object.getOwnPropertyDescriptors 安全读取，accessor 不执行并 STORAGE_UNAVAILABLE；定向测试94/94、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 8 对 submitRound malformed 返回值（null/缺字段/非布尔 inserted）在事件和后续读取前失败关闭；定向测试93/93、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 7 round-submit 拒绝非规范 userId/roundId（含前导零、零值），避免格式歧义进入锁读、查询及幂等键；定向测试89/89、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-07 | Goal round 5/6 round-submit round_player 集合验证收敛：提交前拒绝稀疏集合，提交后要求四名唯一合法成员；三组定向测试87/87、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-06 | Goal round 4 `markRoundPlayerSettled` adapter 校验 netCoinDelta 为规范有符号整数串；无效格式在 DB update 前拒绝。adapter+submit/settle 87/87，backend typecheck/scoped ESLint/Prettier通过。 |
| 2026-11-06 | Goal round 3 SequelizeRoundRepo round/round_player 条件状态转换验证影响行数必须为 1；零行更新 STORAGE_UNAVAILABLE fail closed。适配器+submit/settle 81/81、typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-06 | Goal round 2 校验 round-submit pre-submit round_player 快照 userId 唯一性、合法性及状态值；损坏列表在提交/事件写入前 STORAGE_UNAVAILABLE 失败关闭。submit/settle 定向测试72/72、backend typecheck、scoped ESLint、Prettier、Graphify、diff check通过。 |
| 2026-11-06 | Goal resumed round 1 round-submit 入库前增加牌槽数据属性完整性预检，避免槽位 getter 执行；回归明确断言 getter 零调用；submit/settle 71/71、backend typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-06 | Goal round 8 新增元数据 accessor 零调用回归，证明 snapshot descriptor 批量读取不执行 getter；round-settle/submit 71/71、backend typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-06 | Goal round 7 将 round-settle 快照 descriptor 读取改为 `Object.getOwnPropertyDescriptors` 一次提取，附加元数据 accessor 不执行且不限制元数据字段；定向71/71、backend typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-06 | Goal round 6 使用 descriptor 读取 snapshot 的 heldCards/arrangement，避免属性访问器执行；保留额外元数据兼容性。定向测试71/71、backend typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-06 | Goal round 5 在 round-settle 使用自有属性描述符读取手牌和区域牌槽，显式拒绝访问器/稀疏或额外数组属性；手牌/区域 getter 零执行回归。round-settle/submit 71/71、backend typecheck、scoped ESLint、Prettier、Graphify 与 diff check通过。 |
| 2026-11-06 | Goal round 4 扩展 round-settle 持久手牌数组结构校验，拒绝稀疏槽与访问器槽；settle/submit 定向测试71/71、backend typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-06 | Goal round 3 复核提交层无服务端权威手牌来源，不接受客户端伪造牌权校验；round-settle 增加四家手牌逐张唯一约束和正式规则 validator 验证。submit/settle 测试70/70、backend typecheck、settle scoped ESLint、Prettier、Graphify与diff check通过；跨玩家重复牌回归、规范手牌 fixtures 更新后最终复跑仍70/70； |
| 2026-11-06 | Goal round 2 增加 round-settle submission_snapshot 严格校验：13张合法手牌及摆牌必须通过纯规则 validator，异常快照在算分/账本前失败关闭；定向测试42/42、backend typecheck、scoped ESLint、Prettier通过；权威发牌和安全私牌仍未闭环。 |
| 2026-11-06 | 持续施工复核并为直属上级 reward_type adapter 查询补回归（绑定缺失、枚举 1/2、事务透传、非法持久化值失败关闭）；定向测试88/88、backend/server typecheck、scoped ESLint、Prettier、Graphify及diff check通过。 |
| 2026-11-06 | Round 137 为金币兑余额提交增加事务内流水门禁，阻断未完成流水玩家兑换；新增无副作用/顺序回归，定向测试83/83、backend typecheck、scoped ESLint、Prettier通过。 |
| 2026-11-06 | Round 136 撤回 Round 135 对 turnover REVERSED 的放行推断；无权威业务规则支持时保持 fail closed，相关测试更新并记录需裁定状态语义。 |
| 2026-11-06 | Round 134 收紧 persisted wagerCoins 为正数并补损坏快照拒绝回归；round-settle/start/turnover adapter 79/79，backend typecheck、scoped ESLint、Prettier 通过。 |
| 2026-11-06 | Round 132 为 settlement 有效流水消费补 adapter 回归，覆盖锁/事务、剩余流水扣减与钳零完成、无流水行及输入门禁；定向测试 79/79、backend typecheck、scoped ESLint、Prettier、Graphify 与 diff check 通过，未运行 MySQL 并发集成测试。 |
| 2026-11-06 | Round 85 审计 round-submit 牌面归属：当前用例无服务端持有牌数据，不能安全断言客户端 arrangement 属于该玩家；撤回以本地 canonical cards 伪造 ownership 验证的尝试，保留结构校验，并在 status 记录该能力被权威发牌依赖阻塞。 |
| 2026-11-06 | Round 84 纠正并发 settlement replay 状态判定：SETTLING 下唯一键冲突重放允许 SUBMITTED/SETTLED，只有 round 已 SETTLED 时四名参与者全部必须 SETTLED；成功并发重放不产生账本副作用回归。round-start/round-settle/rooms adapter 57/57，backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。 |
| 2026-11-06 | Round 82 结算前逐一读取并验证 GAME hold 状态、账户归属、类型、剩余金额及 round/user hold key；所有 hold 核验后才释放/入账，并增加损坏占款无副作用回归。round-start/round-settle/rooms adapter 55/55，backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。待验证回填。 |
| 2026-11-06 | Round 81 SETTLED replay 要求全部四名 round_player 已处于 SETTLED，防止 round 与参与者状态不一致时仍返回成功历史结果；增加异常状态 replay fail-closed 测试。round-start/round-settle/rooms adapter 54/54，backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。待验证回填。 |
| 2026-11-06 | Round 80 结算逐玩家校验负 water 不超过其 maxLossHoldCoins，占款上限作为玩家风险门禁；超额规则结果在 settlement 持久化/账本访问前拒绝，增加 no-side-effect 回归。round-start/round-settle/rooms adapter 53/53，backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。 |
| 2026-11-06 | Round 79 settled replay 检查查询返回的 settlement.roundId 必须等于锁定的 roundId，防止仓储错配结果被转为成功 DTO；增加关联错配回归。round-start/round-settle/rooms adapter 52/52，backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。 |
| 2026-11-06 | Round 78 对 SETTLED replay 增加 round_player 恰四人及唯一 userId 门禁，维持经典局的重放约束一致性；新增非四人 replay fail-closed 测试。round-start/round-settle/rooms adapter 51/51，backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。 |
| 2026-11-06 | Round 77 将 `waterToBigInt` 输入检查收紧为 `Number.isSafeInteger`，并补 scoring 输出超安全整数在 settlement 持久化/账本副作用前失败的回归。settled replay 同样拒绝非安全整数；定向 Vitest（rooms rules/domain 没有独立测试文件）、round-start/round-settle/adapter 50/50，backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。 |
| 2026-11-06 | Round 75 settled replay 也校验持久化结果玩家 ID 规范格式、water 安全整数、foul boolean 与 water 零和；损坏快照 fail closed 并补 malformed replay 回归。round-start/round-settle/rooms adapter 49/49，backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过 (Round 75). |
| 2026-11-06 | Round 74 检查 scoring adapter 输出玩家 water 总和必须为零；非守恒输出在 settlement 持久化和账本访问前 fail closed，并补无副作用测试。round-start/round-settle/rooms adapter 45/45，backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。 |
| 2026-11-06 | Round 73 发现 `findActiveRoundByRoom` 可返回 SETTLING，但 start 用例原先把它当作开局成功 replay；现拒绝 SETTLING，仅 PREPARING/ACTIVE 可由 start 重放，防止客户端将结算中状态误当新开局。room start/settle/adapter 定向测试与静态检查通过。 |
| 2026-11-06 | Round 70 将 round-start 既有 round 的参与者快照验证抽为统一 helper，并应用到按 room 查询命中与 createRound 唯一键冲突两种 replay 路径；四名玩家及 userId、membership ID、seatNo 一致且唯一，否则拒绝 replay。定向验证 43/43、backend typecheck、scoped ESLint、Prettier、diff check 与 Graphify 通过。 |
| 2026-11-06 | Round 69 开局幂等重放校验 round_player 与当前 SEATED membership 的数量、userId、membership ID、seatNo 一一对应；异常成员或座位快照 fail closed。 |
| 2026-11-06 | Round 68 settlement 要求 round_player 四名 userId 唯一，且规则输出 playerId 唯一并与本轮集合完全匹配；重复身份在规则/账本副作用前 fail closed。 |
| 2026-11-06 | Round 129 落地服务端配置派生下注：新建房读取可信 game_config 并冻结档位策略；开局合同禁止客户端传金额，服务端解析水数计算 wager/max-loss 并写入 round 快照；相关 contracts/backend/server 类型检查和 85 项测试通过。完整发牌/公平与 Admin 配置发布仍未完成。 |

## 变更历史补充：已有项目记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-08 | Support claim/resolve capability 与 migration 0019 已验证；Admin permission-management use case、同事务审计和 UI remote adapter 实现。Admin tests/typecheck 通过；server typecheck 被并发 identity registration 编译错误阻塞；0020/0021 pending，未执行用户授码。 |
| 2026-11-08 | API-GAP-032 migration 0022 将 registration replay 关联至 sid，并由 logout 清除加密密文；MySQL up/status/down/up/status、logout/registration/session tests 12/12、auth routes 19/19 与 backend/server typecheck 通过。Redis-loss/全用户 fencing、跨存储 fault injection 与浏览器 cookie 验收仍未完成，gate 保持关闭。 |

项目早期的模块状态、测试记录与未决决策较多，按领域的完整工作台账见核心旅程 SDD、各 04_domains / 05_data 权威文档及仓库现存实现。不得因本文件压缩历史摘要而把未闭环项视为完成。
