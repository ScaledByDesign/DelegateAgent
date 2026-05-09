// ─── DELEGATE PATCH: Group Registration + Context Push + Worktree + MCP HTTP API ───
// Exposes POST /api/groups, POST /api/context/:folder, POST /api/worktree/:folder,
// and POST /api/mcp-config/:folder on a configurable port so Delegate can register
// task-specific groups at runtime, push context, manage worktrees, and inject MCP config.
//
// This file is appended to DelegateAgent/RemoteAgent's src/index.ts at deploy time.
// It uses DelegateAgent's internal registerGroup() and getAllRegisteredGroups().

import http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import {
  setupWorktreeAsync,
  removeWorktree,
  listWorktrees,
} from './worktree-manager.js';
import {
  writeMCPConfigDirect,
  writeMCPConfigForGroup,
} from './mcp-config-generator.js';
import { logger, getRecentLogs, logSubscriber } from './logger.js';
import {
  getAllRegisteredGroups,
  setRegisteredGroup,
  getRegisteredGroup,
  getAllTasks,
  setRegisteredAgent,
  getRegisteredAgent,
  listRegisteredAgents,
  deleteRegisteredAgent,
} from './db.js';
import { resolveTokenFromDelegate } from './credential-client.js';
import { getEnvWithFallback } from './config.js';
import { renderTemplate, escape, resolveStaticAsset } from './web-ui/render.js';
import { getContainerTelemetry } from './web-ui/container-telemetry.js';
import { metricsHandler } from './metrics.js';
import { getScheduledTasks } from './task-scheduler.js';
import { getRegisteredChannelNames } from './channels/registry.js';
import type { RegisteredGroup, ScheduledTask } from './types.js';

const LOG_BUFFER_CAPACITY = 500;

const GROUPS_DIR = process.env.GROUPS_DIR || '/opt/delegate-agent/groups';

/** Optional in-memory registerGroup callback — when provided, POST /api/groups
 * updates both SQLite and the live in-memory registeredGroups map so the
 * delegate channel's groupSyncInterval picks up the new JID immediately
 * (within its 10s cycle) rather than requiring a restart.
 */
export function startGroupAPI(
  registerGroupInMemory?: (
    jid: string,
    group: import('./types.js').RegisteredGroup,
  ) => void,
): void {
  const PORT = parseInt(process.env.GROUP_API_PORT || '3001', 10);
  // Canonical: DELEGATE_AGENT_TOKEN. Legacy fallback: DELEGATE_API_KEY (deprecated)
  // and NANOCLAW_TOKEN (pre-rebrand). Accept any non-empty value during the
  // transition window so droplets in flight keep authenticating.
  const VALID_TOKENS = [
    getEnvWithFallback('DELEGATE_AGENT_TOKEN', ['NANOCLAW_TOKEN']),
    process.env.DELEGATE_API_KEY,
  ].filter(Boolean) as string[];

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    // ─── Public static assets: GET /admin/static/:filename ───
    // Bypasses Bearer auth so the dashboard shell can load htmx.min.js
    // before any HTMX-driven authenticated request fires. Whitelist enforced
    // in resolveStaticAsset() (only .js + .css; rejects path traversal).
    const publicStaticMatch = req.url?.match(
      /^\/admin\/static\/([a-zA-Z0-9._-]+)$/,
    );
    if (req.method === 'GET' && publicStaticMatch) {
      const asset = resolveStaticAsset(publicStaticMatch[1]);
      if (!asset) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      res.setHeader('Content-Type', asset.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const stream = fs.createReadStream(asset.fullPath);
      res.writeHead(200);
      stream.pipe(res);
      return;
    }

    // Deploy webhook bypasses the global Bearer gate — it has its own auth
    // (HMAC-SHA256 from GitHub via X-Hub-Signature-256, or Bearer DEPLOY_SECRET).
    // Without this bypass, GitHub's webhook hits the global 401 before the
    // dedicated handler can validate the signature.
    const isDeployWebhook =
      req.method === 'POST' &&
      (req.url === '/webhook/deploy' || req.url === '/deploy');

    // Auth: accept any valid Delegate/DelegateAgent token (skipped for deploy webhook)
    if (!isDeployWebhook) {
      const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
      if (!auth || !VALID_TOKENS.includes(auth)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    if (req.method === 'GET' && req.url === '/api/groups') {
      const groups = getAllRegisteredGroups();
      res.writeHead(200);
      res.end(JSON.stringify({ groups: Object.values(groups) }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/groups') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
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
            res.end(
              JSON.stringify({ ok: true, existing: true, jid: data.jid }),
            );
            return;
          }
          const folder = data.folder || data.jid.replace(/[^a-zA-Z0-9-]/g, '-');
          const groupRecord: import('./types.js').RegisteredGroup = {
            name: data.name,
            folder,
            trigger: data.trigger || 'always',
            added_at: new Date().toISOString(),
            isMain: data.isMain || false,
            containerConfig: data.containerConfig || {},
            requiresTrigger: data.requiresTrigger ?? false,
            workspaceId: data.workspaceId || undefined,
          };
          // Always persist to SQLite
          setRegisteredGroup(data.jid, groupRecord);
          // Also update in-memory map when callback is wired (fixes dynamic
          // group pickup without restart — the delegate channel's
          // groupSyncInterval reads from this map every 10s).
          if (registerGroupInMemory) {
            try {
              registerGroupInMemory(data.jid, groupRecord);
            } catch (e) {
              logger.warn(
                { jid: data.jid, err: e },
                'in-memory registerGroup failed (non-fatal)',
              );
            }
          }
          logger.info(
            {
              jid: data.jid,
              name: data.name,
              inMemory: !!registerGroupInMemory,
            },
            'Group registered via API',
          );
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
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
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
          const sessionsDir =
            process.env.SESSIONS_DIR || '/opt/delegate-agent/data/sessions';
          const sessionClaudeDir = path.join(sessionsDir, folder, '.claude');
          if (!fs.existsSync(sessionClaudeDir)) {
            fs.mkdirSync(sessionClaudeDir, { recursive: true });
          }

          logger.info(
            { folder, size: data.claudeMd.length },
            'Context pushed to group folder',
          );
          res.writeHead(200);
          res.end(
            JSON.stringify({ ok: true, folder, size: data.claudeMd.length }),
          );
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
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
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
                  (jid) => getAllRegisteredGroups()[jid]?.folder === folder,
                ) || '',
              );
              const resolved = await resolveTokenFromDelegate(
                data.workspaceId || group?.workspaceId,
              );
              if (resolved) {
                githubToken = resolved;
              }
            }
            if (!githubToken && data.isAdmin) {
              githubToken = process.env.GITHUB_TOKEN;
              if (githubToken) {
                logger.warn(
                  { folder },
                  'Using admin global GITHUB_TOKEN fallback (deprecated for task operations)',
                );
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
                const { configureWorktreeGitAuth } =
                  await import('./git-auth.js');
                const group = getRegisteredGroup(
                  Object.keys(getAllRegisteredGroups()).find(
                    (jid) => getAllRegisteredGroups()[jid]?.folder === folder,
                  ) || '',
                );
                const wsId = data.workspaceId || group?.workspaceId;
                if (wsId) {
                  configureWorktreeGitAuth(result.worktreePath, wsId);
                  logger.info(
                    { folder, workspaceId: wsId },
                    'Git credential helper configured in worktree',
                  );
                }
              } catch (authErr: any) {
                logger.warn(
                  { folder, error: authErr.message },
                  'Failed to configure git auth in worktree (non-fatal)',
                );
              }
              logger.info(
                { folder, branch: result.branch },
                'Worktree created',
              );
              res.writeHead(201);
            } else if (result.ok) {
              logger.info(
                { folder, branch: result.branch },
                'Worktree created',
              );
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
          res.end(
            JSON.stringify({ error: 'No worktree found for this folder' }),
          );
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
          } catch {
            /* no worktree for this group */
          }
        }
      } catch {
        /* GROUPS_DIR doesn't exist yet */
      }
      res.writeHead(200);
      res.end(JSON.stringify({ worktrees }));
      return;
    }

    // ─── MCP Config: POST /api/mcp-config/:folder ───
    const mcpMatch = req.url?.match(/^\/api\/mcp-config\/([a-zA-Z0-9_-]+)$/);
    if (req.method === 'POST' && mcpMatch) {
      const folder = decodeURIComponent(mcpMatch[1]);
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);

          if (data.mcpServers) {
            // Direct MCP config from Delegate
            const result = writeMCPConfigDirect(
              folder,
              data.mcpServers,
              data.permissions,
              data.workspaceId,
            );
            logger.info(
              { folder, servers: Object.keys(data.mcpServers).length },
              'MCP config pushed directly',
            );
            res.writeHead(result.ok ? 200 : 500);
            res.end(JSON.stringify(result));
          } else if (data.workspaceId) {
            // Generate from workspace ID
            const result = await writeMCPConfigForGroup(folder, {
              workspaceId: data.workspaceId,
              extraServers: data.extraServers,
              permissions: data.permissions,
            });
            logger.info(
              {
                folder,
                workspaceId: data.workspaceId,
                serverCount: result.serverCount,
              },
              'MCP config generated from workspace',
            );
            res.writeHead(result.ok ? 200 : 500);
            res.end(JSON.stringify(result));
          } else {
            res.writeHead(400);
            res.end(
              JSON.stringify({ error: 'mcpServers or workspaceId required' }),
            );
          }
        } catch (err: any) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ─── Agent Registry: POST /api/agents ───
    if (req.method === 'POST' && req.url === '/api/agents') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (
            !data.id ||
            typeof data.id !== 'string' ||
            data.id.trim() === ''
          ) {
            res.writeHead(400);
            res.end(
              JSON.stringify({ error: 'id (non-empty string) required' }),
            );
            return;
          }
          if (!data.name || typeof data.name !== 'string') {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'name required' }));
            return;
          }
          setRegisteredAgent(data.id.trim(), {
            name: data.name,
            role: data.role ?? null,
            systemPrompt: data.systemPrompt ?? null,
            personality: data.personality ?? null,
            color: data.color ?? null,
            model: data.model ?? null,
          });
          logger.info({ id: data.id }, 'Agent registered via API');
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, id: data.id }));
        } catch (err: any) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ─── Agent Registry: GET /api/agents (list) ───
    if (req.method === 'GET' && req.url === '/api/agents') {
      const agents = listRegisteredAgents();
      res.writeHead(200);
      res.end(JSON.stringify({ agents }));
      return;
    }

    // ─── Agent Registry: GET /api/agents/:id and DELETE /api/agents/:id ───
    const agentMatch = req.url?.match(/^\/api\/agents\/([^/]+)$/);
    if (agentMatch) {
      const agentId = decodeURIComponent(agentMatch[1]);

      if (req.method === 'GET') {
        const agent = getRegisteredAgent(agentId);
        if (!agent) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Agent not found' }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(agent));
        return;
      }

      if (req.method === 'DELETE') {
        deleteRegisteredAgent(agentId);
        logger.info({ id: agentId }, 'Agent removed via API');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    }

    // ─── Health: GET /api/health ───
    if (req.method === 'GET' && req.url === '/api/health') {
      let gitSha = 'unknown';
      try {
        gitSha = fs
          .readFileSync('/opt/delegate-agent/.git/refs/heads/main', 'utf-8')
          .trim()
          .slice(0, 8);
      } catch {}
      const worktreeCount = (() => {
        try {
          return fs.readdirSync(GROUPS_DIR).filter((f) => {
            try {
              return fs.existsSync(
                path.join(GROUPS_DIR, f, 'worktree-meta.json'),
              );
            } catch {
              return false;
            }
          }).length;
        } catch {
          return 0;
        }
      })();
      res.writeHead(200);
      res.end(
        JSON.stringify({
          ok: true,
          gitSha,
          uptime: process.uptime(),
          worktreeCount,
        }),
      );
      return;
    }

    // ─── Prometheus /metrics ───
    // Bearer-auth-gated by the global check at the top of this handler.
    // Returns text/plain Prometheus exposition. When
    // DELEGATE_AGENT_METRICS_DISABLED=1, the handler returns 404.
    if (req.method === 'GET' && req.url === '/metrics') {
      try {
        await metricsHandler(req, res);
      } catch (err) {
        logger.error({ err }, '/metrics handler failed');
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'metrics failure' }));
        }
      }
      return;
    }

    // ─── HTMX Admin Dashboard: GET /admin and /admin/partials/* ───
    if (req.method === 'GET' && req.url === '/admin') {
      try {
        const html = renderTemplate('base.html');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.writeHead(200);
        res.end(html);
      } catch (err: any) {
        logger.error({ err }, 'Failed to render /admin shell');
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Render failure' }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/admin/partials/groups') {
      try {
        const groupsBody = renderGroupsBody(getAllRegisteredGroups());
        const html = renderTemplate('groups.html', { groups_body: groupsBody });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.writeHead(200);
        res.end(html);
      } catch (err: any) {
        logger.error({ err }, 'Failed to render /admin/partials/groups');
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Render failure' }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/admin/partials/containers') {
      try {
        const containersBody = renderContainersBody(getContainerTelemetry());
        const html = renderTemplate('containers.html', {
          containers_body: containersBody,
        });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.writeHead(200);
        res.end(html);
      } catch (err: any) {
        logger.error({ err }, 'Failed to render /admin/partials/containers');
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Render failure' }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/admin/partials/scheduler') {
      try {
        const schedulerBody = renderSchedulerBody(getAllTasks());
        const html = renderTemplate('scheduler.html', {
          scheduler_body: schedulerBody,
        });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.writeHead(200);
        res.end(html);
      } catch (err: any) {
        logger.error({ err }, 'Failed to render /admin/partials/scheduler');
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Render failure' }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/admin/partials/logs') {
      try {
        const lines = getRecentLogs();
        const logsBody = lines.map((l) => escape(l)).join('\n');
        const html = renderTemplate('logs.html', {
          logs_body: logsBody,
          buffered_count: String(lines.length),
        });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.writeHead(200);
        res.end(html);
      } catch (err: any) {
        logger.error({ err }, 'Failed to render /admin/partials/logs');
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Render failure' }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/admin/sse/logs') {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.writeHead(200);

      // Flush initial buffer so the client sees current state immediately
      const initialLines = getRecentLogs();
      for (const line of initialLines) {
        const safeHtml = `<div class="log-line">${escape(line)}</div>`;
        res.write(`event: line\ndata: ${safeHtml}\n\n`);
      }

      // Subscribe to live log lines
      const onLine = (line: string) => {
        const safeHtml = `<div class="log-line">${escape(line)}</div>`;
        try {
          res.write(`event: line\ndata: ${safeHtml}\n\n`);
        } catch {
          // Client already disconnected; unsubscribe handled below
        }
      };
      logSubscriber.on('line', onLine);

      // Keepalive ping every 30 seconds
      const keepaliveTimer = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(keepaliveTimer);
        }
      }, 30_000);

      // Clean up on client disconnect
      req.on('close', () => {
        logSubscriber.off('line', onLine);
        clearInterval(keepaliveTimer);
      });

      req.on('error', () => {
        logSubscriber.off('line', onLine);
        clearInterval(keepaliveTimer);
      });

      return;
    }

    // ─── JSON Admin Endpoints (programmatic mirrors of /admin/partials/*) ───
    // Bearer-token-protected JSON variants of the HTML admin partials. These
    // exist so Delegate's admin observability routes can proxy structured
    // data instead of scraping HTML. See `app/api/admin/delegate-agent/*` in
    // the Delegate repo. Auth uses the same VALID_TOKENS allowlist as all
    // other /api/* routes (DELEGATE_AGENT_TOKEN / NANOCLAW_TOKEN /
    // DELEGATE_API_KEY).
    if (req.method === 'GET' && req.url === '/api/admin/logs.json') {
      try {
        const lines = getRecentLogs();
        res.writeHead(200);
        res.end(
          JSON.stringify({
            lines,
            capturedAt: new Date().toISOString(),
            capacity: LOG_BUFFER_CAPACITY,
          }),
        );
      } catch (err: any) {
        logger.error({ err }, 'Failed to render /api/admin/logs.json');
        res.writeHead(500);
        res.end(JSON.stringify({ error: err?.message || 'Internal error' }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/api/admin/scheduled-tasks.json') {
      try {
        const tasks = getScheduledTasks();
        res.writeHead(200);
        res.end(JSON.stringify({ tasks }));
      } catch (err: any) {
        logger.error(
          { err },
          'Failed to render /api/admin/scheduled-tasks.json',
        );
        res.writeHead(500);
        res.end(JSON.stringify({ error: err?.message || 'Internal error' }));
      }
      return;
    }

    if (
      req.method === 'GET' &&
      req.url === '/api/admin/container-telemetry.json'
    ) {
      try {
        const containers = getContainerTelemetry();
        res.writeHead(200);
        res.end(JSON.stringify({ containers }));
      } catch (err: any) {
        logger.error(
          { err },
          'Failed to render /api/admin/container-telemetry.json',
        );
        res.writeHead(500);
        res.end(JSON.stringify({ error: err?.message || 'Internal error' }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/api/admin/channels.json') {
      try {
        const channels = getRegisteredChannelNames();
        res.writeHead(200);
        res.end(JSON.stringify({ channels }));
      } catch (err: any) {
        logger.error({ err }, 'Failed to render /api/admin/channels.json');
        res.writeHead(500);
        res.end(JSON.stringify({ error: err?.message || 'Internal error' }));
      }
      return;
    }

    // ─── Admin: reload Bifrost config ───────────────────────────────────────
    // POST /api/admin/reload-bifrost
    // Re-generates /opt/bifrost/config.json from the template + .env values,
    // then restarts the bifrost systemd service. Bearer auth required.
    if (req.method === 'POST' && req.url === '/api/admin/reload-bifrost') {
      const rba = (req.headers['authorization'] || '')
        .replace(/^Bearer\s+/i, '')
        .trim();
      if (!VALID_TOKENS.includes(rba)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      logger.info('Bifrost config reload triggered via admin API');
      res.writeHead(202);
      res.end(
        JSON.stringify({ ok: true, message: 'Bifrost config reload started' }),
      );

      const { spawn } = await import('node:child_process');
      const proc = spawn(
        'bash',
        [
          '-c',
          // Re-generate Bifrost config from template + .env, then restart Bifrost
          'set -a && source /opt/delegate-agent/.env && set +a && ' +
            'mkdir -p /opt/bifrost && ' +
            'envsubst < /opt/delegate-agent/deploy/bifrost-config.template.json > /opt/bifrost/config.json && ' +
            'echo "Bifrost config written" && ' +
            'systemctl restart bifrost || (pm2 restart bifrost 2>/dev/null) || echo "Bifrost restart failed"',
        ],
        { detached: true, stdio: 'ignore' },
      );
      proc.unref();
      return;
    }

    // ─── Admin: build container image ─────────────────────────────────────────
    // POST /api/admin/build-container
    // Rebuilds the delegateagent:latest Docker image in the background.
    // Requires Bearer auth (same VALID_TOKENS as all /api/* routes).
    if (req.method === 'POST' && req.url === '/api/admin/build-container') {
      const auth = (req.headers['authorization'] || '')
        .replace(/^Bearer\s+/i, '')
        .trim();
      if (!VALID_TOKENS.includes(auth)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      logger.info('Container image build triggered via admin API');
      res.writeHead(202);
      res.end(
        JSON.stringify({
          ok: true,
          message: 'Container build started in background',
        }),
      );

      // Non-blocking build
      const { spawn } = await import('node:child_process');
      const proc = spawn(
        'bash',
        [
          '-c',
          'cd /opt/delegate-agent && bash container/build.sh 2>&1 | tail -20',
        ],
        { detached: true, stdio: 'ignore' },
      );
      proc.unref();
      return;
    }

    // ─── Webhook deploy endpoint ─────────────────────────────────────────────
    // POST /webhook/deploy  or  POST /deploy
    // Triggers git pull + npm ci + tsc + systemctl restart on the droplet.
    // Auth: HMAC-SHA256 signature in X-Hub-Signature-256 (GitHub webhook style)
    // OR a static DEPLOY_SECRET bearer token as a simpler alternative.
    // The webhook_secret is stored in delegate_agent_servers.webhook_secret and
    // configured in Caddy at the host level — Caddy rejects unsigned requests
    // before they reach this handler.
    if (
      req.method === 'POST' &&
      (req.url === '/webhook/deploy' || req.url === '/deploy')
    ) {
      const DEPLOY_SECRET = process.env.DEPLOY_SECRET;
      if (!DEPLOY_SECRET) {
        logger.warn('DEPLOY_SECRET not set — deploy endpoint disabled');
        res.writeHead(503);
        res.end(JSON.stringify({ error: 'Deploy endpoint not configured' }));
        return;
      }

      // Accept either:
      //   a) X-Hub-Signature-256: sha256=<hmac>  (GitHub-style webhook)
      //   b) Authorization: Bearer <DEPLOY_SECRET>  (simple token)
      let authed = false;
      const authHeader = req.headers['authorization'] || '';
      if (authHeader.startsWith('Bearer ')) {
        const provided = authHeader.slice(7).trim();
        const { timingSafeEqual } = await import('node:crypto');
        try {
          authed = timingSafeEqual(
            Buffer.from(provided),
            Buffer.from(DEPLOY_SECRET),
          );
        } catch {
          authed = false;
        }
      }

      // Also accept X-Hub-Signature-256 (for GitHub webhook integration)
      if (!authed) {
        const sig = (req.headers['x-hub-signature-256'] as string) || '';
        if (sig.startsWith('sha256=')) {
          const body = await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
          });
          const { createHmac, timingSafeEqual } = await import('node:crypto');
          const expected =
            'sha256=' +
            createHmac('sha256', DEPLOY_SECRET).update(body).digest('hex');
          try {
            authed = timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
          } catch {
            authed = false;
          }
        }
      }

      if (!authed) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      // Auth passed — kick off the self-update in the background
      logger.info(
        'Deploy webhook triggered — running git pull + build + restart',
      );
      res.writeHead(202);
      res.end(JSON.stringify({ ok: true, message: 'Deploy started' }));

      // Non-blocking: pull → install → build → provision infra → restart agent.
      //
      // post-deploy.sh is the seam where infra changes (new systemd units,
      // Caddyfile updates, docker-compose stacks under deploy/*/) get picked
      // up. It's idempotent and tracks content hashes, so unchanged files
      // don't trigger spurious restarts. See deploy/post-deploy.sh for what
      // it does. If post-deploy.sh is absent (older checkout, e.g. mid-roll)
      // we fall back to the bare flow so the agent still updates itself.
      const { spawn } = await import('node:child_process');
      const proc = spawn(
        'bash',
        [
          '-c',
          'cd /opt/delegate-agent && ' +
            'git pull --ff-only origin main 2>&1 && ' +
            // NODE_ENV=production is inherited from the agent's systemd unit;
            // npm ci treats that as "skip devDeps", so tsc is missing and
            // every build silently fails (`tsc: not found` → dist stays
            // stale → new code never runs even though git pull succeeded).
            // Force NODE_ENV=development for the install + build only.
            // --ignore-scripts skips the `prepare: husky` hook that fails
            // without a git-hooks worktree. Trade-off: it ALSO skips
            // better-sqlite3's `install` script which builds the native
            // binding, so we explicitly rebuild it next.
            'NODE_ENV=development npm ci --ignore-scripts 2>&1 | tail -3 && ' +
            'npm rebuild better-sqlite3 2>&1 | tail -3 && ' +
            'NODE_ENV=development npm run build 2>&1 | tail -5 && ' +
            '(test -x deploy/post-deploy.sh && bash deploy/post-deploy.sh 2>&1 | tail -30 || ' +
            'echo "[deploy] post-deploy.sh missing — skipping infra step") && ' +
            'systemctl restart delegate-agent',
        ],
        { detached: true, stdio: 'ignore' },
      );
      proc.unref();
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
    logger.info(
      { port: PORT, tokens: VALID_TOKENS.length },
      'Group + Context API listening',
    );
  });

  server.on('error', (err) => {
    console.error(`[group-api] FAILED TO BIND :${PORT} — ${err.message}`);
    logger.error(
      { err, port: PORT },
      'Group API failed to bind — Delegate cannot register JIDs',
    );
  });
}

// ─── /admin partial render helpers ───────────────────────────────────────────

function renderGroupsBody(groups: Record<string, RegisteredGroup>): string {
  const entries = Object.entries(groups);
  if (entries.length === 0) {
    return '<p class="empty">No groups registered.</p>';
  }
  const rows = entries
    .map(([jid, g]) => {
      const main = g.isMain ? '<span class="badge ok">main</span>' : '';
      return `<tr>
  <td><code>${escape(jid)}</code></td>
  <td>${escape(g.name)}</td>
  <td><code>${escape(g.folder)}</code></td>
  <td>${escape(g.trigger)}</td>
  <td>${escape(g.added_at)}</td>
  <td>${escape(g.workspaceId ?? '')}</td>
  <td>${main}</td>
</tr>`;
    })
    .join('\n');
  return `<table>
  <thead>
    <tr>
      <th>JID</th>
      <th>Name</th>
      <th>Folder</th>
      <th>Trigger</th>
      <th>Added</th>
      <th>Workspace</th>
      <th>Flags</th>
    </tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

function renderContainersBody(
  entries: ReturnType<typeof getContainerTelemetry>,
): string {
  if (entries.length === 0) {
    return `<p class="placeholder">Container telemetry buffer is empty. Phase 4 wires container-runner start/end hooks into the in-process ring buffer; until then, this panel renders as empty even when containers are actively running.</p>`;
  }
  const rows = entries
    .map((e) => {
      const statusBadge =
        e.status === 'success'
          ? '<span class="badge ok">success</span>'
          : e.status === 'running'
            ? '<span class="badge pending">running</span>'
            : `<span class="badge fail">${escape(e.status)}</span>`;
      const dur = typeof e.durationMs === 'number' ? `${e.durationMs} ms` : '—';
      return `<tr>
  <td><code>${escape(e.id)}</code></td>
  <td><code>${escape(e.groupFolder)}</code></td>
  <td>${escape(e.startedAt)}</td>
  <td>${escape(e.endedAt ?? '—')}</td>
  <td>${dur}</td>
  <td>${statusBadge}</td>
  <td>${escape(e.errorMessage ?? '')}</td>
</tr>`;
    })
    .join('\n');
  return `<table>
  <thead>
    <tr>
      <th>ID</th>
      <th>Group</th>
      <th>Started</th>
      <th>Ended</th>
      <th>Duration</th>
      <th>Status</th>
      <th>Error</th>
    </tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

function renderSchedulerBody(tasks: ScheduledTask[]): string {
  if (tasks.length === 0) {
    return '<p class="empty">No scheduled tasks.</p>';
  }
  const rows = tasks
    .map((t) => {
      const statusBadge =
        t.status === 'active'
          ? '<span class="badge ok">active</span>'
          : t.status === 'paused'
            ? '<span class="badge pending">paused</span>'
            : `<span class="badge">${escape(t.status)}</span>`;
      return `<tr>
  <td><code>${escape(t.id)}</code></td>
  <td><code>${escape(t.group_folder)}</code></td>
  <td>${escape(t.schedule_type)}</td>
  <td><code>${escape(t.schedule_value)}</code></td>
  <td>${escape(t.next_run ?? '—')}</td>
  <td>${escape(t.last_run ?? '—')}</td>
  <td>${statusBadge}</td>
</tr>`;
    })
    .join('\n');
  return `<table>
  <thead>
    <tr>
      <th>ID</th>
      <th>Group</th>
      <th>Type</th>
      <th>Value</th>
      <th>Next Run</th>
      <th>Last Run</th>
      <th>Status</th>
    </tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}
