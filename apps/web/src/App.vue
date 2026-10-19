<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import lobbyBackground from '../../../assets/aigen/lobby-background.webp';
import shisanshuiSubhallBackground from '../../../assets/aigen/shisanshui-subhall-background.webp';
import lotteryGameEmblem from '../../../assets/aigen/brand/lottery-game-emblem.webp';
import PlatformAnnouncementBar from './components/PlatformAnnouncementBar.vue';
import PlatformAnnouncementDetail from './components/PlatformAnnouncementDetail.vue';
import ShisanshuiRoomFlow from './components/ShisanshuiRoomFlow.vue';
import PlayerSocialPage, { type SocialSection } from './components/PlayerSocialPage.vue';
import PlayerPrimaryNavigation, { type PlayerPrimaryDestination } from './components/PlayerPrimaryNavigation.vue';
import PlayerMessagesPage, { type PlayerMessagesSection } from './components/PlayerMessagesPage.vue';
import PlayerInviteAgentWorkspace from './components/PlayerInviteAgentWorkspace.vue';
import PlayerWalletTransferWorkspace from './components/PlayerWalletTransferWorkspace.vue';
import PlayerWalletExchangeWorkspace from './components/PlayerWalletExchangeWorkspace.vue';
import PlayerWalletWithdrawalWorkspace from './components/PlayerWalletWithdrawalWorkspace.vue';
import PlayerEntryPage from './components/PlayerEntryPage.vue';
import PlayerPageAnimatedBackground from './components/PlayerPageAnimatedBackground.vue';
import { localRoomApplication } from './platform/rooms/composition';
import { localPlayerEntryApplication } from './platform/player-entry/composition';
import type { PlatformAnnouncement, PlatformAnnouncementDetail as AnnouncementDetailDto } from '@gameing/contracts/platform-events/announcement';
import type { GameRoomSnapshotDto, RoomDifficultyKey } from '@gameing/contracts/game-room';
import type { GameCatalogDto } from '@gameing/contracts/game-catalog';
import type { GameDifficultyHallDto, GameExperienceDto, GamePreflightResponseDto } from '@gameing/contracts/game-experience';
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
import type { CoinMarketApplication } from './platform/coin-market/coin-market-application';
import { NotificationAction, NotificationSource, type NotificationSummaryItemDto } from '@gameing/contracts/notifications';
import type { NotificationSummaryApplication } from './platform/notifications/notification-summary-application';
import { countUnseenSocialPosts, latestSocialPostCursor, readSocialPostCursor, saveSocialPostCursor } from './platform/social/social-post-badge';
import type { InviteAgentApplication } from './platform/invite-agent/invite-agent-application';
import type { WalletFundingApplication } from './wallet-funding/wallet-funding-application';

const DevelopmentWalletFundingWorkspace = import.meta.env.DEV
  ? defineAsyncComponent(() => import('./components/PlayerWalletFundingWorkspace.vue'))
  : null;

const rootProps = defineProps<{
  gameExperienceApi?: GameExperienceApi;
  playerEntryApplication?: PlayerEntryApplication;
  walletApplication?: WalletApplication;
  walletFundingApplication?: WalletFundingApplication;
  supportApplication?: SupportClientApplication;
  socialFriendsApplication?: SocialFriendsApplication;
  socialApplication?: SocialApplication;
  coinMarketApplication?: CoinMarketApplication;
  checkSocialAccess?: () => Promise<{ enabled: boolean }>;
  notificationSummaryApplication?: NotificationSummaryApplication;
  inviteAgentApplication?: InviteAgentApplication;
  devFixture?: () => Promise<{ userId: string; displayName: string; identifier: string; password: string; recoveryQrPayload: string; recoveryQrPassword: string; recoveryExpiresAt: string }>;
  identitySessionState?: Readonly<Ref<SessionResponseDto | undefined>> | undefined;
}>();

type Page = 'lobby' | 'subhall' | 'entry' | 'event' | 'history' | 'practice' | 'social' | 'messages' | 'wallet' | 'profile';
type LocalGameSession = import('@gameing/shisanshui-client').LocalGameSession;
type GameExperienceApi = {
  gameCatalog(): Promise<GameCatalogDto[]>;
  gameExperiences(): Promise<GameExperienceDto[]>;
  gameExperience(gameKey: string): Promise<GameExperienceDto>;
  gamePreflight(gameKey: string, difficultyKey: string): Promise<GamePreflightResponseDto>;
};

function eventKeyFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/events\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
  return match?.[1];
}

const mobileLobbyBackground = '/assets/page-backgrounds/optimized-v1/mobile/lobby.webp';
const initialAnnouncementId = eventKeyFromPath(window.location.pathname);
const initialSocialPostId = /^\/social\/forum\/posts\/([a-zA-Z0-9_-]{1,128})$/.exec(window.location.pathname)?.[1];
const initialSocialProfileKey = /^\/social\/users\/([A-Z0-9]{8,16})$/.exec(window.location.pathname)?.[1];
const initialSocialMessagesPath = window.location.pathname === '/social/messages';
const initialSocialSection = (/^\/social\/(forum|market|friends)$/.exec(window.location.pathname)?.[1] as SocialSection | undefined) ?? (initialSocialPostId || initialSocialProfileKey ? 'forum' : undefined);
const initialMessagesMatch = /^\/messages(?:\/(inbox|private|support)(?:\/([1-9][0-9]{0,19}))?)?$/.exec(window.location.pathname);
const initialSupportPath = window.location.pathname === '/support';
const initialMessagesSection = (initialMessagesMatch?.[1] as PlayerMessagesSection | undefined) ?? (initialSupportPath ? 'support' : initialSocialMessagesPath ? 'private' : 'all');
const legacyRoomPath = /^\/games\/shisanshui\/(?:match|rooms\/(?:create|join|preview))$/;
const legacyPreviewPath = /^\/games\/[a-z0-9-]+\/preview$/;
if (legacyRoomPath.test(window.location.pathname)) window.history.replaceState({ page: 'subhall' }, '', '/games/shisanshui');
else if (legacyPreviewPath.test(window.location.pathname)) window.history.replaceState({ page: 'lobby' }, '', '/');
else if (initialSupportPath) window.history.replaceState({ page: 'messages', section: 'support' }, '', '/messages/support');
else if (initialSocialMessagesPath) window.history.replaceState({ page: 'messages', section: 'private' }, '', '/messages/private');
const initialGameKey = /^\/games\/([a-z][a-z0-9-]{1,63})$/.exec(window.location.pathname)?.[1];
const initialPrimaryPage = ({ '/wallet': 'wallet', '/profile': 'profile' } as Record<string, 'wallet' | 'profile'>)[window.location.pathname];
const page = ref<Page>(initialGameKey ? 'subhall' : initialAnnouncementId ? 'event' : initialSocialSection ? 'social' : initialMessagesMatch || initialSupportPath || initialSocialMessagesPath ? 'messages' : initialPrimaryPage ?? (window.location.pathname === '/entry' ? 'entry' : window.location.pathname === '/history' ? 'history' : 'lobby'));
const primaryNavigationInProgress = ref(false);
const activePrimaryDestination = computed<PlayerPrimaryDestination>(() => page.value === 'wallet' || page.value === 'profile' || page.value === 'social' || page.value === 'messages' ? page.value : 'lobby');
const socialSection = ref<SocialSection>(initialSocialSection ?? 'forum');
const messagesSection = ref<PlayerMessagesSection>(initialMessagesSection);
const messagePeer = ref<{ userId: string; displayName: string; friendCode: string }>();
const messageConversationId = ref(initialMessagesMatch?.[2]);
const messageReturnPath = ref<string | undefined>(typeof window.history.state?.returnPath === 'string' ? window.history.state.returnPath : undefined);
const socialPostId = ref(initialSocialPostId);
const socialProfileKey = ref(initialSocialProfileKey);
const entryReturnPage = ref<Page>('lobby');
const historyGameFilter = ref('ALL');
const historyRangeFilter = ref('30_DAYS');
const historyOpenFilter = ref<'game' | 'range' | null>(null);
const socialAccessDenied = ref(false);
const messageBadgeCount = ref(0);
const socialNewPostCount = ref(0);
const connection = ref<'checking' | 'online' | 'offline'>('checking');
const message = ref('正在连接游戏服务…');
const gameRoot = ref<HTMLElement | null>(null);
const subhallBackgroundImage = ref<HTMLImageElement | null>(null);
const gameLoading = ref(false);
const gameLoadingStage = ref('准备进入牌桌');
const gameLoadingPhase = ref(1);
const gameLoadingSeconds = ref(0);
const gameLoadingExperience = ref<GameExperienceDto | null>(null);
const gameLoadingAttempt = ref(0);
const gameError = ref('');
const selectedGameKey = ref(initialGameKey ?? 'shisanshui');
const selectedSubhallDifficulty = ref<string | null>(null);
const subhallEntryFeedback = ref('');
const subhallEntryBusy = ref(false);
const gameDirectoryLoading = ref(false);
const gameDirectoryError = ref('');
const lobbyGames = ref<GameExperienceDto[]>([]);
const historyGameLabel = computed(() => historyGameFilter.value === 'ALL' ? '全部游戏' : lobbyGames.value.find((item) => item.game.gameKey === historyGameFilter.value)?.title ?? '全部游戏');
const historyRangeLabel = computed(() => ({ '7_DAYS': '近 7 天', '30_DAYS': '近 30 天', '90_DAYS': '近 90 天', ALL: '全部时间' } as Record<string, string>)[historyRangeFilter.value] ?? '近 30 天');
const activeRulesGameKey = ref('shisanshui');
const gameDirectory = computed(() => lobbyGames.value);
const activeSubhallGame = computed(() => gameDirectory.value.find((item) => item.game.gameKey === selectedGameKey.value));
const activeRulesGame = computed(() => gameDirectory.value.find((item) => item.game.gameKey === activeRulesGameKey.value));
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
const gameCardMotionReady = ref(new Set<string>());
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
  if (item.activityType === WalletActivityType.COIN_MARKET_HOLD) return '集市挂牌冻结';
  if (item.activityType === WalletActivityType.COIN_MARKET_RELEASE) return '集市挂牌解冻';
  return item.activityType === WalletActivityType.TRANSFER_SENT ? '转账转出' : '转账收款';
}
function walletActivityAmount(item: WalletActivityItemDto): string {
  if (item.activityType === WalletActivityType.COIN_MARKET_HOLD || item.activityType === WalletActivityType.COIN_MARKET_RELEASE) {
    const frozen = BigInt(item.frozenDelta ?? '0');
    return `${frozen < 0n ? '释放' : '冻结'} ${frozen < 0n ? -frozen : frozen} 金币`;
  }
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
async function refreshMessageBadge(): Promise<void> {
  const application = rootProps.notificationSummaryApplication;
  if (!rootProps.identitySessionState?.value) {
    messageBadgeCount.value = 0;
    socialNewPostCount.value = 0;
    return;
  }
  if (application) {
    try {
      const snapshot = await application.load(true);
      if (!snapshot.unavailableSources.length) {
        messageBadgeCount.value = snapshot.items.filter((item) => item.requiresAction && !(socialAccessDenied.value && item.source === NotificationSource.SOCIAL_FRIEND_REQUEST)).length;
      }
    } catch {
      // Keep the last known badge when an upstream message source is unavailable.
    }
  }
  await refreshSocialPostBadge();
}
async function refreshSocialPostBadge(): Promise<void> {
  const session = rootProps.identitySessionState?.value;
  const application = rootProps.socialApplication;
  if (!session || !application || socialAccessDenied.value) { socialNewPostCount.value = 0; return; }
  try {
    const topicsResult = await application.listTopics();
    if (!topicsResult.ok) return;
    const results = await Promise.all(topicsResult.value.map((topic) => application.listPosts(topic.topicKey)));
    if (results.some((result) => !result.ok)) return;
    const posts = results.flatMap((result) => result.ok ? result.value : []);
    const cursor = readSocialPostCursor(session.user.userId);
    const latestCursor = latestSocialPostCursor(posts);
    if (page.value === 'social') {
      if (latestCursor) saveSocialPostCursor(session.user.userId, latestCursor);
      socialNewPostCount.value = 0;
      return;
    }
    socialNewPostCount.value = countUnseenSocialPosts(posts, cursor);
  } catch {
    // Keep the last known badge when the community feed is unavailable.
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
const playerPageMotionAssets = {
  wallet: { desktop: '/assets/page-backgrounds/motion/wallet.avif', mobile: '/assets/page-backgrounds/optimized-v1/motion/mobile/wallet.avif' },
  social: { desktop: '/assets/page-backgrounds/motion/social.avif', mobile: '/assets/page-backgrounds/optimized-v1/motion/mobile/social.avif' },
  messages: { desktop: '/assets/page-backgrounds/motion/messages.avif', mobile: '/assets/page-backgrounds/optimized-v1/motion/mobile/messages.avif' },
  profile: { desktop: '/assets/page-backgrounds/motion/profile.avif', mobile: '/assets/page-backgrounds/optimized-v1/motion/mobile/profile.avif' },
} as const;
const playerPageMotionAsset = computed(() => page.value in playerPageMotionAssets ? playerPageMotionAssets[page.value as keyof typeof playerPageMotionAssets] : undefined);
const subhallBackgroundLoaded = ref(page.value === 'subhall');
const gameCarousel = ref<HTMLElement | null>(null);
type LobbyPanel = 'wallet' | 'invite' | 'settings' | 'profile' | 'gameRules';
const lobbyPanel = ref<LobbyPanel | null>(null);
const settingsReturnToProfile = ref(false);
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
type WalletSection = 'home' | 'activity' | 'funding' | 'orders' | 'transfer' | 'exchange' | 'withdraw' | 'withdrawals' | 'accounts';
const walletSection = ref<WalletSection>('home');
const secondaryBackgroundActive = computed(() =>
  (page.value === 'wallet' && walletSection.value !== 'home')
  || (page.value === 'social' && (socialPostId.value !== undefined || socialProfileKey.value !== undefined))
  || (page.value === 'messages' && messageConversationId.value !== undefined),
);
const walletSectionTitles: Record<WalletSection, string> = { home: '钱包', activity: '资产明细', funding: '充值购买金币', orders: '最近订单', transfer: '金币转账', exchange: '兑换余额', withdraw: '申请提现', withdrawals: '提现记录', accounts: '提现账号管理' };
const identityCredentialForm = ref<'username' | 'password' | null>(null);
const securityManagementOpen = ref(false);
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
const identityContactCurrentEmail = ref('');
const identityContactCurrentPhone = ref('');
const identityContactTotpDraft = ref('');
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
const profileUserQrOpen = ref(false);
const profileUserQrImage = ref('');
const profileUserQrCode = ref('');
const profileUserActionMessage = ref('');
let identityDialogReturnFocus: HTMLElement | null = null;
let securityDialogReturnFocus: HTMLElement | null = null;
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
let messageBadgeRefreshTimer: number | undefined;
let gameCarouselMedia: MediaQueryList | undefined;
let boundGameCarousel: HTMLElement | null = null;
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

function bindGameCarousel(): void {
  const carousel = gameCarousel.value;
  if (!carousel) return;
  if (boundGameCarousel && boundGameCarousel !== carousel) {
    boundGameCarousel.removeEventListener('scroll', scheduleActiveGameCard);
  }
  boundGameCarousel = carousel;
  carousel.removeEventListener('scroll', scheduleActiveGameCard);
  carousel.addEventListener('scroll', scheduleActiveGameCard, { passive: true });
  placeFeaturedGame();
}

function handleGameCardImageError(gameId: string): void {
  if (displayedActiveGameCardId.value !== gameId || motionFailedGameCards.value.has(gameId)) return;
  motionFailedGameCards.value = new Set(motionFailedGameCards.value).add(gameId);
}

function isGameCardMotionReady(gameId: string): boolean {
  return gameCardMotionReady.value.has(gameId);
}

function handleGameCardMotionLoad(gameId: string): void {
  if (!isGameCardMotionActive(gameId)) return;
  gameCardMotionReady.value = new Set(gameCardMotionReady.value).add(gameId);
}

function handleGameCardPointerEnter(event: PointerEvent, gameId: string): void {
  if (event.pointerType === 'mouse') hoveredGameCardId.value = gameId;
}

function handleGameCardPointerLeave(event: PointerEvent, gameId: string): void {
  if (event.pointerType === 'mouse' && hoveredGameCardId.value === gameId) hoveredGameCardId.value = null;
}

async function openLobbyPanel(panel: LobbyPanel): Promise<void> {
  if (panel === 'wallet' || panel === 'profile') {
    settingsReturnToProfile.value = false;
    const nextPage = panel as 'wallet' | 'profile';
    const path = `/${nextPage}`;
    if (window.location.pathname !== path) window.history.pushState({ page: nextPage }, '', path);
    page.value = nextPage;
    lobbyPanel.value = panel;
    if (panel === 'wallet') walletSection.value = 'home';
    return;
  }
  if (panel === 'settings' && page.value === 'profile') {
    settingsReturnToProfile.value = true;
    lobbyPanel.value = 'settings';
    return;
  }
  if (page.value === 'wallet' || page.value === 'messages' || page.value === 'profile') {
    window.history.pushState({ page: 'lobby' }, '', '/');
    page.value = 'lobby';
  }
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && !activeElement.closest('.lobby-panel')) {
    panelReturnFocusTarget = activeElement;
  }
  lobbyPanel.value = panel;
}

function closeSettingsPanel(): void {
  if (!settingsReturnToProfile.value) {
    closeLobbyPanel();
    return;
  }
  settingsReturnToProfile.value = false;
  lobbyPanel.value = 'profile';
}

async function openMessagesPage(section: PlayerMessagesSection = 'all', push = true, conversationId?: string): Promise<void> {
  void refreshMessageBadge();
  if (section === 'private' && rootProps.identitySessionState?.value && rootProps.checkSocialAccess) {
    socialAccessDenied.value = true;
    try { socialAccessDenied.value = !(await rootProps.checkSocialAccess()).enabled; }
    catch { socialAccessDenied.value = true; }
    if (socialAccessDenied.value) section = 'all';
  }
  closeLobbyPanel();
  if (section !== 'private') messagePeer.value = undefined;
  messageConversationId.value = conversationId;
  messageReturnPath.value = conversationId && typeof window.history.state?.returnPath === 'string' ? window.history.state.returnPath : undefined;
  messagesSection.value = section;
  const path = conversationId ? `/messages/private/${conversationId}` : section === 'all' ? '/messages' : `/messages/${section}`;
  if (window.location.pathname !== path) {
    const state = { page: 'messages', section, ...(conversationId ? { conversationId, returnPath: messageReturnPath.value } : {}) };
    if (push) window.history.pushState(state, '', path);
    else window.history.replaceState(state, '', path);
  }
  page.value = 'messages';
}

function updateMessagesSection(section: PlayerMessagesSection): void {
  if (section === 'private' && socialAccessDenied.value) return;
  if (messagesSection.value === section) return;
  messageConversationId.value = undefined;
  messagePeer.value = undefined;
  messagesSection.value = section;
  const path = section === 'all' ? '/messages' : `/messages/${section}`;
  window.history.pushState({ page: 'messages', section }, '', path);
}

function openMessagesConversation(conversationId: string): void {
  if (!/^[1-9][0-9]{0,19}$/.test(conversationId) || socialAccessDenied.value) return;
  const path = `/messages/private/${conversationId}`;
  if (window.location.pathname === path) return;
  const returnPath = window.location.pathname;
  messageConversationId.value = conversationId;
  messageReturnPath.value = returnPath;
  messagePeer.value = undefined;
  messagesSection.value = 'private';
  window.history.pushState({ page: 'messages', section: 'private', conversationId, returnPath }, '', path);
}

function closeMessagesConversation(): void {
  const returnPath = typeof window.history.state?.returnPath === 'string' ? window.history.state.returnPath : messageReturnPath.value;
  if (returnPath && window.history.length > 1) {
    window.history.back();
    return;
  }
  messageConversationId.value = undefined;
  messagePeer.value = undefined;
  messageReturnPath.value = undefined;
  messagesSection.value = 'private';
  window.history.replaceState({ page: 'messages', section: 'private' }, '', '/messages/private');
}

async function openSocialPage(section: SocialSection = 'forum', push = true): Promise<void> {
  if (rootProps.identitySessionState?.value && rootProps.checkSocialAccess) {
    try { socialAccessDenied.value = !(await rootProps.checkSocialAccess()).enabled; }
    catch { socialAccessDenied.value = true; }
    if (socialAccessDenied.value) return;
  }
  closeLobbyPanel();
  socialSection.value = section;
  socialPostId.value = undefined;
  socialProfileKey.value = undefined;
  const path = `/social/${section}`;
  if (window.location.pathname !== path) {
    if (push) window.history.pushState({ page: 'social', section }, '', path);
    else window.history.replaceState({ page: 'social', section }, '', path);
  }
  page.value = 'social';
}

function openSocialFriendsPage(): void {
  void openSocialPage('friends');
}

function returnFromSocial(): void {
  closeLobbyPanel(true);
  window.history.replaceState({ page: 'lobby' }, '', '/');
  page.value = 'lobby';
}

function updateSocialSection(section: SocialSection): void {
  if (socialSection.value === section) return;
  socialSection.value = section;
  socialPostId.value = undefined;
  socialProfileKey.value = undefined;
  window.history.pushState({ page: 'social', section }, '', `/social/${section}`);
}

async function openSocialPost(postId: string): Promise<void> {
  if (rootProps.identitySessionState?.value && rootProps.checkSocialAccess) {
    try { socialAccessDenied.value = !(await rootProps.checkSocialAccess()).enabled; }
    catch { socialAccessDenied.value = true; }
    if (socialAccessDenied.value) return;
  }
  socialSection.value = 'forum';
  socialPostId.value = postId;
  socialProfileKey.value = undefined;
  closeLobbyPanel();
  const returnPath = window.location.pathname;
  const returnScrollY = window.scrollY;
  window.history.replaceState({ ...window.history.state, page: 'social', section: socialSection.value, scrollY: returnScrollY }, '', returnPath);
  window.history.pushState({ page: 'social', section: 'forum', postId, returnPath }, '', `/social/forum/posts/${encodeURIComponent(postId)}`);
  page.value = 'social';
}

function returnToSocialForum(): void {
  const returnPath = window.history.state?.returnPath;
  if (typeof returnPath === 'string' && /^\/social\/(forum|users\/[A-Z0-9]{8,16})$/.test(returnPath) && window.history.length > 1) {
    window.history.back();
    return;
  }
  socialPostId.value = undefined;
  socialProfileKey.value = undefined;
  window.history.replaceState({ page: 'social', section: 'forum' }, '', '/social/forum');
  page.value = 'social';
}

async function openSocialProfile(profileKey: string): Promise<void> {
  if (!/^[A-Z0-9]{8,16}$/.test(profileKey)) return;
  if (rootProps.identitySessionState?.value && rootProps.checkSocialAccess) {
    try { socialAccessDenied.value = !(await rootProps.checkSocialAccess()).enabled; }
    catch { socialAccessDenied.value = true; }
    if (socialAccessDenied.value) return;
  }
  socialSection.value = 'forum';
  socialPostId.value = undefined;
  socialProfileKey.value = profileKey;
  const path = `/social/users/${encodeURIComponent(profileKey)}`;
  window.history.pushState({ page: 'social', section: 'forum', profileKey, openedFromSocial: true }, '', path);
  page.value = 'social';
}

function closeSocialProfile(): void {
  if (window.history.state?.openedFromSocial) { window.history.back(); return; }
  socialProfileKey.value = undefined;
  window.history.replaceState({ page: 'social', section: 'forum' }, '', '/social/forum');
}

async function openProfileMessages(peer: { userId: string; displayName: string; friendCode: string; conversationId: string }): Promise<void> {
  if (rootProps.checkSocialAccess) {
    try { socialAccessDenied.value = !(await rootProps.checkSocialAccess()).enabled; }
    catch { socialAccessDenied.value = true; }
    if (socialAccessDenied.value) return;
  }
  closeLobbyPanel();
  messagePeer.value = peer;
  messageConversationId.value = peer.conversationId;
  messageReturnPath.value = window.location.pathname;
  messagesSection.value = 'private';
  const path = `/messages/private/${peer.conversationId}`;
  window.history.pushState({ page: 'messages', section: 'private', conversationId: peer.conversationId, returnPath: messageReturnPath.value }, '', path);
  page.value = 'messages';
}

async function navigatePrimary(destination: PlayerPrimaryDestination): Promise<void> {
  primaryNavigationInProgress.value = true;
  try {
    if (destination === 'lobby') returnFromSocial();
    else if (destination === 'social') await openSocialPage('forum');
    else if (destination === 'messages') await openMessagesPage('all');
    else await openLobbyPanel(destination);
    await nextTick();
  } finally {
    primaryNavigationInProgress.value = false;
  }
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
      void openMessagesPage('support');
      break;
    case NotificationAction.OPEN_FRIENDS:
      void openSocialPage('friends');
      break;
  }
}

function closeLobbyPanel(preservePrimaryRoute = false): void {
  if (!preservePrimaryRoute && (page.value === 'wallet' || page.value === 'profile')) {
    window.history.replaceState({ page: 'lobby' }, '', '/');
    page.value = 'lobby';
  }
  playerHelpTopic.value = null;
  settingsReturnToProfile.value = false;
  lobbyPanel.value = null;
  securityManagementOpen.value = false;
  closeIdentityCredentialDialog(false);
  identityDialogReturnFocus = null;
  securityDialogReturnFocus = null;
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

async function copyProfileUserId(): Promise<void> {
  const userId = rootProps.identitySessionState?.value?.user.userId;
  if (!userId) return;
  try {
    await navigator.clipboard.writeText(userId);
  } catch {
    const input = document.createElement('textarea');
    input.value = userId;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  profileUserActionMessage.value = '账号 ID 已复制';
  window.setTimeout(() => { profileUserActionMessage.value = ''; }, 1800);
}

async function openProfileUserQr(): Promise<void> {
  const application = rootProps.socialFriendsApplication;
  if (!application || !rootProps.identitySessionState?.value) return;
  try {
    const profile = await application.ownProfile();
    const qr = await import('qrcode');
    profileUserQrImage.value = await qr.toDataURL(`${window.location.origin}/social/users/${encodeURIComponent(profile.friendCode)}`, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
    profileUserQrCode.value = profile.friendCode;
    profileUserQrOpen.value = true;
  } catch {
    profileUserActionMessage.value = '二维码暂时无法生成，请稍后重试';
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
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  closeIdentityCredentialDialog(false);
  identityDialogReturnFocus = returnFocus;
  identityCredentialForm.value = form;
  identityCredentialError.value = '';
  identityCredentialMessage.value = '';
  usernameDraft.value = identitySettings.value?.username ?? '';
  usernameCurrentPassword.value = '';
  passwordCurrentDraft.value = '';
  passwordNewDraft.value = '';
  passwordConfirmDraft.value = '';
  identityCredentialTotpDraft.value = '';
  void nextTick(() => document.querySelector<HTMLElement>('.identity-subdialog input')?.focus());
}

function editProfileField(field: 'username' | 'email' | 'phone'): void {
  if (!rootProps.identitySessionState?.value) { openPlayerEntry(); return; }
  if (identitySettingsLoading.value) return;
  if (field === 'username') {
    if (!identitySettings.value?.passwordConfigured) openIdentityCredentialForm('password');
    else openIdentityCredentialForm('username');
  }
  else openIdentityContactForm(field === 'email' ? 'EMAIL' : 'PHONE');
}

function closeIdentityCredentialDialog(restoreFocus = true): void {
  identityCredentialForm.value = null;
  identityContactForm.value = null;
  usernameCurrentPassword.value = '';
  passwordCurrentDraft.value = '';
  passwordNewDraft.value = '';
  passwordConfirmDraft.value = '';
  identityCredentialTotpDraft.value = '';
  identityContactCurrentPassword.value = '';
  identityContactCurrentEmail.value = '';
  identityContactCurrentPhone.value = '';
  identityContactTotpDraft.value = '';
  if (restoreFocus) restoreIdentityDialogFocus();
  else identityDialogReturnFocus = null;
}

function restoreIdentityDialogFocus(): void {
  const target = identityDialogReturnFocus;
  identityDialogReturnFocus = null;
  void nextTick(() => target?.focus());
}

function openSecurityManagement(): void {
  securityDialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  securityManagementOpen.value = true;
  void nextTick(() => document.querySelector<HTMLElement>('.identity-security-dialog button:not(.panel-close), .identity-security-dialog input')?.focus());
}

function closeSecurityManagement(): void {
  securityManagementOpen.value = false;
  clearTotpSecrets();
  clearRecoveryQrDraft();
  const target = securityDialogReturnFocus;
  securityDialogReturnFocus = null;
  void nextTick(() => target?.focus());
}

function openPasswordSetupFromSecurity(): void {
  closeSecurityManagement();
  void nextTick(() => openIdentityCredentialForm('password'));
}

function handleIdentityDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (securityManagementOpen.value) closeSecurityManagement();
    else closeIdentityCredentialDialog();
    return;
  }
  if (event.key !== 'Tab') return;
  const dialog = event.currentTarget;
  if (!(dialog instanceof HTMLElement)) return;
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
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

function identityFailureMessage(code: string): string {
  const messages: Record<string, string> = {
    IDENTIFIER_ALREADY_USED: '这个用户名或联系方式已被使用，请检查后重试。',
    CURRENT_EMAIL_MISMATCH: '原邮箱不正确，请填写当前完整邮箱后重试。',
    CURRENT_PHONE_MISMATCH: '原手机号不正确，请填写当前完整手机号后重试。',
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
  restoreIdentityDialogFocus();
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
  restoreIdentityDialogFocus();
  const refreshed = await application.getIdentitySettings();
  if (refreshed.ok) identitySettings.value = refreshed.value;
  identityCredentialMessage.value = '密码已更新，其他设备上的登录会话已退出。';
}

function openIdentityContactForm(contactType: 'EMAIL' | 'PHONE'): void {
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  closeIdentityCredentialDialog(false);
  identityDialogReturnFocus = returnFocus;
  identityContactForm.value = contactType;
  identityContactDraft.value = '';
  identityContactCurrentPassword.value = '';
  identityContactCurrentEmail.value = '';
  identityContactCurrentPhone.value = '';
  identityContactTotpDraft.value = '';
  identityCredentialError.value = '';
  identityCredentialMessage.value = '';
  void nextTick(() => document.querySelector<HTMLElement>('.identity-subdialog input')?.focus());
}

async function saveIdentityPhone(): Promise<void> {
  const application = rootProps.playerEntryApplication;
  if (!application || identityContactForm.value !== 'PHONE' || !identityContactDraft.value || (identitySettings.value?.passwordConfigured && !identityContactCurrentPassword.value)) return;
  identityContactSending.value = true;
  identityCredentialError.value = '';
  const result = await application.setPhoneContact({ phone: identityContactDraft.value, ...(identitySettings.value?.phone ? { currentPhone: identityContactCurrentPhone.value } : {}), ...(identityContactCurrentPassword.value ? { password: identityContactCurrentPassword.value } : {}), ...(identityContactTotpDraft.value ? { totp: identityContactTotpDraft.value } : {}) });
  identityContactSending.value = false;
  identityContactCurrentPassword.value = '';
  identityContactTotpDraft.value = '';
  if (!result.ok) {
    identityCredentialError.value = result.code === 'CURRENT_PHONE_MISMATCH' ? '原手机号不正确，请核对提示的末三位后重试。' : identityFailureMessage(result.code);
    return;
  }
  identitySettings.value = result.value;
  identityContactForm.value = null;
  restoreIdentityDialogFocus();
  identityContactDraft.value = '';
  identityContactCurrentPhone.value = '';
  identityCredentialMessage.value = '手机号已绑定。';
}

async function saveIdentityEmail(): Promise<void> {
  const application = rootProps.playerEntryApplication;
  if (!application || identityContactForm.value !== 'EMAIL' || !identityContactDraft.value || (identitySettings.value?.email && !identityContactCurrentEmail.value) || (identitySettings.value?.passwordConfigured && !identityContactCurrentPassword.value)) return;
  identityContactSending.value = true;
  identityCredentialError.value = '';
  const result = await application.setEmailContact({ email: identityContactDraft.value, ...(identitySettings.value?.email ? { currentEmail: identityContactCurrentEmail.value } : {}), ...(identityContactCurrentPassword.value ? { password: identityContactCurrentPassword.value } : {}), ...(identityContactTotpDraft.value ? { totp: identityContactTotpDraft.value } : {}) });
  identityContactSending.value = false;
  if (!result.ok) {
    identityCredentialError.value = result.code === 'CURRENT_EMAIL_MISMATCH' ? '原邮箱不正确，请填写当前完整邮箱后重试。' : identityFailureMessage(result.code);
    return;
  }
  identitySettings.value = result.value;
  identityContactForm.value = null;
  restoreIdentityDialogFocus();
  identityContactDraft.value = '';
  identityContactCurrentEmail.value = '';
  identityCredentialMessage.value = '邮箱已绑定，旧邮箱已释放。';
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
  entryReturnPage.value = page.value;
  closeLobbyPanel();
  if (window.location.pathname !== '/entry') window.history.pushState({ page: 'entry' }, '', '/entry');
  page.value = 'entry';
}

function returnFromEntry(): void {
  const returnPage = entryReturnPage.value;
  const returnPath = returnPage === 'history' ? '/history' : returnPage === 'social' ? `/social/${socialPostId.value ? `forum/posts/${socialPostId.value}` : socialSection.value}` : returnPage === 'subhall' ? `/games/${selectedGameKey.value}` : returnPage === 'wallet' || returnPage === 'profile' ? `/${returnPage}` : '/';
  if (window.location.pathname === '/entry') window.history.replaceState({ page: returnPage, section: returnPage === 'social' ? socialSection.value : undefined }, '', returnPath);
  page.value = returnPage;
  if (returnPage === 'wallet' || returnPage === 'profile') lobbyPanel.value = returnPage;
}

function openHistoryPage(): void {
  historyOpenFilter.value = null;
  if (window.location.pathname !== '/history') window.history.pushState({ page: 'history' }, '', '/history');
  page.value = 'history';
}

function returnFromHistory(): void {
  historyOpenFilter.value = null;
  window.history.replaceState({ page: 'lobby' }, '', '/');
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
  if (document.visibilityState === 'visible') {
    void loadActiveAnnouncements();
    void refreshMessageBadge();
  }
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
  const socialPostMatch = /^\/social\/forum\/posts\/([a-zA-Z0-9_-]{1,128})$/.exec(window.location.pathname);
  const socialProfileMatch = /^\/social\/users\/([A-Z0-9]{8,16})$/.exec(window.location.pathname);
  const socialMatch = /^\/social\/(forum|market|friends)$/.exec(window.location.pathname);
  const messagesMatch = /^\/messages(?:\/(inbox|private|support)(?:\/([1-9][0-9]{0,19}))?)?$/.exec(window.location.pathname);
  if (!/^\/messages\/private\/[1-9][0-9]{0,19}$/.test(window.location.pathname)) {
    messageConversationId.value = undefined;
    messagePeer.value = undefined;
    messageReturnPath.value = undefined;
  }
  if (legacyRoomPath.test(window.location.pathname)) {
    window.history.replaceState({ page: 'subhall' }, '', '/games/shisanshui');
    subhallBackgroundLoaded.value = true;
    page.value = 'subhall';
  } else if (legacyPreviewPath.test(window.location.pathname)) {
    window.history.replaceState({ page: 'lobby' }, '', '/');
    page.value = 'lobby';
  } else if (/^\/games\/[a-z][a-z0-9-]{1,63}$/.test(window.location.pathname)) {
    const match = /^\/games\/([a-z][a-z0-9-]{1,63})$/.exec(window.location.pathname);
    if (match?.[1]) void openGameHall(match[1], false);
    subhallBackgroundLoaded.value = true;
  } else if (eventKey) {
    page.value = 'event';
    void loadAnnouncementDetail(eventKey);
  } else if (socialPostMatch) {
    socialSection.value = 'forum';
    socialPostId.value = socialPostMatch[1];
    socialProfileKey.value = undefined;
    page.value = 'social';
  } else if (socialProfileMatch) {
    socialSection.value = 'forum';
    socialPostId.value = undefined;
    socialProfileKey.value = socialProfileMatch[1];
    page.value = 'social';
  } else if (socialMatch) {
    socialSection.value = socialMatch[1] as SocialSection;
    socialPostId.value = undefined;
    socialProfileKey.value = undefined;
    page.value = 'social';
  } else if (window.location.pathname === '/social/messages') {
    window.history.replaceState({ page: 'messages', section: 'private' }, '', '/messages/private');
    void openMessagesPage('private', false);
  } else if (messagesMatch) {
    const requestedSection = (messagesMatch[1] as PlayerMessagesSection | undefined) ?? 'all';
    void openMessagesPage(requestedSection, false, messagesMatch[2]);
  } else if (window.location.pathname === '/support') {
    window.history.replaceState({ page: 'messages', section: 'support' }, '', '/messages/support');
    void openMessagesPage('support', false);
  } else if (window.location.pathname === '/entry') {
    page.value = 'entry';
  } else if (window.location.pathname === '/history') {
    page.value = 'history';
  } else if (initialPrimaryPageForPath(window.location.pathname)) {
    page.value = initialPrimaryPageForPath(window.location.pathname)!;
  } else {
    announcementDetailRequestId += 1;
    selectedAnnouncement.value = null;
    announcementDetailLoading.value = false;
    page.value = 'lobby';
  }
  closeLobbyPanel(true);
  const primaryPage = initialPrimaryPageForPath(window.location.pathname);
  if (primaryPage) { page.value = primaryPage; lobbyPanel.value = primaryPage; }
  const socialScrollY = window.history.state?.page === 'social' && typeof window.history.state.scrollY === 'number' ? window.history.state.scrollY : undefined;
  if (socialScrollY !== undefined && (socialMatch || socialProfileMatch)) void nextTick().then(() => window.scrollTo({ top: socialScrollY, behavior: 'instant' }));
}

function initialPrimaryPageForPath(pathname: string): 'wallet' | 'profile' | undefined {
  return ({ '/wallet': 'wallet', '/profile': 'profile' } as Record<string, 'wallet' | 'profile'>)[pathname];
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
      if (socialAccessDenied.value && page.value === 'social') returnFromSocial();
    } else socialAccessDenied.value = false;
    if (lobbyPanel.value === 'wallet') void reloadWallet();
    void refreshMessageBadge();
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
  void refreshMessageBadge();
}, { immediate: true });
watch(socialAccessDenied, (denied) => {
  if (denied) socialNewPostCount.value = 0;
  else void refreshSocialPostBadge();
});
watch(page, (current) => {
  if (current === 'social') void refreshSocialPostBadge();
});

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

async function loadGameDirectory(): Promise<void> {
  if (!rootProps.gameExperienceApi) {
    gameDirectoryError.value = '游戏目录 API 尚未连接。';
    return;
  }
  gameDirectoryLoading.value = true;
  gameDirectoryError.value = '';
  try {
    const [catalog, experiences] = await Promise.all([rootProps.gameExperienceApi.gameCatalog(), rootProps.gameExperienceApi.gameExperiences()]);
    const catalogByKey = new Map(catalog.map((item) => [item.gameKey, item]));
    const joined = experiences.map((item) => ({ ...item, game: catalogByKey.get(item.game.gameKey) ?? item.game })).sort((left, right) => left.game.sortOrder - right.game.sortOrder);
    if (joined.length !== catalog.length || joined.some((item) => !catalogByKey.has(item.game.gameKey))) throw new Error('GAME_DIRECTORY_MISMATCH');
    lobbyGames.value = joined;
    await nextTick();
    placeFeaturedGame();
    if (initialGameKey) {
      const initial = joined.find((item) => item.game.gameKey === initialGameKey);
      if (initial) await openGameHall(initialGameKey, false);
      else { page.value = 'lobby'; window.history.replaceState({ page: 'lobby' }, '', '/'); }
    }
  } catch {
    gameDirectoryError.value = '游戏目录暂时无法读取，请重试。';
  } finally {
    gameDirectoryLoading.value = false;
  }
}

async function openGameHall(gameKey: string, pushRoute = true): Promise<void> {
  if (!rootProps.gameExperienceApi) { gameDirectoryError.value = '游戏目录 API 尚未连接。'; return; }
  gameDirectoryError.value = '';
  try {
    const experience = await rootProps.gameExperienceApi.gameExperience(gameKey);
    const existingIndex = lobbyGames.value.findIndex((item) => item.game.gameKey === gameKey);
    if (existingIndex >= 0) lobbyGames.value.splice(existingIndex, 1, experience);
    else lobbyGames.value.push(experience);
    selectedGameKey.value = gameKey;
    selectedSubhallDifficulty.value = null;
    subhallEntryFeedback.value = '';
    subhallBackgroundLoaded.value = true;
    await nextTick();
    try { await subhallBackgroundImage.value?.decode(); } catch { /* CSS background keeps the hall legible when art is unavailable. */ }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (pushRoute && window.location.pathname !== `/games/${gameKey}`) window.history.pushState({ page: 'subhall', gameKey }, '', `/games/${gameKey}`);
    page.value = 'subhall';
    maybeStartSubhallGuide();
  } catch {
    gameDirectoryError.value = '游戏厅信息暂时无法读取，请重试。';
  }
}

function openGameRules(gameKey: string): void {
  activeRulesGameKey.value = gameKey;
  openLobbyPanel('gameRules');
}

async function selectDifficulty(game: GameExperienceDto, hall: GameDifficultyHallDto, event?: MouseEvent, source: 'subhall' | 'lobby' = 'subhall'): Promise<void> {
  if (!rootProps.gameExperienceApi || subhallEntryBusy.value) return;
  const triggerElement = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const attempt = ++gameLoadingAttempt.value;
  const loadingStartedAt = Date.now();
  selectedGameKey.value = game.game.gameKey;
  selectedSubhallDifficulty.value = hall.difficultyKey;
  subhallEntryFeedback.value = '';
  subhallEntryBusy.value = true;
  gameLoadingExperience.value = game;
  gameLoading.value = true;
  gameLoadingStage.value = `正在准备${game.title} · ${hall.title}`;
  gameLoadingPhase.value = 1;
  gameLoadingSeconds.value = 0;
  gameLoadingTimer ??= window.setInterval(() => { gameLoadingSeconds.value += 1; }, 1000);
  practiceReturnPage.value = source === 'lobby' || !isDesktopLayout.value ? 'lobby' : 'subhall';
  await nextTick();
  try {
    const result = await rootProps.gameExperienceApi.gamePreflight(game.game.gameKey, hall.difficultyKey);
    if (attempt !== gameLoadingAttempt.value) return;
    if (result.availability !== 'READY' || game.entryMode !== 'LOCAL_PRACTICE') {
      subhallEntryFeedback.value = result.message;
      await waitForLoadingTransition(loadingStartedAt);
      gameLoading.value = false;
      return;
    }
    const practiceTier = practiceTiers.find((tier) => tier.difficultyKey.toLowerCase() === hall.difficultyKey);
    if (!practiceTier) {
      subhallEntryFeedback.value = '当前难度没有已登记的本地练习流程。';
      await waitForLoadingTransition(loadingStartedAt);
      gameLoading.value = false;
      return;
    }
    if (source === 'lobby' || !isDesktopLayout.value) void enterPractice(practiceTier.tierName, 'lobby');
    else {
      await waitForLoadingTransition(loadingStartedAt);
      gameLoading.value = false;
      openRoomFlow(practiceTier, triggerElement);
    }
  } catch {
    if (attempt !== gameLoadingAttempt.value) return;
    subhallEntryFeedback.value = '难度检查失败，请重试。';
    await waitForLoadingTransition(loadingStartedAt);
    gameLoading.value = false;
  } finally {
    if (attempt === gameLoadingAttempt.value) {
      subhallEntryBusy.value = false;
      if (!gameLoading.value) stopGameLoadingClock();
    }
  }
}

async function waitForLoadingTransition(startedAt: number): Promise<void> {
  const remaining = 360 - (Date.now() - startedAt);
  if (remaining > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
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
  if (/^\/games\/[a-z][a-z0-9-]{1,63}$/.test(window.location.pathname)) window.history.replaceState({ page: 'lobby' }, '', '/');
  page.value = 'lobby';
}

async function enterPractice(tierName: string, returnPage: 'lobby' | 'subhall' = 'subhall'): Promise<void> {
  practiceTier.value = tierName;
  practiceReturnPage.value = returnPage;
  page.value = 'practice';
  gameLoading.value = true;
  gameLoadingExperience.value ??= activeSubhallGame.value ?? null;
  gameLoadingStage.value = `正在载入${gameLoadingExperience.value?.title ?? '十三张'}牌桌程序`;
  gameLoadingPhase.value = 1;
  gameLoadingSeconds.value = 0;
  gameError.value = '';
}

function openRoomFlow(tier: typeof practiceTiers[number], triggerElement: HTMLElement | null): void {
  roomDifficultyKey.value = tier.difficultyKey;
  roomDifficultyLabel.value = tier.name;
  roomFlowReturnTarget.value = triggerElement;
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
  gameLoadingStage.value = `正在重新载入${gameLoadingExperience.value?.title ?? '十三张'}牌桌程序`;
  gameLoadingPhase.value = 1;
  gameLoadingSeconds.value = 0;
  void mountPracticeGame();
}

watch(page, async (nextPage) => {
  if (nextPage !== 'lobby' && boundGameCarousel) {
    boundGameCarousel.removeEventListener('scroll', scheduleActiveGameCard);
    boundGameCarousel = null;
  }
  if (nextPage !== 'lobby' && nextPage !== 'practice') return;
  await nextTick();
  if (page.value === 'lobby') bindGameCarousel();
  if (page.value === 'practice') void mountPracticeGame();
}, { flush: 'post' });

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
    gameLoadingStage.value = `正在载入${gameLoadingExperience.value?.title ?? '十三张'}牌桌程序`;
    gameLoadingPhase.value = 1;
    const game = await import('@gameing/shisanshui-client');
    if (!target.isConnected || page.value !== 'practice') return;
    gameLoadingStage.value = `正在初始化${gameLoadingExperience.value?.title ?? '十三张'}画面`;
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
  gameLoadingAttempt.value += 1;
  subhallEntryBusy.value = false;
  const session = gameSession;
  gameSession = undefined;
  stopGameLoadingClock();
  gameLoading.value = false;
  if (session) await session.dispose();
  activePracticeRoom.value = null;
  page.value = practiceReturnPage.value;
}

onMounted(() => {
  void loadGameDirectory();
  void loadClientPreferences();
  if (page.value !== 'social' && !(page.value === 'messages' && messagesSection.value === 'private') && rootProps.identitySessionState?.value && rootProps.checkSocialAccess) {
    socialAccessDenied.value = true;
    void rootProps.checkSocialAccess().then(({ enabled }) => { socialAccessDenied.value = !enabled; }).catch(() => { socialAccessDenied.value = true; });
  }
  const primaryPage = initialPrimaryPageForPath(window.location.pathname);
  if (primaryPage) lobbyPanel.value = primaryPage;
  if (page.value === 'social' && rootProps.identitySessionState?.value) void openSocialPage(socialSection.value, false);
  if (page.value === 'messages' && messagesSection.value === 'private') void openMessagesPage('private', false);
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
  gameCarouselMedia.addEventListener('change', placeFeaturedGame);
  bindGameCarousel();
  window.addEventListener('popstate', handleHistoryNavigation);
  document.addEventListener('visibilitychange', refreshAnnouncementsWhenVisible);
  window.addEventListener('online', refreshAnnouncementsWhenVisible);
  void loadActiveAnnouncements();
  void refreshMessageBadge();
  messageBadgeRefreshTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void refreshMessageBadge();
  }, 30_000);
  if (initialAnnouncementId) void loadAnnouncementDetail(initialAnnouncementId);
  void checkService();
});
onBeforeUnmount(() => {
  if (messageBadgeRefreshTimer !== undefined) window.clearInterval(messageBadgeRefreshTimer);
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
  boundGameCarousel?.removeEventListener('scroll', scheduleActiveGameCard);
  boundGameCarousel = null;
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
    <div class="scene-backdrops" :class="{ 'background-softened': secondaryBackgroundActive }" aria-hidden="true">
      <picture class="scene-backdrop lobby-backdrop" :class="{ active: page === 'lobby' || page === 'entry' || page === 'event' || page === 'history' }">
        <source media="(max-width: 720px)" :srcset="mobileLobbyBackground" />
        <img :src="lobbyBackground" alt="" />
      </picture>
      <picture v-if="page === 'wallet'" class="scene-backdrop player-page-backdrop wallet-page-backdrop active">
        <source media="(max-width: 720px)" srcset="/assets/page-backgrounds/optimized-v1/mobile/wallet.webp" />
        <img src="/assets/page-backgrounds/review-v2/wallet.webp" alt="" />
      </picture>
      <picture v-else-if="page === 'social'" class="scene-backdrop player-page-backdrop social-page-backdrop active">
        <source media="(max-width: 720px)" srcset="/assets/page-backgrounds/optimized-v1/mobile/social.webp" />
        <img src="/assets/page-backgrounds/review-v2/social.webp" alt="" />
      </picture>
      <picture v-else-if="page === 'messages'" class="scene-backdrop player-page-backdrop messages-page-backdrop active">
        <source media="(max-width: 720px)" srcset="/assets/page-backgrounds/optimized-v1/mobile/messages.webp" />
        <img src="/assets/page-backgrounds/review-v2/messages.webp" alt="" />
      </picture>
      <picture v-else-if="page === 'profile'" class="scene-backdrop player-page-backdrop profile-page-backdrop active">
        <source media="(max-width: 720px)" srcset="/assets/page-backgrounds/optimized-v1/mobile/profile.webp" />
        <img src="/assets/page-backgrounds/review-v2/profile.webp" alt="" />
      </picture>
      <PlayerPageAnimatedBackground v-if="gameCardMotionAllowed && playerPageMotionAsset" :class="{ 'profile-motion': page === 'profile', 'cash-exchange-motion': page === 'wallet' }" :key="playerPageMotionAsset.desktop" :desktop-src="playerPageMotionAsset.desktop" :mobile-src="playerPageMotionAsset.mobile" />
      <img v-if="subhallBackgroundLoaded" ref="subhallBackgroundImage" class="scene-backdrop subhall-backdrop" :class="{ active: page === 'subhall' || page === 'practice' }" :src="activeSubhallGame?.subhallBackgroundUrl ?? shisanshuiSubhallBackground" alt="" />
      <div class="scene-tint lobby-tint" :class="{ active: page === 'lobby' || page === 'entry' || page === 'event' || page === 'history' }"></div>
      <div class="scene-tint player-page-tint" :class="{ active: page === 'wallet' || page === 'social' || page === 'messages' || page === 'profile' }"></div>
      <div v-if="subhallBackgroundLoaded" class="scene-tint subhall-tint" :class="{ active: page === 'subhall' || page === 'practice' }"></div>
    </div>
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
      <button class="header-action" type="button" aria-label="消息" @click="openMessagesPage('all')">消息</button>
      <button class="header-action" type="button" aria-label="个人菜单" @click="openLobbyPanel('profile')">我的</button>
      <button class="header-action" type="button" @click="openLobbyPanel('settings')">设置</button>
    </header>
    <PlatformAnnouncementBar :announcements="activeAnnouncements" @open="openAnnouncement" />

    <section class="welcome">
      <div class="eyebrow">WELCOME TO THE HALL</div>
      <h1>挑一款游戏，<span>现在开局。</span></h1>
      <p>选择游戏查看玩法与难度；尚未接入的模块不会创建牌局或扣除资产。</p>
    </section>

    <p v-if="gameDirectoryError" class="game-directory-feedback" role="alert">{{ gameDirectoryError }} <button type="button" @click="loadGameDirectory">重试</button></p>
    <section ref="gameCarousel" class="game-row" :class="{ 'guide-target': hallGuideStep === 1 }" aria-label="游戏列表，可横向滚动" tabindex="0">
      <div v-if="gameDirectoryLoading && !lobbyGames.length" class="game-directory-loading" role="status">正在读取游戏目录…</div>
      <article v-for="game in lobbyGames" :key="game.game.gameKey" class="game-card" :class="{ featured: game.game.isPlayable, 'coming-soon': !game.game.isPlayable, 'is-centered': activeGameCardId === game.game.gameKey, 'is-motion-active': isGameCardMotionActive(game.game.gameKey), 'guide-target': hallGuideStep === 2 && game.game.isPlayable }" :data-game-id="game.game.gameKey" @pointerenter="handleGameCardPointerEnter($event, game.game.gameKey)" @pointerleave="handleGameCardPointerLeave($event, game.game.gameKey)">
        <picture class="game-card-backdrop game-card-backdrop-poster" aria-hidden="true">
          <source media="(min-width: 721px)" type="image/avif" :srcset="`/assets/game-cards/${game.game.gameCode}/portrait/poster.avif`" />
          <source media="(min-width: 721px)" type="image/webp" :srcset="`/assets/game-cards/${game.game.gameCode}/portrait/poster.webp`" />
          <source type="image/avif" :srcset="`/assets/game-cards/${game.game.gameCode}/poster.avif`" />
          <img :src="`/assets/game-cards/${game.game.gameCode}/poster.webp`" alt="" :loading="displayedActiveGameCardId === game.game.gameKey ? 'eager' : 'lazy'" decoding="async" @error="handleGameCardImageError(game.game.gameKey)" />
        </picture>
        <picture v-if="isGameCardMotionActive(game.game.gameKey)" :key="game.game.gameCode" class="game-card-backdrop game-card-backdrop-motion" :class="{ ready: isGameCardMotionReady(game.game.gameKey) }" aria-hidden="true">
          <source media="(min-width: 721px)" type="image/avif" :srcset="`/assets/game-cards/${game.game.gameCode}/portrait/active.avif`" />
          <source media="(min-width: 721px)" type="image/webp" :srcset="`/assets/game-cards/${game.game.gameCode}/portrait/poster.webp`" />
          <source type="image/avif" :srcset="`/assets/game-cards/${game.game.gameCode}/active.avif`" />
          <img :src="`/assets/game-cards/${game.game.gameCode}/poster.webp`" alt="" loading="eager" decoding="async" @load="handleGameCardMotionLoad(game.game.gameKey)" @error="handleGameCardImageError(game.game.gameKey)" />
        </picture>
        <div class="game-art"><img :src="`/assets/game-icons/${game.game.gameCode}.webp`" alt="" :loading="displayedActiveGameCardId === game.game.gameKey ? 'eager' : 'lazy'" /></div>
        <div class="game-info">
          <div><span class="game-tag" :class="{ muted: !game.game.isPlayable }">{{ game.game.isPlayable ? '本地免费练习' : '玩法与难度预览' }}</span><h2>{{ game.title }}</h2></div>
          <p>{{ game.description }}</p>
          <button type="button" @click="openGameHall(game.game.gameKey)">{{ game.game.isPlayable ? '进入游戏厅' : '查看游戏厅' }}</button>
        </div>
        <div class="mobile-card-details">
          <div class="mobile-game-heading">
            <div class="game-art mobile-game-art"><img :src="`/assets/game-icons/${game.game.gameCode}.webp`" alt="" /></div>
            <div class="mobile-card-title">
              <span class="game-tag" :class="{ muted: !game.game.isPlayable }">{{ game.game.isPlayable ? '本地免费练习' : '游戏介绍' }}</span>
              <div class="mobile-title-row"><h2>{{ game.title }}</h2></div>
            </div>
          </div>
          <p class="mobile-game-description">{{ game.description }}</p>
          <section class="mobile-tier-list" :aria-label="`${game.title}难度选择`">
            <h3>选择难度</h3>
            <button v-for="hall in game.difficultyHalls" :key="hall.difficultyKey" class="mobile-tier-option" :disabled="!hall.enabled || subhallEntryBusy" @click="selectDifficulty(game, hall, $event, 'lobby')">
              <span class="mobile-tier-copy"><strong>{{ hall.title }}</strong><small>{{ hall.summary }}</small></span>
              <span class="mobile-tier-metrics"><span>最低投入<strong>{{ hall.minBetCoins }} 金币</strong></span><span>倍率<strong>{{ hall.currentMultiplier }}×</strong></span><span>最高<strong>{{ hall.maxMultiplier }}×</strong></span></span>
              <span class="mobile-tier-enter" aria-hidden="true">›</span>
            </button>
            <p v-if="selectedGameKey === game.game.gameKey && subhallEntryFeedback" class="game-entry-feedback" role="status">{{ subhallEntryFeedback }}</p>
          </section>
          <button class="rules-trigger" type="button" :aria-label="`查看${game.title}玩法规则与说明`" @click="openGameRules(game.game.gameKey)"><span aria-hidden="true">?</span><span>玩法规则与说明</span><span class="rules-trigger-arrow" aria-hidden="true">›</span></button>
        </div>
      </article>
    </section>

    <nav class="lobby-actions" :class="{ 'guide-target': hallGuideStep === 3 && isDesktopLayout, 'social-disabled': socialAccessDenied }" aria-label="大厅功能">
      <button type="button" @click="openLobbyPanel('wallet')"><span>◈</span>充值 / 钱包</button>
      <button type="button" @click="openHistoryPage"><span>▤</span>战绩</button>
      <button type="button" @click="openLobbyPanel('invite')"><span>♧</span>邀请 / 代理</button>
      <button v-if="!socialAccessDenied" class="lobby-social-entry" type="button" :aria-label="socialNewPostCount > 0 ? `社区，有 ${socialNewPostCount} 条新帖子` : undefined" @click="openSocialPage('forum')"><span>◎</span>社区<span v-if="socialNewPostCount > 0" class="lobby-message-badge">{{ socialNewPostCount > 99 ? '99+' : socialNewPostCount }}</span></button>
      <button class="lobby-message-entry" type="button" :aria-label="messageBadgeCount > 0 ? `消息与客服，有 ${messageBadgeCount} 项待处理` : undefined" @click="openMessagesPage('support')"><span>✉</span>消息 / 客服<span v-if="messageBadgeCount > 0" class="lobby-message-badge">{{ messageBadgeCount > 99 ? '99+' : messageBadgeCount }}</span></button>
      <button type="button" @click="openLobbyPanel('settings')"><span>⚙</span>设置</button>
    </nav>

    <footer>本地体验 · 不扣金币 · 退出后不保留练习牌局</footer>
  </main>

  <PlayerSocialPage
    v-else-if="page === 'social'"
    key="player-social"
    :section="socialSection"
    :post-id="socialPostId"
    :profile-key="socialProfileKey"
    :authenticated="Boolean(rootProps.identitySessionState?.value)"
    :user-id="rootProps.identitySessionState?.value?.user.userId"
    :social-application="rootProps.socialApplication"
    :friends-application="rootProps.socialFriendsApplication"
    :market-application="rootProps.coinMarketApplication"
    :available-coins="walletSummary?.assets[0]?.availableAmount ?? '0'"
    :turnover-remaining="walletSummary?.turnover.remainingCoins ?? '0'"
    @navigate="updateSocialSection"
    @back="returnFromSocial"
    @open-post="openSocialPost"
    @back-to-forum="returnToSocialForum"
    @open-profile="openSocialProfile"
    @close-profile="closeSocialProfile"
    @open-messages="openProfileMessages"
    @login="openPlayerEntry"
    @wallet-changed="reloadWallet"
  />
  <PlayerMessagesPage
    v-else-if="page === 'messages'"
    key="player-messages"
    :section="messagesSection"
    :authenticated="Boolean(rootProps.identitySessionState?.value)"
    :user-id="rootProps.identitySessionState?.value?.user.userId"
    :social-enabled="!socialAccessDenied"
    :notification-application="rootProps.notificationSummaryApplication"
    :support-application="rootProps.supportApplication"
    :friends-application="rootProps.socialFriendsApplication"
    :initial-peer="messagePeer"
    :initial-conversation-id="messageConversationId"
    @navigate="updateMessagesSection"
    @open-notification="openNotificationItem"
    @open-friends="openSocialFriendsPage"
    @open-conversation="openMessagesConversation"
    @close-conversation="closeMessagesConversation"
    @login="openPlayerEntry"
    @navigate-primary="navigatePrimary"
  />
  <main v-else-if="page === 'subhall'" :key="`subhall-${selectedGameKey}`" class="lobby-shell subhall-shell" :inert="roomFlowOpen">
    <header class="topbar">
      <button class="back-button" type="button" @click="returnToLobby">‹ 大厅</button>
      <div class="brand-copy"><strong>{{ activeSubhallGame?.title ?? '游戏厅' }}</strong><span>{{ activeSubhallGame?.description ?? '正在读取游戏厅内容…' }}</span></div>
      <button class="connection" :class="connection" type="button" :disabled="connection !== 'offline'" :aria-label="connection === 'offline' ? '服务离线，点击重新连接' : connection === 'online' ? '当前在线' : '正在检查服务'" @click="connection === 'offline' && checkService()"><span class="connection-dot"></span>{{ connection === 'online' ? '当前在线' : connection === 'offline' ? '离线练习可用 · 点击重连' : '正在检查服务' }}<span v-if="connection === 'offline'" class="connection-retry-mark">↻</span></button>
    </header>
    <PlatformAnnouncementBar :announcements="activeAnnouncements" @open="openAnnouncement" />
    <section class="subhall-heading">
      <div>
        <div class="eyebrow">{{ activeSubhallGame?.game.gameCode.toUpperCase() ?? 'GAME HALL' }} · GAME HALL</div>
        <h1>{{ activeSubhallGame?.title ?? '游戏厅' }}</h1>
        <p>{{ activeSubhallGame?.description }}</p>
      </div>
    </section>
    <details v-if="activeSubhallGame" class="subhall-rules" open>
      <summary>玩法介绍</summary>
      <div class="subhall-rule-grid">
        <p v-for="rule in activeSubhallGame.gameplay" :key="rule.title"><strong>{{ rule.title }}</strong>{{ rule.body }}</p>
      </div>
      <p class="game-experience-attribution">{{ activeSubhallGame.attribution }}</p>
    </details>
    <section v-if="activeSubhallGame" class="tier-grid tier-grid-horizontal" :class="{ 'guide-target': subhallGuideVisible }" :aria-label="`${activeSubhallGame.title}难度厅，可横向滚动`" tabindex="0">
      <button v-for="(tier, index) in activeSubhallGame.difficultyHalls" :key="tier.difficultyKey" class="tier-card" :class="[`tier-${['beginner', 'advanced', 'strategy'][index % 3]}`, { selected: selectedSubhallDifficulty === tier.difficultyKey }]" type="button" :disabled="!tier.enabled || subhallEntryBusy" @click="selectDifficulty(activeSubhallGame, tier, $event)">
        <span class="tier-symbol">{{ ['♣', '♦', '♠'][index % 3] }}</span><span class="tier-name">{{ tier.title }}</span><span class="tier-detail">{{ tier.summary }}</span>
        <span class="tier-metrics"><span>最低投入<strong>{{ tier.minBetCoins }} {{ activeSubhallGame.entryMode === 'LOCAL_PRACTICE' ? '练习分' : '金币' }}</strong></span><span>当前倍率<strong>{{ tier.currentMultiplier }}×</strong></span><span>最高倍率<strong>{{ tier.maxMultiplier }}×</strong></span></span>
        <strong class="tier-enter-label">{{ subhallEntryBusy && selectedSubhallDifficulty === tier.difficultyKey ? '正在检查…' : activeSubhallGame.entryMode === 'LOCAL_PRACTICE' ? '进入本地练习　›' : '检查游戏模块　›' }}</strong>
      </button>
    </section>
    <p v-if="subhallEntryFeedback" class="game-entry-feedback subhall-entry-feedback" role="status">{{ subhallEntryFeedback }}</p>
    <footer>{{ activeSubhallGame?.source === 'LOCAL_DEMO' ? '本地演示配置 · 难度与最低投入仅供页面交互验证' : '读取线上配置' }}</footer>
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
  <main v-else-if="page === 'history'" key="player-history" class="player-history-page">
    <header class="player-history-header">
      <button class="back-button" type="button" @click="returnFromHistory"><span aria-hidden="true">‹</span> 返回大厅</button>
      <div class="brand-lockup" aria-label="Lottery Game"><img class="brand-logo" :src="lotteryGameEmblem" alt="" /><span>LOTTERY <strong>GAME</strong></span></div>
      <span class="player-history-header-spacer" aria-hidden="true"></span>
    </header>
    <section class="player-history-content">
      <div class="eyebrow">ROUND HISTORY</div>
      <h1>战绩</h1>
      <p class="player-history-intro">查看已结算对局、牌局详情与资产变化。</p>
      <div class="player-history-toolbar" aria-label="战绩筛选">
        <div class="history-filter-control">
          <button type="button" class="history-filter-trigger" aria-haspopup="listbox" :aria-expanded="historyOpenFilter === 'game'" @click="historyOpenFilter = historyOpenFilter === 'game' ? null : 'game'">{{ historyGameLabel }}<span aria-hidden="true">⌄</span></button>
          <div v-if="historyOpenFilter === 'game'" class="history-filter-menu" role="listbox" aria-label="选择游戏">
            <button type="button" role="option" :aria-selected="historyGameFilter === 'ALL'" @click="historyGameFilter = 'ALL'; historyOpenFilter = null">全部游戏</button>
            <button v-for="game in lobbyGames" :key="game.game.gameKey" type="button" role="option" :aria-selected="historyGameFilter === game.game.gameKey" @click="historyGameFilter = game.game.gameKey; historyOpenFilter = null">{{ game.title }}</button>
          </div>
        </div>
        <div class="history-filter-control">
          <button type="button" class="history-filter-trigger" aria-haspopup="listbox" :aria-expanded="historyOpenFilter === 'range'" @click="historyOpenFilter = historyOpenFilter === 'range' ? null : 'range'">{{ historyRangeLabel }}<span aria-hidden="true">⌄</span></button>
          <div v-if="historyOpenFilter === 'range'" class="history-filter-menu" role="listbox" aria-label="选择时间范围">
            <button v-for="option in [{ value: '7_DAYS', label: '近 7 天' }, { value: '30_DAYS', label: '近 30 天' }, { value: '90_DAYS', label: '近 90 天' }, { value: 'ALL', label: '全部时间' }]" :key="option.value" type="button" role="option" :aria-selected="historyRangeFilter === option.value" @click="historyRangeFilter = option.value; historyOpenFilter = null">{{ option.label }}</button>
          </div>
        </div>
      </div>
      <section v-if="!rootProps.identitySessionState?.value" class="player-history-signin-card">
        <div class="history-empty-icon" aria-hidden="true">▤</div>
        <h2>登录后查看战绩</h2>
        <p>登录或恢复账号后，可以查看已结算的牌局记录。</p>
        <button type="button" class="history-signin-button" @click="openPlayerEntry">登录 / 恢复账号</button>
      </section>
      <section v-else class="player-history-empty-state">
        <div class="history-empty-icon" aria-hidden="true">▤</div>
        <h2>完成对局后，战绩会显示在这里</h2>
        <p>筛选：{{ historyGameLabel }} · {{ historyRangeLabel }}</p>
      </section>
    </section>
  </main>
  <PlayerEntryPage v-else-if="page === 'entry'" key="player-entry" :application="rootProps.playerEntryApplication ?? localPlayerEntryApplication" :emblem="lotteryGameEmblem" :create-dev-fixture="rootProps.devFixture" @back="returnFromEntry" />
  <main v-else-if="page === 'practice'" class="practice-shell" :key="`practice-${practiceTier}`" :style="{ backgroundImage: `linear-gradient(180deg, rgba(3, 22, 19, .45), rgba(3, 22, 19, .76)), url('${shisanshuiSubhallBackground}')` }">
    <div ref="gameRoot" class="pixi-host"></div>
    <div v-if="gameError" class="game-error">
      <p>{{ gameError }}</p>
      <div class="game-error-actions"><button type="button" @click="retryPractice">重试加载</button><button type="button" @click="leavePractice">返回上一页</button></div>
    </div>
  </main>
    <Transition name="game-loading">
      <div v-if="gameLoading" class="game-loading" role="status" aria-live="polite" :data-game="gameLoadingExperience?.game.gameCode ?? 'shisanshui'">
        <div class="game-loading-backdrop" aria-hidden="true" :style="{ backgroundImage: `url('${gameLoadingExperience?.subhallBackgroundUrl ?? shisanshuiSubhallBackground}')` }"></div>
        <section class="game-loading-card" :aria-label="`${gameLoadingExperience?.title ?? '十三张'}加载进度`">
          <div class="game-loading-orbit" aria-hidden="true"><span></span></div>
          <p class="game-loading-title">{{ gameLoadingStage }}</p>
          <div class="game-load-steps" aria-hidden="true">
            <span v-for="(label, index) in ['载入程序', '初始化画面', '准备牌局']" :key="label" :class="{ done: gameLoadingPhase > index + 1, current: gameLoadingPhase === index + 1 }">{{ label }}</span>
          </div>
          <div class="game-load-track" role="progressbar" aria-label="正在加载游戏" aria-valuetext="加载中"><span></span></div>
          <small>已等待 {{ gameLoadingSeconds }} 秒 · 首次进入需要准备游戏资源</small>
          <p v-if="gameLoadingSeconds >= 12" class="game-load-slow">加载时间比平时长，你可以继续等待，或返回上一页。</p>
          <button v-if="gameLoadingSeconds >= 12" type="button" @click="leavePractice">返回上一页</button>
        </section>
      </div>
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

    <Transition name="sheet" :css="page === 'lobby' && !primaryNavigationInProgress">
    <div v-if="lobbyPanel && (page === 'lobby' || page === 'wallet' || page === 'profile')" class="panel-scrim" :class="{ 'player-primary-page-scrim': page !== 'lobby' }" @click.self="page === 'lobby' && closeLobbyPanel()">
      <section ref="lobbyPanelElement" class="lobby-panel" :class="{ 'player-primary-page-panel': page !== 'lobby' }" :role="page === 'lobby' ? 'dialog' : 'main'" :aria-modal="page === 'lobby' ? 'true' : undefined" :inert="playerHelpTopic !== null" :aria-labelledby="`panel-title-${lobbyPanel}`" @keydown="handleLobbyPanelKeydown">
        <button v-if="page === 'lobby' || (page === 'profile' && lobbyPanel === 'settings')" ref="lobbyPanelCloseButton" class="panel-close" type="button" :aria-label="lobbyPanel === 'settings' ? '关闭设置' : '关闭'" @click="lobbyPanel === 'settings' ? closeSettingsPanel() : closeLobbyPanel()">×</button>
        <template v-if="lobbyPanel === 'settings'">
          <div class="eyebrow">PREFERENCES</div><h2 :id="`panel-title-${lobbyPanel}`">设置</h2>
          <p>偏好设置保存在当前浏览器。</p>
          <label class="setting-row"><span><strong>牌桌音效</strong><small>控制十三张练习牌桌的操作与结算音效</small></span><input type="checkbox" :checked="soundEnabled" @change="savePreference(ClientPreferenceKey.SOUND_ENABLED, ($event.target as HTMLInputElement).checked)" /></label>
          <label class="setting-row"><span><strong>低流量模式</strong><small>关闭动态封面，减少装饰动效资源下载</small></span><input type="checkbox" :checked="lowDataMode" @change="savePreference(ClientPreferenceKey.LOW_DATA_MODE, ($event.target as HTMLInputElement).checked)" /></label>
          <p v-if="preferenceError" class="setting-error" role="alert">{{ preferenceError }}</p>
          <button class="guide-replay" type="button" @click="startHallGuide">重新播放大厅引导</button>
          <section v-if="rootProps.identitySessionState?.value" class="settings-account-actions" aria-label="账号操作">
            <div><strong>账号</strong><small>退出后可重新登录此账号</small></div>
            <button type="button" class="settings-logout" @click="logoutPlayer">退出当前账号</button>
          </section>
          <p v-if="identityActionError" class="setting-error" role="alert">{{ identityActionError }}</p>
        </template>
        <template v-else-if="lobbyPanel === 'wallet'">
          <div class="eyebrow">PLAYER WALLET</div><div class="player-wallet-page-heading"><button v-if="walletSection !== 'home'" type="button" class="wallet-back" @click="walletSection = 'home'">‹ 钱包</button><div class="panel-title-row"><h2 :id="`panel-title-${lobbyPanel}`">{{ walletSectionTitles[walletSection] }}</h2><button v-if="walletSection === 'home'" class="panel-help-trigger" type="button" aria-label="查看钱包规则" aria-haspopup="dialog" @click="openPlayerHelp('wallet', $event)">?</button><div v-if="walletSection === 'withdraw'" class="wallet-page-heading-actions"><button type="button" class="wallet-history-link" @click="walletSection = 'withdrawals'">提现记录</button><button type="button" class="wallet-history-link" @click="walletSection = 'accounts'">收款账户设置</button></div></div></div>
          <p v-if="walletSection === 'home'">金币与人民币余额分账显示。</p>
          <div v-if="walletSection === 'home'" class="player-wallet-home">
          <div class="player-wallet-assets">
            <article><div><span>游戏资产</span><b>金币</b></div><strong>{{ walletSummaryLoading ? '读取中…' : rootProps.identitySessionState?.value ? `${walletSummary?.assets[0]?.availableAmount ?? '0'} 可用` : '登录后查看' }}</strong><small v-if="rootProps.identitySessionState?.value">冻结 {{ walletSummary?.assets[0]?.frozenAmount ?? '0' }} · 总额 {{ walletSummary?.assets[0]?.amount ?? '0' }}</small><small v-else>可用 / 冻结</small><button v-if="rootProps.identitySessionState?.value" class="wallet-asset-action" type="button" @click="walletSection = 'transfer'">金币转账 <span aria-hidden="true">›</span></button></article>
            <article><div><span>可提现资产</span><b>余额 · CNY</b></div><strong>{{ walletSummaryLoading ? '读取中…' : rootProps.identitySessionState?.value ? `¥${formatFen(walletSummary?.assets[1]?.availableAmount ?? '0')}` : '登录后查看' }}</strong><small v-if="rootProps.identitySessionState?.value">冻结 ¥{{ formatFen(walletSummary?.assets[1]?.frozenAmount ?? '0') }} · 总额 ¥{{ formatFen(walletSummary?.assets[1]?.amount ?? '0') }}</small><small v-else>可用 / 冻结</small><button v-if="rootProps.identitySessionState?.value" class="wallet-asset-action" type="button" @click="walletSection = 'withdraw'">申请提现 <span aria-hidden="true">›</span></button></article>
          </div>
          <p v-if="walletSummaryError" role="alert">{{ walletSummaryError }}</p>
          <button v-if="!rootProps.identitySessionState?.value" class="panel-primary" type="button" @click="openPlayerEntry">登录后查看钱包</button>
          <nav v-if="rootProps.identitySessionState?.value" class="player-wallet-menu" aria-label="钱包功能">
            <button v-for="item in ([['activity','资产明细','查看金币与余额流水'],['funding','购买金币','选择充值方式并创建订单'],['orders','最近订单','查看充值订单与支付状态'],['exchange','兑换余额','金币换为人民币余额'],['accounts','提现账号管理','管理收款账户']] as const)" :key="item[0]" type="button" @click="walletSection = item[0]"><span><strong>{{ item[1] }}</strong><small>{{ item[2] }}</small></span><span aria-hidden="true">›</span></button>
          </nav>
          </div>
          <section v-if="walletSection === 'activity' && rootProps.identitySessionState?.value && walletActivityLoading" class="player-wallet-activity" aria-label="资产明细" aria-busy="true"><h3>资产明细</h3><p>正在读取账本记录…</p></section>
          <section v-else-if="walletSection === 'activity' && rootProps.identitySessionState?.value" class="player-wallet-activity" aria-label="资产明细"><h3>资产明细</h3>
            <p v-if="walletActivityError" role="alert">{{ walletActivityError }} <button type="button" @click="reloadWallet">重试</button></p>
            <p v-else-if="!walletActivity?.items.length" class="player-wallet-activity-empty">暂无资产记录</p>
            <ol v-else><li v-for="item in walletActivity.items" :key="item.entryId"><span class="wallet-activity-mark" :class="{ negative: item.delta.startsWith('-') }">{{ item.delta.startsWith('-') ? '−' : '+' }}</span><div><strong>{{ walletActivityTitle(item) }} · {{ item.currency === 'COIN' ? '金币' : '余额' }}</strong><small>{{ item.counterpartyLabel ? `对方：${item.counterpartyLabel} · ` : '' }}{{ item.activityType === WalletActivityType.TRANSFER_SENT ? `本金 ${item.transferCoins} · 手续费 ${item.feeCoins} · ` : '' }}{{ item.activityType === WalletActivityType.CURRENCY_EXCHANGE ? `兑换 ${item.exchangeCoins} 金币 · ` : '' }}{{ walletActivityTime(item.occurredAt) }} · {{ item.frozenDelta !== undefined ? `冻结变化 ${item.frozenDelta} · ` : '' }}余额 {{ item.currency === 'CNY' ? `¥${formatFen(item.balanceAfter)}` : `${item.balanceAfter} 金币` }}</small></div><b :class="{ negative: item.delta.startsWith('-') }">{{ walletActivityAmount(item) }}</b></li></ol>
            <p v-if="walletActivityMoreError" role="alert">{{ walletActivityMoreError }} <button type="button" @click="loadMoreWalletActivity">重试</button></p>
            <button v-if="walletActivity?.nextCursor" class="wallet-activity-more" type="button" :disabled="walletActivityMoreLoading" @click="loadMoreWalletActivity">{{ walletActivityMoreLoading ? '正在读取…' : '加载更早记录' }}</button>
          </section>
          <component :is="DevelopmentWalletFundingWorkspace" v-if="rootProps.identitySessionState?.value && rootProps.walletFundingApplication && DevelopmentWalletFundingWorkspace && ['funding','orders'].includes(walletSection)" :application="rootProps.walletFundingApplication" :view="walletSection === 'orders' ? 'orders' : 'purchase'" @completed="reloadWallet" @contact-support="openMessagesPage('support')" />
          <PlayerWalletTransferWorkspace v-if="walletSection === 'transfer' && rootProps.identitySessionState?.value && rootProps.walletApplication && rootProps.socialFriendsApplication" :wallet="rootProps.walletApplication" :friends="rootProps.socialFriendsApplication" :can-transfer="walletSummary?.turnover.canTransferOrWithdraw ?? false" :turnover-remaining="walletSummary?.turnover.remainingCoins ?? '—'" :available-coins="walletSummary?.assets[0]?.availableAmount ?? '0'" @completed="reloadWallet" />
          <PlayerWalletExchangeWorkspace v-if="walletSection === 'exchange' && rootProps.identitySessionState?.value && rootProps.walletApplication" :wallet="rootProps.walletApplication" :can-exchange="walletSummary?.turnover.canTransferOrWithdraw ?? false" :turnover-remaining="walletSummary?.turnover.remainingCoins ?? '—'" :available-coins="walletSummary?.assets[0]?.availableAmount ?? '0'" @completed="reloadWallet" />
          <PlayerWalletWithdrawalWorkspace v-if="['withdraw','withdrawals','accounts'].includes(walletSection) && rootProps.identitySessionState?.value && rootProps.walletApplication" :wallet="rootProps.walletApplication" :view="walletSection === 'withdrawals' ? 'history' : walletSection === 'accounts' ? 'accounts' : 'withdraw'" :turnover-remaining="walletSummary?.turnover.remainingCoins ?? '—'" :available-cny-fen="walletSummary?.assets[1]?.availableAmount ?? '0'" @completed="reloadWallet" @manage-accounts="walletSection = 'accounts'" />
          <p v-if="walletSection !== 'home' && !rootProps.identitySessionState?.value" class="player-panel-empty">请先登录后使用钱包功能。</p>
        </template>
        <template v-else-if="lobbyPanel === 'invite'">
          <div class="eyebrow">INVITATION & AGENT</div><div class="panel-title-row"><h2 :id="`panel-title-${lobbyPanel}`">邀请与代理</h2><button class="panel-help-trigger" type="button" aria-label="查看邀请与返佣说明" aria-haspopup="dialog" @click="openPlayerHelp('invite', $event)">?</button></div>
          <p>邀请归因由平台服务确认；已绑定用户只能由 Admin 换绑，客户端不能修改上级。</p>
          <PlayerInviteAgentWorkspace :application="rootProps.inviteAgentApplication" :authenticated="Boolean(rootProps.identitySessionState?.value)" />
        </template>
        <template v-else-if="lobbyPanel === 'gameRules'">
          <div class="eyebrow">{{ activeRulesGame?.game.gameCode.toUpperCase() ?? 'GAME' }} · HOW TO PLAY</div><h2 :id="`panel-title-${lobbyPanel}`">{{ activeRulesGame?.title ?? '玩法说明' }}</h2>
          <div class="full-game-rules">
            <p v-for="rule in activeRulesGame?.gameplay ?? []" :key="rule.title"><strong>{{ rule.title }}</strong>{{ rule.body }}</p>
            <p class="panel-note">{{ activeRulesGame?.attribution }}</p>
          </div>
        </template>
        <template v-else-if="lobbyPanel === 'profile'">
          <div class="eyebrow">PLAYER ACCOUNT</div><h2 :id="`panel-title-${lobbyPanel}`">我的</h2>
          <p>查看个人资料，管理登录凭证与账号安全。</p>
          <section class="player-profile-card" aria-label="个人资料与账号安全">
            <div class="player-profile-overview">
              <div class="player-profile-avatar" aria-hidden="true">{{ rootProps.identitySessionState?.value?.user.displayName.slice(-1) ?? '?' }}</div>
              <div class="player-profile-identity">
                <strong>{{ rootProps.identitySessionState?.value?.user.displayName ?? '游客' }}</strong>
                <div v-if="rootProps.identitySessionState?.value" class="profile-account-id-row">
                  <small>账号 ID {{ rootProps.identitySessionState.value.user.userId }}</small>
                  <button type="button" class="profile-inline-icon" aria-label="复制账号 ID" title="复制账号 ID" @click="copyProfileUserId"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="10" height="11" rx="2"/><path d="M13 6V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h2"/></svg></button>
                  <button type="button" class="profile-inline-icon" aria-label="显示我的平台二维码" title="我的平台二维码" @click="openProfileUserQr"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 2h6v6H2zM12 2h6v6h-6zM2 12h6v6H2zM12 12h2v2h-2zM16 12h2v2h-2zM12 16h2v2h-2zM16 16h2v2h-2z" fill="currentColor"/><path d="M4 4h2v2H4zM14 4h2v2h-2zM4 14h2v2H4z" fill="#17231e"/></svg></button>
                </div>
                <small v-else>登录后同步账号资料</small>
                <small v-if="profileUserActionMessage" class="profile-account-feedback" role="status">{{ profileUserActionMessage }}</small>
              </div>
              <span class="profile-session-status">{{ rootProps.identitySessionState?.value ? '已登录' : '访客模式' }}</span>
            </div>
            <div class="player-profile-fields" aria-live="polite">
              <div class="player-profile-field" data-profile-field="username"><span>用户名</span><div class="player-profile-field-value"><strong>{{ identitySettingsLoading ? '读取中…' : identitySettings?.username ?? (rootProps.identitySessionState?.value ? '未设置' : '登录后查看') }}</strong><button type="button" class="profile-inline-icon profile-edit-icon" aria-label="编辑用户名" @click="editProfileField('username')"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m3 14.5-.7 3.2 3.2-.7L16.8 6.7a2.1 2.1 0 0 0-3-3L3 14.5Z"/><path d="m12.5 5 3 3"/></svg></button></div></div>
              <div class="player-profile-field" data-profile-field="email"><span>邮箱</span><div class="player-profile-field-value"><strong>{{ identitySettingsLoading ? '读取中…' : identitySettings?.email?.maskedValue ?? (rootProps.identitySessionState?.value ? '未绑定' : '登录后查看') }}<small v-if="identitySettings?.email">已绑定</small></strong><button type="button" class="profile-inline-icon profile-edit-icon" :aria-label="identitySettings?.email ? '更换邮箱' : '绑定邮箱'" @click="editProfileField('email')"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m3 14.5-.7 3.2 3.2-.7L16.8 6.7a2.1 2.1 0 0 0-3-3L3 14.5Z"/><path d="m12.5 5 3 3"/></svg></button></div></div>
              <div class="player-profile-field" data-profile-field="phone"><span>手机</span><div class="player-profile-field-value"><strong>{{ identitySettingsLoading ? '读取中…' : identitySettings?.phone?.maskedValue ?? (rootProps.identitySessionState?.value ? '未绑定' : '登录后查看') }}<small v-if="identitySettings?.phone">已绑定</small></strong><button type="button" class="profile-inline-icon profile-edit-icon" :aria-label="identitySettings?.phone ? '更换手机' : '绑定手机'" @click="editProfileField('phone')"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m3 14.5-.7 3.2 3.2-.7L16.8 6.7a2.1 2.1 0 0 0-3-3L3 14.5Z"/><path d="m12.5 5 3 3"/></svg></button></div></div>
              <div class="player-profile-field" data-profile-field="password"><span>登录密码</span><div class="player-profile-field-value"><strong>{{ identitySettingsLoading ? '读取中…' : identitySettings?.passwordConfigured ? '已设置' : rootProps.identitySessionState?.value ? '尚未设置' : '登录后查看' }}</strong><button v-if="rootProps.identitySessionState?.value" type="button" class="profile-inline-icon profile-edit-icon" :aria-label="identitySettings?.passwordConfigured ? '修改登录密码' : '设置登录密码'" @click="openIdentityCredentialForm('password')"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m3 14.5-.7 3.2 3.2-.7L16.8 6.7a2.1 2.1 0 0 0-3-3L3 14.5Z"/><path d="m12.5 5 3 3"/></svg></button><button v-else type="button" class="profile-inline-icon profile-edit-icon" aria-label="登录后管理密码" @click="openPlayerEntry"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m3 14.5-.7 3.2 3.2-.7L16.8 6.7a2.1 2.1 0 0 0-3-3L3 14.5Z"/><path d="m12.5 5 3 3"/></svg></button></div></div>
              <div class="player-profile-field" data-profile-field="totp"><span>两步验证</span><div class="player-profile-field-value"><strong>{{ !rootProps.identitySessionState?.value ? '登录后查看' : identitySettingsLoading ? '正在读取…' : identitySettings?.totpEnabled ? '已开启' : '未开启' }}<small v-if="rootProps.identitySessionState?.value && identitySettings && !identitySettingsLoading">恢复二维码 {{ identitySettings.recoveryCredential.available ? '有效' : '未设置' }}</small></strong><button type="button" class="profile-inline-icon profile-edit-icon" :aria-label="rootProps.identitySessionState?.value ? '管理两步验证' : '登录后管理两步验证'" @click="rootProps.identitySessionState?.value ? openSecurityManagement() : openPlayerEntry()"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 16 5v4.7c0 3.8-2.4 6.2-6 7.8-3.6-1.6-6-4-6-7.8V5l6-2.5Z"/><path d="m7.5 9.8 1.7 1.7 3.5-3.7"/></svg></button></div></div>
            </div>
          </section>
          <Teleport to="body"><div v-if="profileUserQrOpen" class="profile-user-qr-overlay" role="presentation" @click.self="profileUserQrOpen = false"><section class="profile-user-qr-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-user-qr-title"><header><div><small>牌友主页</small><h2 id="profile-user-qr-title">我的平台二维码</h2></div><button type="button" aria-label="关闭二维码" @click="profileUserQrOpen = false">×</button></header><img :src="profileUserQrImage" alt="扫描二维码访问我的公开主页"><strong>{{ profileUserQrCode }}</strong><p>扫码可打开你的公开主页</p></section></div></Teleport>
          <p v-if="identityCredentialMessage && !securityManagementOpen && !identityCredentialForm && !identityContactForm" class="setting-success" role="status">{{ identityCredentialMessage }}</p>
          <Teleport to="body">
          <div v-if="(page === 'lobby' || page === 'profile') && lobbyPanel === 'profile' && securityManagementOpen" class="identity-subdialog-scrim" @click.self="closeSecurityManagement">
            <section class="identity-subdialog identity-security-dialog" role="dialog" aria-modal="true" aria-labelledby="identity-security-title" @keydown="handleIdentityDialogKeydown">
              <header class="identity-security-sticky-header">
                <button class="panel-close" type="button" aria-label="关闭安全管理" @click="closeSecurityManagement">×</button>
                <div class="eyebrow">ACCOUNT SECURITY</div><h2 id="identity-security-title">安全管理</h2>
                <p class="identity-security-intro">集中管理两步验证、备用恢复码和账号恢复二维码。平台不会重置 TOTP。</p>
              </header>
              <template v-if="identitySettings?.passwordConfigured">
          <section class="identity-totp-settings" aria-label="两步验证设置">
            <h3>两步验证</h3>
            <p v-if="!identitySettings.totpEnabled">启用验证器后，登录和敏感账号操作需要 TOTP。丢失验证器且没有备用恢复码时，请联系客服人工处理，平台不提供重置。</p>
            <form v-if="!identitySettings.totpEnabled && !totpSetup && !totpRecoveryCodes.length" class="identity-credential-form" @submit.prevent="startTotpSetup">
              <label>当前密码<input v-model="totpSetupPassword" name="totp-setup-password" type="password" autocomplete="current-password" required></label>
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
          <section v-if="rootProps.identitySessionState?.value" class="identity-totp-settings" aria-label="恢复二维码管理">
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
              </template>
              <div v-else class="identity-security-password-gate"><p class="panel-note">设置账号密码后即可启用 TOTP，并管理恢复二维码。</p><button class="panel-primary" type="button" @click="openPasswordSetupFromSecurity">先设置登录密码</button></div>
              <p v-if="identityCredentialError" class="setting-error" role="alert">{{ identityCredentialError }}</p>
              <p v-if="identityCredentialMessage" class="setting-success" role="status">{{ identityCredentialMessage }}</p>
            </section>
          </div>
          </Teleport>
          <Teleport to="body">
          <div v-if="(page === 'lobby' || page === 'profile') && lobbyPanel === 'profile' && (identityContactForm || identityCredentialForm)" class="identity-subdialog-scrim" @click.self="closeIdentityCredentialDialog()">
            <section class="identity-subdialog" role="dialog" aria-modal="true" :aria-label="identityContactForm ? '联系方式管理' : identityCredentialForm === 'password' ? '密码管理' : '用户名管理'" @keydown="handleIdentityDialogKeydown">
              <button class="panel-close" type="button" aria-label="关闭" @click="closeIdentityCredentialDialog()">×</button>
          <form v-if="identityContactForm" class="identity-credential-form" @submit.prevent="identityContactForm === 'PHONE' ? saveIdentityPhone() : saveIdentityEmail()">
            <h3>{{ identityContactForm === 'EMAIL' ? (identitySettings?.email ? '更换邮箱' : '绑定邮箱') : (identitySettings?.phone ? '更换手机' : '绑定手机') }}</h3>
            <p v-if="identityContactForm === 'EMAIL' && identitySettings?.email">当前邮箱：{{ identitySettings.email.maskedValue }}。请输入完整原邮箱确认换绑。</p>
            <p v-if="identityContactForm === 'PHONE' && identitySettings?.phone">要更换的手机号当前尾数为 {{ identitySettings.phone.maskedValue.slice(-3) }}，请输入完整原手机号以确认。</p>
            <label v-if="identityContactForm === 'EMAIL' && identitySettings?.email">原邮箱<input v-model="identityContactCurrentEmail" name="current-email" type="email" autocomplete="email" required></label>
            <label v-if="identityContactForm === 'PHONE' && identitySettings?.phone">原手机号<input v-model="identityContactCurrentPhone" name="current-phone" type="tel" autocomplete="tel" required></label>
            <label>{{ identityContactForm === 'EMAIL' ? '新邮箱' : '手机号' }}<input v-model="identityContactDraft" :type="identityContactForm === 'EMAIL' ? 'email' : 'tel'" :name="identityContactForm === 'EMAIL' ? 'new-email' : 'new-phone'" :autocomplete="identityContactForm === 'EMAIL' ? 'email' : 'tel'" required></label>
            <label v-if="identitySettings?.passwordConfigured">当前密码<input v-model="identityContactCurrentPassword" name="contact-current-password" type="password" autocomplete="current-password" required></label>
            <label v-if="identitySettings?.totpEnabled">当前 TOTP<input v-model="identityContactTotpDraft" name="contact-totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label>
            <button class="panel-primary" type="submit" :disabled="identityContactSending">{{ identityContactSending ? '正在保存…' : identityContactForm === 'EMAIL' ? (identitySettings?.email ? '确认更换邮箱' : '绑定邮箱') : (identitySettings?.phone ? '确认更换手机号' : '绑定手机号') }}</button>
            <button type="button" @click="closeIdentityCredentialDialog()">取消</button>
          </form>
          <form v-if="identityCredentialForm === 'username'" class="identity-credential-form" @submit.prevent="submitUsernameChange">
            <h3>{{ identitySettings?.username ? '修改用户名' : '设置用户名' }}</h3>
            <label>用户名<input v-model="usernameDraft" name="username" autocomplete="username" minlength="3" maxlength="32" required></label>
            <label>当前密码<input v-model="usernameCurrentPassword" name="current-password" type="password" autocomplete="current-password" required></label>
            <label v-if="identitySettings?.totpEnabled">当前 TOTP<input v-model="identityCredentialTotpDraft" name="username-totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label>
            <p>以后可使用新用户名和原密码登录。</p>
            <button class="panel-primary" type="submit" :disabled="identityCredentialSaving">{{ identityCredentialSaving ? '正在保存…' : '保存用户名' }}</button>
            <button type="button" @click="closeIdentityCredentialDialog()">取消</button>
          </form>
          <form v-else-if="identityCredentialForm === 'password'" class="identity-credential-form" @submit.prevent="submitPasswordChange">
            <h3>{{ identitySettings?.passwordConfigured ? '修改密码' : '设置密码' }}</h3>
            <label v-if="identitySettings?.passwordConfigured">当前密码<input v-model="passwordCurrentDraft" name="current-password" type="password" autocomplete="current-password" required></label>
            <label v-if="identitySettings?.totpEnabled">当前 TOTP<input v-model="identityCredentialTotpDraft" name="password-totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label>
            <label>新密码<input v-model="passwordNewDraft" name="new-password" type="password" autocomplete="new-password" minlength="8" maxlength="256" required></label>
            <label>确认新密码<input v-model="passwordConfirmDraft" name="confirm-password" type="password" autocomplete="new-password" minlength="8" maxlength="256" required></label>
            <p>{{ identitySettings?.passwordConfigured ? '至少 8 位。保存后，其他设备上的登录会话会退出。' : '至少 8 位。使用当前已登录设备完成首次设置。' }}</p>
            <button class="panel-primary" type="submit" :disabled="identityCredentialSaving">{{ identityCredentialSaving ? '正在保存…' : '更新密码' }}</button>
            <button type="button" @click="closeIdentityCredentialDialog()">取消</button>
          </form>
          <p v-if="identityCredentialError" class="setting-error" role="alert">{{ identityCredentialError }}</p>
              <p v-if="identityCredentialMessage" class="setting-success" role="status">{{ identityCredentialMessage }}</p>
            </section>
          </div>
          </Teleport>
          <div class="profile-shortcuts" aria-label="更多大厅功能">
            <button type="button" @click="openHistoryPage">战绩</button>
            <button type="button" @click="openLobbyPanel('invite')">邀请与代理</button>
            <button type="button" @click="openMessagesPage('all')">消息</button>
            <button type="button" @click="openLobbyPanel('settings')">设置</button>
          </div>
          <button v-if="!rootProps.identitySessionState?.value" class="panel-primary" type="button" @click="openPlayerEntry">登录 / 账号恢复</button>
        </template>
      </section>
    </div>
    </Transition>
    <PlayerPrimaryNavigation
      v-if="!messageConversationId && page !== 'subhall' && page !== 'practice'"
      :active="activePrimaryDestination"
      :social-disabled="socialAccessDenied"
      :message-badge-count="messageBadgeCount"
      :social-badge-count="socialNewPostCount"
      :lobby="page === 'lobby'"
      :page-overlay="page === 'wallet' || page === 'profile'"
      :guide-target="page === 'lobby' && hallGuideStep === 3 && !isDesktopLayout"
      @navigate="navigatePrimary"
    />
    <div v-if="(page === 'lobby' || page === 'wallet') && lobbyPanel && playerHelpTopic" class="player-help-scrim" @click.self="closePlayerHelp">
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
