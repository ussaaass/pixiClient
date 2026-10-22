import { Type } from '@sinclair/typebox';

/**
 * 共享基础标量 schema。
 *
 * 依据 `docs/02_architecture/HTTP接口与共享DTO协议SDD.md` §2：
 * BIGINT ID、金币、人民币金额等不能安全使用 JS number 的值一律用十进制字符串传输；
 * 0 不作为业务状态/常量（仅作查询筛选哨兵，且进入领域逻辑前必须转换）。
 */

/** BIGINT UNSIGNED 主键。用字符串传输避免 JS number 精度丢失。 */
export const BigIntIdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });

/** 正整数字符串（金额、数量）。 */
export const PositiveIntegerStringSchema = Type.String({ pattern: '^[1-9][0-9]*$' });

/** 非负整数字符串（允许 0，但 0 只作为数量而非状态常量）。 */
export const NonNegativeIntegerStringSchema = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });

/** 有符号整数字符串（玩家资产余额可为负，系统金币发行余额允许为负）。不接受 "-0"。 */
export const SignedIntegerStringSchema = Type.String({ pattern: '^(0|-?[1-9][0-9]*)$' });

/** 人民币金额，两位小数（分位精度）。 */
export const CnyAmountSchema = Type.String({ pattern: '^(0|[1-9][0-9]{0,6})\\.[0-9]{2}$' });

/** 严格 ISO 8601 UTC 时间戳（毫秒精度）。 */
export const UtcTimestampSchema = Type.String({
  pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$',
});

/** UUID v4 幂等键。与服务端 requestId 校验使用同一形态约束。 */
export const UuidSchema = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });

/** 游标：不透明字符串，由服务端生成与校验。 */
export const CursorSchema = Type.String({ minLength: 1, maxLength: 512 });
