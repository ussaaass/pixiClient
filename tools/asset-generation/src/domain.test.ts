import test from "node:test";
import assert from "node:assert/strict";
import { composeSeedPrompt, validateSpec } from "./domain.ts";
import { assertRequestedFormat, inspectImage } from "./image-metadata.ts";
import { OpenAIAssetClient } from "./openai-client.ts";
import { SpaceBunnyAssetClient } from "./spacebunny-client.ts";
import { validateSvg } from "./svg-validation.ts";

const spec = validateSpec({
  assetKey: "test-cover", kind: "COVER", title: "Test cover", intendedUse: "A test fixture",
  prompt: "Soft cartoon shapes", output: { size: "1024x1024", format: "png", quality: "high" },
});

test("asset specs reject unsafe keys and malformed output", () => {
  assert.throws(() => validateSpec({ ...spec, assetKey: "../private" }), /assetKey/);
  assert.throws(() => validateSpec({ ...spec, output: { ...spec.output, size: "wide" } }), /output.size/);
});

test("seed prompt includes style, purpose, and negative prompt", () => {
  const prompt = composeSeedPrompt({ ...spec, negativePrompt: "watermark", visualReferenceImages: [{ path: "assets/style.webp", purpose: "style only" }] }, "teal palette");
  assert.match(prompt, /Intended use: A test fixture/);
  assert.match(prompt, /teal palette/);
  assert.match(prompt, /assets\/style.webp \(style only\)/);
  assert.match(prompt, /Treat them as style references only/);
  assert.match(prompt, /Must avoid: watermark/);
});

test("PNG signature and dimensions are checked", () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(png.buffer).setUint32(16, 1024);
  new DataView(png.buffer).setUint32(20, 768);
  assert.deepEqual(inspectImage(png), { mime: "image/png", width: 1024, height: 768 });
  assert.throws(() => assertRequestedFormat(png, "webp"), /Requested webp/);
});

test("WebP VP8X canvas dimensions are parsed for output validation", () => {
  const webp = new Uint8Array(30);
  webp.set(new TextEncoder().encode("RIFF"), 0);
  webp.set(new TextEncoder().encode("WEBP"), 8);
  webp.set(new TextEncoder().encode("VP8X"), 12);
  new DataView(webp.buffer).setUint32(16, 10, true);
  webp[24] = 0xff; webp[25] = 0x03; webp[26] = 0x00;
  webp[27] = 0xff; webp[28] = 0x02; webp[29] = 0x00;
  assert.deepEqual(inspectImage(webp), { mime: "image/webp", width: 1024, height: 768 });
});

test("OpenAI client sends separate configured models and never logs the key", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; auth?: string }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body, auth: new Headers(init?.headers).get("authorization") ?? undefined });
    const payload = !body.tools
      ? { id: "resp_1", output: [{ content: [{ type: "output_text", text: "Refined prompt" }] }] }
      : { id: "resp_2", output: [{ type: "image_generation_call", status: "completed", result: "iVBORw0KGgo=" }] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_test" } });
  };
  const client = new OpenAIAssetClient({ apiKey: "secret-test-key", baseUrl: "https://api.test/v1", mainModel: "gpt-6-test", imageModel: "gpt-image-test" }, fakeFetch);
  await client.refinePrompt("seed", spec);
  await client.generateImage(spec, "Refined prompt", [{ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) }]);
  assert.equal(calls[0].body.model, "gpt-6-test");
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[1].body.model, "gpt-6-test");
  assert.equal((calls[1].body.tools as Array<Record<string, unknown>>)[0].model, "gpt-image-test");
  assert.deepEqual(calls[1].body.tool_choice, { type: "image_generation" });
  const generationInput = calls[1].body.input as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.equal(generationInput[0].content[0].type, "input_text");
  assert.equal(generationInput[0].content[1].type, "input_image");
  assert.match(String(generationInput[0].content[1].image_url), /^data:image\/png;base64,AQID$/);
  assert.equal(calls[0].auth, "Bearer secret-test-key");
  assert.equal(calls[1].auth, "Bearer secret-test-key");
});

test("SVG output accepts safe geometry and rejects active or remote content", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="180" fill="#167c80"/></svg>';
  assert.equal(validateSvg(svg).metadata.width, 512);
  assert.throws(() => validateSvg(svg.replace("<circle", "<script>alert(1)</script><circle")), /forbidden/);
  assert.throws(() => validateSvg(svg.replace("<circle", '<image href="https://example.test/x.png"/><circle')), /forbidden/);
});

test("Space Bunny API returns SVG text through documented chat completions shape", async () => {
  let requestUrl = "";
  let auth = "";
  const fakeFetch: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    auth = new Headers(init?.headers).get("authorization") ?? "";
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.model, "stealth/space-bunny-alpha");
    return new Response(JSON.stringify({
      model: "stealth/space-bunny-alpha",
      choices: [{ message: { content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="100"/></svg>' } }],
      usage: { prompt_tokens: 12, completion_tokens: 30 },
    }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "sb_req_test" } });
  };
  const client = new SpaceBunnyAssetClient({ apiKey: "space-bunny-secret", baseUrl: "https://spacebunny.test/api/v1", model: "stealth/space-bunny-alpha" }, fakeFetch);
  const result = await client.generateSvg(spec, "Draw a simple icon");
  assert.equal(requestUrl, "https://spacebunny.test/api/v1/chat/completions");
  assert.equal(auth, "Bearer space-bunny-secret");
  assert.equal(result.requestId, "sb_req_test");
  assert.match(result.svg, /^<svg/);
});
