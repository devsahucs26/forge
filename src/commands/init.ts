import { Command } from "commander";
import { initializeForgeConfig } from "../core/config.js";

export async function initProject(cwd: string = process.cwd()): Promise<void> {
  const result = initializeForgeConfig(cwd);
  if (result.created) {
    console.log(`Forge initialized: ${result.path}`);
  } else {
    console.log(`Forge already initialized: ${result.path}`);
  }
}

export const initCommand = new Command("init")
  .description("Initialize Forge configuration in the current project")
  .action(async () => {
    await initProject();
  });
