import assert from "node:assert/strict";
import test from "node:test";
import { KlingVideoClient } from "./kling-client.ts";

test("Kling client submits identical start/end image and polls the saved task", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input.toString() : String(input);
    calls.push({ url, init });
    if (init?.method === "POST") return Response.json({ code: 0, request_id: "request-1", data: { task_id: "task-1", task_status: "submitted" } });
    return Response.json({ code: 0, request_id: "request-2", data: { task_id: "task-1", task_status: "succeed", task_result: { videos: [{ url: "https://video.test/result.mp4", duration: "5" }] }, final_balance_deduction: { quota: "15" } } });
  };
  const client = new KlingVideoClient({ apiKey: "secret-test-key", baseUrl: "https://api.test", model: "kling-v3" }, fakeFetch);
  const submitted = await client.createTask({ imageBase64: "start", imageTailBase64: "end", prompt: "animate", negativePrompt: "zoom", duration: "5", mode: "std", externalTaskId: "local-job" });
  assert.deepEqual(submitted, { taskId: "task-1", taskStatus: "submitted", taskStatusMessage: undefined, requestId: "request-1", videoUrl: undefined, duration: undefined, balanceDeduction: undefined });
  assert.equal(calls[0].url, "https://api.test/v1/videos/image2video");
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer secret-test-key");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { model_name: "kling-v3", image: "start", image_tail: "end", prompt: "animate", negative_prompt: "zoom", duration: "5", mode: "std", sound: "off", external_task_id: "local-job" });
  const complete = await client.getTask("task-1");
  assert.equal(calls[1].url, "https://api.test/v1/videos/image2video/task-1");
  assert.equal(complete.taskStatus, "succeed");
  assert.equal(complete.videoUrl, "https://video.test/result.mp4");
  assert.equal(complete.balanceDeduction?.quota, "15");
});

test("Kling client marks a create timeout as an unknown outcome", async () => {
  const client = new KlingVideoClient({ apiKey: "secret-test-key", baseUrl: "https://api.test", model: "kling-v3" }, async () => { throw new Error("socket hang up"); });
  await assert.rejects(client.createTask({ imageBase64: "start", imageTailBase64: "end", prompt: "animate", negativePrompt: "", duration: "5", mode: "std", externalTaskId: "local-job" }), /unknown/);
});
