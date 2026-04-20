// ─── MCP Config Generator ───
// Generates .claude/settings.json for agent sessions by merging:
// 1. Built-in Delegate MCP server (always present)
// 2. Workspace-configured MCP servers from Delegate UI
//
// This file runs on the RemoteAgent droplet as part of group setup.

import * as fs from 'fs';
import * as path from 'path';

const GROUPS_DIR = process.env.GROUPS_DIR || '/opt/remote-agent/groups';
const SESSIONS_DIR =
  process.env.SESSIONS_DIR || '/opt/remote-agent/data/sessions';
const DELEGATE_URL = process.env.DELEGATE_URL || 'https://delegate.ws';
const DELEGATE_API_TOKEN = process.env.DELEGATE_API_KEY || '';

export interface MCPServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  type?: 'stdio' | 'sse' | 'streamable-http';
}

export interface ClaudeSettingsMCP {
  [serverName: string]: MCPServerConfig;
}

export interface WorkspaceMCPServer {
  id: string;
  name: string;
  url: string;
  type: string;
  enabled: boolean;
  registryName?: string;
  category?: string;
}

/**
 * Fetch workspace MCP servers from Delegate API
 */
async function fetchWorkspaceMCPServers(
  workspaceId: string,
): Promise<WorkspaceMCPServer[]> {
  if (!workspaceId || !DELEGATE_API_TOKEN) return [];

  try {
    const res = await fetch(
      `${DELEGATE_URL}/api/workspaces/${workspaceId}/mcp-servers`,
      {
        headers: {
          Authorization: `Bearer ${DELEGATE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!res.ok) return [];

    const data: any = await res.json();
    return (data.mcpServers || data || []).filter(
      (s: WorkspaceMCPServer) => s.enabled,
    );
  } catch {
    return [];
  }
}

/**
 * Build the built-in Delegate MCP server config.
 * This server provides token resolution, git auth, failure tracking, etc.
 */
function buildDelegateMCPConfig(workspaceId?: string): MCPServerConfig {
  const env: Record<string, string> = {
    DELEGATE_URL,
    DELEGATE_API_TOKEN,
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    NODE_ENV: process.env.NODE_ENV || 'production',
  };
  if (workspaceId) {
    env.DELEGATE_WORKSPACE_ID = workspaceId;
  }
  return {
    command: 'node',
    args: ['/opt/delegate-agent/mcp/delegate-mcp-server.js'],
    env,
  };
}

/**
 * Convert a workspace MCP server to a Claude settings entry.
 */
function workspaceServerToConfig(server: WorkspaceMCPServer): MCPServerConfig {
  const type = server.type || 'sse';

  if (type === 'stdio') {
    // For stdio servers we need a command — this would come from the catalog
    // For now, skip stdio servers that don't have a command
    return {
      command: 'echo',
      args: [`stdio-server-${server.name}-not-configured`],
    };
  }

  // SSE and streamable-http use URL-based transport
  return {
    url: server.url,
    type: type as 'sse' | 'streamable-http',
  };
}

/**
 * Sanitize a server name for use as a JSON key
 */
function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Generate the merged MCP server config for an agent session.
 * Combines the built-in Delegate MCP server with workspace servers.
 */
export async function generateMCPConfig(
  workspaceId?: string,
  extraServers?: Record<string, MCPServerConfig>,
): Promise<ClaudeSettingsMCP> {
  const mcpServers: ClaudeSettingsMCP = {};

  // 1. Built-in Delegate MCP server (always present, with workspace context)
  mcpServers['delegate'] = buildDelegateMCPConfig(workspaceId);

  // 2. Workspace MCP servers from Delegate UI
  if (workspaceId) {
    const servers = await fetchWorkspaceMCPServers(workspaceId);
    for (const server of servers) {
      const key = sanitizeName(server.registryName || server.name);
      // Don't overwrite the built-in delegate server
      if (key === 'delegate') continue;
      mcpServers[key] = workspaceServerToConfig(server);
    }
  }

  // 3. Extra servers (for testing or custom injection)
  if (extraServers) {
    Object.assign(mcpServers, extraServers);
  }

  return mcpServers;
}

/**
 * Generate and write .claude/settings.json for a group folder.
 * This configures which MCP servers the agent can use.
 */
export async function writeMCPConfigForGroup(
  folder: string,
  opts?: {
    workspaceId?: string;
    extraServers?: Record<string, MCPServerConfig>;
    permissions?: { allow: string[]; deny: string[] };
  },
): Promise<{
  ok: boolean;
  path?: string;
  serverCount?: number;
  error?: string;
}> {
  try {
    const mcpServers = await generateMCPConfig(
      opts?.workspaceId,
      opts?.extraServers,
    );

    // Default permissions — allow all tools including MCP
    const permissions = opts?.permissions || {
      allow: [
        'Bash(*)',
        'Read(*)',
        'Write(*)',
        'Edit(*)',
        'Glob(*)',
        'Grep(*)',
        'WebFetch(*)',
        'WebSearch(*)',
        'Task(*)',
        'TaskOutput(*)',
        'TaskStop(*)',
        'TeamCreate(*)',
        'TeamDelete(*)',
        'SendMessage(*)',
        'TodoWrite(*)',
        'ToolSearch(*)',
        'Skill(*)',
        'NotebookEdit(*)',
        'Agent(*)',
        'AskUserQuestion(*)',
        'mcp__*(*)',
      ],
      deny: [],
    };

    const settings = {
      permissions,
      mcpServers,
    };

    // Write to group folder
    const groupDir = path.join(GROUPS_DIR, folder);
    const claudeDir = path.join(groupDir, '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    // Also write to sessions dir if it exists
    const sessionDir = path.join(SESSIONS_DIR, folder, '.claude');
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(sessionDir, 'settings.json'),
      JSON.stringify(settings, null, 2),
    );

    return {
      ok: true,
      path: settingsPath,
      serverCount: Object.keys(mcpServers).length,
    };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/**
 * Push MCP config received from Delegate to a group folder.
 * Used by the POST /api/mcp-config/:folder endpoint.
 */
export function writeMCPConfigDirect(
  folder: string,
  mcpConfig: ClaudeSettingsMCP,
  permissions?: { allow: string[]; deny: string[] },
  workspaceId?: string,
): { ok: boolean; path?: string; error?: string } {
  try {
    const merged: ClaudeSettingsMCP = {
      // Always include the built-in Delegate MCP server (with workspace context)
      delegate: buildDelegateMCPConfig(workspaceId),
      ...mcpConfig,
    };

    const settings = {
      permissions: permissions || {
        allow: [
          'Bash(*)',
          'Read(*)',
          'Write(*)',
          'Edit(*)',
          'Glob(*)',
          'Grep(*)',
          'WebFetch(*)',
          'WebSearch(*)',
          'Task(*)',
          'TaskOutput(*)',
          'TaskStop(*)',
          'TeamCreate(*)',
          'TeamDelete(*)',
          'SendMessage(*)',
          'TodoWrite(*)',
          'ToolSearch(*)',
          'Skill(*)',
          'NotebookEdit(*)',
          'Agent(*)',
          'AskUserQuestion(*)',
          'mcp__*(*)',
        ],
        deny: [],
      },
      mcpServers: merged,
    };

    const groupDir = path.join(GROUPS_DIR, folder);
    const claudeDir = path.join(groupDir, '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    return { ok: true, path: settingsPath };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
