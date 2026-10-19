import { SocialMessageAttachmentKind, type SocialMessageAttachmentDto } from '@gameing/contracts/social';
import { createAssetContentKeys, decryptAssetStream, encryptAssetStream, type AssetContentKeys } from './asset-encryption';

export type EncryptedMessageAsset = {
  assetId: string;
  ownerUserId: string;
  authorizedUserIds: string[];
  kind: typeof SocialMessageAttachmentKind[keyof typeof SocialMessageAttachmentKind];
  mimeType: string;
  fileName: string;
  byteSize: number;
  ciphertext: Blob;
  keys: AssetContentKeys;
  createdAt: string;
};

export interface SocialMessageAssetRepository {
  createId(): Promise<string>;
  save(asset: EncryptedMessageAsset): Promise<void>;
  find(assetId: string): Promise<EncryptedMessageAsset | undefined>;
}

export interface SocialMessageAssetApplication {
  upload(file: File, recipientUserId: string): Promise<SocialMessageAttachmentDto>;
  open(assetId: string, viewerUserId: string): Promise<Blob>;
}

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);
const AUDIO_TYPES = new Set(['audio/mp4', 'audio/webm', 'audio/ogg']);

export function createSocialMessageAssetApplication(
  repository: SocialMessageAssetRepository,
  currentUserId: () => string | undefined,
  now: () => string = () => new Date().toISOString(),
): SocialMessageAssetApplication {
  return {
    async upload(file, recipientUserId) {
      const ownerUserId = currentUserId();
      if (!ownerUserId) throw new Error('SOCIAL_ACTOR_REQUIRED');
      if (!/^[1-9][0-9]{0,19}$/.test(recipientUserId)) throw new Error('SOCIAL_ATTACHMENT_RECIPIENT_INVALID');
      if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_ATTACHMENT_BYTES) throw new Error('SOCIAL_ATTACHMENT_SIZE_INVALID');
      const mimeType = file.type.toLowerCase().split(';', 1)[0]?.trim() ?? '';
      const kind = IMAGE_TYPES.has(mimeType) ? SocialMessageAttachmentKind.IMAGE : VIDEO_TYPES.has(mimeType) ? SocialMessageAttachmentKind.VIDEO : AUDIO_TYPES.has(mimeType) ? SocialMessageAttachmentKind.AUDIO : undefined;
      if (!kind) throw new Error('SOCIAL_ATTACHMENT_TYPE_INVALID');
      const signature = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      if (!matchesMediaSignature(mimeType, signature)) throw new Error('SOCIAL_ATTACHMENT_CONTENT_INVALID');

      const assetId = await repository.createId();
      const keys = createAssetContentKeys();
      const stream = encryptAssetStream(file.stream(), file.size, assetId, keys);
      const ciphertext = await new Response(stream).blob();
      const fileName = file.name.replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 160) || 'attachment';
      await repository.save({ assetId, ownerUserId, authorizedUserIds: [...new Set([ownerUserId, recipientUserId])], kind, mimeType, fileName, byteSize: file.size, ciphertext, keys, createdAt: now() });
      return { assetId, kind, mimeType, fileName, byteSize: file.size };
    },
    async open(assetId, viewerUserId) {
      const asset = await repository.find(assetId);
      if (!asset || !asset.authorizedUserIds.includes(viewerUserId)) throw new Error('ASSET_ACCESS_DENIED');
      return new Response(decryptAssetStream(asset.ciphertext.stream(), asset.assetId, asset.keys)).blob().then((blob) => new Blob([blob], { type: asset.mimeType }));
    },
  };
}

function matchesMediaSignature(mimeType: string, bytes: Uint8Array): boolean {
  const ascii = (offset: number, value: string) => value.split('').every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/png') return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  if (mimeType === 'image/gif') return ascii(0, 'GIF87a') || ascii(0, 'GIF89a');
  if (mimeType === 'image/webp') return ascii(0, 'RIFF') && ascii(8, 'WEBP');
  if (mimeType === 'image/avif') return ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis'));
  if (mimeType === 'video/mp4') return ascii(4, 'ftyp');
  if (mimeType === 'video/webm') return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  if (mimeType === 'audio/mp4') return ascii(4, 'ftyp');
  if (mimeType === 'audio/webm') return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  if (mimeType === 'audio/ogg') return ascii(0, 'OggS');
  return false;
}
