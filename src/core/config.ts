import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const forgeConfigSchema = z.object({
  version: z.literal(1),
  planning: z.object({
    requireAcceptanceCriteria: z.boolean(),
  }),
  execution: z.object({
    maxRepairs: z.number().int().min(0).max(5),
    maxRunMinutes: z.number().int().positive(),
  }),
});

export type ForgeConfig = z.infer<typeof forgeConfigSchema>;

export const defaultForgeConfig: ForgeConfig = {
  version: 1,
  planning: {
    requireAcceptanceCriteria: true,
  },
  execution: {
    maxRepairs: 2,
    maxRunMinutes: 15,
  },
};

export const forgeConfigPath = (cwd: string): string =>
  path.join(cwd, ".forge", "config.json");

export function loadForgeConfig(cwd: string): ForgeConfig {
  const configPath = forgeConfigPath(cwd);
  if (!fs.existsSync(configPath)) return defaultForgeConfig;

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const result = forgeConfigSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // Invalid configuration is handled as an absent configuration. The
    // generated defaults keep runs safe and predictable.
  }

  return defaultForgeConfig;
}

export function initializeForgeConfig(cwd: string): {
  path: string;
  created: boolean;
} {
  const configPath = forgeConfigPath(cwd);
  if (fs.existsSync(configPath)) {
    return { path: configPath, created: false };
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(defaultForgeConfig, null, 2)}\n`,
    "utf8"
  );
  return { path: configPath, created: true };
}
