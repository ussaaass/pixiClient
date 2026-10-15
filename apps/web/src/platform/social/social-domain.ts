import { SocialContentStatus, type CreateSocialPostReplyRequestDto, type CreateSocialPostRequestDto, type SocialPostDto, type SocialPostReplyDto, type SocialTopicDto } from '@gameing/contracts/social';

export type SocialFailureCode = 'INVALID_REQUEST' | 'AUTHENTICATION_REQUIRED' | 'TOPIC_NOT_FOUND' | 'TITLE_REQUIRED' | 'BODY_REQUIRED' | 'POST_NOT_FOUND' | 'REPLY_NOT_FOUND' | 'REPLY_DEPTH_EXCEEDED';
export type SocialResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: SocialFailureCode };

const failure = <T>(code: SocialFailureCode): SocialResult<T> => ({ ok: false, code });

export function createPost(
  topic: SocialTopicDto | null,
  request: CreateSocialPostRequestDto,
  postId: string,
  createdAt: string,
  authorLabel: string,
): SocialResult<SocialPostDto> {
  if (!topic || topic.status !== 'ACTIVE') return failure('TOPIC_NOT_FOUND');
  const title = request.title.trim();
  const body = request.body.trim();
  if (!title) return failure('TITLE_REQUIRED');
  if (!body) return failure('BODY_REQUIRED');
  return {
    ok: true,
    value: {
      postId,
      topicId: topic.topicId,
      topicKey: topic.topicKey,
      title,
      body,
      authorLabel,
      isOwnPost: true,
      assetIds: request.assetIds ?? [],
      status: SocialContentStatus.PUBLISHED,
      createdAt,
    },
  };
}

export function createReply(
  post: SocialPostDto | null,
  parent: SocialPostReplyDto | null,
  request: CreateSocialPostReplyRequestDto,
  replyId: string,
  createdAt: string,
  authorLabel: string,
): SocialResult<SocialPostReplyDto> {
  if (!post || post.status !== SocialContentStatus.PUBLISHED) return failure('POST_NOT_FOUND');
  const body = request.body.trim();
  if (!body) return failure('BODY_REQUIRED');
  if (request.parentReplyId && (!parent || parent.postId !== post.postId)) return failure('REPLY_NOT_FOUND');
  if (parent?.parentReplyId) return failure('REPLY_DEPTH_EXCEEDED');
  return {
    ok: true,
    value: {
      replyId,
      postId: post.postId,
      ...(parent ? { parentReplyId: parent.replyId } : {}),
      body,
      authorLabel,
      isOwnReply: true,
      assetIds: request.assetIds ?? [],
      status: SocialContentStatus.PUBLISHED,
      createdAt,
    },
  };
}
