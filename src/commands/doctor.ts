import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";

const execFileAsync = promisify(execFile);

export interface ToolCheckResult {
  tool: string;
  pass: boolean;
  version?: string;
}

const TOOLS_TO_CHECK = ["node", "npm", "git", "opencode"];

export async function checkTool(tool: string): Promise<ToolCheckResult> {
  const isWindows = process.platform === "win32";

  try {
    let file = tool;
    let args = ["--version"];

    // On Windows, npm and opencode are typically .cmd launchers which cannot be
    // spawned directly without a shell in Node.js (throws EINVAL). We invoke them safely via cmd.exe.
    if (isWindows && (tool === "npm" || tool === "opencode")) {
      file = process.env.ComSpec || "cmd.exe";
      args = ["/d", "/s", "/c", tool, "--version"];
    }

    const { stdout } = await execFileAsync(file, args, {
      timeout: 5000,
      windowsHide: true,
    });

    const version = stdout.trim().split("\n")[0]?.trim() || stdout.trim();
    return { tool, pass: true, version };
  } catch (err: unknown) {
    if (
      isWindows &&
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "EINVAL"
    ) {
      try {
        const { stdout } = await execFileAsync(
          process.env.ComSpec || "cmd.exe",
          ["/d", "/s", "/c", tool, "--version"],
          {
            timeout: 5000,
            windowsHide: true,
          }
        );
        const version = stdout.trim().split("\n")[0]?.trim() || stdout.trim();
        return { tool, pass: true, version };
      } catch {
        return { tool, pass: false };
      }
    }
    return { tool, pass: false };
  }
}

export async function runDoctor(): Promise<void> {
  let anyMissing = false;

  for (const tool of TOOLS_TO_CHECK) {
    const result = await checkTool(tool);
    if (result.pass && result.version) {
      console.log(`${result.tool}: PASS (${result.version})`);
    } else {
      console.log(`${result.tool}: MISSING`);
      anyMissing = true;
    }
  }

  if (anyMissing) {
    process.exitCode = 1;
  }
}

export const doctorCommand = new Command("doctor")
  .description("Check that required external tools are installed and working")
  .action(async () => {
    await runDoctor();
  });
