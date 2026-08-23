import type { CustomEvaluator } from "../../../../packages/evals/src/index";

export const evaluate: CustomEvaluator = async ({ events }) => {
  const terminal = events.find((event) =>
    ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type),
  );
  return [
    {
      passed: Boolean(terminal),
      detail: terminal ? `terminal event: ${terminal.type}` : "missing terminal event",
      hardFailure: false,
    },
  ];
};
