import type { loadDreamCodeConfig } from "@dreamcode/store";

const families: Record<string, string[]> = {
  mimo: ["mimo-v2.5", "mimo-v2.5-pro"],
  deepseek: ["deepseek-flash", "deepseek-v4-pro"],
};
/** Explicit model profiles win; siblings may reuse a unique configured provider account. */
export function configuredProfileEntries(config: Awaited<ReturnType<typeof loadDreamCodeConfig>>) {
  const profiles = Object.entries(config.profiles).filter(
    ([, profile]) =>
      profile.model && (profile.apiKey || (profile.apiKeyEnv && process.env[profile.apiKeyEnv])),
  );
  const models = [
    ...new Set(
      profiles.flatMap(([, profile]) => [profile.model!, ...(families[profile.provider] ?? [])]),
    ),
  ];
  return models.flatMap((model) => {
    const exact = profiles.filter(([, profile]) => profile.model === model);
    const matches = exact.length
      ? exact
      : profiles.filter(([, profile]) => families[profile.provider]?.includes(model));
    return matches.map(([id, profile]) => ({
      id: profile.model === model ? id : `${id}:${model}`,
      model,
      profile,
    }));
  });
}
