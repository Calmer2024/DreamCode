import type { CustomEvaluator } from "../../../packages/evals/src/index";

export const evaluate: CustomEvaluator = async ({ task, events }) => {
  if (task.id === "U01-runtime-process") {
    const calls = events
      .filter((event) => event.type === "model.tool_call")
      .map((event) => (event.payload as { toolCall?: { name?: string } }).toolCall?.name);
    const processCompleted = events.some(
      (event) =>
        event.type === "tool.completed" &&
        (event.payload as { tool?: string; status?: string }).tool === "process.run" &&
        (event.payload as { status?: string }).status === "success",
    );
    const passed =
      calls.includes("runtime.info") &&
      calls.includes("process.run") &&
      !calls.includes("shell.run") &&
      processCompleted;
    return [
      {
        passed,
        detail: passed
          ? "runtime.info preceded a successful process.run without shell trial"
          : `unexpected runtime path: ${calls.join(", ")}`,
        hardFailure: false,
      },
    ];
  }

  if (task.id === "U02-read-cache") {
    const starts = events.filter(
      (event) =>
        event.type === "tool.started" && (event.payload as { tool?: string }).tool === "file.read",
    );
    const cacheHit = events.some(
      (event) =>
        event.type === "tool.completed" &&
        (event.payload as { tool?: string; cached?: boolean }).tool === "file.read" &&
        (event.payload as { cached?: boolean }).cached === true,
    );
    const passed = starts.length === 1 && cacheHit;
    return [
      {
        passed,
        detail: `file.read starts=${starts.length}, compact cache hit=${cacheHit}`,
        hardFailure: false,
      },
    ];
  }

  if (task.id === "U03-core-tool-exposure") {
    const started = events.find((event) => event.type === "model.started");
    const tools = (started?.payload as { tools?: string[] } | undefined)?.tools ?? [];
    const optional = tools.filter((tool) => tool.startsWith("web.") || tool.startsWith("mcp."));
    const passed =
      tools.includes("runtime.info") &&
      tools.includes("process.run") &&
      tools.includes("skill.load") &&
      optional.length === 0;
    return [
      {
        passed,
        detail: passed
          ? "the core coding tools and progressive Skill loader were exposed"
          : `optional tools: ${optional.join(", ")}`,
        hardFailure: false,
      },
    ];
  }

  const usage = events.find((event) => event.type === "model.usage")?.payload as
    | {
        usage?: {
          inputTokens?: number;
          cachedInputTokens?: number;
          uncachedInputTokens?: number;
        };
      }
    | undefined;
  const passed =
    usage?.usage?.inputTokens === 1_000 &&
    usage.usage.cachedInputTokens === 800 &&
    usage.usage.uncachedInputTokens === 200;
  return [
    {
      passed,
      detail: passed ? "cached usage breakdown was preserved" : "cached usage breakdown was lost",
      hardFailure: false,
    },
  ];
};
