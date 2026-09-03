import type { ChatMessage, NormalizedToolCall, ToolResult } from "@dreamcode/shared";
import { createId } from "@dreamcode/shared";

export interface ToolResultAggregatorOptions {
  maxBatchChars?: number;
  maxResultChars?: number;
}

/** Builds one protocol-required tool message per call while enforcing a shared batch budget. */
export class ToolResultAggregator {
  private remainingChars: number;
  private readonly maxResultChars: number;

  constructor(options: ToolResultAggregatorOptions = {}) {
    this.remainingChars = options.maxBatchChars ?? 32_000;
    this.maxResultChars = options.maxResultChars ?? 8_000;
  }

  project(toolCall: NormalizedToolCall, result: ToolResult): ChatMessage {
    const prefix = `Status: ${result.status}\nSummary: ${result.summary}`;
    const artifacts = result.artifactRefs?.length
      ? `\nArtifacts: ${result.artifactRefs.join(", ")}`
      : "";
    const minimum = prefix.length + artifacts.length;
    const allowance = Math.max(0, Math.min(this.maxResultChars, this.remainingChars) - minimum);
    const serialized = safeJson(modelView(result));
    const data = allowance
      ? `\nData: ${truncate(serialized, allowance)}`
      : "\nData: [batch result budget exhausted; use artifact references or request a focused range]";
    const content = `${prefix}${data}${artifacts}`;
    this.remainingChars = Math.max(0, this.remainingChars - content.length);
    return {
      id: createId("msg"),
      role: "tool",
      name: toolCall.name,
      toolCallId: toolCall.id,
      content,
    };
  }
}

function modelView(result: ToolResult): Record<string, unknown> {
  let data = result.data;
  if (result.streams && data && typeof data === "object" && !Array.isArray(data)) {
    const { stdout: _stdout, stderr: _stderr, ...rest } = data as Record<string, unknown>;
    data = rest;
  }
  return {
    data,
    error: result.error,
    execution: result.execution,
    streams: result.streams,
    warnings: result.warnings,
    cache: result.cache,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars < 80) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 64)}\n...[truncated by tool batch result budget]`;
}
