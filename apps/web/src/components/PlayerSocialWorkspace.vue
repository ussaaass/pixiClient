<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { CreateSocialPostReplyRequestDto, CreateSocialPostRequestDto, SocialPostDto, SocialPostReplyDto, SocialTopicDto } from '@gameing/contracts/social';
import type { SocialApplication } from '../platform/social/social-application';

const props = defineProps<{ application: SocialApplication }>();
const topics = ref<SocialTopicDto[]>([]);
const selectedTopicKey = ref('');
const posts = ref<SocialPostDto[]>([]);
const replies = reactive<Record<string, SocialPostReplyDto[]>>({});
const expandedPostIds = ref(new Set<string>());
const replyDrafts = reactive<Record<string, string>>({});
const postDrafts = reactive<Record<string, { title: string; body: string }>>({});
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const composerOpen = ref(false);
const replyOpenPostId = ref<string | null>(null);
const postTitle = ref('');
const postBody = ref('');
const selectedTopic = computed(() => topics.value.find((topic) => topic.topicKey === selectedTopicKey.value) ?? null);

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
    selectedTopicKey.value ||= result.value[0]?.topicKey ?? '';
    if (!selectedTopicKey.value) error.value = '当前没有可浏览的话题。';
    else await loadPosts();
  } catch {
    error.value = '本地话题暂时无法读取，请重试。';
  } finally {
    loading.value = false;
  }
}

async function loadPosts(): Promise<void> {
  const key = selectedTopicKey.value;
  if (!key) return;
  loading.value = true;
  error.value = '';
  try {
    const result = await props.application.listPosts(key);
    if (!result.ok) {
      error.value = failureCopy[result.code] ?? '操作失败，请重试。';
      return;
    }
    posts.value = result.value;
  } catch {
    error.value = '本地帖子暂时无法读取，请重试。';
  } finally {
    loading.value = false;
  }
}

async function selectTopic(topicKey: string): Promise<void> {
  if (selectedTopicKey.value && (composerOpen.value || postTitle.value || postBody.value || postDrafts[selectedTopicKey.value])) {
    postDrafts[selectedTopicKey.value] = { title: postTitle.value, body: postBody.value };
  }
  selectedTopicKey.value = topicKey;
  composerOpen.value = false;
  replyOpenPostId.value = null;
  postTitle.value = postDrafts[topicKey]?.title ?? '';
  postBody.value = postDrafts[topicKey]?.body ?? '';
  posts.value = [];
  await loadPosts();
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
    expanded.add(post.postId);
    expandedPostIds.value = expanded;
  } catch {
    error.value = '回复暂时无法读取，请重试。';
  }
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

onMounted(() => { void loadTopics(); });
</script>

<template>
  <section class="player-social-workspace" aria-label="话题广场">
    <nav v-if="topics.length" class="social-topic-picker" aria-label="选择话题">
      <button v-for="topic in topics" :key="topic.topicKey" type="button" :class="{ active: selectedTopicKey === topic.topicKey }" :aria-pressed="selectedTopicKey === topic.topicKey" @click="selectTopic(topic.topicKey)">{{ topic.title }}</button>
    </nav>
    <div v-if="selectedTopic" class="social-topic-heading"><div><strong>{{ selectedTopic.title }}</strong><p>{{ selectedTopic.description }}</p></div><button type="button" @click="composerOpen = !composerOpen; error = ''">{{ composerOpen ? '收起编辑' : '写一条' }}</button></div>
    <form v-if="composerOpen" class="social-composer" @submit.prevent="submitPost">
      <label>标题<input v-model="postTitle" maxlength="80" required placeholder="给帖子起个标题" /></label>
      <label>内容<textarea v-model="postBody" maxlength="2000" required rows="4" placeholder="分享你的想法"></textarea></label>
      <div class="social-composer-footer"><small>{{ postBody.length }}/2000</small><span><button type="button" @click="composerOpen = false; delete postDrafts[selectedTopicKey]; postTitle = ''; postBody = ''; error = ''">取消</button><button class="panel-primary" type="submit" :disabled="saving">{{ saving ? '提交中…' : '提交' }}</button></span></div>
    </form>
    <p v-if="error" class="social-workspace-error" role="alert">{{ error }} <button type="button" @click="loadTopics">重试</button></p>
    <div v-if="loading" class="social-workspace-state" role="status">正在读取话题…</div>
    <div v-else-if="!posts.length" class="social-workspace-empty"><span aria-hidden="true">◎</span><strong>这个话题还没有帖子</strong><p>分享你的想法，与大家交流。</p><button type="button" @click="composerOpen = true">写下第一条</button></div>
    <article v-for="post in posts" :key="post.postId" class="social-post-card">
      <header><span class="social-author">{{ post.authorLabel }}</span><time :datetime="post.createdAt">{{ formatDate(post.createdAt) }}</time></header>
      <h3>{{ post.title }}</h3><p class="social-post-body">{{ post.body }}</p>
      <footer><span>{{ post.assetIds.length ? `${post.assetIds.length} 个附件` : '文字帖子' }}</span><button type="button" @click="toggleReplies(post)">{{ expandedPostIds.has(post.postId) ? '收起回复' : `回复 ${replies[post.postId]?.length ?? ''}` }}</button></footer>
      <section v-if="expandedPostIds.has(post.postId)" class="social-replies" :aria-label="`${post.title} 的回复`">
        <p v-if="!replies[post.postId]?.length" class="social-replies-empty">还没有回复。</p>
        <article v-for="reply in replies[post.postId] ?? []" :key="reply.replyId" class="social-reply-card"><strong>{{ reply.authorLabel }}</strong><p>{{ reply.body }}</p><time :datetime="reply.createdAt">{{ formatDate(reply.createdAt) }}</time></article>
        <form v-if="replyOpenPostId === post.postId" class="social-reply-form" @submit.prevent="submitReply(post)"><label :for="`reply-${post.postId}`">写一条回复</label><textarea :id="`reply-${post.postId}`" v-model="replyDrafts[post.postId]" rows="2" maxlength="1000" required placeholder="友善交流，请勿填写敏感信息"></textarea><div><button type="button" @click="replyOpenPostId = null">取消</button><button class="panel-primary" type="submit" :disabled="saving">发送回复</button></div></form>
        <button v-else type="button" class="social-reply-trigger" @click="replyOpenPostId = post.postId">回复这条帖子</button>
      </section>
    </article>
  </section>
</template>
