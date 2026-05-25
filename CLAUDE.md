# DelegateAgent

DelegateAgent is forked from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) and customized for the Delegate workspace platform. See [README.md](README.md) for overview and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts; credential injection, credit/429 cooldown report + in-run model cascade |
| `src/credential-client.ts` | Resolves LLM keys + funded `fallbacks[]` from Delegate (`/api/agent/integrations/llm-keys`) |
| `src/cooldown-client.ts` | Reports credit/429 cooldown back to Delegate so the next dispatch rotates |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy

**Delegate deployment (live path):** LLM credentials are resolved per-dispatch from Delegate's
`GET /api/agent/integrations/llm-keys` (`src/credential-client.ts`) and injected into the agent
container as `-e ANTHROPIC_API_KEY` / `-e ANTHROPIC_BASE_URL` (or `CLAUDE_CODE_OAUTH_TOKEN` for
OAuth mode). `ANTHROPIC_BASE_URL` points at the Bifrost gateway, which routes the requested model
to a healthy upstream. On a credit (402) / rate-limit (429), `src/container-runner.ts` reports a
cooldown (`src/cooldown-client.ts`) so the next dispatch rotates, AND re-runs the task once with
`CLAUDE_AGENT_MODEL` forced to a funded fallback model (the in-run cascade).

> **Definitive end-to-end reference** (Delegate `LLMProvider` rows → AI Models ordering → Bifrost →
> models → waterfall + this container's failover), with mermaid diagrams:
> **`../docs/architecture/llm-provider-engine.md`** in the Delegate repo. Read it before changing
> `container-runner.ts` / `credential-client.ts` / `cooldown-client.ts`.

**OneCLI (Tier 2, optional):** when no per-workspace key resolves and the OneCLI gateway is
installed, it can inject secrets at request time. This is a fallback tier, not the primary path on
the Delegate deployment. Run `onecli --help`.

## Skills

Four types of skills exist in DelegateAgent. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-delegate-agent` | Bring upstream delegate-agent updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.delegate-agent.plist
launchctl unload ~/Library/LaunchAgents/com.delegate-agent.plist
launchctl kickstart -k gui/$(id -u)/com.delegate-agent  # restart

# Linux (systemd)
systemctl --user start delegate-agent
systemctl --user stop delegate-agent
systemctl --user restart delegate-agent
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
