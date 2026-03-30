// ─── DELEGATE PATCH: Group Registration + Context Push HTTP API ───
// Exposes POST /api/groups and POST /api/context/:folder on a configurable port
// so Delegate can register task-specific groups at runtime and push rich CLAUDE.md
// context to group folders.

import http from 'http';
import * as fs from 'fs';
import * as path from 'path';

import { getAllRegisteredGroups } from './db.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';
import { GROUPS_DIR } from './config.js';

/**
 * Start the group + context HTTP API.
 * @param registerGroupFn — injected from index.ts (module-scoped function)
 */
export function startGroupAPI(
  registerGroupFn: (jid: string, group: RegisteredGroup) => void,
): void {
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
          registerGroupFn(data.jid, {
            name: data.name,
            folder,
            trigger: data.trigger || 'always',
            added_at: new Date().toISOString(),
            isMain: data.isMain || false,
            containerConfig: data.containerConfig || {},
            requiresTrigger: data.requiresTrigger ?? false,
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
          const sessionsDir = process.env.SESSIONS_DIR || '/opt/remote-agent/data/sessions';
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

    // ─── Health: GET /api/health ───
    if (req.method === 'GET' && req.url === '/api/health') {
      let gitSha = 'unknown';
      try {
        gitSha = fs.readFileSync('/opt/remote-agent/.git/refs/heads/main', 'utf-8').trim().slice(0, 8);
      } catch {}
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, gitSha, uptime: process.uptime() }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, () => {
    logger.info({ port: PORT }, 'Group + Context API listening');
  });
}
