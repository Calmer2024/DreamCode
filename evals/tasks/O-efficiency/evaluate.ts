import type { CustomEvaluator } from "../../../packages/evals/src/index";

export const evaluate: CustomEvaluator = async ({ task, events }) => {
  if (task.id === "U01-runtime-process") {
    const calls = events
      .filter((event) => event.type === "model.tool_call")
      .map((event) => (event.payload as { toolCall?: { name?: string } }).toolCall?.name);
    const passed = !calls.some((call) =>
      /^(runtime|process|shell)[._]/.test(call ?? ""),
    );
    return [
      {
        passed,
        detail: passed
          ? "platform shell preceded a successful Node version check"
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
    const passed =
      tools.includes(process.platform === "win32" ? "pwsh" : "bash") &&
      tools.includes("job_output") &&
      tools.includes("job_list") &&
      tools.includes("job_kill") &&
      !tools.some((tool) =>
        /^(runtime|process|shell)[._]/.test(tool),
      );
    return [
      {
        passed,
        detail: passed
          ? "the core coding tools and progressive Skill loader were exposed"
          : `exposed tools: ${tools.join(", ")}`,
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
