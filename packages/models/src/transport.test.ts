import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { OpenAICompatibleModelProvider } from "./index";
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(closers.splice(0).map((close) => close()));
});
async function slowStream(delay = 250) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"begin"}}]}\n\n');
    const timer = setTimeout(
      () =>
        res.end(
          'data: {"choices":[{"delta":{"content":"end"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n',
        ),
      delay,
    );
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}
describe("model stream transport deadlines", () => {
  it("uses the caller deadline rather than the native-fetch body inactivity timer", async () => {
    const baseURL = await slowStream(2500),
      short = new Agent({ bodyTimeout: 1000 });
    closers.push(() => short.close());
    // Scale the observed 300-second body-idle timer to 1s for a local reproduction.
    vi.stubGlobal("fetch", (input: any, init: any) =>
      undiciFetch(input, { ...init, dispatcher: short }),
    );
    const provider = new OpenAICompatibleModelProvider({
      providerId: "mimo",
      displayName: "MiMo",
      apiKey: "fixture",
      baseURL,
      defaultModel: "test",
    });
    const events = [];
    for await (const event of provider.stream({
      model: "test",
      messages: [{ role: "user", content: "task" }],
      tools: [],
      mode: "read-only",
      workspaceRoot: "",
      signal: AbortSignal.timeout(5000),
    }))
      events.push(event);
    expect(
      events.filter((event) => event.type === "text_delta").map((event) => event.text),
    ).toEqual(["begin", "end"]);
    expect(events.some((event) => event.type === "usage")).toBe(true);
  });
  it("still aborts a stalled body at the caller deadline", async () => {
    const baseURL = await slowStream();
    const provider = new OpenAICompatibleModelProvider({
      providerId: "mimo",
      displayName: "MiMo",
      apiKey: "fixture",
      baseURL,
      defaultModel: "test",
    });
    const work = async () => {
      for await (const _event of provider.stream({
        model: "test",
        messages: [{ role: "user", content: "task" }],
        tools: [],
        mode: "read-only",
        workspaceRoot: "",
        signal: AbortSignal.timeout(60),
      })) {
      }
    };
    await expect(work()).rejects.toThrow();
  });
});
