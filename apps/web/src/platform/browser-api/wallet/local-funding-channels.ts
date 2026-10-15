import { FundingChannelStatus, FundingPaymentMethod, type FundingChannelDto } from '@gameing/contracts/wallet-funding';

/** Clearly labeled local options used only by BrowserApiServer; production channels come from the payment service. */
export const LOCAL_FUNDING_CHANNELS: readonly FundingChannelDto[] = [
  { channelId: 'local-alipay', displayName: '支付宝 · 本机模拟', paymentMethod: FundingPaymentMethod.ALIPAY, sortOrder: 10, status: FundingChannelStatus.ENABLED },
  { channelId: 'local-wechat', displayName: '微信支付 · 本机模拟', paymentMethod: FundingPaymentMethod.WECHAT, sortOrder: 20, status: FundingChannelStatus.ENABLED },
  { channelId: 'local-bank', displayName: '银行卡转账 · 本机模拟', paymentMethod: FundingPaymentMethod.BANK_TRANSFER, sortOrder: 30, status: FundingChannelStatus.ENABLED },
  { channelId: 'local-unionpay', displayName: '银联二维码 · 本机模拟', paymentMethod: FundingPaymentMethod.UNIONPAY_QR, sortOrder: 40, status: FundingChannelStatus.ENABLED },
  { channelId: 'local-digital-cny', displayName: '数字人民币 · 本机模拟', paymentMethod: FundingPaymentMethod.DIGITAL_CNY, sortOrder: 50, status: FundingChannelStatus.ENABLED },
  { channelId: 'local-usdt-tron', displayName: 'USDT · TRON/TRC-20 本机演练', paymentMethod: FundingPaymentMethod.USDT_TRON, sortOrder: 60, status: FundingChannelStatus.ENABLED },
];
