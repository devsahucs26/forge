import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type AgentResult = {
  success: boolean;
  output: string;
  error: string;
  timedOut: boolean;
};

interface ResolvedExecutable {
  file: string;
  argsPrefix: string[];
}

async function resolveOpenCodeOnWindows(): Promise<ResolvedExecutable | null> {
  // 1. Try finding paths via where.exe
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("where.exe", ["opencode"], { windowsHide: true }, (err, out) => {
        if (err) return reject(err);
        resolve(out);
      });
    });

    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      // If where found an actual .exe
      if (line.toLowerCase().endsWith(".exe") && fs.existsSync(line)) {
        return { file: line, argsPrefix: [] };
      }

      const dir = path.dirname(line);

      // Check standard npm structure: <npm-dir>/node_modules/opencode-ai/bin/opencode.exe
      const candidateOpencodeAi = path.join(dir, "node_modules", "opencode-ai", "bin", "opencode.exe");
      if (fs.existsSync(candidateOpencodeAi)) {
        return { file: candidateOpencodeAi, argsPrefix: [] };
      }

      // Check <npm-dir>/node_modules/opencode/bin/opencode.exe
      const candidateOpencode = path.join(dir, "node_modules", "opencode", "bin", "opencode.exe");
      if (fs.existsSync(candidateOpencode)) {
        return { file: candidateOpencode, argsPrefix: [] };
      }

      // If line is a .cmd launcher, inspect for dp0 executable or JS entry script
      if (line.toLowerCase().endsWith(".cmd") && fs.existsSync(line)) {
        const content = fs.readFileSync(line, "utf-8");
        const dp0Match = content.match(/["']?%dp0%\\([^"'\r\n]+)["']?/);
        if (dp0Match && dp0Match[1]) {
          const resolved = path.join(dir, dp0Match[1].trim());
          if (fs.existsSync(resolved)) {
            if (resolved.toLowerCase().endsWith(".exe")) {
              return { file: resolved, argsPrefix: [] };
            }
            if (resolved.toLowerCase().endsWith(".js") || resolved.toLowerCase().endsWith(".mjs")) {
              return { file: process.execPath, argsPrefix: [resolved] };
            }
          }
        }
      }
    }
  } catch {
    // where.exe failed or command not found in PATH
  }

  // 2. Fallback check common Windows npm global directories
  const appData = process.env.APPDATA;
  if (appData) {
    const defaultGlobalExe = path.join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (fs.existsSync(defaultGlobalExe)) {
      return { file: defaultGlobalExe, argsPrefix: [] };
    }
    const altGlobalExe = path.join(appData, "npm", "node_modules", "opencode", "bin", "opencode.exe");
    if (fs.existsSync(altGlobalExe)) {
      return { file: altGlobalExe, argsPrefix: [] };
    }
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const localExe = path.join(localAppData, "opencode", "opencode.exe");
    if (fs.existsSync(localExe)) {
      return { file: localExe, argsPrefix: [] };
    }
  }

  return null;
}

function resolveOpenCodeOnUnix(): ResolvedExecutable {
  return { file: "opencode", argsPrefix: [] };
}

export async function runOpenCode(
  projectDirectory: string,
  prompt: string
): Promise<AgentResult> {
  try {
    const resolved =
      process.platform === "win32"
        ? await resolveOpenCodeOnWindows()
        : resolveOpenCodeOnUnix();

    if (!resolved) {
      return {
        success: false,
        output: "",
        error:
          "Could not safely resolve opencode executable or node entry script on Windows without a shell.",
        timedOut: false,
      };
    }

    const args = [...resolved.argsPrefix, "run", prompt];

    return await new Promise<AgentResult>((resolve) => {
      const child = execFile(
        resolved.file,
        args,
        {
          cwd: projectDirectory,
          timeout: 120_000,
          maxBuffer: 5 * 1024 * 1024,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const output = stdout ?? "";
          const errOutput = stderr ?? "";

          if (err) {
            const isMaxBuffer =
              err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
            const timedOut = Boolean(err.killed && !isMaxBuffer);
            const errorMessage = isMaxBuffer
              ? "Output exceeded 5 MB"
              : (errOutput.trim() || err.message);
            resolve({
              success: false,
              output,
              error: errorMessage,
              timedOut,
            });
          } else {
            resolve({
              success: true,
              output,
              error: errOutput,
              timedOut: false,
            });
          }
        }
      );

      child.stdin?.end();
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      output: "",
      error: errorMessage,
      timedOut: false,
    };
  }
}
