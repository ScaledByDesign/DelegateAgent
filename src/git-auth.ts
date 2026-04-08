// ─── Git Authentication via GIT_ASKPASS ───
// Provides per-operation token injection for git commands.
// Tokens are NEVER embedded in URLs or persisted to .git/config.
// Uses GIT_ASKPASS + env var pattern for secure credential passing.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync, exec, type ExecSyncOptions } from "child_process";

/**
 * Create a temporary GIT_ASKPASS script that echoes a token.
 * The script reads the token from the GIT_AUTH_TOKEN env var (set per-invocation).
 * Returns the path to the script (caller must clean up).
 */
export function createAskPassScript(): string {
  const scriptPath = path.join(
    os.tmpdir(),
    `git-askpass-${process.pid}-${Date.now()}.sh`
  );
  // The script echoes the token from env — never from disk
  fs.writeFileSync(scriptPath, '#!/bin/sh\necho "$GIT_AUTH_TOKEN"\n', {
    mode: 0o700,
  });
  return scriptPath;
}

/**
 * Build the environment object for authenticated git operations.
 * Uses a credential helper script that echoes protocol/host/username/password
 * to git's credential subsystem. This works for bare clones and all git operations.
 */
function buildGitAuthEnv(
  token: string,
  askPassScript: string
): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: askPassScript,
    GIT_AUTH_TOKEN: token,
    // Use a credential helper that provides the token
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: `!f() { echo "username=x-token"; echo "password=$GIT_AUTH_TOKEN"; }; f`,
  };
}

/**
 * Run a git command synchronously with per-operation token injection via GIT_ASKPASS.
 * Token is passed via environment variable, never via URL or disk.
 */
export function runGitWithToken(
  cmd: string,
  token: string,
  cwd?: string,
  askPassScript?: string
): string {
  const ownScript = !askPassScript;
  const script = askPassScript || createAskPassScript();
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: 120_000,
      env: buildGitAuthEnv(token, script),
    }).trim();
  } finally {
    if (ownScript) {
      try {
        fs.unlinkSync(script);
      } catch {
        /* cleanup best-effort */
      }
    }
  }
}

/**
 * Run a git command asynchronously with per-operation token injection via GIT_ASKPASS.
 */
export function runGitWithTokenAsync(
  cmd: string,
  token: string,
  cwd?: string,
  askPassScript?: string
): Promise<string> {
  const ownScript = !askPassScript;
  const script = askPassScript || createAskPassScript();
  return new Promise((resolve, reject) => {
    exec(
      cmd,
      {
        cwd,
        encoding: "utf-8",
        timeout: 120_000,
        env: buildGitAuthEnv(token, script),
      },
      (error, stdout, stderr) => {
        if (ownScript) {
          try {
            fs.unlinkSync(script);
          } catch {
            /* cleanup best-effort */
          }
        }
        if (error) {
          reject(new Error(`${error.message}\n${stderr}`));
        } else {
          resolve(stdout.trim());
        }
      }
    );
  });
}

/**
 * Sanitize a URL by removing any embedded credentials.
 * Use before logging or storing URLs — NEVER log raw repo URLs.
 */
export function sanitizeGitUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    // Not a valid URL, return as-is but mask potential tokens
    return url.replace(/\/\/[^@]+@/, "//***@");
  }
}

/**
 * Sanitize legacy bare clones that have embedded tokens in remote URLs.
 * Replaces the remote origin URL with a clean (credential-free) version.
 * Non-fatal — bare clone is still usable even if sanitization fails.
 */
export function sanitizeBareCloneRemote(
  bareDir: string,
  cleanUrl: string
): void {
  try {
    execSync(`git remote set-url origin "${cleanUrl}"`, {
      cwd: bareDir,
      encoding: "utf-8",
      timeout: 10_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch {
    // Non-fatal — bare clone still usable
  }
}
