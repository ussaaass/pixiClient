import { Value } from '@sinclair/typebox/value';
import {
  CreateSocialPostReplyRequestSchema,
  CreateSocialPostRequestSchema,
  SocialPostDtoSchema,
  SocialPostReplyDtoSchema,
  SocialTopicDtoSchema,
  type CreateSocialPostReplyRequestDto,
  type CreateSocialPostRequestDto,
  type SocialPostDto,
  type SocialPostReplyDto,
  type SocialTopicDto,
} from '@gameing/contracts/social';
import { createPost, createReply, type SocialFailureCode, type SocialResult } from './social-domain';

export interface SocialRepositoryPort {
  currentActor(): Promise<{ userId: string; displayName: string } | null>;
  listTopics(): Promise<SocialTopicDto[]>;
  findTopic(topicKey: string): Promise<SocialTopicDto | null>;
  listPosts(topicKey: string): Promise<SocialPostDto[]>;
  findPost(postId: string): Promise<SocialPostDto | null>;
  savePost(post: SocialPostDto): Promise<void>;
  listReplies(postId: string): Promise<SocialPostReplyDto[]>;
  findReply(replyId: string): Promise<SocialPostReplyDto | null>;
  saveReply(reply: SocialPostReplyDto): Promise<void>;
  createId(): Promise<string>;
  now(): string;
}

export type SocialApplicationResult<T> = SocialResult<T>;

export interface SocialApplication {
  listTopics(): Promise<SocialApplicationResult<SocialTopicDto[]>>;
  listPosts(topicKey: string): Promise<SocialApplicationResult<SocialPostDto[]>>;
  listReplies(postId: string): Promise<SocialApplicationResult<SocialPostReplyDto[]>>;
  createPost(request: CreateSocialPostRequestDto): Promise<SocialApplicationResult<SocialPostDto>>;
  createReply(postId: string, request: CreateSocialPostReplyRequestDto): Promise<SocialApplicationResult<SocialPostReplyDto>>;
}

function failure<T>(code: SocialFailureCode): SocialApplicationResult<T> {
  return { ok: false, code };
}

export function createSocialApplication(repository: SocialRepositoryPort): SocialApplication {
  return {
    async listTopics() {
      const topics = await repository.listTopics();
      return topics.every((topic) => Value.Check(SocialTopicDtoSchema, topic))
        ? { ok: true, value: topics }
        : failure('INVALID_REQUEST');
    },

    async listPosts(topicKey) {
      if (!await repository.currentActor()) return failure('AUTHENTICATION_REQUIRED');
      const topic = await repository.findTopic(topicKey);
      if (!topic || topic.status !== 'ACTIVE') return failure('TOPIC_NOT_FOUND');
      const posts = await repository.listPosts(topicKey);
      return posts.every((post) => Value.Check(SocialPostDtoSchema, post))
        ? { ok: true, value: posts }
        : failure('INVALID_REQUEST');
    },

    async listReplies(postId) {
      if (!await repository.currentActor()) return failure('AUTHENTICATION_REQUIRED');
      if (!await repository.findPost(postId)) return failure('POST_NOT_FOUND');
      const replies = await repository.listReplies(postId);
      return replies.every((reply) => Value.Check(SocialPostReplyDtoSchema, reply))
        ? { ok: true, value: replies }
        : failure('INVALID_REQUEST');
    },

    async createPost(request) {
      if (!Value.Check(CreateSocialPostRequestSchema, request)) return failure('INVALID_REQUEST');
      const actor = await repository.currentActor();
      if (!actor) return failure('AUTHENTICATION_REQUIRED');
      const result = createPost(await repository.findTopic(request.topicKey), request, await repository.createId(), repository.now(), actor.displayName);
      if (!result.ok) return result;
      if (!Value.Check(SocialPostDtoSchema, result.value)) return failure('INVALID_REQUEST');
      await repository.savePost(result.value);
      const saved = await repository.findPost(result.value.postId);
      return saved && Value.Check(SocialPostDtoSchema, saved) ? { ok: true, value: saved } : failure('INVALID_REQUEST');
    },

    async createReply(postId, request) {
      if (!Value.Check(CreateSocialPostReplyRequestSchema, request)) return failure('INVALID_REQUEST');
      const actor = await repository.currentActor();
      if (!actor) return failure('AUTHENTICATION_REQUIRED');
      const parent = request.parentReplyId ? await repository.findReply(request.parentReplyId) : null;
      const result = createReply(await repository.findPost(postId), parent, request, await repository.createId(), repository.now(), actor.displayName);
      if (!result.ok) return result;
      if (!Value.Check(SocialPostReplyDtoSchema, result.value)) return failure('INVALID_REQUEST');
      await repository.saveReply(result.value);
      const saved = await repository.findReply(result.value.replyId);
      return saved && Value.Check(SocialPostReplyDtoSchema, saved) ? { ok: true, value: saved } : failure('INVALID_REQUEST');
    },
  };
}
