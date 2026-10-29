import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultForgeConfig,
  forgeConfigPath,
  initializeForgeConfig,
  loadForgeConfig,
} from "../src/core/config.js";
import { initProject } from "../src/commands/init.js";

describe("Forge configuration", () => {
  it("initializes a project with conservative defaults", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-config-test-"));
    try {
      const result = initializeForgeConfig(cwd);
      expect(result.created).toBe(true);
      expect(loadForgeConfig(cwd)).toEqual(defaultForgeConfig);
      expect(JSON.parse(fs.readFileSync(forgeConfigPath(cwd), "utf8"))).toEqual(
        defaultForgeConfig
      );

      const second = initializeForgeConfig(cwd);
      expect(second.created).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing configuration", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-config-test-"));
    try {
      fs.mkdirSync(path.join(cwd, ".forge"));
      const config = {
        ...defaultForgeConfig,
        execution: { maxRepairs: 4, maxRunMinutes: 10 },
      };
      fs.writeFileSync(forgeConfigPath(cwd), JSON.stringify(config));
      expect(initializeForgeConfig(cwd).created).toBe(false);
      expect(loadForgeConfig(cwd)).toEqual(config);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("init command reports an already initialized project", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-config-test-"));
    try {
      await initProject(cwd);
      await initProject(cwd);
      expect(fs.existsSync(forgeConfigPath(cwd))).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
