import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@dreamcode/shared";
import type { ExternalAgent } from "./agents.js";
import { publicAgentData } from "./agent-protocol.js";

/** Native tool IDs remain stable. Receive time is labelled separately from product-owned timestamps. */
export class AgentEventNormalizer {
  private sessionId = randomUUID();
  private tools = new Map<string, string>();
  private completed = new Set<string>();
  terminal = false;
  failed = false;
  failureReason = "";
  finalText = "";
  constructor(
    readonly agent: ExternalAgent,
    private emit: (event: AgentEvent) => void,
  ) {}
  private event(type: AgentEvent["type"], payload: unknown, timestamp = new Date().toISOString()) {
    this.emit({
      id: randomUUID(),
      sessionId: this.sessionId,
      turnId: this.sessionId,
      type,
      timestamp,
      payload,
    });
  }
  private start(
    id: string,
    name: string,
    input: unknown,
    timestamp: string,
    timestampSource = "observed",
  ) {
    if (!id || !name) throw Error("Native tool event is missing ID or name");
    if (this.tools.has(id)) return;
    this.tools.set(id, name);
    this.event("model.tool_call", { toolCall: { id, name, input }, timestampSource }, timestamp);
    this.event("tool.started", { toolCallId: id, tool: name, timestampSource }, timestamp);
  }
  private finish(
    id: string,
    output: unknown,
    error: boolean,
    timestamp: string,
    timestampSource = "observed",
  ) {
    if (this.completed.has(id)) return;
    if (!this.tools.has(id)) throw Error(`Native tool result has no matching call: ${id}`);
    this.completed.add(id);
    this.event(
      "tool.completed",
      {
        toolCallId: id,
        tool: this.tools.get(id),
        status: error ? "error" : "success",
        output,
        summary: typeof output === "string" ? output : JSON.stringify(output),
        timestampSource,
      },
      timestamp,
    );
  }
  consume(raw: Record<string, any>, observedAt = new Date().toISOString()) {
    const record = publicAgentData(raw) as Record<string, any> | undefined;
    if (!record) return;
    if (this.agent === "claude-code") {
      if (record.type === "assistant")
        for (const block of record.message?.content ?? []) {
          if (block.type === "text") {
            this.finalText = block.text;
            this.event("assistant.message", { content: block.text }, observedAt);
          }
          if (block.type === "tool_use") this.start(block.id, block.name, block.input, observedAt);
        }
      if (record.type === "user")
        for (const block of record.message?.content ?? [])
          if (block.type === "tool_result")
            this.finish(block.tool_use_id, block.content, !!block.is_error, observedAt);
      if (record.type === "result") {
        this.terminal = true;
        this.failed = !!record.is_error;
        this.failureReason =
          (record.errors ?? []).join("; ") ||
          record.result ||
          record.subtype ||
          "Claude Code failed";
        if (record.result) {
          this.finalText = record.result;
          this.event("assistant.message", { content: record.result }, observedAt);
        }
      }
    } else if (this.agent === "pi") {
      if (record.type === "message_end" && record.message?.role === "assistant") {
        this.finalText = (record.message.content ?? [])
          .filter((block: any) => block.type === "text")
          .map((block: any) => block.text)
          .join("");
        if (this.finalText)
          this.event("assistant.message", { content: this.finalText }, observedAt);
        if (["error", "aborted"].includes(record.message.stopReason)) {
          this.failed = true;
          this.failureReason = record.message.errorMessage ?? record.message.stopReason;
        }
      }
      if (record.type === "tool_execution_start")
        this.start(record.toolCallId, record.toolName, record.args, observedAt);
      if (record.type === "tool_execution_end")
        this.finish(record.toolCallId, record.result, !!record.isError, observedAt);
      if (record.type === "agent_end") this.terminal = true;
    } else if (this.agent === "opencode") {
      const part = record.part ?? {};
      if (record.type === "text") {
        this.finalText = part.text ?? "";
        this.event("assistant.message", { content: this.finalText }, observedAt);
      }
      if (record.type === "tool_use") {
        const id = part.callID ?? part.id;
        this.start(id, part.tool, part.state?.input, observedAt);
        if (["completed", "error"].includes(part.state?.status))
          this.finish(
            id,
            part.state.output ?? part.state.error,
            part.state.status === "error",
            observedAt,
          );
      }
      if (record.type === "step_finish" && part.reason === "stop") this.terminal = true;
      if (record.type === "error") {
        this.failed = true;
        this.failureReason = JSON.stringify(record.error);
      }
    } else {
      // SDK notifications carry committed session events; final-response is emitted only after SDK idle.
      if (record.type === "dsh.result") {
        this.terminal = true;
        this.finalText = record.finalResponse ?? "";
        this.event("assistant.message", { content: this.finalText }, observedAt);
      }
      const event = record.method === "session.event" ? record.params?.event : null;
      if (event) this.dshEvent(event, observedAt);
    }
  }
  private dshEvent(event: Record<string, any>, timestamp: string) {
    const data = event.data ?? event;
    const source = typeof event.time === "number" ? "native" : "observed";
    if (typeof event.time === "number" && Number.isFinite(event.time))
      timestamp = new Date(event.time).toISOString();
    if (event.type === "assistant/message")
      for (const block of data.content ?? data.message?.content ?? []) {
        if (block.type === "text")
          this.event("assistant.message", { content: block.text }, timestamp);
      }
    if (["tool/call", "tool/started"].includes(event.type)) {
      let input = data.input ?? data.arguments;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          /* retain malformed native arguments */
        }
      }
      this.start(
        data.callId ?? data.toolCallId ?? data.id,
        data.name ?? data.tool,
        input,
        timestamp,
        source,
      );
    }
    if (["tool/result", "tool/completed"].includes(event.type))
      this.finish(
        data.message?.callId ?? data.message?.toolCallId ?? data.callId ?? data.toolCallId,
        data.message?.content ?? data.result ?? data.output,
        !!(data.message?.isError ?? data.isError),
        timestamp,
        source,
      );
    if (["agent/error", "agent/failed"].includes(event.type)) {
      this.failed = true;
      this.failureReason = JSON.stringify(event.error);
    }
  }
  verify() {
    if (!this.terminal)
      throw Error(
        "Framework exited without a terminal result; cannot infer task completion from exit code",
      );
    if (this.failed) throw Error(`Framework reported failure: ${this.failureReason}`);
    const pending = [...this.tools.keys()].filter((id) => !this.completed.has(id));
    if (pending.length) throw Error(`Framework tool trace is incomplete: ${pending.join(", ")}`);
    this.event("turn.completed", { finalText: this.finalText });
  }
}
