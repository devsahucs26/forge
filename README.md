# Forge

[![CI](https://github.com/devsahucs26/forge/actions/workflows/ci.yml/badge.svg)](https://github.com/devsahucs26/forge/actions/workflows/ci.yml)

**Forge is an early-stage, open-source command-line tool that wraps the [OpenCode](https://opencode.ai) coding agent in a safety and verification loop.**

You give it a task in plain English. Forge hands the task to OpenCode, then runs your project's own checks (type check and tests) and reports what really happened, instead of trusting the agent's claim that it worked.

> **Status: early development (pre-release).** Forge is not published to npm yet, the command set is small, and the interface may change. Use it on projects under Git, and review every change.

## What it does today

| Command | What it does |
| --- | --- |
| `forge doctor` | Checks that Node.js, npm, Git and OpenCode are installed and runnable, and prints their versions. |
| `forge run "<task>"` | Runs a task through OpenCode, verifies the result, repairs failures within a limit, and reports exactly which files changed. |

`forge init` exists as a placeholder and does nothing yet.

### How `forge run` works

1. **Safety check.** It refuses to start unless the folder is a Git repository with a clean working tree (override with `--allow-dirty`), so every change the agent makes is visible in `git diff`.
2. **Agent run.** It calls `opencode run` with your task. The prompt is passed as a single argument and never goes through a shell.
3. **Verification.** It runs `npm run typecheck` and `npm test` itself and records the real exit codes and output. Missing scripts are reported as skipped, never as passed.
4. **Bounded repair.** If a check fails, it sends the failure details back to the agent for up to `--max-repairs` attempts (default 2, maximum 5). It stops early if a repair makes no progress, or after 15 minutes in total.
5. **Report.** It prints a verdict, the files the run changed, and the exact commands you could use to undo the change. Forge never runs those commands itself. It also saves a JSON report of the run under `.forge/runs/`.

Verdicts:

- `VERIFIED`: every check passed.
- `FAILED`: a check failed or timed out.
- `UNVERIFIED`: nothing failed, but at least one check was skipped or none exist.

The exit code is `0` only for `VERIFIED`.

### Options

```
forge run [options] <task>

  --allow-dirty       Allow running with uncommitted changes
  --max-repairs <n>   Maximum repair attempts, 0 to 5 (default: 2)
```

## Requirements

- **Node.js 24** (the version CI tests against) and npm
- **Git**
- **[OpenCode](https://opencode.ai)**, installed and connected to a model provider. Forge was developed against OpenCode 1.19.4. Forge does not provide a model or any free inference, and your provider's limits and costs apply.
- Your project needs `typecheck` and `test` scripts in its `package.json` for Forge to verify anything.

Forge is developed on Windows with PowerShell. CI runs the test suite on Windows and Ubuntu. macOS is untested.

## Install from source

There is no published package yet.

```bash
git clone https://github.com/devsahucs26/forge.git
cd forge
npm ci
npm run dev -- doctor
```

Run Forge from the root of the project you want to change:

```bash
npm run dev -- run "Add a function add(a, b) in src/math.ts and a unit test for it"
```

Until a `forge` binary is packaged, the `npm run dev -- ...` form is how you run it.

## Safety model

Forge executes code and lets an AI edit your files, so it is conservative by default.

- It never uses a shell, `cmd.exe` or `shell: true`. Programs are started with argument arrays.
- It refuses to run on a dirty Git tree unless you opt in.
- It never resets, cleans, restores or deletes anything for you. Undo commands are printed, not run.
- It reports changed files even when the agent fails or times out.
- Run reports redact common secret patterns (API keys, bearer tokens, `KEY=`/`TOKEN=`/`PASSWORD=` assignments) and store only a short tail of each check's output, not the agent's full output. Redaction is pattern-based and not a guarantee, so don't share reports without reading them.
- `.forge/` is listed in `.gitignore`. Keep it there.

**What `VERIFIED` means.** Only that your type check and tests passed. It does not prove the change is correct if the tests don't cover it. Review the diff.

## Development

```bash
npm ci
npm run typecheck
npm test
```

The test suite fakes OpenCode, `npm` and (mostly) Git, so it needs no AI provider, network access or API key. One integration test creates a real temporary Git repository. Tests must never write into the real project folder.

Project layout:

```
src/
  index.ts             CLI entry point
  commands/            doctor, run
  adapters/opencode.ts OpenCode process wrapper
  verification/        check runner, default checks, report formatting
  workspace/git.ts     Git status and change detection
  core/                text helpers, run report store
tests/                 unit and integration tests (Vitest)
```

## Roadmap

Planned, in rough order. None of this is promised or dated.

- `forge status` and `forge report` to read saved run reports
- Record the model, provider and tool versions in each report
- `forge init` with a per-project config file, including custom checks
- Model and provider listing
- Curated skills, MCP servers and profiles, installed only with your approval
- A benchmark suite to measure whether extra orchestration (planning, multi-agent roles) actually beats a single agent before any of it becomes a default

## Contributing

Issues and pull requests are welcome once the project settles. Please keep changes small, add tests, and don't add dependencies without a reason.

## License

No license has been chosen yet, so by default all rights are reserved. Add a `LICENSE` file (MIT and Apache-2.0 are common choices) before inviting reuse or contributions.

## Acknowledgements

Forge is built on top of [OpenCode](https://opencode.ai) and uses [Commander](https://github.com/tj/commander.js), [Zod](https://zod.dev) and [Vitest](https://vitest.dev).
