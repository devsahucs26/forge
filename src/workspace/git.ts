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

export type GitFileStatus = {
  path: string;
  status: string;
  type: "tracked" | "untracked";
  origPath?: string;
};

export type GitStatusResult = {
  clean: boolean;
  changedFiles: string[];
  files: GitFileStatus[];
  trackedFiles: string[];
  untrackedFiles: string[];
};

export async function getStatus(cwd: string): Promise<GitStatusResult> {
  const out = await execGit(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "-uall",
  ]);
  if (out === null) {
    return {
      clean: false,
      changedFiles: [],
      files: [],
      trackedFiles: [],
      untrackedFiles: [],
    };
  }

  const files: GitFileStatus[] = [];

  if (out.includes("\0")) {
    const tokens = out.split("\0");
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      if (!token) {
        i++;
        continue;
      }

      const statusCode = token.slice(0, 2);
      const filePath = token.slice(3);
      if (!filePath) {
        i++;
        continue;
      }

      const isRenameOrCopy =
        statusCode.includes("R") || statusCode.includes("C");
      let origPath: string | undefined;
      if (isRenameOrCopy && i + 1 < tokens.length) {
        origPath = tokens[i + 1] || undefined;
        i++;
      }

      const isUntracked = statusCode === "??";
      files.push({
        path: filePath,
        status: statusCode,
        type: isUntracked ? "untracked" : "tracked",
        ...(origPath ? { origPath } : {}),
      });

      i++;
    }
  } else {
    // Fallback for non-NUL (e.g. mocked newline-separated status output)
    const lines = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const statusCode = line.slice(0, 2);
      const pathPart = line.slice(2).trim();
      let target = pathPart;
      let origPath: string | undefined;

      if (pathPart.includes(" -> ")) {
        const parts = pathPart.split(" -> ");
        origPath = parts[0]?.trim().replace(/^["']|["']$/g, "");
        target = parts[1]?.trim().replace(/^["']|["']$/g, "");
      } else {
        target = target.replace(/^["']|["']$/g, "");
      }

      if (!target) continue;
      const isUntracked = statusCode === "??";
      files.push({
        path: target,
        status: statusCode,
        type: isUntracked ? "untracked" : "tracked",
        ...(origPath ? { origPath } : {}),
      });
    }
  }

  const changedFiles = files.map((f) => f.path);
  const trackedFiles = files
    .filter((f) => f.type === "tracked")
    .map((f) => f.path);
  const untrackedFiles = files
    .filter((f) => f.type === "untracked")
    .map((f) => f.path);

  return {
    clean: files.length === 0,
    changedFiles,
    files,
    trackedFiles,
    untrackedFiles,
  };
}

export async function getHead(cwd: string): Promise<string | null> {
  const out = await execGit(cwd, ["rev-parse", "HEAD"]);
  return out ? out.trim() : null;
}

export async function getCommittedSince(
  cwd: string,
  startHead: string | null
): Promise<string[]> {
  const committed = new Set<string>();

  try {
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
          committed.add(file);
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
          committed.add(file);
        }
      }
    }
  } catch {
    // Return safe default / collected files on error
  }

  return Array.from(committed);
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

    const committed = await getCommittedSince(cwd, startHead);
    for (const file of committed) {
      changed.add(file);
    }
  } catch {
    // Return safe default / collected files on error
  }

  return Array.from(changed);
}
