import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

declare global {
  interface Window {
    __LG_BOOT__?: {
      mounted(): void;
      painted(): void;
      ready(): void;
    };
  }
}

let app: ReturnType<typeof createApp>;
let startLocalIdentity: (() => Promise<void>) | undefined;
if (import.meta.env.DEV) {
  const { createBrowserDevelopmentIdentity } = await import('./platform/browser-api/composition');
  const identity = await createBrowserDevelopmentIdentity();
  app = createApp(App, {
    playerEntryApplication: identity.application,
    walletApplication: identity.walletApplication,
    walletFundingApplication: identity.walletFundingApplication,
    supportApplication: identity.supportApplication,
    socialApplication: identity.socialApplication,
    socialFriendsApplication: identity.socialFriendsApplication,
    checkSocialAccess: identity.checkSocialAccess,
    notificationSummaryApplication: identity.notificationSummaryApplication,
    inviteAgentApplication: identity.inviteAgentApplication,
    devFixture: identity.createTestAccount,
    readDevelopmentContactChallengeCode: identity.readDevelopmentContactChallengeCode,
    identitySessionState: identity.sessionState,
  });
  startLocalIdentity = identity.start;
} else {
  app = createApp(App);
}
app.mount('#app');
if (startLocalIdentity) void startLocalIdentity().catch((error: unknown) => {
  window.dispatchEvent(new CustomEvent('browser-identity-startup-error', { detail: error instanceof Error ? error.message : 'IDENTITY_STORAGE_UNAVAILABLE' }));
});
window.__LG_BOOT__?.mounted();
requestAnimationFrame(() => {
  window.__LG_BOOT__?.painted();
  requestAnimationFrame(() => window.__LG_BOOT__?.ready());
});
