import { IndexedDbPaymentChannelAdapter } from './indexeddb-payment-channel-adapter';
import { createPaymentChannelApplication } from './payment-channel-application';

export const localPaymentChannelAdapter = new IndexedDbPaymentChannelAdapter();
export const localPaymentChannelApplication = createPaymentChannelApplication(localPaymentChannelAdapter);
