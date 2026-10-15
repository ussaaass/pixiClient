import { AnnouncementTemplateEventType, type AnnouncementTemplateDto, type AnnouncementTemplateSaveRequestDto } from '@gameing/admin-contracts/announcement-template';

const PLACEHOLDERS = {
  [AnnouncementTemplateEventType.PLAYER_BURST]: new Set(['actorLabel', 'gameName', 'difficultyName']),
  [AnnouncementTemplateEventType.PLAYER_STREAK]: new Set(['actorLabel', 'gameName', 'difficultyName', 'roundCount']),
} as const;

export function validateAnnouncementTemplate(request: AnnouncementTemplateSaveRequestDto): boolean {
  const allowed = PLACEHOLDERS[request.eventType];
  for (const text of [request.titlePattern, request.messagePattern]) {
    if (/[<>]/.test(text) || /(?:https?:|javascript:|data:)/i.test(text)) return false;
    const placeholders = [...text.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g)].map((match) => match[1]!);
    if (text.replace(/\{\{[a-zA-Z][a-zA-Z0-9]*\}\}/g, '').includes('{{') || text.replace(/\{\{[a-zA-Z][a-zA-Z0-9]*\}\}/g, '').includes('}}')) return false;
    if (placeholders.some((key) => !allowed.has(key as never))) return false;
  }
  return true;
}

export function renderAnnouncementTemplate(template: Pick<AnnouncementTemplateDto, 'titlePattern' | 'messagePattern'>, values: Record<string, string>): { title: string; message: string } {
  const render = (text: string) => text.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_placeholder, key: string) => values[key] ?? '');
  return { title: render(template.titlePattern), message: render(template.messagePattern) };
}
