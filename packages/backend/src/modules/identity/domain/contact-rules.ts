/**
 * 邮箱/手机换绑纯规则（§5 免验证码 + 精确比较 + 再认证）。
 *
 * 领域所有者：identity 模块（user.email / user.phone 换绑）。
 * 对应 SDD 章节：JWT 登录与会话设计 §5 —— "邮箱绑定和换绑不发送验证码：首次绑定依赖
 * 当前有效会话；换绑要求输入当前完整邮箱，服务端规范化后精确比较，失败时保持旧绑定，
 * 成功时在同一事务替换邮箱并立即释放旧值。手机号同样不发送短信验证码：首次绑定依赖
 * 当前有效会话；换绑要求输入当前完整手机号……若账号已设置密码，两类操作都要求当前密码；
 * 未设密码时依赖有效会话。启用 TOTP 的账号还须当前 TOTP。安全事件只记录脱敏的新旧值。"
 *
 * 纯函数，无 IO；用例层负责再认证（password/totp）与事务内的原子替换。
 */

/** 规范化邮箱（小写 trim；数据库 SDD "用户名、邮箱小写规范化后唯一"）。 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** 规范化手机（E.164；去除空格/短横线，保留前导 +；数据库 SDD "phone 使用 E.164 唯一索引"）。 */
export function normalizePhone(raw: string): string {
  return raw.replace(/[\s-]/g, '');
}

/** 邮箱脱敏（row-mapper 与 security event snapshot 共用；保留前 2 + 域名首字符）。 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, 2);
  const tail = local.length > 2 ? `${'***'}${local.slice(-2)}` : '***';
  const domainHead = domain[0] ?? '';
  return `${head}${tail}@${domainHead}***`;
}

/** 手机脱敏（保留前 3 与末 3；界面同时显示已绑定号码末三位供核对，§5）。 */
export function maskPhone(phone: string): string {
  if (phone.length <= 3) return '***';
  if (phone.length <= 6) return `${phone.slice(0, 1)}***${phone.slice(-2)}`;
  return `${phone.slice(0, 3)}***${phone.slice(-3)}`;
}

/** 手机末三位（界面核对提示用，§5 "界面同时显示已绑定号码末三位"）。 */
export function phoneTail3(phone: string): string {
  return phone.slice(-3);
}

/** 换绑校验结果。 */
export interface ContactChangeCheck {
  ok: boolean;
  /** 失败原因码（IdentityErrorCode）；ok=true 时为 null。 */
  code: 'CURRENT_EMAIL_MISMATCH' | 'CURRENT_PHONE_MISMATCH' | null;
  /** 规范化后的新值（原子替换目标）。 */
  normalizedNew: string;
  /** 规范化后的旧值（精确比较用）。 */
  normalizedOld: string;
}

/**
 * 邮箱换绑校验（§5）：输入完整旧邮箱，规范化后精确比较；失败保持旧绑定。
 * @param currentEmail 现绑定邮箱（已规范化值；null 表示未绑定——走首次绑定路径，不适用本函数）。
 * @param submittedOld 用户输入的完整旧邮箱（换绑时必填）。
 * @param newEmail 目标新邮箱。
 */
export function checkEmailChange(currentEmail: string, submittedOld: string, newEmail: string): ContactChangeCheck {
  const normalizedNew = normalizeEmail(newEmail);
  const normalizedOld = normalizeEmail(currentEmail);
  const submittedNorm = normalizeEmail(submittedOld);
  if (submittedNorm !== normalizedOld) {
    return { ok: false, code: 'CURRENT_EMAIL_MISMATCH', normalizedNew, normalizedOld };
  }
  if (normalizedNew === normalizedOld) {
    // 同值：视为无操作（用例层走 no-op 成功，不释放再重绑）。
    return { ok: false, code: 'CURRENT_EMAIL_MISMATCH', normalizedNew, normalizedOld };
  }
  return { ok: true, code: null, normalizedNew, normalizedOld };
}

/**
 * 手机换绑校验（§5）：输入完整旧手机号，规范化后精确比较。
 * @param currentPhone 现绑定手机（E.164 规范化值；null 走首次绑定路径）。
 * @param submittedOld 用户输入的完整旧手机。
 * @param newPhone 目标新手机。
 */
export function checkPhoneChange(currentPhone: string, submittedOld: string, newPhone: string): ContactChangeCheck {
  const normalizedNew = normalizePhone(newPhone);
  const normalizedOld = normalizePhone(currentPhone);
  const submittedNorm = normalizePhone(submittedOld);
  if (submittedNorm !== normalizedOld) {
    return { ok: false, code: 'CURRENT_PHONE_MISMATCH', normalizedNew, normalizedOld };
  }
  if (normalizedNew === normalizedOld) {
    return { ok: false, code: 'CURRENT_PHONE_MISMATCH', normalizedNew, normalizedOld };
  }
  return { ok: true, code: null, normalizedNew, normalizedOld };
}

/**
 * 再认证需求判定（§5 "若账号已设置密码，两类操作都要求当前密码；未设密码时依赖有效
 * 会话。启用 TOTP 的账号还须当前 TOTP"）。纯判定，输入为账号当前状态。
 */
export function contactReauthRequirements(params: { passwordConfigured: boolean; totpEnabled: boolean }): {
  requirePassword: boolean;
  requireTotp: boolean;
} {
  return {
    requirePassword: params.passwordConfigured,
    requireTotp: params.totpEnabled,
  };
}
