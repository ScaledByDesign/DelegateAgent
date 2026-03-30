---
name: security-hardening
description: Security configuration and guidelines for agent container execution
---

# Security Hardening

## Container Security Configuration

When running in a container, these restrictions apply automatically:

### Network
- **Default-deny egress** — outbound traffic is blocked unless explicitly needed
- **Allowed destinations**: GitHub API, npm registry, Delegate API, project-specific domains
- **Blocked**: Cloud metadata endpoints (`169.254.169.254`), SSH to other hosts, internal network ranges

### Filesystem
- Only the project directory is writable
- System directories are read-only
- No access to host filesystem outside the mount

### Resources
- Memory: capped at 2GB
- CPU: capped at 1.5 cores
- Max processes: 256
- No privileged escalation

## Security Rules for Agents

### NEVER do these
- Access or read `.env` files that aren't part of the project
- Attempt to access cloud provider metadata
- Open network connections to internal services
- Install system packages without approval
- Modify system configuration files
- Access other containers or processes

### API Keys and Secrets
- **NEVER hardcode** API keys, tokens, or passwords in code
- Use environment variables or `.env.example` with placeholder values
- If you need access to an API, use the Delegate integration proxy:
  - `POST /api/agent/integrations/{provider}/{action}` — proxied with real credentials
  - You never see the actual API key — RemoteAgent handles authentication

### Git Security
- Never commit `.env`, `*.key`, `*.pem`, or tokens
- Always check `git diff` before committing
- Create feature branches, never push directly to `main`
- Use draft PRs for review

## Integration Proxy Endpoints

Instead of using raw API keys, use these proxied endpoints:

| Provider | Proxy Endpoint | Actions |
|----------|---------------|---------|
| GitHub | `/api/agent/integrations/github/*` | repos, issues, PRs |
| Vercel | `/api/agent/integrations/vercel/*` | deploy, env vars |
| Cloudflare | `/api/agent/integrations/cloudflare/*` | workers, DNS |
| Google | `/api/agent/integrations/google/*` | calendar, drive, contacts |
| Slack | `/api/agent/integrations/slack/*` | messages, channels |
