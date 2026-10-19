import { describe, expect, it } from 'vitest';
import { createSocialMessageAssetApplication, type EncryptedMessageAsset, type SocialMessageAssetRepository } from './social-message-asset-application';

describe('social message asset application', () => {
  it('stores encrypted image bytes and serves decrypted bytes only to the sender and recipient', async () => {
    const assets = new Map<string, EncryptedMessageAsset>();
    const repository: SocialMessageAssetRepository = {
      createId: async () => '701',
      save: async (asset) => { assets.set(asset.assetId, asset); },
      find: async (assetId) => assets.get(assetId),
    };
    const application = createSocialMessageAssetApplication(repository, () => '501', () => '2026-10-18T08:00:00.000Z');
    const source = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x02]);
    const file = new File([source], '牌桌.gif', { type: 'image/gif' });
    const attachment = await application.upload(file, '502');
    const stored = assets.get(attachment.assetId)!;

    expect(attachment).toMatchObject({ assetId: '701', kind: 1, mimeType: 'image/gif', fileName: '牌桌.gif', byteSize: source.byteLength });
    expect(new Uint8Array(await stored.ciphertext.arrayBuffer())).not.toEqual(source);
    expect(new Uint8Array(await (await application.open(attachment.assetId, '502')).arrayBuffer())).toEqual(source);
    await expect(application.open(attachment.assetId, '503')).rejects.toThrow('ASSET_ACCESS_DENIED');
  });

  it('stores encrypted voice messages as authorized audio attachments', async () => {
    const assets = new Map<string, EncryptedMessageAsset>();
    const repository: SocialMessageAssetRepository = {
      createId: async () => '702',
      save: async (asset) => { assets.set(asset.assetId, asset); },
      find: async (assetId) => assets.get(assetId),
    };
    const application = createSocialMessageAssetApplication(repository, () => '501');
    const source = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42]);
    const file = new File([source], 'voice-message.webm', { type: 'audio/webm;codecs=opus' });
    const attachment = await application.upload(file, '502');

    expect(attachment).toMatchObject({ assetId: '702', kind: 3, mimeType: 'audio/webm', fileName: 'voice-message.webm' });
    expect(new Uint8Array(await (await application.open(attachment.assetId, '502')).arrayBuffer())).toEqual(source);
  });
});
