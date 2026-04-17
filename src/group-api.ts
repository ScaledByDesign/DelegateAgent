// ─── DELEGATE PATCH: Group Registration + Context Push + Worktree + MCP HTTP API ───
// Exposes POST /api/groups, POST /api/context/:folder, POST /api/worktree/:folder,
// and POST /api/mcp-config/:folder on a configurable port so Delegate can register
// task-specific groups at runtime, push context, manage worktrees, and inject MCP config.
//
// This file is appended to NanoClaw/RemoteAgent's src/index.ts at deploy time.
// It uses NanoClaw's internal registerGroup() and getAllRegisteredGroups().

import http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { setupWorktreeAsync, removeWorktree, listWorktrees } from './worktree-manager.js';
import { writeMCPConfigDirect, writeMCPConfigForGroup } from './mcp-config-generator.js';
import { logger } from './logger.js';
import { getAllRegisteredGroups, setRegisteredGroup, getRegisteredGroup } from './db.js';
import { resolveTokenFromDelegate } from './credential-client.js';

const GROUPS_DIR = process.env.GROUPS_DIR || '/opt/nanoclaw/groups';

export function startGroupAPI(): void {
  const PORT = parseInt(process.env.GROUP_API_PORT || '3001', 10);
  const VALID_TOKENS = [
    process.env.DELEGATE_API_KEY,
    process.env.NANOCLAW_TOKEN,
  ].filter(Boolean) as string[];

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    // Auth: accept any valid Delegate/NanoClaw token
    const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
    if (!auth || !VALID_TOKENS.includes(auth)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/groups') {
      const groups = getAllRegisteredGroups();
      res.writeHead(200);
      res.end(JSON.stringify({ groups: Object.values(groups) }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/groups') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.jid || !data.name) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'jid and name required' }));
            return;
          }
          const existing = getAllRegisteredGroups();
          if (existing[data.jid]) {
            res.writeHead(409);
            res.end(JSON.stringify({ ok: true, existing: true, jid: data.jid }));
            return;
          }
          const folder = data.folder || data.jid.replace(/[^a-zA-Z0-9-]/g, '-');
          setRegisteredGroup(data.jid, {
            name: data.name,
            folder,
            trigger: data.trigger || 'always',
            added_at: new Date().toISOString(),
            isMain: data.isMain || false,
            containerConfig: data.containerConfig || {},
            requiresTrigger: data.requiresTrigger ?? false,
            workspaceId: data.workspaceId || undefined,
          });
          logger.info({ jid: data.jid, name: data.name }, 'Group registered via API');
          res.writeHead(201);
          res.end(JSON.stringify({ ok: true, jid: data.jid }));
        } catch (err: any) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ─── Context Push: POST /api/context/:folder ───
    // Receives a CLAUDE.md from Delegate and writes it to the group folder.
    // This gives the agent full task context before its first message.
    const contextMatch = req.url?.match(/^\/api\/context\/([a-zA-Z0-9_-]+)$/);
    if (req.method === 'POST' && contextMatch) {
      const folder = decodeURIComponent(contextMatch[1]);
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.claudeMd || typeof data.claudeMd !== 'string') {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'claudeMd string required' }));
            return;
          }

          // Write CLAUDE.md atomically
          const groupDir = path.join(GROUPS_DIR, folder);
          if (!fs.existsSync(groupDir)) {
            fs.mkdirSync(groupDir, { recursive: true });
          }
          const claudePath = path.join(groupDir, 'CLAUDE.md');
          const tmpPath = claudePath + '.tmp';
          fs.writeFileSync(tmpPath, data.claudeMd);
          fs.renameSync(tmpPath, claudePath);

          // Also ensure the session dir has .claude settings
          const sessionsDir = process.env.SESSIONS_DIR || '/opt/nanoclaw/data/sessions';
          const sessionClaudeDir = path.join(sessionsDir, folder, '.claude');
          if (!fs.existsSync(sessionClaudeDir)) {
            fs.mkdirSync(sessionClaudeDir, { recursive: true });
          }

          logger.info({ folder, size: data.claudeMd.length }, 'Context pushed to group folder');
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, folder, size: data.claudeMd.length }));
        } catch (err: any) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ─── Worktree: POST/DELETE/GET /api/worktree/:folder ───
    const worktreeMatch = req.url?.match(/^\/api\/worktree\/([a-zA-Z0-9_-]+)$/);
    if (worktreeMatch) {
      const folder = decodeURIComponent(worktreeMatch[1]);

      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            if (!data.repoUrl) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'repoUrl required' }));
              return;
            }
            // Per-workspace credential routing:
            // 1. Prefer token from request body (sent by Delegate with per-workspace creds)
            // 2. Try resolving from Delegate API using workspaceId
            // 3. Admin-only fallback to global env var
            let githubToken = data.githubToken;
            if (!githubToken && !data.isAdmin) {
              // Resolve group's workspaceId for token lookup
              const group = getRegisteredGroup(
                Object.keys(getAllRegisteredGroups()).find(
                  (jid) => getAllRegisteredGroups()[jid]?.folder === folder
                ) || ''
              );
              const resolved = await resolveTokenFromDelegate(
                data.workspaceId || group?.workspaceId
              );
              if (resolved) {
                githubToken = resolved;
              }
            }
            if (!githubToken && data.isAdmin) {
              githubToken = process.env.GITHUB_TOKEN;
              if (githubToken) {
                logger.warn({ folder }, 'Using admin global GITHUB_TOKEN fallback (deprecated for task operations)');
              }
            }

            const result = await setupWorktreeAsync(data.repoUrl, folder, {
              branch: data.branch,
              baseBranch: data.baseBranch,
              githubToken,
            });
            if (result.ok && result.worktreePath) {
              // Configure git credential helper inside the worktree so the agent can push
              try {
                const { configureWorktreeGitAuth } = await import('./git-auth.js');
                const group = getRegisteredGroup(
                  Object.keys(getAllRegisteredGroups()).find(
                    (jid) => getAllRegisteredGroups()[jid]?.folder === folder
                  ) || ''
                );
                const wsId = data.workspaceId || group?.workspaceId;
                if (wsId) {
                  configureWorktreeGitAuth(result.worktreePath, wsId);
                  logger.info({ folder, workspaceId: wsId }, 'Git credential helper configured in worktree');
                }
              } catch (authErr: any) {
                logger.warn({ folder, error: authErr.message }, 'Failed to configure git auth in worktree (non-fatal)');
              }
              logger.info({ folder, branch: result.branch }, 'Worktree created');
              res.writeHead(201);
            } else if (result.ok) {
              logger.info({ folder, branch: result.branch }, 'Worktree created');
              res.writeHead(201);
            } else {
              res.writeHead(500);
            }
            res.end(JSON.stringify(result));
          } catch (err: any) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (req.method === 'DELETE') {
        // Read metadata to find bare clone path
        const metaPath = path.join(GROUPS_DIR, folder, 'worktree-meta.json');
        let bareClonePath = '';
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          bareClonePath = meta.bareClonePath;
        } catch {}

        if (!bareClonePath) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No worktree found for this folder' }));
          return;
        }

        const result = removeWorktree(bareClonePath, folder);
        logger.info({ folder, ok: result.ok }, 'Worktree removed');
        res.writeHead(result.ok ? 200 : 500);
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === 'GET') {
        // List worktrees — needs a repoUrl query param or just list the folder's meta
        const metaPath = path.join(GROUPS_DIR, folder, 'worktree-meta.json');
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          res.writeHead(200);
          res.end(JSON.stringify(meta));
        } catch {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No worktree found' }));
        }
        return;
      }
    }

    // ─── Worktree List: GET /api/worktrees ───
    if (req.method === 'GET' && req.url === '/api/worktrees') {
      // Scan all groups for worktree metadata
      const worktrees: any[] = [];
      try {
        const folders = fs.readdirSync(GROUPS_DIR);
        for (const folder of folders) {
          const metaPath = path.join(GROUPS_DIR, folder, 'worktree-meta.json');
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            worktrees.push(meta);
          } catch { /* no worktree for this group */ }
        }
      } catch { /* GROUPS_DIR doesn't exist yet */ }
      res.writeHead(200);
      res.end(JSON.stringify({ worktrees }));
      return;
    }

    // ─── MCP Config: POST /api/mcp-config/:folder ───
    const mcpMatch = req.url?.match(/^\/api\/mcp-config\/([a-zA-Z0-9_-]+)$/);
    if (req.method === 'POST' && mcpMatch) {
      const folder = decodeURIComponent(mcpMatch[1]);
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);

          if (data.mcpServers) {
            // Direct MCP config from Delegate
            const result = writeMCPConfigDirect(folder, data.mcpServers, data.permissions, data.workspaceId);
            logger.info({ folder, servers: Object.keys(data.mcpServers).length }, 'MCP config pushed directly');
            res.writeHead(result.ok ? 200 : 500);
            res.end(JSON.stringify(result));
          } else if (data.workspaceId) {
            // Generate from workspace ID
            const result = await writeMCPConfigForGroup(folder, {
              workspaceId: data.workspaceId,
              extraServers: data.extraServers,
              permissions: data.permissions,
            });
            logger.info({ folder, workspaceId: data.workspaceId, serverCount: result.serverCount }, 'MCP config generated from workspace');
            res.writeHead(result.ok ? 200 : 500);
            res.end(JSON.stringify(result));
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'mcpServers or workspaceId required' }));
          }
        } catch (err: any) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ─── Health: GET /api/health ───
    if (req.method === 'GET' && req.url === '/api/health') {
      let gitSha = 'unknown';
      try {
        gitSha = fs.readFileSync('/opt/nanoclaw/.git/refs/heads/main', 'utf-8').trim().slice(0, 8);
      } catch {}
      const worktreeCount = (() => {
        try {
          return fs.readdirSync(GROUPS_DIR).filter((f) => {
            try { return fs.existsSync(path.join(GROUPS_DIR, f, 'worktree-meta.json')); } catch { return false; }
          }).length;
        } catch { return 0; }
      })();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, gitSha, uptime: process.uptime(), worktreeCount }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, () => {
    // Plain-text line first — unmistakable in journalctl even if pino
    // structured output is filtered or pretty-printer isn't attached.
    // If you ever see the service running without this line, the deployed
    // dist is stale and Delegate cannot register task JIDs.
    console.log(`[group-api] listening on :${PORT}`);
    logger.info({ port: PORT, tokens: VALID_TOKENS.length }, 'Group + Context API listening');
  });

  server.on('error', (err) => {
    console.error(`[group-api] FAILED TO BIND :${PORT} — ${err.message}`);
    logger.error({ err, port: PORT }, 'Group API failed to bind — Delegate cannot register JIDs');
  });
}
