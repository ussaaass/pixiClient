const MAGIC = new Uint8Array([0x4c, 0x47, 0x41, 0x53, 0x53, 0x45, 0x54, 0x31]); // LGASSET1
const FORMAT_VERSION = 1;
const HEADER_BYTES = 8 + 1 + 4 + 4 + 8;
const COUNTER_BYTES = 16;
const MAC_BYTES = 32;
const MAC_DOMAIN = new TextEncoder().encode('LOTTERY-GAME-ASSET-AES128CTR-HMAC-SHA256-V1');
const DEFAULT_CHUNK_SIZE = 64 * 1024;
const MAX_CHUNK_SIZE = 1024 * 1024;

export type AssetContentKeys = { aes128Key: Uint8Array; hmacSha256Key: Uint8Array };
export type AssetCipherFormat = { version: 1; chunkSize: number; chunkCount: number; plainSize: number };

export class AssetCipherError extends Error {
  constructor(readonly code: 'INVALID_SOURCE_SIZE' | 'INVALID_CONTAINER' | 'UNSUPPORTED_FORMAT' | 'INTEGRITY_CHECK_FAILED') {
    super(code);
    this.name = 'AssetCipherError';
  }
}

export function createAssetContentKeys(): AssetContentKeys {
  return {
    aes128Key: crypto.getRandomValues(new Uint8Array(16)),
    hmacSha256Key: crypto.getRandomValues(new Uint8Array(32)),
  };
}

export function encryptAssetStream(
  source: ReadableStream<Uint8Array>,
  plainSize: number,
  assetId: string,
  keys: AssetContentKeys,
  chunkSize = DEFAULT_CHUNK_SIZE,
): ReadableStream<Uint8Array> {
  assertInput(plainSize > 0 && Number.isSafeInteger(plainSize), 'INVALID_SOURCE_SIZE');
  assertInput(chunkSize > 0 && chunkSize <= MAX_CHUNK_SIZE && Number.isInteger(chunkSize), 'INVALID_SOURCE_SIZE');
  assertInput(/^[1-9][0-9]{0,19}$/.test(assetId), 'INVALID_SOURCE_SIZE');
  assertInput(keys.aes128Key.byteLength === 16 && keys.hmacSha256Key.byteLength === 32, 'INVALID_SOURCE_SIZE');

  const chunkCount = Math.ceil(plainSize / chunkSize);
  assertInput(chunkCount <= 0xffff_ffff, 'INVALID_SOURCE_SIZE');
  const reader = source.getReader();
  const input = new StreamInput(reader, plainSize);
  let index = 0;
  let aesKey: Promise<CryptoKey> | undefined;
  let hmacKey: Promise<CryptoKey> | undefined;
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) return;
      try {
        if (index === 0) controller.enqueue(encodeHeader({ version: FORMAT_VERSION, chunkSize, chunkCount, plainSize }));
        if (index >= chunkCount) {
          await input.assertEnded();
          controller.close();
          return;
        }
        aesKey ??= crypto.subtle.importKey('raw', copyBuffer(keys.aes128Key), { name: 'AES-CTR' }, false, ['encrypt']);
        hmacKey ??= crypto.subtle.importKey('raw', copyBuffer(keys.hmacSha256Key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const plain = await input.readExactly(Math.min(chunkSize, plainSize - index * chunkSize));
        const counter = counterForChunk(index, chunkSize);
        const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CTR', counter: copyBuffer(counter), length: 128 }, await aesKey, copyBuffer(plain)));
        const macInput = encodeMacInput(assetId, { version: FORMAT_VERSION, chunkSize, chunkCount, plainSize }, index, counter, ciphertext);
        const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey, copyBuffer(macInput)));
        controller.enqueue(encodeFrame(ciphertext, counter, mac));
        index += 1;
        if (index === chunkCount) {
          await input.assertEnded();
          controller.close();
        }
      } catch (error) {
        cancelled = true;
        await reader.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason);
    },
  });
}

export function decryptAssetStream(
  ciphertext: ReadableStream<Uint8Array>,
  assetId: string,
  keys: AssetContentKeys,
): ReadableStream<Uint8Array> {
  assertInput(/^[1-9][0-9]{0,19}$/.test(assetId), 'INVALID_CONTAINER');
  assertInput(keys.aes128Key.byteLength === 16 && keys.hmacSha256Key.byteLength === 32, 'INVALID_CONTAINER');

  const reader = ciphertext.getReader();
  const input = new StreamInput(reader);
  let format: AssetCipherFormat | undefined;
  let index = 0;
  let aesKey: Promise<CryptoKey> | undefined;
  let hmacKey: Promise<CryptoKey> | undefined;
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) return;
      try {
        if (!format) {
          format = decodeHeader(await input.readExactly(HEADER_BYTES));
          aesKey = crypto.subtle.importKey('raw', copyBuffer(keys.aes128Key), { name: 'AES-CTR' }, false, ['decrypt']);
          hmacKey = crypto.subtle.importKey('raw', copyBuffer(keys.hmacSha256Key), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
        }
        if (index >= format.chunkCount) {
          await input.assertEnded();
          controller.close();
          return;
        }
        const expectedLength = Math.min(format.chunkSize, format.plainSize - index * format.chunkSize);
        const frameLength = readUint32(await input.readExactly(4));
        if (frameLength !== expectedLength) throw new AssetCipherError('INVALID_CONTAINER');
        const counter = await input.readExactly(COUNTER_BYTES);
        const mac = await input.readExactly(MAC_BYTES);
        const encrypted = await input.readExactly(frameLength);
        const macInput = encodeMacInput(assetId, format, index, counter, encrypted);
        if (!await crypto.subtle.verify('HMAC', await hmacKey!, copyBuffer(mac), copyBuffer(macInput))) {
          throw new AssetCipherError('INTEGRITY_CHECK_FAILED');
        }
        const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CTR', counter: copyBuffer(counter), length: 128 }, await aesKey!, copyBuffer(encrypted)));
        index += 1;
        if (index === format.chunkCount) await input.assertEnded();
        controller.enqueue(plain);
        if (index === format.chunkCount) controller.close();
      } catch (error) {
        cancelled = true;
        await reader.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason);
    },
  });
}

class StreamInput {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private received = 0;
  private ended = false;
  private readonly expectedSize: number | undefined;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>, expectedSize?: number) {
    this.expectedSize = expectedSize;
  }

  async readExactly(size: number): Promise<Uint8Array> {
    while (this.buffered < size && !this.ended) {
      const { value, done } = await this.reader.read();
      if (done) { this.ended = true; break; }
      if (!value?.byteLength) continue;
      this.received += value.byteLength;
      if (this.expectedSize !== undefined && this.received > this.expectedSize) throw new AssetCipherError('INVALID_SOURCE_SIZE');
      this.chunks.push(value);
      this.buffered += value.byteLength;
    }
    if (this.buffered < size) throw new AssetCipherError(this.expectedSize === undefined ? 'INVALID_CONTAINER' : 'INVALID_SOURCE_SIZE');
    const result = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const first = this.chunks[0]!;
      const take = Math.min(first.byteLength, size - offset);
      result.set(first.subarray(0, take), offset);
      offset += take;
      this.buffered -= take;
      if (take === first.byteLength) this.chunks.shift();
      else this.chunks[0] = first.subarray(take);
    }
    return result;
  }

  async assertEnded(): Promise<void> {
    if (this.buffered > 0) throw new AssetCipherError(this.expectedSize === undefined ? 'INVALID_CONTAINER' : 'INVALID_SOURCE_SIZE');
    if (!this.ended) {
      const { value, done } = await this.reader.read();
      if (!done && value?.byteLength) throw new AssetCipherError(this.expectedSize === undefined ? 'INVALID_CONTAINER' : 'INVALID_SOURCE_SIZE');
      if (!done) return this.assertEnded();
      this.ended = true;
    }
    if (this.expectedSize !== undefined && this.received !== this.expectedSize) throw new AssetCipherError('INVALID_SOURCE_SIZE');
  }
}

function encodeHeader(format: AssetCipherFormat): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES);
  bytes.set(MAGIC, 0);
  bytes[8] = format.version;
  writeUint32(bytes, 9, format.chunkSize);
  writeUint32(bytes, 13, format.chunkCount);
  new DataView(bytes.buffer).setBigUint64(17, BigInt(format.plainSize), false);
  return bytes;
}

function decodeHeader(bytes: Uint8Array): AssetCipherFormat {
  if (bytes.byteLength !== HEADER_BYTES || !MAGIC.every((value, index) => bytes[index] === value)) throw new AssetCipherError('INVALID_CONTAINER');
  const version = bytes[8]!;
  const chunkSize = readUint32(bytes.subarray(9, 13));
  const chunkCount = readUint32(bytes.subarray(13, 17));
  const plainSize = new DataView(copyBuffer(bytes.subarray(17, 25))).getBigUint64(0, false);
  if (version !== FORMAT_VERSION) throw new AssetCipherError('UNSUPPORTED_FORMAT');
  if (!chunkSize || chunkSize > MAX_CHUNK_SIZE || !chunkCount || plainSize <= 0n || plainSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new AssetCipherError('INVALID_CONTAINER');
  const asNumber = Number(plainSize);
  if (Math.ceil(asNumber / chunkSize) !== chunkCount) throw new AssetCipherError('INVALID_CONTAINER');
  return { version: 1, chunkSize, chunkCount, plainSize: asNumber };
}

function encodeFrame(ciphertext: Uint8Array, counter: Uint8Array, mac: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + counter.byteLength + mac.byteLength + ciphertext.byteLength);
  writeUint32(frame, 0, ciphertext.byteLength);
  frame.set(counter, 4);
  frame.set(mac, 4 + counter.byteLength);
  frame.set(ciphertext, 4 + counter.byteLength + mac.byteLength);
  return frame;
}

function encodeMacInput(assetId: string, format: AssetCipherFormat, chunkIndex: number, counter: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(assetId);
  const meta = new Uint8Array(4 + 4 + 4 + 4 + 4 + 8);
  const view = new DataView(meta.buffer);
  view.setUint32(0, id.byteLength, false);
  view.setUint32(4, format.version, false);
  view.setUint32(8, chunkIndex, false);
  view.setUint32(12, format.chunkCount, false);
  view.setUint32(16, format.chunkSize, false);
  view.setBigUint64(20, BigInt(format.plainSize), false);
  const data = new Uint8Array(MAC_DOMAIN.byteLength + id.byteLength + meta.byteLength + counter.byteLength + ciphertext.byteLength);
  let offset = 0;
  data.set(MAC_DOMAIN, offset); offset += MAC_DOMAIN.byteLength;
  data.set(id, offset); offset += id.byteLength;
  data.set(meta, offset); offset += meta.byteLength;
  data.set(counter, offset); offset += counter.byteLength;
  data.set(ciphertext, offset);
  return data;
}

function counterForChunk(index: number, chunkSize: number): Uint8Array {
  const counter = new Uint8Array(COUNTER_BYTES);
  const blockOffset = BigInt(index) * BigInt(Math.ceil(chunkSize / 16));
  new DataView(counter.buffer).setBigUint64(COUNTER_BYTES - 8, blockOffset, false);
  return counter;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, false);
}

function readUint32(bytes: Uint8Array): number {
  return new DataView(copyBuffer(bytes)).getUint32(0, false);
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function assertInput(condition: boolean, code: ConstructorParameters<typeof AssetCipherError>[0]): asserts condition {
  if (!condition) throw new AssetCipherError(code);
}
