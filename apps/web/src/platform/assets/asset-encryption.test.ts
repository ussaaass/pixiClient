import { describe, expect, it } from 'vitest';
import { AssetCipherError, createAssetContentKeys, decryptAssetStream, encryptAssetStream } from './asset-encryption';

describe('client encrypted Asset stream', () => {
  it('round trips chunked streams while validating source and chunk boundaries', async () => {
    const original = Uint8Array.from({ length: 173 }, (_, index) => index * 37 % 256);
    const keys = createAssetContentKeys();
    const encrypted = await collect(encryptAssetStream(splitStream(original, [3, 41, 82]), original.byteLength, '812', keys, 64));
    const decrypted = await collect(decryptAssetStream(splitStream(encrypted, [1, 7, 20, 94]), '812', keys));
    expect(decrypted).toEqual(original);
    await expect(collect(encryptAssetStream(splitStream(original.slice(0, 80), [7, 22]), original.byteLength, '812', keys, 64))).rejects.toMatchObject({ code: 'INVALID_SOURCE_SIZE' });
  });

  it('never releases a chunk before its HMAC validates and rejects tampering', async () => {
    const original = Uint8Array.from({ length: 100 }, (_, index) => index);
    const keys = createAssetContentKeys();
    const encrypted = await collect(encryptAssetStream(splitStream(original, [29]), original.byteLength, '9301', keys, 64));
    encrypted[77] = encrypted[77]! ^ 0xff;
    const reader = decryptAssetStream(splitStream(encrypted, [1, 25, 29]), '9301', keys).getReader();
    await expect(reader.read()).rejects.toMatchObject({ code: 'INTEGRITY_CHECK_FAILED' });
  });

  it('binds each authenticated stream to its asset id and rejects truncation', async () => {
    const original = Uint8Array.from({ length: 90 }, (_, index) => index * 3);
    const keys = createAssetContentKeys();
    const encrypted = await collect(encryptAssetStream(splitStream(original, [14, 30]), original.byteLength, '42', keys, 64));
    await expect(collect(decryptAssetStream(splitStream(encrypted, [19]), '43', keys))).rejects.toBeInstanceOf(AssetCipherError);
    await expect(collect(decryptAssetStream(splitStream(encrypted.slice(0, -1), [26]), '42', keys))).rejects.toBeInstanceOf(AssetCipherError);
  });
});

function splitStream(value: Uint8Array, sizes: number[]): ReadableStream<Uint8Array> {
  let offset = 0;
  let cursor = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= value.byteLength) { controller.close(); return; }
      const nextSize = sizes[cursor % sizes.length] ?? value.byteLength;
      controller.enqueue(value.slice(offset, Math.min(value.byteLength, offset + nextSize)));
      offset += nextSize;
      cursor += 1;
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
