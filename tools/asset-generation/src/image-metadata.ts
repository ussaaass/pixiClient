export interface ImageMetadata {
  mime: "image/png" | "image/webp";
  width?: number;
  height?: number;
}

export function inspectImage(bytes: Uint8Array): ImageMetadata {
  if (bytes.length < 12) throw new Error("Generated output is too short to be an image.");
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    if (bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") {
      throw new Error("PNG output is missing a valid IHDR header.");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { mime: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunk = String.fromCharCode(...bytes.subarray(offset, offset + 4));
      const length = view.getUint32(offset + 4, true);
      const data = offset + 8;
      if (data + length > bytes.length) throw new Error("WebP output has a truncated chunk.");
      if (chunk === "VP8X" && length >= 10) {
        const width = 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16);
        const height = 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16);
        return { mime: "image/webp", width, height };
      }
      if (chunk === "VP8L" && length >= 5 && bytes[data] === 0x2f) {
        const width = 1 + bytes[data + 1] + ((bytes[data + 2] & 0x3f) << 8);
        const height = 1 + ((bytes[data + 2] >> 6) & 0x03) + (bytes[data + 3] << 2) + ((bytes[data + 4] & 0x0f) << 10);
        return { mime: "image/webp", width, height };
      }
      if (chunk === "VP8 " && length >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
        const width = (bytes[data + 6] | (bytes[data + 7] << 8)) & 0x3fff;
        const height = (bytes[data + 8] | (bytes[data + 9] << 8)) & 0x3fff;
        return { mime: "image/webp", width, height };
      }
      offset = data + length + (length & 1);
    }
    return { mime: "image/webp" };
  }
  throw new Error("Image output signature does not match the requested PNG or WebP format.");
}

export function assertRequestedFormat(bytes: Uint8Array, format: "png" | "webp"): ImageMetadata {
  const metadata = inspectImage(bytes);
  const expected = format === "png" ? "image/png" : "image/webp";
  if (metadata.mime !== expected) throw new Error(`Requested ${format}, but provider returned ${metadata.mime}.`);
  return metadata;
}
