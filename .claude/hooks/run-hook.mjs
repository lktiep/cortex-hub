#!/usr/bin/env node
// Cross-platform hook runner for Claude Code
// Delegates to .sh (macOS/Linux/Git Bash) or .ps1 (Windows native)
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { platform } from "os";

const hookName = process.argv[2];
if (!hookName) {
  console.error("Usage: run-hook.mjs <hook-name>");
  process.exit(0);
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || ".";
const hooksDir = join(projectDir, ".claude", "hooks");
const isWindows = platform() === "win32";

// Determine which script and shell to use
const shPath = join(hooksDir, `${hookName}.sh`);
const ps1Path = join(hooksDir, `${hookName}.ps1`);

let cmd, args;

if (isWindows && existsSync(ps1Path)) {
  cmd = "powershell.exe";
  args = ["-ExecutionPolicy", "Bypass", "-File", ps1Path];
} else if (existsSync(shPath)) {
  cmd = "bash";
  args = [shPath];
} else {
  // No hook file found — not an error, just skip
  process.exit(0);
}

try {
  execFileSync(cmd, args, {
    stdio: "inherit",
    env: process.env,
  });
} catch (err) {
  process.exit(err.status ?? 1);
}
