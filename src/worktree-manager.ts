// ─── Git Worktree Manager ───
// Enables parallel agent execution by giving each task group
// an isolated git worktree from a shared bare clone.
//
// Layout:
//   /opt/remote-agent/repos/<repo-hash>/      ← shared bare clone
//   /opt/remote-agent/groups/<folder>/workspace/ ← per-task worktree
//
// This module is used by the Group API on the RemoteAgent droplet.

import crypto from "crypto";
import { execSync, exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { runGitWithToken, sanitizeGitUrl, sanitizeBareCloneRemote } from "./git-auth.js";

const REPOS_DIR = process.env.REPOS_DIR || "/opt/remote-agent/repos";
const GROUPS_DIR = process.env.GROUPS_DIR || "/opt/remote-agent/groups";

export interface WorktreeInfo {
  folder: string;
  branch: string;
  worktreePath: string;
  bareClonePath: string;
  repoUrl: string;
  createdAt: string;
}

export interface WorktreeResult {
  ok: boolean;
  worktreePath?: string;
  branch?: string;
  bareClonePath?: string;
  error?: string;
}

/** Hash a repo URL to a stable directory name */
function repoHash(repoUrl: string): string {
  return crypto.createHash("sha256").update(repoUrl).digest("hex").slice(0, 16);
}

/** Run a shell command, return stdout */
function run(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    cwd,
    encoding: "utf-8",
    timeout: 120_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

/** Run a shell command asynchronously */
function runAsync(cmd: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      cmd,
      {
        cwd,
        encoding: "utf-8",
        timeout: 120_000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) => {
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
 * Ensure a shared bare clone exists for the given repo URL.
 * If it already exists, fetch the latest changes.
 */
export function ensureBareClone(repoUrl: string, githubToken?: string): string {
  if (!fs.existsSync(REPOS_DIR)) {
    fs.mkdirSync(REPOS_DIR, { recursive: true });
  }

  const hash = repoHash(repoUrl);
  const bareDir = path.join(REPOS_DIR, hash);

  // SECURITY: Never embed tokens in URLs — use GIT_ASKPASS for auth
  const cleanUrl = sanitizeGitUrl(repoUrl);

  if (fs.existsSync(path.join(bareDir, "HEAD"))) {
    // Already cloned — sanitize any legacy embedded tokens in remote URL
    sanitizeBareCloneRemote(bareDir, cleanUrl);

    // Fetch latest with per-operation token via GIT_ASKPASS
    try {
      if (githubToken) {
        runGitWithToken(`git fetch --all --prune`, githubToken, bareDir);
      } else {
        run(`git fetch --all --prune`, bareDir);
      }
    } catch (e) {
      // Fetch failures are non-fatal; we still have the local clone
      // SECURITY: sanitize URL in error output
      console.error(`[worktree] Fetch failed for ${sanitizeGitUrl(repoUrl)}: ${(e as Error).message}`);
    }
  } else {
    // Fresh bare clone — always use clean URL with GIT_ASKPASS
    if (githubToken) {
      runGitWithToken(`git clone --bare "${cleanUrl}" "${bareDir}"`, githubToken);
    } else {
      run(`git clone --bare "${cleanUrl}" "${bareDir}"`);
    }

    // Store the original URL (without token) as metadata
    fs.writeFileSync(path.join(bareDir, "delegate-repo-url"), cleanUrl);
  }

  return bareDir;
}

/**
 * Create a git worktree for a specific task group.
 * Creates a new branch `agent/<folder>` from the default branch.
 */
export function createWorktree(
  bareClonePath: string,
  folder: string,
  opts?: { branch?: string; baseBranch?: string }
): WorktreeResult {
  const groupDir = path.join(GROUPS_DIR, folder);
  const worktreePath = path.join(groupDir, "workspace");

  // Already exists?
  if (fs.existsSync(worktreePath) && fs.existsSync(path.join(worktreePath, ".git"))) {
    const branch = run("git rev-parse --abbrev-ref HEAD", worktreePath);
    return { ok: true, worktreePath, branch, bareClonePath };
  }

  // Ensure parent dir exists
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }

  // Determine default branch
  const baseBranch =
    opts?.baseBranch || detectDefaultBranch(bareClonePath);

  // Branch name
  const branchName = opts?.branch || `agent/${folder}`;

  try {
    // Create a new branch from the base branch
    // First check if branch already exists
    try {
      run(`git show-ref --verify refs/heads/${branchName}`, bareClonePath);
      // Branch exists — just create worktree from it
      run(
        `git worktree add "${worktreePath}" "${branchName}"`,
        bareClonePath
      );
    } catch {
      // Branch doesn't exist — create new from base
      // In bare clones, branches are refs/heads/<name>, not refs/remotes/origin/<name>
      // Try both patterns for compatibility
      try {
        run(
          `git worktree add -b "${branchName}" "${worktreePath}" "origin/${baseBranch}"`,
          bareClonePath
        );
      } catch {
        run(
          `git worktree add -b "${branchName}" "${worktreePath}" "${baseBranch}"`,
          bareClonePath
        );
      }
    }

    // SECURITY: Never persist credentials to metadata — sanitize URLs
    const meta = {
      folder,
      branch: branchName,
      baseBranch,
      worktreePath,
      bareClonePath,
      repoUrl: sanitizeGitUrl(readRepoUrl(bareClonePath)),
      createdAt: new Date().toISOString(),
    };

    // Write metadata
    fs.writeFileSync(
      path.join(groupDir, "worktree-meta.json"),
      JSON.stringify(meta, null, 2)
    );

    return { ok: true, worktreePath, branch: branchName, bareClonePath };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/**
 * Remove a worktree for a task group.
 */
export function removeWorktree(bareClonePath: string, folder: string): { ok: boolean; error?: string } {
  const groupDir = path.join(GROUPS_DIR, folder);
  const worktreePath = path.join(groupDir, "workspace");

  try {
    if (fs.existsSync(worktreePath)) {
      // Let git clean up its tracking
      try {
        run(`git worktree remove --force "${worktreePath}"`, bareClonePath);
      } catch {
        // Force remove if git worktree command fails
        fs.rmSync(worktreePath, { recursive: true, force: true });
        try {
          run("git worktree prune", bareClonePath);
        } catch {
          // Non-fatal
        }
      }
    }

    // Clean up metadata
    const metaPath = path.join(groupDir, "worktree-meta.json");
    if (fs.existsSync(metaPath)) {
      fs.unlinkSync(metaPath);
    }

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/**
 * List all active worktrees for a bare clone.
 */
export function listWorktrees(bareClonePath: string): WorktreeInfo[] {
  try {
    const output = run("git worktree list --porcelain", bareClonePath);
    const worktrees: WorktreeInfo[] = [];
    const repoUrl = readRepoUrl(bareClonePath);

    // Parse porcelain output
    const blocks = output.split("\n\n").filter(Boolean);
    for (const block of blocks) {
      const lines = block.split("\n");
      const worktreeLine = lines.find((l) => l.startsWith("worktree "));
      const branchLine = lines.find((l) => l.startsWith("branch "));

      if (!worktreeLine || !branchLine) continue;

      const worktreePath = worktreeLine.replace("worktree ", "");
      const branch = branchLine.replace("branch refs/heads/", "");

      // Skip the bare repo itself
      if (worktreePath === bareClonePath) continue;

      // Derive folder from worktree path
      const folder = path.basename(path.dirname(worktreePath));

      // Read metadata
      const metaPath = path.join(GROUPS_DIR, folder, "worktree-meta.json");
      let createdAt = "";
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        createdAt = meta.createdAt || "";
      } catch {
        // No metadata
      }

      worktrees.push({
        folder,
        branch,
        worktreePath,
        bareClonePath,
        repoUrl,
        createdAt,
      });
    }

    return worktrees;
  } catch {
    return [];
  }
}

/**
 * Async version of ensureBareClone + createWorktree for non-blocking API use.
 */
export async function setupWorktreeAsync(
  repoUrl: string,
  folder: string,
  opts?: { branch?: string; baseBranch?: string; githubToken?: string }
): Promise<WorktreeResult> {
  try {
    const bareClonePath = ensureBareClone(repoUrl, opts?.githubToken);
    return createWorktree(bareClonePath, folder, opts);
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ─── Helpers ───

function detectDefaultBranch(bareClonePath: string): string {
  try {
    const ref = run("git symbolic-ref refs/remotes/origin/HEAD", bareClonePath);
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // Bare clones have branches at refs/heads/, not refs/remotes/origin/
    // Try both patterns for compatibility
    try {
      run("git show-ref --verify refs/heads/main", bareClonePath);
      return "main";
    } catch {
      // noop
    }
    try {
      run("git show-ref --verify refs/remotes/origin/main", bareClonePath);
      return "main";
    } catch {
      // noop
    }
    return "master";
  }
}

function readRepoUrl(bareClonePath: string): string {
  try {
    return fs.readFileSync(path.join(bareClonePath, "delegate-repo-url"), "utf-8").trim();
  } catch {
    try {
      return run("git config --get remote.origin.url", bareClonePath);
    } catch {
      return "";
    }
  }
}
