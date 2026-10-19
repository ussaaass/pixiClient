import { Value } from '@sinclair/typebox/value';
import {
  CreateSocialPostReplyRequestSchema,
  CreateSocialPostRequestSchema,
  SocialContentActionRequestSchema,
  SocialAuthorBlockRequestSchema,
  SocialAuthorReportRequestSchema,
  SocialPostDtoSchema,
  SocialPostReplyDtoSchema,
  SocialPublicProfileDtoSchema,
  SocialPublicProfilePostsResponseSchema,
  SocialTopicDtoSchema,
  type CreateSocialPostReplyRequestDto,
  type CreateSocialPostRequestDto,
  type SocialContentActionRequestDto,
  type SocialContentActionStateDto,
  type SocialPostDto,
  type SocialPostReplyDto,
  type SocialTopicDto,
  type SocialPublicProfileDto,
  type SocialPublicProfilePostsResponseDto,
  type SocialAuthorReportRequestDto,
} from '@gameing/contracts/social';
import { createPost, createReply, type SocialFailureCode as DomainSocialFailureCode } from './social-domain';

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
  contentActionState(actorUserId: string, resourceType: 'POST' | 'REPLY', resourceId: string): Promise<SocialContentActionStateDto>;
  applyContentAction(actorUserId: string, request: SocialContentActionRequestDto): Promise<SocialContentActionStateDto>;
  getPublicProfile(publicProfileKey: string): Promise<SocialPublicProfileDto | null>;
  setFollowAuthor(publicProfileKey: string, followed: boolean): Promise<boolean>;
  listPublicProfilePosts(publicProfileKey: string): Promise<SocialPublicProfilePostsResponseDto>;
  setBlockAuthor(publicProfileKey: string, blocked: boolean): Promise<boolean>;
  reportAuthor(request: SocialAuthorReportRequestDto): Promise<void>;
  createId(): Promise<string>;
  now(): string;
}

export type SocialFailureCode = DomainSocialFailureCode | 'AUTHENTICATION_REQUIRED' | 'PROFILE_NOT_FOUND';
export type SocialApplicationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: SocialFailureCode };

export interface SocialApplication {
  listTopics(): Promise<SocialApplicationResult<SocialTopicDto[]>>;
  listPosts(topicKey: string): Promise<SocialApplicationResult<SocialPostDto[]>>;
  getPost(postId: string): Promise<SocialApplicationResult<SocialPostDto>>;
  listReplies(postId: string): Promise<SocialApplicationResult<SocialPostReplyDto[]>>;
  createPost(request: CreateSocialPostRequestDto): Promise<SocialApplicationResult<SocialPostDto>>;
  createReply(postId: string, request: CreateSocialPostReplyRequestDto): Promise<SocialApplicationResult<SocialPostReplyDto>>;
  contentActionState(resourceType: 'POST' | 'REPLY', resourceId: string): Promise<SocialApplicationResult<SocialContentActionStateDto>>;
  applyContentAction(request: SocialContentActionRequestDto): Promise<SocialApplicationResult<SocialContentActionStateDto>>;
  getPublicProfile(publicProfileKey: string): Promise<SocialApplicationResult<SocialPublicProfileDto>>;
  setFollowAuthor(publicProfileKey: string, followed: boolean): Promise<SocialApplicationResult<boolean>>;
  listPublicProfilePosts(publicProfileKey: string): Promise<SocialApplicationResult<SocialPublicProfilePostsResponseDto>>;
  setBlockAuthor(publicProfileKey: string, blocked: boolean): Promise<SocialApplicationResult<boolean>>;
  reportAuthor(request: SocialAuthorReportRequestDto): Promise<SocialApplicationResult<boolean>>;
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

    async getPost(postId) {
      if (!await repository.currentActor()) return failure('AUTHENTICATION_REQUIRED');
      const post = await repository.findPost(postId);
      if (!post || post.status !== 'PUBLISHED') return failure('POST_NOT_FOUND');
      return Value.Check(SocialPostDtoSchema, post) ? { ok: true, value: post } : failure('INVALID_REQUEST');
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

    async contentActionState(resourceType, resourceId) {
      const actor = await repository.currentActor();
      if (!actor) return failure('AUTHENTICATION_REQUIRED');
      const content = resourceType === 'POST' ? await repository.findPost(resourceId) : await repository.findReply(resourceId);
      if (!content) return failure(resourceType === 'POST' ? 'POST_NOT_FOUND' : 'REPLY_NOT_FOUND');
      return { ok: true, value: await repository.contentActionState(actor.userId, resourceType, resourceId) };
    },

    async applyContentAction(request) {
      if (!Value.Check(SocialContentActionRequestSchema, request)) return failure('INVALID_REQUEST');
      const actor = await repository.currentActor();
      if (!actor) return failure('AUTHENTICATION_REQUIRED');
      const content = request.resourceType === 'POST' ? await repository.findPost(request.resourceId) : await repository.findReply(request.resourceId);
      if (!content) return failure(request.resourceType === 'POST' ? 'POST_NOT_FOUND' : 'REPLY_NOT_FOUND');
      if (request.action === 'FOLLOW_AUTHOR' && (request.resourceType === 'POST' ? (content as SocialPostDto).isOwnPost : (content as SocialPostReplyDto).isOwnReply)) return failure('INVALID_REQUEST');
      if (request.action === 'REPORT' && !request.reasonCode) return failure('INVALID_REQUEST');
      return { ok: true, value: await repository.applyContentAction(actor.userId, request) };
    },

    async getPublicProfile(publicProfileKey) {
      if (!await repository.currentActor()) return failure('AUTHENTICATION_REQUIRED');
      if (!/^[A-Z0-9]{8,16}$/.test(publicProfileKey)) return failure('INVALID_REQUEST');
      const profile = await repository.getPublicProfile(publicProfileKey);
      return profile && Value.Check(SocialPublicProfileDtoSchema, profile) ? { ok: true, value: profile } : failure('PROFILE_NOT_FOUND');
    },

    async setFollowAuthor(publicProfileKey, followed) {
      if (!/^[A-Z0-9]{8,16}$/.test(publicProfileKey) || typeof followed !== 'boolean') return failure('INVALID_REQUEST');
      const actor = await repository.currentActor();
      if (!actor) return failure('AUTHENTICATION_REQUIRED');
      const profile = await repository.getPublicProfile(publicProfileKey);
      if (!profile || profile.isSelf || profile.blockedByMe) return failure('PROFILE_NOT_FOUND');
      return { ok: true, value: await repository.setFollowAuthor(publicProfileKey, followed) };
    },

    async listPublicProfilePosts(publicProfileKey) {
      if (!await repository.currentActor()) return failure('AUTHENTICATION_REQUIRED');
      if (!/^[A-Z0-9]{8,16}$/.test(publicProfileKey)) return failure('INVALID_REQUEST');
      const page = await repository.listPublicProfilePosts(publicProfileKey);
      return Value.Check(SocialPublicProfilePostsResponseSchema, page) ? { ok: true, value: page } : failure('INVALID_REQUEST');
    },

    async setBlockAuthor(publicProfileKey, blocked) {
      if (!Value.Check(SocialAuthorBlockRequestSchema, { publicProfileKey, blocked })) return failure('INVALID_REQUEST');
      if (!await repository.currentActor()) return failure('AUTHENTICATION_REQUIRED');
      const profile = await repository.getPublicProfile(publicProfileKey);
      if (!profile || profile.isSelf) return failure('PROFILE_NOT_FOUND');
      return { ok: true, value: await repository.setBlockAuthor(publicProfileKey, blocked) };
    },

    async reportAuthor(request) {
      if (!Value.Check(SocialAuthorReportRequestSchema, request)) return failure('INVALID_REQUEST');
      if (!await repository.currentActor()) return failure('AUTHENTICATION_REQUIRED');
      const profile = await repository.getPublicProfile(request.publicProfileKey);
      if (!profile || profile.isSelf) return failure('PROFILE_NOT_FOUND');
      await repository.reportAuthor(request);
      return { ok: true, value: true };
    },
  };
}
