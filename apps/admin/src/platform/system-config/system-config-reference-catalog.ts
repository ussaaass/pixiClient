import type { SystemConfigEntryDto } from '@gameing/admin-contracts/system-config';

/** Read-only requirement references for local Admin previews; production configuration comes from an API. */
export const SYSTEM_CONFIG_REFERENCE_ENTRIES: readonly SystemConfigEntryDto[] = [
  { configKey: 'new_user_gift_coins', title: '新用户赠币', configType: 'INTEGER', valueKind: 'UNSIGNED_INTEGER', referenceValue: '1000', unit: '金币', description: '新用户首次进入时的赠币数量。' },
  { configKey: 'cny_to_coin_ratio', title: '人民币与金币比例', configType: 'RATIO', valueKind: 'INTEGER_RATIO', referenceValue: '1:10', unit: '元:金币', description: '充值和兑币使用的全局基础比例。' },
  { configKey: 'minimum_withdrawal_coins', title: '最低提现金币', configType: 'INTEGER', valueKind: 'UNSIGNED_INTEGER', referenceValue: '1000', unit: '金币', description: '申请提现的最低金币数量及其整数倍门槛。' },
  { configKey: 'withdrawal_fee_rate_percent', title: '提现手续费率', configType: 'PERCENTAGE', valueKind: 'PERCENT_INTEGER', referenceValue: '5', unit: '%', description: '手续费在申请提现金额之外另行扣除。' },
  { configKey: 'coin_transfer_fee_rate_percent', title: '金币转账手续费率', configType: 'PERCENTAGE', valueKind: 'PERCENT_INTEGER', referenceValue: '5', unit: '%', description: '转账手续费由发送方在本金之外承担。' },
  { configKey: 'turnover_requirement_multiplier', title: '赠币流水倍数', configType: 'MULTIPLIER', valueKind: 'UNSIGNED_INTEGER', referenceValue: '5', unit: '倍', description: '赠币产生的流水要求倍数。' },
  { configKey: 'invite_link_ttl_years', title: '邀请链接有效期', configType: 'DURATION', valueKind: 'UNSIGNED_INTEGER', referenceValue: '2', unit: '年', description: '新签发邀请链接的默认有效期。' },
  { configKey: 'credential_qr_ttl_years', title: '账号凭证二维码有效期', configType: 'DURATION', valueKind: 'UNSIGNED_INTEGER', referenceValue: '2', unit: '年', description: '新签发账号凭证二维码的默认有效期。' },
  { configKey: 'support_asset_retention_years', title: '客服文件保留期限', configType: 'DURATION', valueKind: 'UNSIGNED_INTEGER', referenceValue: '2', unit: '年', description: '客服会话中上传文件的保留期限。' },
];
