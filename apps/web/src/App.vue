<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import lobbyBackground from '../../../assets/aigen/lobby-background.webp';
import mobileLobbyBackground from '../../../assets/aigen/lobby-background-mobile.webp';
import shisanshuiSubhallBackground from '../../../assets/aigen/shisanshui-subhall-background.webp';
import lotteryGameEmblem from '../../../assets/aigen/brand/lottery-game-emblem.webp';
import PlatformAnnouncementBar from './components/PlatformAnnouncementBar.vue';
import PlatformAnnouncementDetail from './components/PlatformAnnouncementDetail.vue';
import ShisanshuiRoomFlow from './components/ShisanshuiRoomFlow.vue';
import PlayerSocialWorkspace from './components/PlayerSocialWorkspace.vue';
import PlayerFriendsWorkspace from './components/PlayerFriendsWorkspace.vue';
import PlayerNotificationsWorkspace from './components/PlayerNotificationsWorkspace.vue';
import PlayerSupportWorkspace from './components/PlayerSupportWorkspace.vue';
import PlayerInviteAgentWorkspace from './components/PlayerInviteAgentWorkspace.vue';
import PlayerWalletTransferWorkspace from './components/PlayerWalletTransferWorkspace.vue';
import PlayerWalletExchangeWorkspace from './components/PlayerWalletExchangeWorkspace.vue';
import PlayerWalletWithdrawalWorkspace from './components/PlayerWalletWithdrawalWorkspace.vue';
import PlayerEntryPage from './components/PlayerEntryPage.vue';
import { localRoomApplication } from './platform/rooms/composition';
import { localPlayerEntryApplication } from './platform/player-entry/composition';
import type { PlatformAnnouncement, PlatformAnnouncementDetail as AnnouncementDetailDto } from '@gameing/contracts/platform-events/announcement';
import type { GameRoomSnapshotDto, RoomDifficultyKey } from '@gameing/contracts/game-room';
import { LOBBY_GAME_REFERENCE } from '@gameing/contracts/lobby-game-reference';
import { GameCatalogStatus } from '@gameing/contracts/game-catalog';
import { ClientPreferenceKey, type ClientPreferenceDto } from '@gameing/contracts/client-preferences';
import { getActivePlatformAnnouncements, getPlatformAnnouncement } from './platform/announcements-api';
import { getHealth } from './platform/health-api';
import { localClientPreferenceApplication } from './platform/preferences/composition';
import { DEFAULT_CLIENT_PREFERENCES } from './platform/preferences/preferences-domain';
import type { PlayerEntryApplication } from './platform/player-entry/player-entry-application';
import type { Ref } from 'vue';
import type { SessionResponseDto } from '@gameing/contracts/identity';
import type { IdentitySettingsResponseDto } from '@gameing/contracts/identity';
import { WalletActivityType, type WalletActivityItemDto, type WalletActivityResponseDto, type WalletSummaryResponseDto } from '@gameing/contracts/wallet';
import type { WalletApplication } from './platform/wallet/wallet-application';
import type { SupportClientApplication } from './platform/support/support-application';
import type { SocialFriendsApplication } from './platform/social/friends-application';
import type { SocialApplication } from './platform/social/social-application';
import { NotificationAction, type NotificationSummaryItemDto } from '@gameing/contracts/notifications';
import type { NotificationSummaryApplication } from './platform/notifications/notification-summary-application';
import type { InviteAgentApplication } from './platform/invite-agent/invite-agent-application';
import type { WalletFundingApplication } from './wallet-funding/wallet-funding-application';

const DevelopmentContactCodeInspector = import.meta.env.DEV
  ? defineAsyncComponent(() => import('./components/DevelopmentContactCodeInspector.vue'))
  : null;
const DevelopmentWalletFundingWorkspace = import.meta.env.DEV
  ? defineAsyncComponent(() => import('./components/PlayerWalletFundingWorkspace.vue'))
  : null;

const rootProps = defineProps<{
  playerEntryApplication?: PlayerEntryApplication;
  walletApplication?: WalletApplication;
  walletFundingApplication?: WalletFundingApplication;
  supportApplication?: SupportClientApplication;
  socialFriendsApplication?: SocialFriendsApplication;
  socialApplication?: SocialApplication;
  checkSocialAccess?: () => Promise<{ enabled: boolean }>;
  notificationSummaryApplication?: NotificationSummaryApplication;
  inviteAgentApplication?: InviteAgentApplication;
  devFixture?: () => Promise<{ userId: string; displayName: string; identifier: string; password: string; recoveryQrPayload: string; recoveryQrPassword: string; recoveryExpiresAt: string }>;
  readDevelopmentContactChallengeCode?: (challengeId: string) => string | undefined;
  identitySessionState?: Readonly<Ref<SessionResponseDto | undefined>> | undefined;
}>();

type Page = 'lobby' | 'subhall' | 'entry' | 'event' | 'practice';
type LocalGameSession = import('@gameing/shisanshui-client').LocalGameSession;

function eventKeyFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/events\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
  return match?.[1];
}

const initialAnnouncementId = eventKeyFromPath(window.location.pathname);
const legacyRoomPath = /^\/games\/shisanshui\/(?:match|rooms\/(?:create|join|preview))$/;
const legacyPreviewPath = /^\/games\/[a-z0-9-]+\/preview$/;
if (legacyRoomPath.test(window.location.pathname)) window.history.replaceState({ page: 'subhall' }, '', '/games/shisanshui');
else if (legacyPreviewPath.test(window.location.pathname)) window.history.replaceState({ page: 'lobby' }, '', '/');
const page = ref<Page>(window.location.pathname === '/games/shisanshui' ? 'subhall' : initialAnnouncementId ? 'event' : window.location.pathname === '/entry' ? 'entry' : 'lobby');
const socialAccessDenied = ref(false);
const connection = ref<'checking' | 'online' | 'offline'>('checking');
const message = ref('正在连接游戏服务…');
const gameRoot = ref<HTMLElement | null>(null);
const subhallBackgroundImage = ref<HTMLImageElement | null>(null);
const gameLoading = ref(false);
const gameLoadingStage = ref('准备进入牌桌');
const gameLoadingPhase = ref(1);
const gameLoadingSeconds = ref(0);
const gameError = ref('');
const practiceTier = ref('新手练习');
const practiceReturnPage = ref<Page>('subhall');
const practiceTiers = [
  { name: '新手厅', tierName: '新手练习', difficultyKey: 'BEGINNER', symbol: '♣', detail: '熟悉规则 · 练习摆牌', minBet: 10, multiplier: 1, maxMultiplier: 5, accent: 'beginner' },
  { name: '进阶厅', tierName: '进阶练习', difficultyKey: 'ADVANCED', symbol: '♦', detail: '练习手动摆牌与比较', minBet: 50, multiplier: 1, maxMultiplier: 10, accent: 'advanced' },
  { name: '策略厅', tierName: '策略练习', difficultyKey: 'STRATEGY', symbol: '♠', detail: '练习牌型组合与取舍', minBet: 100, multiplier: 1, maxMultiplier: 20, accent: 'strategy' },
] as const;
const roomFlowOpen = ref(false);
const roomFlowReturnTarget = ref<HTMLElement | null>(null);
const roomDifficultyKey = ref<RoomDifficultyKey>('BEGINNER');
const roomDifficultyLabel = ref('新手厅');
const activePracticeRoom = ref<GameRoomSnapshotDto | null>(null);
const activeGameCardId = ref('shisanshui');
const isDesktopLayout = ref(window.innerWidth > 720);
const hoveredGameCardId = ref<string | null>(null);
const displayedActiveGameCardId = computed(() => hoveredGameCardId.value ?? activeGameCardId.value);
const motionFailedGameCards = ref(new Set<string>());
const reducedMotionRequested = ref(false);
const networkRequestsSaveData = ref(false);
const documentIsVisible = ref(true);
function formatFen(value: string): string {
  const amount = BigInt(value);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${(absolute / 100n).toString()}.${(absolute % 100n).toString().padStart(2, '0')}`;
}
function walletActivityTitle(item: WalletActivityItemDto): string {
  if (item.activityType === WalletActivityType.WELCOME_GIFT) return '新用户赠币';
  if (item.activityType === WalletActivityType.CURRENCY_EXCHANGE) return '金币兑换余额';
  if (item.activityType === WalletActivityType.PAYMENT_PURCHASE) return '充值购买金币';
  return item.activityType === WalletActivityType.TRANSFER_SENT ? '转账转出' : '转账收款';
}
function walletActivityAmount(item: WalletActivityItemDto): string {
  const value = BigInt(item.delta);
  const absolute = (value < 0n ? -value : value).toString();
  return item.currency === 'CNY' ? `¥${formatFen(absolute)}` : `${value > 0n ? '+' : value < 0n ? '−' : ''}${absolute} 金币`;
}
function walletActivityTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}
async function reloadWallet(): Promise<void> {
  if (!rootProps.identitySessionState?.value || !rootProps.walletApplication) return;
  walletSummaryLoading.value = true;
  walletActivityLoading.value = true;
  walletSummaryError.value = '';
  walletActivityError.value = '';
  try {
    const [summary, activity] = await Promise.all([rootProps.walletApplication.getSummary(), rootProps.walletApplication.getActivity()]);
    walletSummary.value = summary;
    walletActivity.value = activity;
  } catch {
    walletSummaryError.value = '钱包数据暂时无法读取，请稍后重试。';
    walletActivityError.value = '资产记录暂时无法读取。';
  } finally {
    walletSummaryLoading.value = false;
    walletActivityLoading.value = false;
  }
}
async function loadMoreWalletActivity(): Promise<void> {
  const cursor = walletActivity.value?.nextCursor;
  if (!cursor || !rootProps.walletApplication || walletActivityMoreLoading.value) return;
  walletActivityMoreLoading.value = true;
  walletActivityMoreError.value = '';
  try {
    const page = await rootProps.walletApplication.getActivity(cursor);
    const existingIds = new Set(walletActivity.value?.items.map((item) => item.entryId) ?? []);
    walletActivity.value = {
      items: [...(walletActivity.value?.items ?? []), ...page.items.filter((item) => !existingIds.has(item.entryId))],
      nextCursor: page.nextCursor,
    };
  } catch {
    walletActivityMoreError.value = '更早的资产记录暂时无法读取。';
  } finally {
    walletActivityMoreLoading.value = false;
  }
}
const gameCardMotionAllowed = computed(() => !lowDataMode.value && !reducedMotionRequested.value && !networkRequestsSaveData.value && documentIsVisible.value);
const lobbyGames = LOBBY_GAME_REFERENCE.map((game) => ({
  id: game.gameKey,
  assetKey: game.gameCode,
  name: game.name,
  category: game.category,
  description: game.description,
  playable: game.isPlayable && game.status === GameCatalogStatus.ACTIVE,
}));
const subhallBackgroundLoaded = ref(page.value === 'subhall');
const gameCarousel = ref<HTMLElement | null>(null);
type LobbyPanel = 'wallet' | 'history' | 'invite' | 'community' | 'messages' | 'support' | 'settings' | 'profile' | 'gameRules';
const lobbyPanel = ref<LobbyPanel | null>(null);
const playerSocialTab = ref<'topics' | 'friends' | 'messages'>('topics');
const activeAnnouncements = ref<PlatformAnnouncement[]>([]);
const selectedAnnouncement = ref<AnnouncementDetailDto | null>(null);
const announcementDetailLoading = ref(false);
const announcementDetailUnavailable = ref(false);
let announcementDetailRequestId = 0;
let activeAnnouncementsRequestId = 0;
const lobbyPanelElement = ref<HTMLElement | null>(null);
const lobbyPanelCloseButton = ref<HTMLButtonElement | null>(null);
const playerHelpTopic = ref<'wallet' | 'invite' | null>(null);
const playerHelpCloseButton = ref<HTMLButtonElement | null>(null);
const playerHelpConfirmButton = ref<HTMLButtonElement | null>(null);
const playerHelpTrigger = ref<HTMLElement | null>(null);
let panelReturnFocusTarget: HTMLElement | null = null;
let pageScrollBeforePanel: {
  scrollY: number;
  documentOverflow: string;
  bodyOverflow: string;
  bodyPosition: string;
  bodyTop: string;
  bodyLeft: string;
  bodyRight: string;
  bodyWidth: string;
} | undefined;
const clientPreferences = ref<ClientPreferenceDto>({ ...DEFAULT_CLIENT_PREFERENCES });
const soundEnabled = computed(() => clientPreferences.value.soundEnabled);
const lowDataMode = computed(() => clientPreferences.value.lowDataMode);
const preferenceError = ref('');
const identityActionError = ref('');
const identitySettings = ref<IdentitySettingsResponseDto>();
const identitySettingsLoading = ref(false);
const walletSummary = ref<WalletSummaryResponseDto>();
const walletActivity = ref<WalletActivityResponseDto>();
const walletSummaryLoading = ref(false);
const walletSummaryError = ref('');
const walletActivityLoading = ref(false);
const walletActivityError = ref('');
const walletActivityMoreLoading = ref(false);
const walletActivityMoreError = ref('');
const identityCredentialForm = ref<'username' | 'password' | null>(null);
const identityCredentialSaving = ref(false);
const identityCredentialError = ref('');
const identityCredentialMessage = ref('');
const usernameDraft = ref('');
const usernameCurrentPassword = ref('');
const passwordCurrentDraft = ref('');
const passwordNewDraft = ref('');
const passwordConfirmDraft = ref('');
const identityCredentialTotpDraft = ref('');
const identityContactForm = ref<'EMAIL' | 'PHONE' | null>(null);
const identityContactDraft = ref('');
const identityContactCurrentPassword = ref('');
const identityContactTotpDraft = ref('');
const identityContactCodeDraft = ref('');
const identityContactChallengeId = ref('');
const identityContactExpiresAt = ref('');
const identityContactDevCode = ref('');
const identityContactSending = ref(false);
const totpSetup = ref<{ setupId: string; otpauthUri: string; expiresAt: string }>();
const totpSetupPassword = ref('');
const totpSetupCode = ref('');
const totpSetupSecret = ref('');
const totpRecoveryCodes = ref<string[]>([]);
const totpDisablePassword = ref('');
const totpDisableCode = ref('');
const totpDisableFormOpen = ref(false);
const totpRecoveryRotateOpen = ref(false);
const totpRecoveryRotateCode = ref('');
const totpBusy = ref(false);
const recoveryQrDraft = ref<{ credentialId: string; expiresAt: string; image: string; downloaded: boolean }>();
const recoveryQrPassword = ref('');
const recoveryQrPasswordConfirm = ref('');
const recoveryQrCurrentPassword = ref('');
const recoveryQrTotp = ref('');
const recoveryQrBusy = ref(false);
const hallGuideStep = ref<0 | 1 | 2 | 3>(0);
const hallGuideNextButton = ref<HTMLButtonElement | null>(null);
const hallGuideSkipButton = ref<HTMLButtonElement | null>(null);
const hallGuidePosition = ref({ top: '50%', left: '50%' });
const hallGuideSeenKey = 'gameing-hall.hallGuide.v1';
const subhallGuideSeenKey = 'gameing-hall.shisanshuiGuide.v1';
const subhallGuideVisible = ref(false);
const subhallGuideButton = ref<HTMLButtonElement | null>(null);
const subhallGuideElement = ref<HTMLElement | null>(null);
const subhallGuidePosition = ref({ top: '16px', left: '50%' });
const hallGuideCopy = computed(() => ([
  { title: '横向浏览游戏', description: '左右滑动卡片带，选择想体验的游戏。桌面端也可用方向键浏览；当前只有十三张开放本地练习。' },
  { title: '从十三张开始', description: isDesktopLayout.value ? '点击“进入游戏厅”查看玩法和练习难度；练习不扣金币。' : '直接选择卡片中的练习难度，开始免费练习。' },
  { title: '大厅功能在这里', description: '钱包、社区、客服和个人入口都在固定导航中。' },
] as const)[Math.max(0, hallGuideStep.value - 1)]!);
let gameSession: LocalGameSession | undefined;
let gameLoadingTimer: number | undefined;
let gameCarouselMedia: MediaQueryList | undefined;
let reducedMotionMedia: MediaQueryList | undefined;
let networkInformation: (EventTarget & { saveData?: boolean; effectiveType?: string }) | undefined;
let gameCardSettleTimer: number | undefined;

function refreshNetworkMotionPreference(): void {
  const connection = (navigator as Navigator & { connection?: typeof networkInformation }).connection;
  networkRequestsSaveData.value = connection?.saveData === true || connection?.effectiveType === 'slow-2g' || connection?.effectiveType === '2g';
}

function refreshReducedMotionPreference(): void {
  reducedMotionRequested.value = reducedMotionMedia?.matches ?? false;
}

function refreshDocumentVisibility(): void {
  documentIsVisible.value = document.visibilityState !== 'hidden';
}

function isGameCardMotionActive(gameId: string): boolean {
  return gameCardMotionAllowed.value && displayedActiveGameCardId.value === gameId && !motionFailedGameCards.value.has(gameId);
}

function placeFeaturedGame(): void {
  const carousel = gameCarousel.value;
  if (!carousel) return;
  const isDesktop = gameCarouselMedia?.matches ?? window.innerWidth > 720;
  isDesktopLayout.value = isDesktop;
  if (!isDesktop) {
    carousel.scrollLeft = 0;
    return;
  }
  const featured = carousel.querySelector<HTMLElement>('[data-game-id="shisanshui"]');
  if (featured) {
    const featuredRect = featured.getBoundingClientRect();
    const carouselRect = carousel.getBoundingClientRect();
    const featuredCenter = featuredRect.left + featuredRect.width / 2;
    const carouselCenter = carouselRect.left + carouselRect.width / 2;
    carousel.scrollLeft += featuredCenter - carouselCenter;
  }
  updateActiveGameCard();
}

function updateActiveGameCard(): void {
  const carousel = gameCarousel.value;
  if (!carousel) return;
  const carouselRect = carousel.getBoundingClientRect();
  const center = carouselRect.left + carouselRect.width / 2;
  let closestId = activeGameCardId.value;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const card of carousel.querySelectorAll<HTMLElement>('.game-card')) {
    const rect = card.getBoundingClientRect();
    const distance = Math.abs(rect.left + rect.width / 2 - center);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestId = card.dataset.gameId ?? closestId;
    }
  }
  activeGameCardId.value = closestId;
}

function scheduleActiveGameCard(): void {
  if (gameCardSettleTimer !== undefined) window.clearTimeout(gameCardSettleTimer);
  gameCardSettleTimer = window.setTimeout(updateActiveGameCard, 140);
}

function handleGameCardImageError(gameId: string): void {
  if (displayedActiveGameCardId.value !== gameId || motionFailedGameCards.value.has(gameId)) return;
  motionFailedGameCards.value = new Set(motionFailedGameCards.value).add(gameId);
}

function handleGameCardPointerEnter(event: PointerEvent, gameId: string): void {
  if (event.pointerType === 'mouse') hoveredGameCardId.value = gameId;
}

function handleGameCardPointerLeave(event: PointerEvent, gameId: string): void {
  if (event.pointerType === 'mouse' && hoveredGameCardId.value === gameId) hoveredGameCardId.value = null;
}

async function openLobbyPanel(panel: LobbyPanel): Promise<void> {
  if (panel === 'community' && rootProps.identitySessionState?.value && rootProps.checkSocialAccess) {
    try { socialAccessDenied.value = !(await rootProps.checkSocialAccess()).enabled; }
    catch { socialAccessDenied.value = true; }
    if (socialAccessDenied.value) return;
  }
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && !activeElement.closest('.lobby-panel')) {
    panelReturnFocusTarget = activeElement;
  }
  lobbyPanel.value = panel;
}

function openNotificationItem(item: NotificationSummaryItemDto): void {
  switch (item.action) {
    case NotificationAction.OPEN_ANNOUNCEMENT:
      closeLobbyPanel();
      openAnnouncement(item.sourceId);
      break;
    case NotificationAction.OPEN_WALLET:
      openLobbyPanel('wallet');
      break;
    case NotificationAction.OPEN_SUPPORT:
      openLobbyPanel('support');
      break;
    case NotificationAction.OPEN_FRIENDS:
      playerSocialTab.value = 'friends';
      openLobbyPanel('community');
      break;
  }
}

function closeLobbyPanel(): void {
  playerHelpTopic.value = null;
  lobbyPanel.value = null;
  clearTotpSecrets();
  clearRecoveryQrDraft();
}

function clearRecoveryQrDraft(): void {
  recoveryQrDraft.value = undefined;
  recoveryQrPassword.value = '';
  recoveryQrPasswordConfirm.value = '';
  recoveryQrCurrentPassword.value = '';
  recoveryQrTotp.value = '';
}

async function createRecoveryQr(): Promise<void> {
  const application = rootProps.playerEntryApplication;
  if (!application || !recoveryQrCurrentPassword.value || recoveryQrPassword.value.length < 8) return;
  if (recoveryQrPassword.value !== recoveryQrPasswordConfirm.value) {
    identityCredentialError.value = '两次输入的二维码密码不一致。';
    return;
  }
  recoveryQrBusy.value = true;
  identityCredentialError.value = '';
  identityCredentialMessage.value = '';
  try {
    const result = await application.prepareRecoveryCredential({ password: recoveryQrCurrentPassword.value, qrPassword: recoveryQrPassword.value, ...(recoveryQrTotp.value ? { totp: recoveryQrTotp.value } : {}) });
    if (!result.ok) {
      identityCredentialError.value = identityFailureMessage(result.code);
      return;
    }
    const qr = await import('qrcode');
    const image = await qr.toDataURL(result.value.qrPayload, { errorCorrectionLevel: 'M', margin: 2, width: 360 });
    recoveryQrDraft.value = { credentialId: result.value.credentialId, expiresAt: result.value.expiresAt, image, downloaded: false };
    identityCredentialMessage.value = '二维码已生成但尚未启用。下载图片后确认，旧二维码在此之前仍可使用。';
  } catch {
    identityCredentialError.value = '二维码生成失败；旧二维码仍有效，请重试。';
  } finally {
    recoveryQrBusy.value = false;
    recoveryQrCurrentPassword.value = '';
    recoveryQrPassword.value = '';
    recoveryQrPasswordConfirm.value = '';
    recoveryQrTotp.value = '';
  }
}

function downloadRecoveryQr(): void {
  const draft = recoveryQrDraft.value;
  if (!draft) return;
  const anchor = document.createElement('a');
  anchor.href = draft.image;
  anchor.download = 'lottery-game-recovery-qr.png';
  anchor.click();
  draft.downloaded = true;
  identityCredentialMessage.value = '二维码图片已下载。确认你已妥善保存后，再启用新二维码。';
}

async function activateRecoveryQr(): Promise<void> {
  const application = rootProps.playerEntryApplication;
  const draft = recoveryQrDraft.value;
  if (!application || !draft?.downloaded) return;
  recoveryQrBusy.value = true;
  identityCredentialError.value = '';
  const result = await application.activateRecoveryCredential(draft.credentialId);
  recoveryQrBusy.value = false;
  if (!result.ok) {
    identityCredentialError.value = identityFailureMessage(result.code);
    return;
  }
  identitySettings.value = result.value;
  clearRecoveryQrDraft();
  identityCredentialMessage.value = '新恢复二维码已启用，旧二维码已失效。';
}

function clearTotpSecrets(): void {
  totpSetup.value = undefined;
  totpSetupPassword.value = '';
  totpSetupCode.value = '';
  totpSetupSecret.value = '';
  totpRecoveryCodes.value = [];
  totpDisablePassword.value = '';
  totpDisableCode.value = '';
  totpDisableFormOpen.value = false;
  totpRecoveryRotateOpen.value = false;
  totpRecoveryRotateCode.value = '';
}

async function logoutPlayer(): Promise<void> {
  identityActionError.value = '';
  const application = rootProps.playerEntryApplication;
  if (!application) {
    identityActionError.value = '当前运行模式未提供身份操作。';
    return;
  }
  const result = await application.logout();
  if (!result.ok) {
    identityActionError.value = '退出没有完成，请重试。';
    return;
  }
  closeLobbyPanel();
}

function openIdentityCredentialForm(form: 'username' | 'password'): void {
  identityContactForm.value = null;
  identityCredentialForm.value = form;
  identityCredentialError.value = '';
  identityCredentialMessage.value = '';
  usernameDraft.value = identitySettings.value?.username ?? '';
  usernameCurrentPassword.value = '';
  passwordCurrentDraft.value = '';
  passwordNewDraft.value = '';
  passwordConfirmDraft.value = '';
  identityCredentialTotpDraft.value = '';
}

function identityFailureMessage(code: string): string {
  const messages: Record<string, string> = {
    IDENTIFIER_ALREADY_USED: '这个用户名已被使用，请换一个。',
    REAUTHENTICATION_FAILED: '当前密码不正确，请检查后重试。',
    USERNAME_INVALID: '用户名需为 3–32 位字母、数字、下划线或连字符。',
    PASSWORD_REUSE: '新密码不能与当前密码相同。',
    TOTP_REQUIRED: '此账号已启用两步验证，需要先完成 TOTP 验证。',
    SESSION_REVOKED: '登录状态已过期，请重新登录后继续。',
    TOTP_VERIFICATION_NOT_IMPLEMENTED: '当前离线版本尚未接入 TOTP 校验，请先在验证器功能完成后修改。',
    TOTP_INVALID: '验证码不正确，或备用恢复码已使用。',
    RECOVERY_CREDENTIAL_NOT_FOUND: '待启用的二维码记录不存在，请重新生成。',
    RECOVERY_CREDENTIAL_PENDING_EXPIRED: '二维码确认时间已过，请重新生成；旧二维码仍有效。',
    TOTP_ALREADY_ENABLED: '两步验证已经开启。',
    TOTP_NOT_ENABLED: '两步验证当前未开启。',
    SETUP_NOT_FOUND: '两步验证设置已失效，请重新开始。',
    SETUP_EXPIRED: '设置验证码已过期或输入错误次数过多，请重新开始。',
    VERIFICATION_CODE_INVALID: '验证码不正确，请重新检查。',
    CHALLENGE_EXPIRED: '验证码已过期，请重新发送。',
    CHALLENGE_NOT_FOUND: '验证码请求已失效，请重新发送。',
    AUTH_RATE_LIMITED: '操作过于频繁，请稍后再试。',
    VALIDATION_FAILED: '输入格式不正确，请检查后重试。',
  };
  return messages[code] ?? '保存失败，请检查网络后重试。';
}

async function startTotpSetup(): Promise<void> {
  const application = rootProps.playerEntryApplication;
  if (!application || !totpSetupPassword.value) return;
  totpBusy.value = true;
  identityCredentialError.value = '';
  identityCredentialMessage.value = '';
  const result = await application.startTotpSetup({ password: totpSetupPassword.value });
  totpBusy.value = false;
  totpSetupPassword.value = '';
  if (!result.ok) {
    identityCredentialError.value = identityFailureMessage(result.code);
    return;
  }
  totpSetup.value = result.value;
  totpSetupSecret.value = new URL(result.value.otpauthUri).searchParams.get('secret') ?? '';
  totpSetupCode.value = '';
}

async function confirmTotpSetup(): Promise<void> {
  const application = rootProps.playerEntryApplication;
  if (!application || !totpSetup.value || !totpSetupCode.value) return;
  totpBusy.value = true;
  identityCredentialError.value = '';
  const result = await application.confirmTotpSetup({ setupId: totpSetup.value.setupId, code: totpSetupCode.value });
  totpBusy.value = false;
  totpSetupCode.value = '';
  if (!result.ok) {
    identityCredentialError.value = identityFailureMessage(result.code);
    return;
  }
  totpRecoveryCodes.value = result.value.recoveryCodes;
  totpSetup.value = undefined;
  totpSetupSecret.value = '';
  const settings = await application.getIdentitySettings();
  if (settings.ok) identitySettings.value = settings.value;
  identityCredentialMessage.value = '两步验证已开启。请立即保存这 10 个备用恢复码；关闭本面板后将无法再次查看。';
}

async function disableTotp(): Promise<void> {
  const application = rootProps.playerEntryApplication;
  if (!application || !totpDisablePassword.value || !totpDisableCode.value) return;
  totpBusy.value = true;
  identityCredentialError.value = '';
  const result = await application.disableTotp({ password: totpDisablePassword.value, code: totpDisableCode.value });
  totpBusy.value = false;
  totpDisablePassword.value = '';
  totpDisableCode.value = '';
  if (!result.ok) {
    identityCredentialError.value = identityFailureMessage(result.code);
    return;
  }
  const settings = await application.getIdentitySettings();
  if (settings.ok) identitySettings.value = settings.value;
  totpRecoveryCodes.value = [];
  identityCredentialMessage.value = '两步验证已关闭，尚未使用的备用恢复码也已撤销。';
}

async function copyTotpRecoveryCodes(): Promise<void> {
  if (!totpRecoveryCodes.value.length) return;
  try {
    await navigator.clipboard.writeText(totpRecoveryCodes.value.join('\n'));
    identityCredentialMessage.value = '备用恢复码已复制，请保存到安全的位置。';
  } catch {
    identityCredentialError.value = '浏览器未允许剪贴板访问，请手动复制并保存全部恢复码。';
  }
}

async function rotateTotpRecoveryCodes(): Promise<void> {
  const application = rootProps.playerEntryApplication;
  if (!application || !/^\d{6}$/.test(totpRecoveryRotateCode.value)) return;
  totpBusy.value = true;
  identityCredentialError.value = '';
  identityCredentialMessage.value = '';
  const result = await application.rotateTotpRecoveryCodes({ code: totpRecoveryRotateCode.value });
  totpBusy.value = false;
  totpRecoveryRotateCode.value = '';
  if (!result.ok) {
    identityCredentialError.value = identityFailureMessage(result.code);
    return;
  }
  totpRecoveryCodes.value = result.value.recoveryCodes;
  totpRecoveryRotateOpen.value = false;
  identityCredentialMessage.value = '新的 10 个备用恢复码仅显示一次；旧码已全部失效，请立即保存。';
}

async function submitUsernameChange(): Promise<void> {
  const application = rootProps.playerEntryApplication;
  if (!application || !usernameDraft.value || !usernameCurrentPassword.value) return;
  identityCredentialSaving.value = true;
  identityCredentialError.value = '';
  identityCredentialMessage.value = '';
  const result = await application.setUsername({ username: usernameDraft.value, password: usernameCurrentPassword.value, ...(identityCredentialTotpDraft.value ? { totp: identityCredentialTotpDraft.value } : {}) });
  identityCredentialSaving.value = false;
  usernameCurrentPassword.value = '';
  identityCredentialTotpDraft.value = '';
  if (!result.ok) {
    identityCredentialError.value = identityFailureMessage(result.code);
    return;
  }
  identitySettings.value = result.value;
  identityCredentialForm.value = null;
  identityCredentialMessage.value = '用户名已保存。之后可使用新用户名和原密码登录。';
}

async function submitPasswordChange(): Promise<void> {
  const application = rootProps.playerEntryApplication;
  if (!application || (identitySettings.value?.passwordConfigured && !passwordCurrentDraft.value) || passwordNewDraft.value.length < 8) return;
  if (passwordNewDraft.value !== passwordConfirmDraft.value) {
    identityCredentialError.value = '两次输入的新密码不一致。';
    return;
  }
  identityCredentialSaving.value = true;
  identityCredentialError.value = '';
  identityCredentialMessage.value = '';
  const result = await application.changePassword({ ...(passwordCurrentDraft.value ? { currentPassword: passwordCurrentDraft.value } : {}), newPassword: passwordNewDraft.value, ...(identityCredentialTotpDraft.value ? { totp: identityCredentialTotpDraft.value } : {}) });
  identityCredentialSaving.value = false;
  passwordCurrentDraft.value = '';
  passwordNewDraft.value = '';
  passwordConfirmDraft.value = '';
  identityCredentialTotpDraft.value = '';
  if (!result.ok) {
    identityCredentialError.value = identityFailureMessage(result.code);
    return;
  }
  identityCredentialForm.value = null;
  const refreshed = await application.getIdentitySettings();
  if (refreshed.ok) identitySettings.value = refreshed.value;
  identityCredentialMessage.value = '密码已更新，其他设备上的登录会话已退出。';
}

function openIdentityContactForm(contactType: 'EMAIL' | 'PHONE'): void {
  identityCredentialForm.value = null;
  identityContactForm.value = contactType;
  identityContactDraft.value = '';
  identityContactCurrentPassword.value = '';
  identityContactTotpDraft.value = '';
  identityContactCodeDraft.value = '';
  identityContactChallengeId.value = '';
  identityContactExpiresAt.value = '';
  identityContactDevCode.value = '';
  identityCredentialError.value = '';
  identityCredentialMessage.value = '';
}

async function sendIdentityContactChallenge(): Promise<void> {
  const application = rootProps.playerEntryApplication;
  if (!application || !identityContactForm.value || !identityContactDraft.value || !identityContactCurrentPassword.value) return;
  identityContactSending.value = true;
  identityCredentialError.value = '';
  const result = await application.createContactChallenge({ contactType: identityContactForm.value, contactValue: identityContactDraft.value, password: identityContactCurrentPassword.value, ...(identityContactTotpDraft.value ? { totp: identityContactTotpDraft.value } : {}) });
  identityContactSending.value = false;
  identityContactCurrentPassword.value = '';
  identityContactTotpDraft.value = '';
  if (!result.ok) {
    identityCredentialError.value = identityFailureMessage(result.code);
    return;
  }
  identityContactChallengeId.value = result.value.challengeId;
  identityContactExpiresAt.value = result.value.expiresAt;
  identityContactDevCode.value = rootProps.readDevelopmentContactChallengeCode?.(result.value.challengeId) ?? '';
  identityCredentialMessage.value = identityContactDevCode.value ? '本地开发验证码已生成。生产环境会发送到你填写的联系方式。' : '验证码已发送，请检查填写的联系方式。';
}

async function confirmIdentityContact(): Promise<void> {
  const application = rootProps.playerEntryApplication;
  if (!application || !identityContactChallengeId.value || !identityContactCodeDraft.value) return;
  identityContactSending.value = true;
  identityCredentialError.value = '';
  const result = await application.confirmContactChallenge(identityContactChallengeId.value, { code: identityContactCodeDraft.value });
  identityContactSending.value = false;
  if (!result.ok) {
    identityCredentialError.value = identityFailureMessage(result.code);
    return;
  }
  identitySettings.value = result.value;
  identityContactForm.value = null;
  identityContactDraft.value = '';
  identityContactCodeDraft.value = '';
  identityContactChallengeId.value = '';
  identityContactDevCode.value = '';
  identityCredentialMessage.value = '联系方式已验证并绑定。旧联系方式已释放。';
}

async function openPlayerHelp(topic: 'wallet' | 'invite', event: MouseEvent): Promise<void> {
  playerHelpTrigger.value = event.currentTarget as HTMLElement;
  playerHelpTopic.value = topic;
  await nextTick();
  playerHelpCloseButton.value?.focus();
}

async function closePlayerHelp(): Promise<void> {
  playerHelpTopic.value = null;
  await nextTick();
  playerHelpTrigger.value?.focus();
}

function handlePlayerHelpKeydown(event: KeyboardEvent): void {
  event.stopPropagation();
  if (event.key === 'Escape') {
    event.preventDefault();
    void closePlayerHelp();
  } else if (event.key === 'Tab') {
    event.preventDefault();
    if (event.shiftKey) {
      (document.activeElement === playerHelpCloseButton.value ? playerHelpConfirmButton.value : playerHelpCloseButton.value)?.focus();
    } else {
      (document.activeElement === playerHelpConfirmButton.value ? playerHelpCloseButton.value : playerHelpConfirmButton.value)?.focus();
    }
  }
}

function openPlayerEntry(): void {
  closeLobbyPanel();
  if (window.location.pathname !== '/entry') window.history.pushState({ page: 'entry' }, '', '/entry');
  page.value = 'entry';
}

function returnFromEntry(): void {
  if (window.location.pathname === '/entry') window.history.replaceState({ page: 'lobby' }, '', '/');
  page.value = 'lobby';
}

async function loadActiveAnnouncements(): Promise<void> {
  const requestId = ++activeAnnouncementsRequestId;
  try {
    const announcements = await getActivePlatformAnnouncements();
    if (requestId === activeAnnouncementsRequestId) activeAnnouncements.value = announcements;
  } catch {
    if (requestId === activeAnnouncementsRequestId) activeAnnouncements.value = [];
  }
}

function refreshAnnouncementsWhenVisible(): void {
  if (document.visibilityState === 'visible') void loadActiveAnnouncements();
}

async function loadAnnouncementDetail(announcementId: string): Promise<void> {
  const requestId = ++announcementDetailRequestId;
  selectedAnnouncement.value = null;
  announcementDetailUnavailable.value = false;
  announcementDetailLoading.value = true;
  try {
    const detail = await getPlatformAnnouncement(announcementId);
    if (requestId === announcementDetailRequestId && eventKeyFromPath(window.location.pathname) === announcementId) {
      selectedAnnouncement.value = detail;
    }
  } catch {
    if (requestId === announcementDetailRequestId && eventKeyFromPath(window.location.pathname) === announcementId) {
      announcementDetailUnavailable.value = true;
    }
  } finally {
    if (requestId === announcementDetailRequestId) announcementDetailLoading.value = false;
  }
}

function openAnnouncement(announcementId: string): void {
  const target = `/events/${encodeURIComponent(announcementId)}`;
  window.history.pushState({ page: 'event', announcementId }, '', target);
  page.value = 'event';
  void loadAnnouncementDetail(announcementId);
}

function returnFromAnnouncement(): void {
  announcementDetailRequestId += 1;
  if (eventKeyFromPath(window.location.pathname)) window.history.replaceState({ page: 'lobby' }, '', '/');
  selectedAnnouncement.value = null;
  page.value = 'lobby';
}

function retryAnnouncementDetail(): void {
  const eventKey = eventKeyFromPath(window.location.pathname);
  if (eventKey) void loadAnnouncementDetail(eventKey);
}

function handleHistoryNavigation(): void {
  const eventKey = eventKeyFromPath(window.location.pathname);
  if (legacyRoomPath.test(window.location.pathname)) {
    window.history.replaceState({ page: 'subhall' }, '', '/games/shisanshui');
    subhallBackgroundLoaded.value = true;
    page.value = 'subhall';
  } else if (legacyPreviewPath.test(window.location.pathname)) {
    window.history.replaceState({ page: 'lobby' }, '', '/');
    page.value = 'lobby';
  } else if (window.location.pathname === '/games/shisanshui') {
    subhallBackgroundLoaded.value = true;
    page.value = 'subhall';
  } else if (eventKey) {
    page.value = 'event';
    void loadAnnouncementDetail(eventKey);
  } else if (window.location.pathname === '/entry') {
    page.value = 'entry';
  } else {
    announcementDetailRequestId += 1;
    selectedAnnouncement.value = null;
    announcementDetailLoading.value = false;
    page.value = 'lobby';
  }
  closeLobbyPanel();
}

function moveSocialTabByKeyboard(event: KeyboardEvent): void {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  event.preventDefault();
  const tabs = ['topics', 'friends', 'messages'] as const;
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.player-social-tabs [role="tab"]'));
  const currentIndex = tabs.indexOf(playerSocialTab.value);
  const offset = event.key === 'ArrowRight' ? 1 : -1;
  const nextIndex = (currentIndex + offset + tabs.length) % tabs.length;
  playerSocialTab.value = tabs[nextIndex]!;
  buttons[nextIndex]?.focus();
}

watch(lobbyPanel, async (panel) => {
  if (panel === 'wallet' && rootProps.identitySessionState?.value && rootProps.walletApplication) {
    await reloadWallet();
  }
  if (panel === 'profile' && rootProps.identitySessionState?.value && rootProps.playerEntryApplication?.getIdentitySettings) {
    identitySettingsLoading.value = true;
    identityActionError.value = '';
    const result = await rootProps.playerEntryApplication.getIdentitySettings();
    if (result.ok) identitySettings.value = result.value;
    else identityActionError.value = result.code === 'SESSION_REVOKED' ? '登录状态已过期，请重新登录后继续。' : '账号安全信息暂时无法读取，请稍后重试。';
    identitySettingsLoading.value = false;
  }
  if (panel && pageScrollBeforePanel === undefined) {
    pageScrollBeforePanel = {
      scrollY: window.scrollY,
      documentOverflow: document.documentElement.style.overflow,
      bodyOverflow: document.body.style.overflow,
      bodyPosition: document.body.style.position,
      bodyTop: document.body.style.top,
      bodyLeft: document.body.style.left,
      bodyRight: document.body.style.right,
      bodyWidth: document.body.style.width,
    };
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `${-pageScrollBeforePanel.scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
  } else if (!panel && pageScrollBeforePanel !== undefined) {
    const previous = pageScrollBeforePanel;
    document.documentElement.style.overflow = previous.documentOverflow;
    document.body.style.overflow = previous.bodyOverflow;
    document.body.style.position = previous.bodyPosition;
    document.body.style.top = previous.bodyTop;
    document.body.style.left = previous.bodyLeft;
    document.body.style.right = previous.bodyRight;
    document.body.style.width = previous.bodyWidth;
    pageScrollBeforePanel = undefined;
    window.scrollTo(0, previous.scrollY);
  }
  await nextTick();
  if (panel) {
    lobbyPanelCloseButton.value?.focus();
    return;
  }
  const target = panelReturnFocusTarget;
  panelReturnFocusTarget = null;
  target?.focus();
});

watch(() => rootProps.identitySessionState?.value, async (session) => {
  if (session) {
    if (rootProps.checkSocialAccess) {
      socialAccessDenied.value = true;
      try { socialAccessDenied.value = !(await rootProps.checkSocialAccess()).enabled; }
      catch { socialAccessDenied.value = true; }
      if (socialAccessDenied.value && lobbyPanel.value === 'community') closeLobbyPanel();
    } else socialAccessDenied.value = false;
    if (lobbyPanel.value === 'wallet') void reloadWallet();
    return;
  }
  socialAccessDenied.value = false;
  walletSummary.value = undefined;
  walletActivity.value = undefined;
  walletSummaryError.value = '';
  walletActivityError.value = '';
  identitySettings.value = undefined;
  clearTotpSecrets();
  clearRecoveryQrDraft();
  identityCredentialForm.value = null;
  identityContactForm.value = null;
}, { immediate: true });

function handleLobbyPanelKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeLobbyPanel();
    return;
  }
  if (event.key !== 'Tab') return;

  const panel = lobbyPanelElement.value;
  if (!panel) return;
  const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.tabIndex >= 0 && !element.hidden);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) {
    event.preventDefault();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function savePreference(key: typeof ClientPreferenceKey[keyof typeof ClientPreferenceKey], value: boolean): Promise<void> {
  preferenceError.value = '';
  const result = await localClientPreferenceApplication.updatePreference({ key, value });
  if (!result.ok) {
    preferenceError.value = result.code === 'PREFERENCE_STORAGE_FAILED' ? '设置未能保存，请检查浏览器存储空间后重试。' : '无法保存此设置。';
    return;
  }
  clientPreferences.value = result.value;
}

async function loadClientPreferences(): Promise<void> {
  try {
    clientPreferences.value = await localClientPreferenceApplication.getPreferences();
  } catch {
    preferenceError.value = '设置暂时无法读取，当前使用默认偏好。';
  }
}

async function startHallGuide(): Promise<void> {
  page.value = 'lobby';
  panelReturnFocusTarget = null;
  closeLobbyPanel();
  hallGuideStep.value = 1;
  await nextTick();
  updateHallGuidePosition();
  hallGuideNextButton.value?.focus();
}

function updateHallGuidePosition(): void {
  if (hallGuideStep.value === 0) return;
  const selectors = ['', '.game-row', '.game-card.featured', window.matchMedia('(min-width: 721px)').matches ? '.lobby-actions' : '.mobile-dock'];
  const target = document.querySelector<HTMLElement>(selectors[hallGuideStep.value]!);
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const width = Math.min(380, window.innerWidth - 32);
  const height = window.matchMedia('(max-width: 720px)').matches ? 178 : 150;
  const left = Math.max(16, Math.min(window.innerWidth - width - 16, rect.left + rect.width / 2 - width / 2));
  const below = rect.bottom + 14;
  const top = below + height < window.innerHeight - 16 ? below : Math.max(16, rect.top - height - 14);
  hallGuidePosition.value = { top: `${top}px`, left: `${left}px` };
}

function handleHallGuideKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    void finishHallGuide();
    return;
  }
  if (event.key === 'Tab') {
    if (event.shiftKey && document.activeElement === hallGuideSkipButton.value) {
      event.preventDefault();
      hallGuideNextButton.value?.focus();
    } else if (!event.shiftKey && document.activeElement === hallGuideNextButton.value) {
      event.preventDefault();
      hallGuideSkipButton.value?.focus();
    }
  }
}

async function finishHallGuide(): Promise<void> {
  hallGuideStep.value = 0;
  localStorage.setItem(hallGuideSeenKey, 'true');
  await nextTick();
  gameCarousel.value?.focus();
}

function advanceHallGuide(): void {
  if (hallGuideStep.value >= 3) finishHallGuide();
  else {
    hallGuideStep.value = (hallGuideStep.value + 1) as 1 | 2 | 3;
    void nextTick(() => {
      updateHallGuidePosition();
      hallGuideNextButton.value?.focus();
    });
  }
}

async function checkService(): Promise<void> {
  connection.value = 'checking';
  message.value = '正在连接游戏服务…';
  try {
    await getHealth();
    connection.value = 'online';
    message.value = '当前在线';
  } catch {
    connection.value = 'offline';
    message.value = '离线 · 点击重连';
  }
}

async function openGameHall(): Promise<void> {
  if (subhallBackgroundLoaded.value) {
    if (window.location.pathname !== '/games/shisanshui') window.history.pushState({ page: 'subhall' }, '', '/games/shisanshui');
    page.value = 'subhall';
    maybeStartSubhallGuide();
    return;
  }
  subhallBackgroundLoaded.value = true;
  await nextTick();
  try {
    await subhallBackgroundImage.value?.decode();
  } catch {
    // Continue into the subhall if image decoding fails; CSS retains a solid fallback.
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (window.location.pathname !== '/games/shisanshui') window.history.pushState({ page: 'subhall' }, '', '/games/shisanshui');
  page.value = 'subhall';
  maybeStartSubhallGuide();
}

function maybeStartSubhallGuide(): void {
  if (localStorage.getItem(subhallGuideSeenKey) === 'true') return;
  window.setTimeout(() => {
    if (page.value !== 'subhall' || lobbyPanel.value || roomFlowOpen.value) return;
    subhallGuideVisible.value = true;
    void nextTick(() => {
      updateSubhallGuidePosition();
      subhallGuideButton.value?.focus();
    });
  }, 250);
}

function updateSubhallGuidePosition(): void {
  const target = document.querySelector<HTMLElement>('.tier-grid-horizontal');
  const guide = subhallGuideElement.value;
  if (!target || !guide || !subhallGuideVisible.value) return;
  const targetRect = target.getBoundingClientRect();
  const guideHeight = guide.getBoundingClientRect().height;
  const above = targetRect.top - guideHeight - 14;
  const below = targetRect.bottom + 14;
  const top = above >= 16 ? above : Math.min(below, window.innerHeight - guideHeight - 16);
  subhallGuidePosition.value = { top: `${Math.max(16, top)}px`, left: '50%' };
}

async function finishSubhallGuide(): Promise<void> {
  subhallGuideVisible.value = false;
  localStorage.setItem(subhallGuideSeenKey, 'true');
  await nextTick();
  document.querySelector<HTMLElement>('.tier-grid-horizontal')?.focus();
}

function handleSubhallGuideKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    void finishSubhallGuide();
  } else if (event.key === 'Tab') {
    event.preventDefault();
    subhallGuideButton.value?.focus();
  }
}

function returnToLobby(): void {
  if (window.location.pathname === '/games/shisanshui') window.history.replaceState({ page: 'lobby' }, '', '/');
  page.value = 'lobby';
}

async function enterPractice(tierName: string, returnPage: 'lobby' | 'subhall' = 'subhall'): Promise<void> {
  practiceTier.value = tierName;
  practiceReturnPage.value = returnPage;
  page.value = 'practice';
  gameLoading.value = true;
  gameLoadingStage.value = '正在载入牌桌程序';
  gameLoadingPhase.value = 1;
  gameLoadingSeconds.value = 0;
  gameError.value = '';
}

function openRoomFlow(tier: typeof practiceTiers[number], event: MouseEvent): void {
  roomDifficultyKey.value = tier.difficultyKey;
  roomDifficultyLabel.value = tier.name;
  roomFlowReturnTarget.value = event.currentTarget as HTMLElement;
  roomFlowOpen.value = true;
}

async function closeRoomFlow(): Promise<void> {
  roomFlowOpen.value = false;
  await nextTick();
  if (roomFlowReturnTarget.value?.isConnected) roomFlowReturnTarget.value.focus();
  roomFlowReturnTarget.value = null;
}

function startSinglePractice(): void {
  roomFlowOpen.value = false;
  void enterPractice(practiceTiers.find((tier) => tier.difficultyKey === roomDifficultyKey.value)!.tierName);
}

function startRoomPractice(snapshot: GameRoomSnapshotDto): void {
  activePracticeRoom.value = snapshot;
  roomFlowOpen.value = false;
  void enterPractice(practiceTiers.find((tier) => tier.difficultyKey === snapshot.difficultyKey)!.tierName);
}

function stopGameLoadingClock(): void {
  if (gameLoadingTimer !== undefined) window.clearInterval(gameLoadingTimer);
  gameLoadingTimer = undefined;
}

function retryPractice(): void {
  if (gameSession) return;
  gameError.value = '';
  gameLoading.value = true;
  gameLoadingStage.value = '正在重新载入牌桌程序';
  gameLoadingPhase.value = 1;
  gameLoadingSeconds.value = 0;
  void mountPracticeGame();
}

function onPageEntered(element: Element): void {
  if (element.classList.contains('practice-shell')) void mountPracticeGame();
}

async function mountPracticeGame(): Promise<void> {
  const target = gameRoot.value;
  const tierName = practiceTier.value;
  if (page.value !== 'practice' || gameSession) return;
  if (!target) {
    gameError.value = '牌桌页面尚未就绪，请返回难度厅后重试。';
    gameLoading.value = false;
    stopGameLoadingClock();
    return;
  }
  gameLoadingTimer ??= window.setInterval(() => { gameLoadingSeconds.value += 1; }, 1000);
  try {
    gameLoadingStage.value = '正在载入牌桌程序';
    gameLoadingPhase.value = 1;
    const game = await import('@gameing/shisanshui-client');
    if (!target.isConnected || page.value !== 'practice') return;
    gameLoadingStage.value = '正在初始化牌桌画面';
    gameLoadingPhase.value = 2;
    const room = activePracticeRoom.value;
    const session = await game.mountLocalGame(target, {
      onExit: leavePractice,
      tierName,
      soundEnabled: soundEnabled.value,
      ...(room ? {
        roomCode: room.roomCode,
        opponentNames: room.members
          .filter((member) => !member.isCurrentPlayer)
          .sort((left, right) => left.seat - right.seat)
          .map((member) => member.displayName),
      } : {}),
    });
    if (!target.isConnected || page.value !== 'practice') {
      await session.dispose();
      return;
    }
    gameSession = session;
    gameLoadingStage.value = '牌桌准备完成';
    gameLoadingPhase.value = 3;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 140));
  } catch (error) {
    gameError.value = error instanceof Error ? error.message : '游戏加载失败，请返回后重试。';
  } finally {
    gameLoading.value = false;
    stopGameLoadingClock();
  }
}

async function leavePractice(): Promise<void> {
  const session = gameSession;
  gameSession = undefined;
  stopGameLoadingClock();
  gameLoading.value = false;
  if (session) await session.dispose();
  activePracticeRoom.value = null;
  page.value = practiceReturnPage.value;
}

onMounted(() => {
  void loadClientPreferences();
  if (page.value === 'subhall') maybeStartSubhallGuide();
  if (localStorage.getItem(hallGuideSeenKey) !== 'true') {
    window.setTimeout(() => {
      if (page.value === 'lobby' && !lobbyPanel.value) {
        hallGuideStep.value = 1;
        void nextTick(() => {
          updateHallGuidePosition();
          hallGuideNextButton.value?.focus();
        });
      }
    }, 250);
  }
  window.addEventListener('resize', updateHallGuidePosition);
  window.addEventListener('resize', updateSubhallGuidePosition);
  window.addEventListener('scroll', updateHallGuidePosition, true);
  gameCarouselMedia = window.matchMedia('(min-width: 721px)');
  reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  refreshReducedMotionPreference();
  reducedMotionMedia.addEventListener('change', refreshReducedMotionPreference);
  refreshDocumentVisibility();
  document.addEventListener('visibilitychange', refreshDocumentVisibility);
  networkInformation = (navigator as Navigator & { connection?: typeof networkInformation }).connection;
  refreshNetworkMotionPreference();
  networkInformation?.addEventListener('change', refreshNetworkMotionPreference);
  requestAnimationFrame(placeFeaturedGame);
  gameCarouselMedia.addEventListener('change', placeFeaturedGame);
  gameCarousel.value?.addEventListener('scroll', scheduleActiveGameCard, { passive: true });
  window.addEventListener('popstate', handleHistoryNavigation);
  document.addEventListener('visibilitychange', refreshAnnouncementsWhenVisible);
  window.addEventListener('online', refreshAnnouncementsWhenVisible);
  void loadActiveAnnouncements();
  if (initialAnnouncementId) void loadAnnouncementDetail(initialAnnouncementId);
  void checkService();
});
onBeforeUnmount(() => {
  if (pageScrollBeforePanel !== undefined) {
    const previous = pageScrollBeforePanel;
    document.documentElement.style.overflow = previous.documentOverflow;
    document.body.style.overflow = previous.bodyOverflow;
    document.body.style.position = previous.bodyPosition;
    document.body.style.top = previous.bodyTop;
    document.body.style.left = previous.bodyLeft;
    document.body.style.right = previous.bodyRight;
    document.body.style.width = previous.bodyWidth;
    pageScrollBeforePanel = undefined;
    window.scrollTo(0, previous.scrollY);
  }
  gameCarouselMedia?.removeEventListener('change', placeFeaturedGame);
  reducedMotionMedia?.removeEventListener('change', refreshReducedMotionPreference);
  document.removeEventListener('visibilitychange', refreshDocumentVisibility);
  document.removeEventListener('visibilitychange', refreshAnnouncementsWhenVisible);
  window.removeEventListener('online', refreshAnnouncementsWhenVisible);
  networkInformation?.removeEventListener('change', refreshNetworkMotionPreference);
  gameCarousel.value?.removeEventListener('scroll', scheduleActiveGameCard);
  window.removeEventListener('popstate', handleHistoryNavigation);
  window.removeEventListener('resize', updateHallGuidePosition);
  window.removeEventListener('resize', updateSubhallGuidePosition);
  window.removeEventListener('scroll', updateHallGuidePosition, true);
  if (gameCardSettleTimer !== undefined) window.clearTimeout(gameCardSettleTimer);
  stopGameLoadingClock();
  void gameSession?.dispose();
});
</script>

<template>
  <div class="app-root" :class="{ 'player-lobby-root': page === 'lobby' }">
    <div class="scene-backdrops" aria-hidden="true">
      <picture class="scene-backdrop lobby-backdrop" :class="{ active: page === 'lobby' || page === 'entry' || page === 'event' }">
        <source media="(max-width: 720px)" :srcset="mobileLobbyBackground" />
        <img :src="lobbyBackground" alt="" />
      </picture>
      <img v-if="subhallBackgroundLoaded" ref="subhallBackgroundImage" class="scene-backdrop subhall-backdrop" :class="{ active: page === 'subhall' || page === 'practice' }" :src="shisanshuiSubhallBackground" alt="" />
      <div class="scene-tint lobby-tint" :class="{ active: page === 'lobby' || page === 'entry' || page === 'event' }"></div>
      <div v-if="subhallBackgroundLoaded" class="scene-tint subhall-tint" :class="{ active: page === 'subhall' || page === 'practice' }"></div>
    </div>
    <Transition name="hall-page" mode="out-in" @after-enter="onPageEntered">
  <main v-if="page === 'lobby'" key="lobby" class="lobby-shell" :class="{ 'has-active-announcements': activeAnnouncements.length > 0 }" :inert="lobbyPanel !== null">
    <header class="topbar">
      <div class="brand-lockup" aria-label="Lottery Game">
        <img class="brand-logo" :src="lotteryGameEmblem" alt="" />
        <span>LOTTERY <strong>GAME</strong></span>
      </div>
      <button class="connection" :class="connection" type="button" :disabled="connection !== 'offline'" :aria-label="connection === 'offline' ? '连接离线，点击重新连接' : message" @click="connection === 'offline' && checkService()">
        <span class="connection-dot"></span>{{ message }}<span v-if="connection === 'offline'" class="connection-retry-mark">↻</span>
      </button>
      <button class="header-action" type="button" aria-label="打开钱包" @click="openLobbyPanel('wallet')">钱包</button>
      <button class="header-action player-entry-trigger" type="button" @click="openPlayerEntry">{{ rootProps.identitySessionState?.value?.user.displayName ?? '登录 / 恢复' }}</button>
      <button class="header-action" type="button" aria-label="消息" @click="openLobbyPanel('messages')">消息</button>
      <button class="header-action" type="button" aria-label="个人菜单" @click="openLobbyPanel('profile')">我的</button>
      <button class="header-action" type="button" @click="openLobbyPanel('settings')">设置</button>
    </header>
    <PlatformAnnouncementBar :announcements="activeAnnouncements" @open="openAnnouncement" />

    <section class="welcome">
      <div class="eyebrow">WELCOME TO THE HALL</div>
      <h1>挑一款游戏，<span>现在开局。</span></h1>
      <p>十三张可免费本地练习，不涉及金币和真实结算。</p>
    </section>

    <section ref="gameCarousel" class="game-row" :class="{ 'guide-target': hallGuideStep === 1 }" aria-label="游戏列表，可横向滚动" tabindex="0">
      <article v-for="game in lobbyGames" :key="game.id" class="game-card" :class="{ featured: game.playable, 'coming-soon': !game.playable, 'is-centered': activeGameCardId === game.id, 'is-motion-active': isGameCardMotionActive(game.id), 'guide-target': hallGuideStep === 2 && game.playable }" :data-game-id="game.id" @pointerenter="handleGameCardPointerEnter($event, game.id)" @pointerleave="handleGameCardPointerLeave($event, game.id)">
        <picture :key="`${game.assetKey}-${isGameCardMotionActive(game.id) ? 'active' : 'poster'}`" class="game-card-backdrop" aria-hidden="true">
          <source media="(min-width: 721px)" type="image/avif" :srcset="`/assets/game-cards/${game.assetKey}/portrait/${isGameCardMotionActive(game.id) ? 'active' : 'poster'}.avif`" />
          <source media="(min-width: 721px)" type="image/webp" :srcset="`/assets/game-cards/${game.assetKey}/portrait/poster.webp`" />
          <source type="image/avif" :srcset="`/assets/game-cards/${game.assetKey}/${isGameCardMotionActive(game.id) ? 'active' : 'poster'}.avif`" />
          <img :src="`/assets/game-cards/${game.assetKey}/poster.webp`" alt="" :loading="displayedActiveGameCardId === game.id ? 'eager' : 'lazy'" decoding="async" @error="handleGameCardImageError(game.id)" />
        </picture>
        <template v-if="game.playable">
          <div class="game-art"><img :src="`/assets/game-icons/${game.assetKey}.webp`" alt="" /></div>
          <div class="game-info">
            <div><span class="game-tag">首发游戏</span><h2>{{ game.name }}</h2></div>
            <p>{{ game.description }}</p>
            <button type="button" @click="openGameHall">进入游戏厅</button>
          </div>
          <div class="mobile-card-details">
            <div class="mobile-game-heading">
              <div class="game-art mobile-game-art"><img :src="`/assets/game-icons/${game.assetKey}.webp`" alt="" /></div>
              <div class="mobile-card-title">
                <span class="game-tag">首发游戏 · 本地练习</span>
                <div class="mobile-title-row"><h2>{{ game.name }}</h2><button class="rules-trigger" type="button" aria-label="查看十三张玩法规则" @click="openLobbyPanel('gameRules')"><span aria-hidden="true">?</span><span>规则</span></button></div>
              </div>
            </div>
            <p class="mobile-game-description">整理 13 张牌，分成头、中、底三道，与对手逐墩比较。先选练习难度，熟悉摆牌和牌型策略。</p>
            <section class="mobile-tier-list" aria-label="选择练习难度">
              <h3>选择难度</h3>
              <button v-for="tier in practiceTiers" :key="tier.tierName" class="mobile-tier-option" :class="`tier-${tier.accent}`" type="button" @click="enterPractice(tier.tierName, 'lobby')">
                <span class="mobile-tier-copy"><strong>{{ tier.name }}</strong><small>{{ tier.detail }}</small></span>
                <span class="mobile-tier-metrics"><span>最低下注<strong>{{ tier.minBet }} 练习分</strong></span><span>倍率<strong>{{ tier.multiplier }}×</strong></span><span>最高<strong>{{ tier.maxMultiplier }}×</strong></span></span>
                <span class="mobile-tier-enter" aria-hidden="true">›</span>
              </button>
            </section>
          </div>
        </template>
        <template v-else>
          <div class="coming-art" aria-hidden="true"><img :src="`/assets/game-icons/${game.assetKey}.webp`" alt="" loading="lazy" decoding="async" /></div>
          <div class="game-info">
            <div><span class="game-tag muted">即将开放</span><h2>{{ game.name }}</h2></div>
            <p>{{ game.description }}</p>
            <button type="button" disabled>敬请期待</button>
          </div>
        </template>
      </article>
    </section>

    <nav class="lobby-actions" :class="{ 'guide-target': hallGuideStep === 3 && isDesktopLayout, 'social-disabled': socialAccessDenied }" aria-label="大厅功能">
      <button type="button" @click="openLobbyPanel('wallet')"><span>◈</span>充值 / 钱包</button>
      <button type="button" @click="openLobbyPanel('history')"><span>▤</span>战绩</button>
      <button type="button" @click="openLobbyPanel('invite')"><span>♧</span>邀请 / 代理</button>
      <button v-if="!socialAccessDenied" type="button" @click="openLobbyPanel('community')"><span>◎</span>社区 / 私信</button>
      <button type="button" @click="openLobbyPanel('support')"><span>？</span>客服</button>
      <button type="button" @click="openLobbyPanel('settings')"><span>⚙</span>设置</button>
    </nav>

    <footer>本地体验 · 不扣金币 · 退出后不保留练习牌局</footer>
    <nav class="mobile-dock" :class="{ 'guide-target': hallGuideStep === 3 && !isDesktopLayout, 'social-disabled': socialAccessDenied }" aria-label="快捷导航">
      <button class="dock-item active" type="button" aria-current="page" @click="lobbyPanel = null"><span class="dock-icon">⌂</span><span>游戏</span></button>
      <button class="dock-item" type="button" @click="openLobbyPanel('wallet')"><span class="dock-icon">◈</span><span>钱包</span></button>
      <button v-if="!socialAccessDenied" class="dock-item" type="button" @click="openLobbyPanel('community')"><span class="dock-icon">◎</span><span>社区</span></button>
      <button class="dock-item" type="button" @click="openLobbyPanel('support')"><span class="dock-icon">？</span><span>客服</span></button>
      <button class="dock-item" type="button" @click="openLobbyPanel('profile')"><span class="dock-icon">●</span><span>我的</span></button>
    </nav>
  </main>

  <main v-else-if="page === 'subhall'" key="subhall" class="lobby-shell subhall-shell" :inert="roomFlowOpen">
    <header class="topbar">
      <button class="back-button" type="button" @click="returnToLobby">‹ 大厅</button>
      <div class="brand-copy"><strong>十三张游戏厅</strong><span>整理牌型，和牌友逐墩较量</span></div>
      <button class="connection" :class="connection" type="button" :disabled="connection !== 'offline'" :aria-label="connection === 'offline' ? '服务离线，点击重新连接' : connection === 'online' ? '当前在线' : '正在检查服务'" @click="connection === 'offline' && checkService()"><span class="connection-dot"></span>{{ connection === 'online' ? '当前在线' : connection === 'offline' ? '离线练习可用 · 点击重连' : '正在检查服务' }}<span v-if="connection === 'offline'" class="connection-retry-mark">↻</span></button>
    </header>
    <PlatformAnnouncementBar :announcements="activeAnnouncements" @open="openAnnouncement" />
    <section class="subhall-heading">
      <div>
        <div class="eyebrow">SHISANSHUI · GAME HALL</div>
        <h1>十三张</h1>
        <p>标准 52 张牌 · 头墩 3 张 · 中墩与底墩各 5 张</p>
      </div>
    </section>
    <details class="subhall-rules" open>
      <summary>玩法规则</summary>
      <div class="subhall-rule-grid">
        <p><strong>用牌</strong>一副 52 张牌，不含大小王，四位玩家各 13 张。</p>
        <p><strong>分墩</strong>头墩 3 张，中墩、底墩各 5 张。</p>
        <p><strong>摆牌</strong>头墩 ≤ 中墩 ≤ 底墩；违反顺序按相公处理。</p>
        <p><strong>牌型</strong>同花顺、铁支、葫芦、同花、顺子、三条、两对、对子、乌龙。</p>
        <p><strong>计分</strong>头、中、底逐墩比较；特殊牌型、打枪等奖励由本厅配置决定。</p>
      </div>
    </details>
    <section class="tier-grid tier-grid-horizontal" :class="{ 'guide-target': subhallGuideVisible }" aria-label="十三张难度厅，可横向滚动" tabindex="0">
      <button v-for="tier in practiceTiers" :key="tier.tierName" class="tier-card" :class="`tier-${tier.accent}`" type="button" @click="openRoomFlow(tier, $event)">
        <span class="tier-symbol">{{ tier.symbol }}</span><span class="tier-name">{{ tier.name }}</span><span class="tier-detail">{{ tier.detail }}</span>
        <span class="tier-metrics"><span>最低下注<strong>{{ tier.minBet }} 练习分</strong></span><span>当前倍率<strong>{{ tier.multiplier }}×</strong></span><span>最高倍率<strong>{{ tier.maxMultiplier }}×</strong></span></span>
        <strong class="tier-enter-label">进入牌桌　›</strong>
      </button>
    </section>
    <footer>头墩 3 张 · 中墩 5 张 · 底墩 5 张　｜　倒道（相公）将按练习规则判负</footer>
  </main>

  <PlatformAnnouncementDetail
    v-else-if="page === 'event'"
    key="platform-announcement-detail"
    :detail="selectedAnnouncement"
    :loading="announcementDetailLoading"
    :unavailable="announcementDetailUnavailable"
    @retry="retryAnnouncementDetail"
    @back="returnFromAnnouncement"
  />
  <PlayerEntryPage v-else-if="page === 'entry'" key="player-entry" :application="rootProps.playerEntryApplication ?? localPlayerEntryApplication" :emblem="lotteryGameEmblem" :create-dev-fixture="rootProps.devFixture" @back="returnFromEntry" />
  <main v-else class="practice-shell" :key="`practice-${practiceTier}`">
    <div ref="gameRoot" class="pixi-host"></div>
    <Transition name="game-loading">
      <div v-if="gameLoading" class="game-loading" role="status" aria-live="polite">
        <section class="game-loading-card" aria-label="牌桌加载进度">
          <div class="game-loading-orbit" aria-hidden="true"><span></span></div>
          <p class="game-loading-title">{{ gameLoadingStage }}</p>
          <div class="game-load-steps" aria-hidden="true">
            <span v-for="(label, index) in ['载入程序', '初始化画面', '准备牌局']" :key="label" :class="{ done: gameLoadingPhase > index + 1, current: gameLoadingPhase === index + 1 }">{{ label }}</span>
          </div>
          <div class="game-load-track" role="progressbar" aria-label="正在加载牌桌" aria-valuetext="加载中">
            <span></span>
          </div>
          <small>已等待 {{ gameLoadingSeconds }} 秒 · 首次进入需要准备牌桌资源</small>
          <p v-if="gameLoadingSeconds >= 12" class="game-load-slow">加载时间比平时长，你可以继续等待，或返回上一页。</p>
          <button v-if="gameLoadingSeconds >= 12" type="button" @click="leavePractice">返回上一页</button>
        </section>
      </div>
    </Transition>
    <div v-if="gameError" class="game-error">
      <p>{{ gameError }}</p>
      <div class="game-error-actions"><button type="button" @click="retryPractice">重试加载</button><button type="button" @click="leavePractice">返回上一页</button></div>
    </div>
  </main>
    </Transition>

    <ShisanshuiRoomFlow
      v-if="roomFlowOpen && page === 'subhall'"
      :application="localRoomApplication"
      :difficulty-key="roomDifficultyKey"
      :difficulty-label="roomDifficultyLabel"
      @close="closeRoomFlow"
      @practice="startSinglePractice"
      @start="startRoomPractice"
    />

    <template v-if="page === 'subhall' && subhallGuideVisible">
      <div class="hall-guide-scrim" aria-hidden="true"></div>
      <aside ref="subhallGuideElement" class="subhall-guide" role="dialog" aria-modal="true" aria-label="难度选择引导" :style="subhallGuidePosition" @keydown="handleSubhallGuideKeydown">
        <div class="hall-guide-copy"><strong>选择练习难度</strong><p>难度卡可横向浏览，卡片会显示最低下注、倍率和最高倍率。当前是本地练习，不扣真实金币。</p></div>
        <div class="hall-guide-actions"><button ref="subhallGuideButton" type="button" class="hall-guide-next" @click="finishSubhallGuide">开始选择</button></div>
      </aside>
    </template>

    <template v-if="page === 'lobby' && hallGuideStep > 0">
      <div class="hall-guide-scrim" aria-hidden="true"></div>
      <aside class="hall-guide" role="dialog" aria-modal="true" aria-live="polite" aria-label="大厅新手引导" :style="hallGuidePosition" @keydown="handleHallGuideKeydown">
        <div class="hall-guide-progress" aria-hidden="true"><span v-for="step in 3" :key="step" :class="{ active: hallGuideStep >= step }"></span></div>
        <div class="hall-guide-copy"><strong>{{ hallGuideCopy.title }}</strong><p>{{ hallGuideCopy.description }}</p></div>
        <div class="hall-guide-actions">
          <button ref="hallGuideSkipButton" type="button" @click="finishHallGuide">跳过</button>
          <button ref="hallGuideNextButton" type="button" class="hall-guide-next" @click="advanceHallGuide">{{ hallGuideStep === 3 ? '完成' : '下一步' }}</button>
        </div>
      </aside>
    </template>

    <Transition name="sheet">
    <div v-if="page === 'lobby' && lobbyPanel" class="panel-scrim" @click.self="closeLobbyPanel">
      <section ref="lobbyPanelElement" class="lobby-panel" role="dialog" aria-modal="true" :inert="playerHelpTopic !== null" :aria-labelledby="`panel-title-${lobbyPanel}`" @keydown="handleLobbyPanelKeydown">
        <button ref="lobbyPanelCloseButton" class="panel-close" type="button" aria-label="关闭" @click="closeLobbyPanel">×</button>
        <template v-if="lobbyPanel === 'settings'">
          <div class="eyebrow">PREFERENCES</div><h2 :id="`panel-title-${lobbyPanel}`">设置</h2>
          <p>偏好设置保存在当前浏览器。</p>
          <label class="setting-row"><span><strong>牌桌音效</strong><small>控制十三张练习牌桌的操作与结算音效</small></span><input type="checkbox" :checked="soundEnabled" @change="savePreference(ClientPreferenceKey.SOUND_ENABLED, ($event.target as HTMLInputElement).checked)" /></label>
          <label class="setting-row"><span><strong>低流量模式</strong><small>关闭动态封面，减少装饰动效资源下载</small></span><input type="checkbox" :checked="lowDataMode" @change="savePreference(ClientPreferenceKey.LOW_DATA_MODE, ($event.target as HTMLInputElement).checked)" /></label>
          <p v-if="preferenceError" class="setting-error" role="alert">{{ preferenceError }}</p>
          <button class="guide-replay" type="button" @click="startHallGuide">重新播放大厅引导</button>
        </template>
        <template v-else-if="lobbyPanel === 'wallet'">
          <div class="eyebrow">PLAYER WALLET</div><div class="panel-title-row"><h2 :id="`panel-title-${lobbyPanel}`">钱包</h2><button class="panel-help-trigger" type="button" aria-label="查看钱包规则" aria-haspopup="dialog" @click="openPlayerHelp('wallet', $event)">?</button></div>
          <p>金币与人民币余额分账显示。</p>
          <div class="player-wallet-assets">
            <article><div><span>游戏资产</span><b>金币</b></div><strong>{{ walletSummaryLoading ? '读取中…' : rootProps.identitySessionState?.value ? `${walletSummary?.assets[0]?.availableAmount ?? '0'} 可用` : '登录后查看' }}</strong><small v-if="rootProps.identitySessionState?.value">冻结 {{ walletSummary?.assets[0]?.frozenAmount ?? '0' }} · 总额 {{ walletSummary?.assets[0]?.amount ?? '0' }}</small><small v-else>可用 / 冻结</small></article>
            <article><div><span>可提现资产</span><b>余额 · CNY</b></div><strong>{{ walletSummaryLoading ? '读取中…' : rootProps.identitySessionState?.value ? `¥${formatFen(walletSummary?.assets[1]?.availableAmount ?? '0')}` : '登录后查看' }}</strong><small v-if="rootProps.identitySessionState?.value">冻结 ¥{{ formatFen(walletSummary?.assets[1]?.frozenAmount ?? '0') }} · 总额 ¥{{ formatFen(walletSummary?.assets[1]?.amount ?? '0') }}</small><small v-else>可用 / 冻结</small></article>
          </div>
          <p v-if="walletSummaryError" role="alert">{{ walletSummaryError }}</p>
          <div v-if="rootProps.identitySessionState?.value" class="player-wallet-turnover"><strong>有效下注流水</strong><span>还需完成 {{ walletSummary?.turnover.remainingCoins ?? '—' }} 金币</span><small>{{ walletSummary?.turnover.canTransferOrWithdraw ? '流水要求已完成' : '完成前暂不能转出金币或申请提现' }}</small></div>
          <div v-if="walletSummary?.welcomeGift" class="player-panel-empty"><strong>新用户赠币已入账</strong><p>{{ walletSummary.welcomeGift.coins }} 金币 · 需完成 {{ walletSummary.welcomeGift.turnoverRequirement }} 金币有效下注流水。</p></div>
          <button v-if="!rootProps.identitySessionState?.value" class="panel-primary" type="button" @click="openPlayerEntry">登录后查看钱包</button>
          <section v-else-if="walletActivityLoading" class="player-wallet-activity" aria-label="资产明细" aria-busy="true"><h3>资产明细</h3><p>正在读取账本记录…</p></section>
          <section v-else class="player-wallet-activity" aria-label="资产明细"><h3>资产明细</h3>
            <p v-if="walletActivityError" role="alert">{{ walletActivityError }} <button type="button" @click="reloadWallet">重试</button></p>
            <p v-else-if="!walletActivity?.items.length" class="player-wallet-activity-empty">暂无资产记录</p>
            <ol v-else><li v-for="item in walletActivity.items" :key="item.entryId"><span class="wallet-activity-mark" :class="{ negative: item.delta.startsWith('-') }">{{ item.delta.startsWith('-') ? '−' : '+' }}</span><div><strong>{{ walletActivityTitle(item) }} · {{ item.currency === 'COIN' ? '金币' : '余额' }}</strong><small>{{ item.counterpartyLabel ? `对方：${item.counterpartyLabel} · ` : '' }}{{ item.activityType === WalletActivityType.TRANSFER_SENT ? `本金 ${item.transferCoins} · 手续费 ${item.feeCoins} · ` : '' }}{{ item.activityType === WalletActivityType.CURRENCY_EXCHANGE ? `兑换 ${item.exchangeCoins} 金币 · ` : '' }}{{ walletActivityTime(item.occurredAt) }} · 余额 {{ item.currency === 'CNY' ? `¥${formatFen(item.balanceAfter)}` : `${item.balanceAfter} 金币` }}</small></div><b :class="{ negative: item.delta.startsWith('-') }">{{ walletActivityAmount(item) }}</b></li></ol>
            <p v-if="walletActivityMoreError" role="alert">{{ walletActivityMoreError }} <button type="button" @click="loadMoreWalletActivity">重试</button></p>
            <button v-if="walletActivity?.nextCursor" class="wallet-activity-more" type="button" :disabled="walletActivityMoreLoading" @click="loadMoreWalletActivity">{{ walletActivityMoreLoading ? '正在读取…' : '加载更早记录' }}</button>
          </section>
          <component :is="DevelopmentWalletFundingWorkspace" v-if="rootProps.identitySessionState?.value && rootProps.walletFundingApplication && DevelopmentWalletFundingWorkspace" :application="rootProps.walletFundingApplication" @completed="reloadWallet" @contact-support="openLobbyPanel('support')" />
          <PlayerWalletTransferWorkspace v-if="rootProps.identitySessionState?.value && rootProps.walletApplication && rootProps.socialFriendsApplication" :wallet="rootProps.walletApplication" :friends="rootProps.socialFriendsApplication" :can-transfer="walletSummary?.turnover.canTransferOrWithdraw ?? false" :turnover-remaining="walletSummary?.turnover.remainingCoins ?? '—'" :available-coins="walletSummary?.assets[0]?.availableAmount ?? '0'" @completed="reloadWallet" />
          <PlayerWalletExchangeWorkspace v-if="rootProps.identitySessionState?.value && rootProps.walletApplication" :wallet="rootProps.walletApplication" :can-exchange="walletSummary?.turnover.canTransferOrWithdraw ?? false" :turnover-remaining="walletSummary?.turnover.remainingCoins ?? '—'" :available-coins="walletSummary?.assets[0]?.availableAmount ?? '0'" @completed="reloadWallet" />
          <PlayerWalletWithdrawalWorkspace v-if="rootProps.identitySessionState?.value && rootProps.walletApplication" :wallet="rootProps.walletApplication" :can-withdraw="walletSummary?.turnover.canTransferOrWithdraw ?? false" :turnover-remaining="walletSummary?.turnover.remainingCoins ?? '—'" :available-cny-fen="walletSummary?.assets[1]?.availableAmount ?? '0'" @completed="reloadWallet" />
        </template>
        <template v-else-if="lobbyPanel === 'history'">
          <div class="eyebrow">ROUND HISTORY</div><h2 :id="`panel-title-${lobbyPanel}`">战绩</h2>
          <p>这里只呈现已结算记录；牌型和奖励详情由对应游戏 handler 版本解释。</p>
          <div class="player-history-filters"><button type="button" class="active" disabled>全部游戏</button><button type="button" disabled>十三张</button><button type="button" disabled>时间范围</button></div>
          <div class="player-panel-empty player-panel-empty-large"><span aria-hidden="true">♧</span><strong>登录后查看战绩</strong><p>查看已结算牌局、牌型详情与资产变化。</p><button type="button" @click="openPlayerEntry">登录 / 恢复账号</button></div>
        </template>
        <template v-else-if="lobbyPanel === 'invite'">
          <div class="eyebrow">INVITATION & AGENT</div><div class="panel-title-row"><h2 :id="`panel-title-${lobbyPanel}`">邀请与代理</h2><button class="panel-help-trigger" type="button" aria-label="查看邀请与返佣说明" aria-haspopup="dialog" @click="openPlayerHelp('invite', $event)">?</button></div>
          <p>邀请归因由平台服务确认；已绑定用户只能由 Admin 换绑，客户端不能修改上级。</p>
          <PlayerInviteAgentWorkspace :application="rootProps.inviteAgentApplication" :authenticated="Boolean(rootProps.identitySessionState?.value)" />
        </template>
        <template v-else-if="lobbyPanel === 'community'">
          <div class="eyebrow">COMMUNITY & MESSAGES</div><h2 :id="`panel-title-${lobbyPanel}`">社区与私信</h2>
          <p>分享游戏心得，找到牌友并继续交流。</p>
          <div class="player-social-tabs" role="tablist" aria-label="社区功能分区" @keydown="moveSocialTabByKeyboard">
            <button id="social-tab-topics" type="button" role="tab" aria-controls="social-panel-topics" :aria-selected="playerSocialTab === 'topics'" :tabindex="playerSocialTab === 'topics' ? 0 : -1" :class="{ active: playerSocialTab === 'topics' }" @click="playerSocialTab = 'topics'">话题广场</button>
            <button id="social-tab-friends" type="button" role="tab" aria-controls="social-panel-friends" :aria-selected="playerSocialTab === 'friends'" :tabindex="playerSocialTab === 'friends' ? 0 : -1" :class="{ active: playerSocialTab === 'friends' }" @click="playerSocialTab = 'friends'">好友</button>
            <button id="social-tab-messages" type="button" role="tab" aria-controls="social-panel-messages" :aria-selected="playerSocialTab === 'messages'" :tabindex="playerSocialTab === 'messages' ? 0 : -1" :class="{ active: playerSocialTab === 'messages' }" @click="playerSocialTab = 'messages'">私信</button>
          </div>
          <section v-if="playerSocialTab === 'topics'" id="social-panel-topics" class="player-social-panel" role="tabpanel" aria-labelledby="social-tab-topics" tabindex="0">
            <PlayerSocialWorkspace v-if="rootProps.identitySessionState?.value && rootProps.socialApplication" :application="rootProps.socialApplication" />
            <div v-else class="player-panel-empty player-panel-empty-large"><span aria-hidden="true">◎</span><strong>登录后参与话题</strong><p>登录或恢复账号后，可以浏览话题、发布帖子并参与讨论。</p><button type="button" @click="openPlayerEntry">登录 / 恢复账号</button></div>
          </section>
          <section v-else-if="playerSocialTab === 'friends'" id="social-panel-friends" class="player-social-panel" role="tabpanel" aria-labelledby="social-tab-friends" tabindex="0">
            <PlayerFriendsWorkspace v-if="rootProps.identitySessionState?.value && rootProps.socialFriendsApplication" :application="rootProps.socialFriendsApplication" mode="friends" :current-user-id="rootProps.identitySessionState.value.user.userId" />
            <div v-else class="player-panel-empty player-panel-empty-large"><span aria-hidden="true">♧</span><strong>登录后查看好友</strong><p>查找牌友并管理好友申请。</p><button type="button" @click="openPlayerEntry">登录 / 恢复账号</button></div>
          </section>
          <section v-else id="social-panel-messages" class="player-social-panel" role="tabpanel" aria-labelledby="social-tab-messages" tabindex="0">
            <PlayerFriendsWorkspace v-if="rootProps.identitySessionState?.value && rootProps.socialFriendsApplication" :application="rootProps.socialFriendsApplication" mode="messages" :current-user-id="rootProps.identitySessionState.value.user.userId" />
            <div v-else class="player-panel-empty player-panel-empty-large"><span aria-hidden="true">✉</span><strong>登录后查看私信</strong><p>与好友继续交流。</p><button type="button" @click="openPlayerEntry">登录 / 恢复账号</button></div>
          </section>
        </template>
        <template v-else-if="lobbyPanel === 'messages'">
          <div class="eyebrow">NOTIFICATIONS</div><h2 :id="`panel-title-${lobbyPanel}`">消息</h2>
          <p>从业务来源读取最近动态，点击可继续处理。</p>
          <PlayerNotificationsWorkspace v-if="rootProps.notificationSummaryApplication" :application="rootProps.notificationSummaryApplication" :authenticated="Boolean(rootProps.identitySessionState?.value)" @open="openNotificationItem" @login="openPlayerEntry" />
          <div v-else class="player-panel-empty player-panel-empty-large"><span aria-hidden="true">✉</span><strong>登录后查看消息</strong><p>及时掌握账户与牌局动态。</p><button type="button" @click="openPlayerEntry">登录 / 恢复账号</button></div>
        </template>
        <template v-else-if="lobbyPanel === 'support'">
          <div class="eyebrow">PLAYER SUPPORT</div><h2 :id="`panel-title-${lobbyPanel}`">客服</h2>
          <p>咨询账户、订单与游戏问题，查看客服会话进度。</p>
          <PlayerSupportWorkspace v-if="rootProps.identitySessionState?.value && rootProps.supportApplication" :application="rootProps.supportApplication" />
          <div v-else class="player-panel-empty player-panel-empty-large"><span aria-hidden="true">？</span><strong>登录后联系在线客服</strong><p>客服会话将与账号关联，方便继续查看处理进度。</p><button type="button" @click="openPlayerEntry">登录 / 恢复账号</button></div>
        </template>
        <template v-else-if="lobbyPanel === 'gameRules'">
          <div class="eyebrow">SHISANSHUI · HOW TO PLAY</div><h2 :id="`panel-title-${lobbyPanel}`">十三张玩法规则</h2>
          <div class="full-game-rules">
            <p><strong>人数与牌数</strong>四人使用一副去掉大小王的 52 张牌，每人 13 张。</p>
            <p><strong>分墩</strong>头墩 3 张，中墩 5 张，底墩 5 张。</p>
            <p><strong>摆牌顺序</strong>头墩不得大于中墩，中墩不得大于底墩；违反顺序视为倒道（相公）。</p>
            <p><strong>牌型大小</strong>同花顺 &gt; 铁支 &gt; 葫芦 &gt; 同花 &gt; 顺子 &gt; 三条 &gt; 两对 &gt; 对子 &gt; 乌龙。头墩只有 3 张，最大为三条。</p>
            <p><strong>比牌与计分</strong>头、中、底逐墩比较；普通胜墩计分，特殊牌型、打枪与全垒打奖励以当前难度厅配置为准。</p>
            <p class="panel-note">当前为免费练习，不涉及金币资产。</p>
          </div>
        </template>
        <template v-else-if="lobbyPanel === 'profile'">
          <div class="eyebrow">PLAYER ACCOUNT</div><h2 :id="`panel-title-${lobbyPanel}`">个人资料</h2>
          <p>登录后管理昵称、联系方式与账号安全。</p>
          <div class="player-profile-card"><div class="player-profile-avatar" aria-hidden="true">{{ rootProps.identitySessionState?.value?.user.displayName.slice(-1) ?? '?' }}</div><div><strong>{{ rootProps.identitySessionState?.value?.user.displayName ?? '游客' }}</strong><small>{{ rootProps.identitySessionState?.value ? `账号 ID ${rootProps.identitySessionState.value.user.userId}` : '登录后同步账号资料' }}</small></div><span>{{ rootProps.identitySessionState?.value ? '已登录' : '访客模式' }}</span></div>
          <div class="player-profile-fields" aria-live="polite">
            <div><span>用户名</span><strong>{{ identitySettingsLoading ? '读取中…' : identitySettings?.username ?? (rootProps.identitySessionState?.value ? '未设置' : '登录后查看') }}</strong></div>
            <div><span>邮箱</span><strong>{{ identitySettingsLoading ? '读取中…' : identitySettings?.email?.maskedValue ?? (rootProps.identitySessionState?.value ? '未绑定' : '登录后查看') }}<small v-if="identitySettings?.email">{{ identitySettings.email.verified ? '已验证' : '未验证' }}</small></strong></div>
            <div><span>手机</span><strong>{{ identitySettingsLoading ? '读取中…' : identitySettings?.phone?.maskedValue ?? (rootProps.identitySessionState?.value ? '未绑定' : '登录后查看') }}<small v-if="identitySettings?.phone">{{ identitySettings.phone.verified ? '已验证' : '未验证' }}</small></strong></div>
            <div><span>账号密码</span><strong>{{ identitySettingsLoading ? '读取中…' : identitySettings?.passwordConfigured ? '已设置' : rootProps.identitySessionState?.value ? '未设置' : '登录后查看' }}</strong></div>
            <div><span>两步验证</span><strong>{{ identitySettingsLoading ? '读取中…' : identitySettings?.totpEnabled ? '已开启' : rootProps.identitySessionState?.value ? '未开启' : '登录后查看' }}</strong></div>
            <div><span>恢复二维码</span><strong>{{ identitySettingsLoading ? '读取中…' : identitySettings?.recoveryCredential.available ? '有效' : rootProps.identitySessionState?.value ? '未设置' : '登录后查看' }}</strong></div>
          </div>
          <section v-if="rootProps.identitySessionState?.value && identitySettings?.passwordConfigured" class="identity-totp-settings" aria-label="两步验证设置">
            <h3>两步验证</h3>
            <p v-if="!identitySettings.totpEnabled">启用验证器后，登录和敏感账号操作需要 TOTP。丢失验证器且没有备用恢复码时，请联系客服人工处理，平台不提供重置。</p>
            <form v-if="!identitySettings.totpEnabled && !totpSetup && !totpRecoveryCodes.length" class="identity-credential-form" @submit.prevent="startTotpSetup">
              <label>当前密码<input v-model="totpSetupPassword" type="password" autocomplete="current-password" required></label>
              <button class="panel-primary" type="submit" :disabled="totpBusy || !totpSetupPassword">{{ totpBusy ? '正在准备…' : '开始设置' }}</button>
            </form>
            <div v-if="totpSetup" class="identity-totp-setup">
              <p>在验证器 App 中选择“手动输入密钥”，输入下方密钥和账号名；设置请求 10 分钟后失效。</p>
              <label>验证器密钥<input readonly :value="totpSetupSecret" autocomplete="off" spellcheck="false"></label>
              <p class="panel-note">算法：SHA1；位数：6；周期：30 秒。设置期间输入验证器当前显示的 6 位码确认。</p>
              <form class="identity-credential-form" @submit.prevent="confirmTotpSetup">
                <label>验证器验证码<input v-model="totpSetupCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label>
                <button class="panel-primary" type="submit" :disabled="totpBusy || totpSetupCode.length !== 6">确认并启用</button>
                <button type="button" :disabled="totpBusy" @click="clearTotpSecrets">取消设置</button>
              </form>
            </div>
            <div v-if="totpRecoveryCodes.length" class="identity-totp-recovery">
              <p>这些备用恢复码每个只能使用一次，只显示本次。请保存后再关闭面板。</p>
              <code v-for="code in totpRecoveryCodes" :key="code">{{ code }}</code>
              <button class="panel-secondary" type="button" @click="copyTotpRecoveryCodes">复制全部恢复码</button>
              <button type="button" @click="totpRecoveryCodes = []; identityCredentialMessage = '已关闭一次性恢复码。遗失时需联系客服人工处理。'">我已安全保存，关闭显示</button>
            </div>
            <template v-if="identitySettings.totpEnabled">
              <p>尚未使用的备用恢复码保存在启用时的一次性页面中；每个恢复码只能使用一次。</p>
              <button v-if="!totpRecoveryCodes.length && !totpRecoveryRotateOpen" class="panel-secondary" type="button" @click="totpRecoveryRotateOpen = true">重新生成备用恢复码</button>
              <form v-if="totpRecoveryRotateOpen" class="identity-credential-form" @submit.prevent="rotateTotpRecoveryCodes">
                <p>输入验证器当前的 6 位验证码。确认后旧备用码立即全部失效，新码只显示一次。</p>
                <label>当前 TOTP<input v-model="totpRecoveryRotateCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label>
                <button class="panel-primary" type="submit" :disabled="totpBusy || totpRecoveryRotateCode.length !== 6">{{ totpBusy ? '正在更换…' : '验证并生成新码' }}</button>
                <button type="button" :disabled="totpBusy" @click="totpRecoveryRotateOpen = false; totpRecoveryRotateCode = ''">取消</button>
              </form>
              <button v-if="!totpDisableFormOpen" class="panel-secondary" type="button" @click="totpDisableFormOpen = true">关闭两步验证</button>
              <form v-if="totpDisableFormOpen" class="identity-credential-form" @submit.prevent="disableTotp">
                <label>当前密码<input v-model="totpDisablePassword" type="password" autocomplete="current-password" required></label>
                <label>验证器验证码<input v-model="totpDisableCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label>
                <button class="panel-primary" type="submit" :disabled="totpBusy || totpDisableCode.length !== 6">确认关闭</button>
                <button type="button" @click="totpDisableFormOpen = false; totpDisablePassword = ''; totpDisableCode = ''">取消</button>
              </form>
            </template>
          </section>
          <section v-if="rootProps.identitySessionState?.value && identitySettings?.passwordConfigured" class="identity-totp-settings" aria-label="恢复二维码管理">
            <h3>恢复二维码</h3>
            <p>二维码包含加密后的账号恢复凭证。请把二维码图片和二维码密码分开保管。新二维码下载并确认启用前，现有二维码继续有效。</p>
            <form v-if="!recoveryQrDraft" class="identity-credential-form" @submit.prevent="createRecoveryQr">
              <label>当前账号密码<input v-model="recoveryQrCurrentPassword" type="password" autocomplete="current-password" required></label>
              <label v-if="identitySettings.totpEnabled">当前 TOTP 或备用码<input v-model="recoveryQrTotp" autocomplete="one-time-code" required></label>
              <label>新二维码密码<input v-model="recoveryQrPassword" type="password" autocomplete="new-password" minlength="8" maxlength="256" required></label>
              <label>确认二维码密码<input v-model="recoveryQrPasswordConfirm" type="password" autocomplete="new-password" minlength="8" maxlength="256" required></label>
              <p>至少 8 位。二维码密码只用于本地加密，不会发送到身份服务。</p>
              <button class="panel-primary" type="submit" :disabled="recoveryQrBusy">{{ recoveryQrBusy ? '正在生成二维码…' : identitySettings.recoveryCredential.available ? '更换恢复二维码' : '生成恢复二维码' }}</button>
            </form>
            <div v-else class="identity-recovery-qr-preview">
              <img :src="recoveryQrDraft.image" alt="加密的账号恢复二维码">
              <p>有效期至 {{ new Date(recoveryQrDraft.expiresAt).toLocaleDateString() }}。先下载并确认图片可保存，再启用。</p>
              <button class="panel-secondary" type="button" @click="downloadRecoveryQr">{{ recoveryQrDraft.downloaded ? '再次下载二维码' : '下载二维码图片' }}</button>
              <button class="panel-primary" type="button" :disabled="recoveryQrBusy || !recoveryQrDraft.downloaded" @click="activateRecoveryQr">{{ recoveryQrBusy ? '正在启用…' : '我已保存，启用新二维码' }}</button>
              <button type="button" :disabled="recoveryQrBusy" @click="clearRecoveryQrDraft">取消更换</button>
            </div>
          </section>
          <div v-if="rootProps.identitySessionState?.value" class="identity-credential-actions">
            <button type="button" :disabled="!identitySettings?.passwordConfigured" @click="openIdentityCredentialForm('username')">{{ identitySettings?.username ? '修改用户名' : '设置用户名' }}</button>
            <button type="button" @click="openIdentityCredentialForm('password')">{{ identitySettings?.passwordConfigured ? '修改密码' : '设置密码' }}</button>
          </div>
          <p v-if="rootProps.identitySessionState?.value && !identitySettings?.passwordConfigured" class="panel-note">请先设置账号密码，再设置用户名。</p>
          <div v-if="rootProps.identitySessionState?.value" class="identity-contact-actions">
            <button type="button" :disabled="!identitySettings?.passwordConfigured" @click="openIdentityContactForm('EMAIL')">{{ identitySettings?.email ? '更换邮箱' : '绑定邮箱' }}</button>
            <button type="button" :disabled="!identitySettings?.passwordConfigured" @click="openIdentityContactForm('PHONE')">{{ identitySettings?.phone ? '更换手机' : '绑定手机' }}</button>
          </div>
          <p v-if="rootProps.identitySessionState?.value && !identitySettings?.passwordConfigured" class="panel-note">绑定或更换联系方式前，请先设置账号密码。</p>
          <form v-if="identityContactForm" class="identity-credential-form" @submit.prevent="identityContactChallengeId ? confirmIdentityContact() : sendIdentityContactChallenge()">
            <h3>{{ identityContactForm === 'EMAIL' ? (identitySettings?.email ? '更换邮箱' : '绑定邮箱') : (identitySettings?.phone ? '更换手机' : '绑定手机') }}</h3>
            <p v-if="identityContactForm === 'EMAIL' && identitySettings?.email">当前邮箱：{{ identitySettings.email.maskedValue }}（已验证）</p>
            <p v-if="identityContactForm === 'PHONE' && identitySettings?.phone">当前手机：{{ identitySettings.phone.maskedValue }}（已验证）</p>
            <label>{{ identityContactForm === 'EMAIL' ? '新邮箱' : '新手机号' }}<input v-model="identityContactDraft" :type="identityContactForm === 'EMAIL' ? 'email' : 'tel'" :name="identityContactForm === 'EMAIL' ? 'new-email' : 'new-phone'" :autocomplete="identityContactForm === 'EMAIL' ? 'email' : 'tel'" :disabled="!!identityContactChallengeId" required></label>
            <label v-if="!identityContactChallengeId">当前密码<input v-model="identityContactCurrentPassword" name="contact-current-password" type="password" autocomplete="current-password" required></label>
            <label v-if="!identityContactChallengeId && identitySettings?.totpEnabled">当前 TOTP<input v-model="identityContactTotpDraft" name="contact-totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label>
            <button v-if="!identityContactChallengeId" class="panel-primary" type="button" :disabled="identityContactSending" @click="sendIdentityContactChallenge">{{ identityContactSending ? '正在发送…' : '发送验证码' }}</button>
            <template v-if="identityContactChallengeId">
              <p>验证码已发送，5 分钟内有效；确认后新联系方式生效，旧值立即释放。</p>
              <p v-if="identityContactExpiresAt">失效时间：{{ new Date(identityContactExpiresAt).toLocaleTimeString() }}</p>
              <DevelopmentContactCodeInspector v-if="identityContactDevCode && DevelopmentContactCodeInspector" :code="identityContactDevCode" @fill="identityContactCodeDraft = identityContactDevCode" />
              <label>验证码<input v-model="identityContactCodeDraft" name="contact-verification-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label>
              <button class="panel-primary" type="submit" :disabled="identityContactSending || identityContactCodeDraft.length !== 6">{{ identityContactSending ? '正在验证…' : '验证并绑定' }}</button>
              <button type="button" :disabled="identityContactSending" @click="identityContactChallengeId = ''; identityContactDevCode = ''; identityContactCodeDraft = ''">重新填写联系方式</button>
            </template>
            <button v-else type="button" @click="identityContactForm = null">取消</button>
          </form>
          <form v-if="identityCredentialForm === 'username'" class="identity-credential-form" @submit.prevent="submitUsernameChange">
            <h3>{{ identitySettings?.username ? '修改用户名' : '设置用户名' }}</h3>
            <label>用户名<input v-model="usernameDraft" name="username" autocomplete="username" minlength="3" maxlength="32" required></label>
            <label>当前密码<input v-model="usernameCurrentPassword" name="current-password" type="password" autocomplete="current-password" required></label>
            <label v-if="identitySettings?.totpEnabled">当前 TOTP<input v-model="identityCredentialTotpDraft" name="username-totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label>
            <p>以后可使用新用户名和原密码登录。</p>
            <button class="panel-primary" type="submit" :disabled="identityCredentialSaving">{{ identityCredentialSaving ? '正在保存…' : '保存用户名' }}</button>
            <button type="button" @click="identityCredentialForm = null">取消</button>
          </form>
          <form v-else-if="identityCredentialForm === 'password'" class="identity-credential-form" @submit.prevent="submitPasswordChange">
            <h3>{{ identitySettings?.passwordConfigured ? '修改密码' : '设置密码' }}</h3>
            <label v-if="identitySettings?.passwordConfigured">当前密码<input v-model="passwordCurrentDraft" name="current-password" type="password" autocomplete="current-password" required></label>
            <label v-if="identitySettings?.totpEnabled">当前 TOTP<input v-model="identityCredentialTotpDraft" name="password-totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label>
            <label>新密码<input v-model="passwordNewDraft" name="new-password" type="password" autocomplete="new-password" minlength="8" maxlength="256" required></label>
            <label>确认新密码<input v-model="passwordConfirmDraft" name="confirm-password" type="password" autocomplete="new-password" minlength="8" maxlength="256" required></label>
            <p>{{ identitySettings?.passwordConfigured ? '至少 8 位。保存后，其他设备上的登录会话会退出。' : '至少 8 位。使用当前已登录设备完成首次设置。' }}</p>
            <button class="panel-primary" type="submit" :disabled="identityCredentialSaving">{{ identityCredentialSaving ? '正在保存…' : '更新密码' }}</button>
            <button type="button" @click="identityCredentialForm = null">取消</button>
          </form>
          <p v-if="identityCredentialError" class="setting-error" role="alert">{{ identityCredentialError }}</p>
          <p v-if="identityCredentialMessage" class="setting-success" role="status">{{ identityCredentialMessage }}</p>
          <div class="profile-shortcuts" aria-label="更多大厅功能">
            <button type="button" @click="openLobbyPanel('history')">战绩</button>
            <button type="button" @click="openLobbyPanel('invite')">邀请与代理</button>
            <button type="button" @click="openLobbyPanel('messages')">消息</button>
            <button type="button" @click="openLobbyPanel('settings')">设置</button>
          </div>
          <p v-if="identityActionError" class="setting-error" role="alert">{{ identityActionError }}</p>
          <button v-if="!rootProps.identitySessionState?.value" class="panel-primary" type="button" @click="openPlayerEntry">登录 / 账号恢复</button>
          <button v-else class="panel-primary" type="button" @click="logoutPlayer">退出当前账号</button>
        </template>
      </section>
    </div>
    </Transition>
    <div v-if="page === 'lobby' && lobbyPanel && playerHelpTopic" class="player-help-scrim" @click.self="closePlayerHelp">
      <section class="player-help-dialog" role="dialog" aria-modal="true" :aria-labelledby="`player-help-title-${playerHelpTopic}`" @keydown="handlePlayerHelpKeydown">
        <button ref="playerHelpCloseButton" class="panel-close" type="button" aria-label="关闭说明" @click="closePlayerHelp">×</button>
        <div class="eyebrow">{{ playerHelpTopic === 'wallet' ? 'WALLET GUIDE' : 'INVITATION GUIDE' }}</div>
        <h2 :id="`player-help-title-${playerHelpTopic}`">{{ playerHelpTopic === 'wallet' ? '钱包规则' : '邀请与返佣' }}</h2>
        <p v-if="playerHelpTopic === 'wallet'">金币与人民币余额分账。转账手续费由发送方额外支付；提现金额按净到账填写，费率、实际扣除和资格以服务端确认摘要为准。未完成赠币流水时不能转出或提现。</p>
        <p v-else>本人可以成为邀请人。可获得的层级与比例由配置决定；每笔奖励依据操作发生时记录的邀请链快照计算。已绑定用户只能由 Admin 换绑。</p>
        <button ref="playerHelpConfirmButton" class="panel-primary" type="button" @click="closePlayerHelp">知道了</button>
      </section>
    </div>
  </div>
</template>
