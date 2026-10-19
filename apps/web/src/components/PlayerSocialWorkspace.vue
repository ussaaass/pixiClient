<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { CreateSocialPostReplyRequestDto, CreateSocialPostRequestDto, SocialContentActionRequestDto, SocialContentActionStateDto, SocialPostDto, SocialPostReplyDto, SocialTopicDto } from '@gameing/contracts/social';
import type { SocialApplication } from '../platform/social/social-application';
import PlayerSocialShareCard, { type SocialShareCardData } from './PlayerSocialShareCard.vue';
import PlayerAppSelect from './PlayerAppSelect.vue';

const props = defineProps<{ application: SocialApplication; postId?: string | undefined }>();
const emit = defineEmits<{ openPost: [postId: string]; openProfile: [profileKey: string]; backToForum: [] }>();
const topics = ref<SocialTopicDto[]>([]);
const selectedTopicKey = ref('');
const requestedTopicKey = ref('');
const posts = ref<SocialPostDto[]>([]);
const feedPostsByTopic = new Map<string, SocialPostDto[]>();
const replies = reactive<Record<string, SocialPostReplyDto[]>>({});
const expandedPostIds = ref(new Set<string>());
const replyDrafts = reactive<Record<string, string>>({});
const postDrafts = reactive<Record<string, { title: string; body: string }>>({});
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const composerOpen = ref(false);
const replyOpenPostId = ref<string | null>(null);
const moreTarget = ref<{ resourceType: 'POST' | 'REPLY'; resourceId: string; title: string; authorLabel: string; isOwn: boolean } | null>(null);
const actionStates = reactive<Record<string, SocialContentActionStateDto>>({});
const reportMode = ref(false);
const reportReason = ref<'SPAM' | 'ABUSE' | 'FRAUD' | 'SEXUAL_CONTENT' | 'OTHER'>('SPAM');
const reportReasonOptions = [
  { value: 'SPAM', label: '垃圾广告' }, { value: 'ABUSE', label: '辱骂骚扰' },
  { value: 'FRAUD', label: '诈骗或诱导转账' }, { value: 'SEXUAL_CONTENT', label: '色情或不适内容' }, { value: 'OTHER', label: '其他违规内容' },
] as const;
const reportDetails = ref('');
const actionFeedback = ref('');
const postTitle = ref('');
const postBody = ref('');
const shareData = ref<SocialShareCardData>();
const selectedTopic = computed(() => topics.value.find((topic) => topic.topicKey === selectedTopicKey.value) ?? null);
const visiblePosts = computed(() => props.postId ? posts.value.filter((post) => post.postId === props.postId) : posts.value);
let postDetailRequestId = 0;

const failureCopy: Record<string, string> = {
  INVALID_REQUEST: '内容格式不符合要求，请修改后重试。',
  AUTHENTICATION_REQUIRED: '登录状态已失效，请重新登录后继续。',
  TOPIC_NOT_FOUND: '这个话题暂不可用，请重新选择。',
  TITLE_REQUIRED: '请填写帖子标题。',
  BODY_REQUIRED: '请填写内容。',
  POST_NOT_FOUND: '帖子已不可用，请刷新列表。',
  REPLY_NOT_FOUND: '回复目标已不可用，请刷新后重试。',
  REPLY_DEPTH_EXCEEDED: '回复最多嵌套一级，请直接回复帖子或上一层。',
};

async function loadTopics(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await props.application.listTopics();
    if (!result.ok) {
      error.value = failureCopy[result.code] ?? '操作失败，请重试。';
      return;
    }
    topics.value = result.value;
    if (props.postId) {
      await loadPostDetail(props.postId);
      return;
    }
    selectedTopicKey.value ||= result.value[0]?.topicKey ?? '';
    if (!selectedTopicKey.value) error.value = '当前没有可浏览的话题。';
    else {
      await loadPosts();
      const selectedPost = visiblePosts.value[0];
      if (selectedPost) await toggleReplies(selectedPost);
    }
  } catch {
    error.value = '本地话题暂时无法读取，请重试。';
  } finally {
    loading.value = false;
  }
}

async function loadPosts(key = selectedTopicKey.value, options: { commit?: boolean; indicateLoading?: boolean } = {}): Promise<SocialPostDto[] | null> {
  if (!key) return null;
  const commit = options.commit ?? true;
  const indicateLoading = options.indicateLoading ?? true;
  if (indicateLoading) loading.value = true;
  error.value = '';
  try {
    const result = await props.application.listPosts(key);
    if (!result.ok) {
      error.value = failureCopy[result.code] ?? '操作失败，请重试。';
      return null;
    }
    if (commit) {
      posts.value = result.value;
      feedPostsByTopic.set(key, result.value);
    }
    await Promise.all(result.value.map(async (post) => {
      const state = await props.application.contentActionState('POST', post.postId);
      if (state.ok) actionStates[`POST:${post.postId}`] = state.value;
    }));
    return result.value;
  } catch {
    error.value = '本地帖子暂时无法读取，请重试。';
    return null;
  } finally {
    if (indicateLoading) loading.value = false;
  }
}

async function loadPostDetail(postId: string): Promise<void> {
  const requestId = ++postDetailRequestId;
  loading.value = true;
  error.value = '';
  try {
    const result = await props.application.getPost(postId);
    if (requestId !== postDetailRequestId) return;
    if (!result.ok) {
      error.value = failureCopy[result.code] ?? '这个帖子暂时无法查看。';
      posts.value = [];
      return;
    }
    posts.value = [result.value];
    selectedTopicKey.value = result.value.topicKey;
    const state = await props.application.contentActionState('POST', result.value.postId);
    if (state.ok) actionStates[`POST:${result.value.postId}`] = state.value;
    if (requestId === postDetailRequestId) await toggleReplies(result.value);
  } catch {
    if (requestId === postDetailRequestId) error.value = '帖子详情暂时无法读取，请重试。';
  } finally {
    if (requestId === postDetailRequestId) loading.value = false;
  }
}

async function selectTopic(topicKey: string): Promise<void> {
  if (topicKey === selectedTopicKey.value || requestedTopicKey.value) return;
  if (selectedTopicKey.value && (composerOpen.value || postTitle.value || postBody.value || postDrafts[selectedTopicKey.value])) {
    postDrafts[selectedTopicKey.value] = { title: postTitle.value, body: postBody.value };
  }
  requestedTopicKey.value = topicKey;
  try {
    const nextPosts = await loadPosts(topicKey, { commit: false, indicateLoading: false });
    if (!nextPosts) return;
    posts.value = nextPosts;
    feedPostsByTopic.set(topicKey, nextPosts);
    selectedTopicKey.value = topicKey;
    composerOpen.value = false;
    replyOpenPostId.value = null;
    postTitle.value = postDrafts[topicKey]?.title ?? '';
    postBody.value = postDrafts[topicKey]?.body ?? '';
  } finally {
    requestedTopicKey.value = '';
  }
}

async function submitPost(): Promise<void> {
  if (saving.value || !selectedTopic.value) return;
  saving.value = true;
  error.value = '';
  const request: CreateSocialPostRequestDto = { topicKey: selectedTopic.value.topicKey, title: postTitle.value, body: postBody.value };
  try {
    const result = await props.application.createPost(request);
    if (!result.ok) {
      error.value = failureCopy[result.code] ?? '操作失败，请重试。';
      return;
    }
    posts.value = [result.value, ...posts.value];
    delete postDrafts[selectedTopic.value.topicKey];
    postTitle.value = '';
    postBody.value = '';
    composerOpen.value = false;
  } catch {
    error.value = '帖子没有保存，请保留内容后重试。';
  } finally {
    saving.value = false;
  }
}

async function toggleReplies(post: SocialPostDto): Promise<void> {
  error.value = '';
  const expanded = new Set(expandedPostIds.value);
  if (expanded.has(post.postId)) {
    expanded.delete(post.postId);
    expandedPostIds.value = expanded;
    replyOpenPostId.value = null;
    return;
  }
  try {
    const result = await props.application.listReplies(post.postId);
    if (!result.ok) {
      error.value = failureCopy[result.code] ?? '操作失败，请重试。';
      return;
    }
    replies[post.postId] = result.value;
    await Promise.all(result.value.map(async (reply) => {
      const state = await props.application.contentActionState('REPLY', reply.replyId);
      if (state.ok) actionStates[`REPLY:${reply.replyId}`] = state.value;
    }));
    expanded.add(post.postId);
    expandedPostIds.value = expanded;
  } catch {
    error.value = '回复暂时无法读取，请重试。';
  }
}

function openMore(resourceType: 'POST' | 'REPLY', item: SocialPostDto | SocialPostReplyDto): void {
  moreTarget.value = { resourceType, resourceId: resourceType === 'POST' ? (item as SocialPostDto).postId : (item as SocialPostReplyDto).replyId, title: resourceType === 'POST' ? (item as SocialPostDto).title : '这条回复', authorLabel: item.authorLabel, isOwn: resourceType === 'POST' ? (item as SocialPostDto).isOwnPost : (item as SocialPostReplyDto).isOwnReply };
  reportMode.value = false; reportDetails.value = ''; reportReason.value = 'SPAM'; actionFeedback.value = '';
}

function sharePost(): void {
  if (!moreTarget.value || moreTarget.value.resourceType !== 'POST') return;
  const post = posts.value.find((item) => item.postId === moreTarget.value?.resourceId);
  if (!post) return;
  shareData.value = {
    kind: 'POST', title: post.title, subtitle: post.authorLabel, topic: post.topicKey.replaceAll('_', ' '),
    description: post.body.slice(0, 150), url: `${window.location.origin}/social/forum/posts/${encodeURIComponent(post.postId)}`,
  };
  moreTarget.value = null;
}

async function applyContentAction(action: SocialContentActionRequestDto['action']): Promise<void> {
  if (!moreTarget.value) return;
  const stateKey = `${moreTarget.value.resourceType}:${moreTarget.value.resourceId}`;
  const previous = actionStates[stateKey] ?? { disliked: false, followingAuthor: false, reported: false };
  const selectedAction: SocialContentActionRequestDto['action'] = action === 'DISLIKE' && previous.disliked ? 'CLEAR_DISLIKE'
    : action === 'FOLLOW_AUTHOR' && previous.followingAuthor ? 'UNFOLLOW_AUTHOR' : action;
  const request: SocialContentActionRequestDto = { resourceType: moreTarget.value.resourceType, resourceId: moreTarget.value.resourceId, action: selectedAction,
    ...(selectedAction === 'REPORT' ? { reasonCode: reportReason.value, ...(reportDetails.value.trim() ? { details: reportDetails.value.trim() } : {}) } : {}) };
  const result = await props.application.applyContentAction(request);
  if (!result.ok) { error.value = '操作未完成，请稍后重试。'; return; }
  actionStates[stateKey] = result.value;
  actionFeedback.value = selectedAction === 'REPORT' ? '已收到举报，平台审核后会处理。'
    : selectedAction === 'DISLIKE' ? '已减少此类内容的展示。'
      : selectedAction === 'CLEAR_DISLIKE' ? '已撤销“不喜欢”标记。'
        : selectedAction === 'FOLLOW_AUTHOR' ? `已关注${moreTarget.value.authorLabel}。`
          : '已取消关注。';
  moreTarget.value = null; reportMode.value = false;
}

async function submitReply(post: SocialPostDto): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  const request: CreateSocialPostReplyRequestDto = { body: replyDrafts[post.postId] ?? '' };
  try {
    const result = await props.application.createReply(post.postId, request);
    if (!result.ok) {
      error.value = failureCopy[result.code] ?? '操作失败，请重试。';
      return;
    }
    replies[post.postId] = [...(replies[post.postId] ?? []), result.value];
    replyDrafts[post.postId] = '';
    replyOpenPostId.value = null;
    expandedPostIds.value = new Set(expandedPostIds.value).add(post.postId);
  } catch {
    error.value = '回复没有保存，请保留内容后重试。';
  } finally {
    saving.value = false;
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

watch(() => props.postId, async (postId, previousPostId) => {
  if (postId) {
    await loadPostDetail(postId);
    return;
  }
  if (previousPostId) {
    postDetailRequestId += 1;
    const cachedPosts = feedPostsByTopic.get(selectedTopicKey.value);
    if (cachedPosts) {
      posts.value = cachedPosts;
      void loadPosts(selectedTopicKey.value);
    } else {
      await loadPosts(selectedTopicKey.value);
    }
    expandedPostIds.value = new Set();
  }
});
onMounted(() => { void loadTopics(); });
</script>

<template>
  <section class="player-social-workspace" :aria-label="postId ? '帖子详情与回复' : '话题广场'">
    <nav v-if="topics.length && !postId" class="social-topic-picker" aria-label="选择话题" :aria-busy="Boolean(requestedTopicKey)">
      <button v-for="topic in topics" :key="topic.topicKey" type="button" :class="{ active: (requestedTopicKey || selectedTopicKey) === topic.topicKey }" :aria-pressed="(requestedTopicKey || selectedTopicKey) === topic.topicKey" :disabled="Boolean(requestedTopicKey)" @click="selectTopic(topic.topicKey)">{{ topic.title }}</button>
      <span v-if="requestedTopicKey" class="social-topic-switch-status" role="status">正在切换…</span>
    </nav>
    <Transition name="social-topic-content" mode="out-in">
    <div :key="postId ? `post-${postId}` : `topic-${selectedTopicKey || 'loading'}`" class="social-topic-content" :aria-busy="loading">
    <header v-if="postId" class="social-post-detail-header"><button type="button" @click="emit('backToForum')">‹ 返回上一页</button><span>帖子详情 · 回复</span></header>
    <div v-if="selectedTopic && !postId" class="social-topic-heading"><div><strong>{{ selectedTopic.title }}</strong><p>{{ selectedTopic.description }}</p></div><button type="button" @click="composerOpen = !composerOpen; error = ''">{{ composerOpen ? '收起编辑' : '写一条' }}</button></div>
    <form v-if="composerOpen" class="social-composer" @submit.prevent="submitPost">
      <label>标题<input v-model="postTitle" maxlength="80" required placeholder="给帖子起个标题" /></label>
      <label>内容<textarea v-model="postBody" maxlength="2000" required rows="4" placeholder="分享你的想法"></textarea></label>
      <div class="social-composer-footer"><small>{{ postBody.length }}/2000</small><span><button type="button" @click="composerOpen = false; delete postDrafts[selectedTopicKey]; postTitle = ''; postBody = ''; error = ''">取消</button><button class="panel-primary" type="submit" :disabled="saving">{{ saving ? '提交中…' : '提交' }}</button></span></div>
    </form>
    <p v-if="error" class="social-workspace-error" role="alert">{{ error }} <button type="button" @click="loadTopics">重试</button></p>
    <div v-if="loading" class="social-workspace-state" role="status">正在读取话题…</div>
    <div v-else-if="!posts.length && !postId" class="social-workspace-empty"><span aria-hidden="true">◎</span><strong>这个话题还没有帖子</strong><p>分享你的想法，与大家交流。</p><button type="button" @click="composerOpen = true">写下第一条</button></div>
    <article v-for="post in visiblePosts" :key="post.postId" class="social-post-card" :class="{ 'social-post-detail-card': postId === post.postId }">
      <header><button v-if="post.authorProfileKey" class="social-author-link" type="button" @click="emit('openProfile', post.authorProfileKey)">{{ post.authorLabel }}</button><span v-else class="social-author">{{ post.authorLabel }}</span><time :datetime="post.createdAt">{{ formatDate(post.createdAt) }}</time><button class="social-more-trigger" type="button" :aria-label="`更多：${post.title}`" @click="openMore('POST', post)">更多</button></header>
      <h3>{{ post.title }}</h3><p class="social-post-body">{{ post.body }}</p>
      <footer><span>{{ post.assetIds.length ? `${post.assetIds.length} 个附件` : '文字帖子' }}</span><button v-if="!postId" type="button" @click="emit('openPost', post.postId)">查看详情与回复</button><button v-else type="button" @click="toggleReplies(post)">{{ expandedPostIds.has(post.postId) ? '收起回复' : `回复 ${replies[post.postId]?.length ?? ''}` }}</button></footer>
      <section v-if="expandedPostIds.has(post.postId)" class="social-replies" :aria-label="`${post.title} 的回复`">
        <p v-if="!replies[post.postId]?.length" class="social-replies-empty">还没有回复。</p>
        <article v-for="reply in replies[post.postId] ?? []" :key="reply.replyId" class="social-reply-card"><header class="social-reply-header"><button v-if="reply.authorProfileKey" class="social-author-link" type="button" @click="emit('openProfile', reply.authorProfileKey)">{{ reply.authorLabel }}</button><strong v-else>{{ reply.authorLabel }}</strong><time :datetime="reply.createdAt">{{ formatDate(reply.createdAt) }}</time><button class="social-more-trigger" type="button" :aria-label="`更多：${reply.authorLabel}的回复`" @click="openMore('REPLY', reply)">更多</button></header><p>{{ reply.body }}</p></article>
        <form v-if="replyOpenPostId === post.postId" class="social-reply-form" @submit.prevent="submitReply(post)"><label :for="`reply-${post.postId}`">写一条回复</label><textarea :id="`reply-${post.postId}`" v-model="replyDrafts[post.postId]" rows="2" maxlength="1000" required placeholder="友善交流，请勿填写敏感信息"></textarea><div><button type="button" @click="replyOpenPostId = null">取消</button><button class="panel-primary" type="submit" :disabled="saving">发送回复</button></div></form>
        <button v-else type="button" class="social-reply-trigger" @click="replyOpenPostId = post.postId">回复这条帖子</button>
      </section>
    </article>
    </div>
    </Transition>
    <p v-if="actionFeedback" class="social-action-feedback" role="status">{{ actionFeedback }}</p>
    <div v-if="moreTarget" class="social-more-overlay" role="presentation" @click.self="moreTarget = null; reportMode = false"><section role="dialog" aria-modal="true" aria-labelledby="social-more-title"><header><div><small>{{ moreTarget.resourceType === 'POST' ? '帖子操作' : '回复操作' }}</small><h3 id="social-more-title">{{ moreTarget.title }}</h3></div><button type="button" aria-label="关闭操作菜单" @click="moreTarget = null; reportMode = false">×</button></header>
      <template v-if="!reportMode"><button v-if="moreTarget.resourceType === 'POST'" type="button" @click="sharePost">分享帖子</button><button type="button" @click="applyContentAction('DISLIKE')">{{ actionStates[`${moreTarget.resourceType}:${moreTarget.resourceId}`]?.disliked ? '撤销不喜欢' : '不喜欢' }}</button><button type="button" :disabled="moreTarget.isOwn" @click="applyContentAction('FOLLOW_AUTHOR')">{{ actionStates[`${moreTarget.resourceType}:${moreTarget.resourceId}`]?.followingAuthor ? `取消关注 ${moreTarget.authorLabel}` : `关注 ${moreTarget.authorLabel}` }}</button><button class="social-report-choice" type="button" :disabled="actionStates[`${moreTarget.resourceType}:${moreTarget.resourceId}`]?.reported" @click="reportMode = true">{{ actionStates[`${moreTarget.resourceType}:${moreTarget.resourceId}`]?.reported ? '已举报' : '举报内容' }}</button></template>
      <form v-else class="social-report-form" @submit.prevent="applyContentAction('REPORT')"><label>举报原因<PlayerAppSelect v-model="reportReason" label="举报原因" :options="[...reportReasonOptions]" /></label><label>补充说明（选填）<textarea v-model="reportDetails" maxlength="300" rows="3" placeholder="简要说明情况"></textarea></label><footer><button type="button" @click="reportMode = false">返回</button><button class="social-report-submit" type="submit">提交举报</button></footer></form>
    </section></div>
    <PlayerSocialShareCard v-if="shareData" :data="shareData" @close="shareData = undefined" />
  </section>
</template>
