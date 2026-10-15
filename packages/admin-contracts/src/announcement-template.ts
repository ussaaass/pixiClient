import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const IdSchema = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });
const UtcTimestampSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' });

export const AnnouncementTemplateEventType = { PLAYER_BURST: 'PLAYER_BURST', PLAYER_STREAK: 'PLAYER_STREAK' } as const;
export const AnnouncementTemplateStatus = { DRAFT: 1 } as const;
export const AnnouncementTemplateSource = { LOCAL_DEMO: 1, SERVER: 2 } as const;

export const AnnouncementTemplateDtoSchema = Type.Object({
  templateId: IdSchema,
  eventType: Type.Union([Type.Literal(AnnouncementTemplateEventType.PLAYER_BURST), Type.Literal(AnnouncementTemplateEventType.PLAYER_STREAK)]),
  titlePattern: Type.String({ minLength: 1, maxLength: 80 }),
  messagePattern: Type.String({ minLength: 1, maxLength: 240 }),
  status: Type.Literal(AnnouncementTemplateStatus.DRAFT),
  updatedAt: UtcTimestampSchema,
}, { additionalProperties: false });

export const AnnouncementTemplateChangeDtoSchema = Type.Object({
  changeId: IdSchema,
  requestKey: IdSchema,
  templateId: IdSchema,
  previous: Type.Union([AnnouncementTemplateDtoSchema, Type.Null()]),
  next: AnnouncementTemplateDtoSchema,
  reason: Type.String({ minLength: 3, maxLength: 240 }),
  source: Type.Union([Type.Literal(AnnouncementTemplateSource.LOCAL_DEMO), Type.Literal(AnnouncementTemplateSource.SERVER)]),
  createdAt: UtcTimestampSchema,
}, { additionalProperties: false });

export const AnnouncementTemplateQuerySchema = Type.Object({
  eventType: Type.Optional(Type.Union([Type.Literal(AnnouncementTemplateEventType.PLAYER_BURST), Type.Literal(AnnouncementTemplateEventType.PLAYER_STREAK)])),
  keyword: Type.Optional(Type.String({ maxLength: 80 })),
}, { additionalProperties: false });

export const AnnouncementTemplateSaveRequestSchema = Type.Object({
  templateId: Type.Union([IdSchema, Type.Null()]),
  eventType: Type.Union([Type.Literal(AnnouncementTemplateEventType.PLAYER_BURST), Type.Literal(AnnouncementTemplateEventType.PLAYER_STREAK)]),
  titlePattern: Type.String({ minLength: 1, maxLength: 80 }),
  messagePattern: Type.String({ minLength: 1, maxLength: 240 }),
  reason: Type.String({ minLength: 3, maxLength: 240 }),
  requestKey: IdSchema,
}, { additionalProperties: false });

export type AnnouncementTemplateDto = Static<typeof AnnouncementTemplateDtoSchema>;
export type AnnouncementTemplateChangeDto = Static<typeof AnnouncementTemplateChangeDtoSchema>;
export type AnnouncementTemplateQueryDto = Static<typeof AnnouncementTemplateQuerySchema>;
export type AnnouncementTemplateSaveRequestDto = Static<typeof AnnouncementTemplateSaveRequestSchema>;
