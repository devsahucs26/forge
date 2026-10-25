import { execFile } from "node:child_process";

async function execGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        "git",
        args,
        {
          cwd,
          timeout: 15_000,
          windowsHide: true,
        },
        (err, stdout) => {
          if (err) {
            resolve(null);
          } else {
            resolve(typeof stdout === "string" ? stdout : String(stdout ?? ""));
          }
        }
      );
      child.stdin?.end();
    } catch {
      resolve(null);
    }
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const out = await execGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return out?.trim() === "true";
}

export async function getStatus(
  cwd: string
): Promise<{ clean: boolean; changedFiles: string[] }> {
  const out = await execGit(cwd, ["status", "--porcelain"]);
  if (out === null) {
    return { clean: false, changedFiles: [] };
  }

  const changedFiles = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const pathPart = line.slice(2).trim();
      const target = pathPart.includes(" -> ")
        ? pathPart.split(" -> ").pop()!.trim()
        : pathPart;
      return target.replace(/^["']|["']$/g, "");
    })
    .filter(Boolean);

  return {
    clean: changedFiles.length === 0,
    changedFiles,
  };
}

export async function getHead(cwd: string): Promise<string | null> {
  const out = await execGit(cwd, ["rev-parse", "HEAD"]);
  return out ? out.trim() : null;
}

export async function getChangedSince(
  cwd: string,
  startHead: string | null
): Promise<string[]> {
  const changed = new Set<string>();

  try {
    const status = await getStatus(cwd);
    for (const file of status.changedFiles) {
      changed.add(file);
    }

    const currentHead = await getHead(cwd);

    if (startHead && currentHead && startHead !== currentHead) {
      const diffOut = await execGit(cwd, [
        "diff",
        "--name-only",
        startHead,
        currentHead,
      ]);
      if (diffOut) {
        for (const file of diffOut
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)) {
          changed.add(file);
        }
      }
    } else if (!startHead && currentHead) {
      const logOut = await execGit(cwd, [
        "log",
        "--name-only",
        "--format=",
        currentHead,
      ]);
      if (logOut) {
        for (const file of logOut
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)) {
          changed.add(file);
        }
      }
    }
  } catch {
    // Return safe default / collected files on error
  }

  return Array.from(changed);
}
