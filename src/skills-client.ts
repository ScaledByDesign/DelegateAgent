// ─── Delegate Skills Client ───
// Fetches per-workspace AgentSkill rows (SKILL.md content) from Delegate so the
// container-runner can write them into the group's .claude/skills/ dir alongside
// the baked-in container/skills/. This is what makes a skill authored in the
// Delegate "Agent Command Center → Settings → Skills" tab actually loadable on
// the droplet (the agent can `cat .claude/skills/<key>/SKILL.md`).
//
// Mirrors credential-client.ts: no caching, fresh per spawn, best-effort (a
// failure must never block the container from starting — the same skills are
// also delivered inline in the dispatch system prompt by Delegate).

import { logger } from './logger.js';
import { agentFetch } from './delegate-fetch.js';

export interface DelegateSkill {
  key: string;
  name: string;
  markdown: string;
}

/**
 * Resolve the skills assigned to an agent (or global skills) for a workspace.
 * Returns [] on any error or when unconfigured — never throws.
 *
 * Mints a per-workspace JWT via agentFetch (falls back to legacy bearer on
 * any mint failure so skill resolution never blocks container start).
 */
export async function fetchSkillsFromDelegate(
  workspaceId?: string | null,
  agentProfileId?: string | null,
): Promise<DelegateSkill[]> {
  if (!workspaceId) return [];
  try {
    const params = new URLSearchParams();
    params.set('workspaceId', workspaceId);
    if (agentProfileId) params.set('agentProfileId', agentProfileId);

    const res = await agentFetch(`/api/agent/integrations/skills?${params}`, {
      workspaceId,
      init: { signal: AbortSignal.timeout(10000) },
    });
    if (!res.ok) {
      logger.warn(
        { workspaceId, status: res.status },
        '[skills-client] skill resolution failed',
      );
      return [];
    }
    const body = (await res.json()) as { data?: { skills?: DelegateSkill[] } };
    const skills = body?.data?.skills;
    return Array.isArray(skills) ? skills : [];
  } catch (e) {
    logger.warn(
      { workspaceId, error: (e as Error).message },
      '[skills-client] skill resolution error',
    );
    return [];
  }
}
