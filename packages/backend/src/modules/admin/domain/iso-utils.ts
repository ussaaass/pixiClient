/**
 * admin 模块 iso 时间戳工具（wire 十进制 / ISO 字符串格式化；
 * BIGINT 列 Sequelize 6 严格模式下 Date | string 双类型桥接）。
 *
 * 领域所有者：admin 模块（domain 纯函数，无 IO；全模块用例 / 适配器
 * 共享）。
 * 对应 SDD 章节：后端实施 SDD §2 第 2 条（BIGINT ID 与金额 / 时间
 * wire 十进制字符串；DateTime 列 UTC ISO 8601 毫秒）、§4（用例层
 * DTO 格式化经本工具，不在路由层散写）。
 */

/** Date | string | null → ISO 字符串（缺省 new Date() 兜底，
 * 仅用于 DDL 无对应时间列的首版占位场景；正常路径传入非 null 值）。 */
export function toIso(d: Date | string | null): string {
  if (d === null) return new Date().toISOString();
  return typeof d === 'string' ? d : d.toISOString();
}

/** Date | string | null → ISO 字符串 | null（保持 null 语义，
 * 用于可选时间列；区别于 toIso 的缺省兜底）。 */
export function toNullableIso(d: Date | string | null): string | null {
  if (d === null) return null;
  return typeof d === 'string' ? d : d.toISOString();
}
