import { randomUUID } from "node:crypto";
import { modelFetch } from "@dreamcode/models";
import type { AgentEvent, ModelUsage } from "@dreamcode/shared";
import type { ModelEndpoint } from "./agents.js";
import { publicAgentData, usageFromResponse } from "./agent-protocol.js";

export interface BridgeRequest {
  path: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}
export type BridgeResponse = { status: number; contentType: string } | { chunk: string };
export function createModelBridge(options: {
  endpoint: ModelEndpoint;
  maxModelRequests: number;
  signal: AbortSignal;
  add: (type: string, data: unknown) => void;
  onEvent: (event: AgentEvent) => void;
  usage: (ModelUsage | null)[];
  fetch?: typeof fetch;
}) {
  let requests = 0;
  const sessionId = randomUUID();
  const emit = (type: AgentEvent["type"], payload: unknown) =>
    options.onEvent({
      id: randomUUID(),
      sessionId,
      turnId: sessionId,
      type,
      timestamp: new Date().toISOString(),
      payload,
    });
  return async function* forward(
    input: BridgeRequest,
    runtimeSignal?: AbortSignal,
  ): AsyncGenerator<BridgeResponse> {
    const { endpoint } = options;
    if (!input.path.startsWith("/") || input.path.startsWith("//"))
      throw Error("Invalid bridge path");
    const route = new URL(input.path, "http://loopback").pathname;
    const generation =
      endpoint.protocol === "anthropic"
        ? route === "/v1/messages"
        : route === "/v1/chat/completions";
    const count = endpoint.protocol === "anthropic" && route === "/v1/messages/count_tokens";
    if (
      (!generation && !count) ||
      !input.body ||
      typeof input.body !== "object" ||
      Array.isArray(input.body)
    )
      throw Error("Unsupported model bridge request");
    if (options.signal.aborted) throw options.signal.reason;
    if (generation && requests >= options.maxModelRequests)
      throw Error("Model request budget exhausted");
    const requestedModel = input.body.model;
    // [1m] is a Claude CLI context modifier, not part of the upstream API model ID.
    const wireModel =
      endpoint.protocol === "anthropic" ? endpoint.model.replace(/\[1m\]$/, "") : endpoint.model;
    if (
      requestedModel !== endpoint.model &&
      requestedModel !== `${endpoint.model}[1m]` &&
      requestedModel !== wireModel
    )
      throw Error(`Framework requested a different model: ${String(requestedModel)}`);
    const body: Record<string, unknown> = { ...input.body, model: wireModel };
    // Retain native framework parameters, prompts and tool schemas without rewriting the agent loop.
    const request = generation ? ++requests : 0;
    if (generation) {
      emit("model.started", { request, model: endpoint.model, source: "http-bridge" });
      options.add("model.request", {
        timestamp: new Date().toISOString(),
        request,
        protocol: endpoint.protocol,
        path: input.path,
        body: publicAgentData(body),
        parameters: {
          temperature: body.temperature ?? null,
          top_p: body.top_p ?? null,
          max_tokens: body.max_tokens ?? body.max_completion_tokens ?? null,
          reasoning_effort: body.reasoning_effort ?? null,
          thinking:
            body.thinking && typeof body.thinking === "object"
              ? {
                  type: (body.thinking as Record<string, unknown>).type ?? null,
                  budget_tokens: (body.thinking as Record<string, unknown>).budget_tokens ?? null,
                }
              : null,
        },
      });
    }
    let usage: ModelUsage | null = null;
    let usageInput = false,
      usageOutput = false;
    let responseComplete = false;
    const observe = (value: Record<string, any>) => {
      const update = usageFromResponse(endpoint.protocol, value);
      if (!update) return;
      usage = { ...usage, ...update };
      usageInput ||= typeof update.inputTokens === "number";
      usageOutput ||= typeof update.outputTokens === "number";
    };
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (endpoint.authType !== "api-key") headers.authorization = `Bearer ${endpoint.apiKey}`;
      if (endpoint.protocol === "anthropic") {
        if (endpoint.authType !== "bearer") headers["x-api-key"] = endpoint.apiKey;
        headers["anthropic-version"] = input.headers?.["anthropic-version"] ?? "2023-06-01";
        if (input.headers?.["anthropic-beta"])
          headers["anthropic-beta"] = input.headers["anthropic-beta"];
      }
      const suffix = endpoint.protocol === "anthropic" ? input.path : input.path.slice(3);
      const response = await (options.fetch ?? modelFetch)(
        `${endpoint.baseURL.replace(/\/$/, "")}${suffix}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: runtimeSignal ? AbortSignal.any([options.signal, runtimeSignal]) : options.signal,
          redirect: "error",
        },
      );
      yield {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/json",
      };
      const decoder = new TextDecoder();
      const sse = response.headers.get("content-type")?.includes("text/event-stream");
      let pending = "",
        bytes = 0;
      const reader = response.body?.getReader();
      while (reader) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        bytes += chunk.byteLength;
        if (bytes > 32_000_000) throw Error("Model response exceeds evidence limit");
        // Wire chunks are transient and may contain private reasoning; never add them as evidence.
        yield { chunk: Buffer.from(chunk).toString("base64") };
        pending += decoder.decode(chunk, { stream: true });
        if (sse) {
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines)
            if (line.startsWith("data:")) {
              const data = line.slice(5).trim();
              if (data && data !== "[DONE]") {
                try {
                  observe(JSON.parse(data));
                } catch {
                  /* non-usage frame */
                }
              }
            }
        }
      }
      pending += decoder.decode();
      if (pending.trim()) {
        try {
          observe(JSON.parse(sse ? pending.replace(/^data:\s*/, "") : pending));
        } catch {
          /* no usable usage */
        }
      }
      if (!response.ok) options.add("model.http_error", { request, status: response.status });
      responseComplete = response.ok;
    } finally {
      if (generation) {
        const reported = responseComplete && usageInput && usageOutput ? usage : null;
        options.usage.push(reported);
        options.add("provider.usage", {
          timestamp: new Date().toISOString(),
          request,
          usage: reported,
          source: reported ? "provider-http" : "unavailable",
        });
        if (reported) emit("model.usage", { request, usage: reported, source: "http-bridge" });
      }
    }
  };
}
