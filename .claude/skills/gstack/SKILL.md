---
name: gstack
description: Garry Tan's engineering skill pack — 28 specialist commands for planning, review, QA, security, release, and browser automation
---

# gstack — Virtual Engineering Team

gstack provides specialist-role commands. Each acts as a different team member.

## Most Useful for Agents

### Code Review (use before completing any task)
```bash
/review
```
Paranoid production audit: N+1 queries, race conditions, trust boundaries. Auto-fixes mechanical issues.

### Investigation (use when debugging)
```bash
/investigate
```
Systematic root-cause analysis. Stops after 3 failed fix attempts to challenge architecture.

### Security Audit
```bash
/cso
```
OWASP Top 10 + STRIDE threat modeling. Zero false-positive filtering.

### Ship (push + PR)
```bash
/ship
```
Sync main, run tests, coverage audit, push branch, open PR.

### QA Testing (browser-based)
```bash
/qa
```
Real Chromium testing + bug fixes + auto-generated regression tests.

### Planning
```bash
/plan-eng-review    # Architecture lockdown, data flow, edge cases
/plan-ceo-review    # Strategic scope analysis
/autoplan           # Full pipeline: CEO + design + eng review
```

## All Available Commands

| Category | Commands |
|----------|----------|
| **Planning** | `/office-hours` `/plan-ceo-review` `/plan-eng-review` `/plan-design-review` `/design-consultation` `/autoplan` |
| **Review** | `/review` `/design-review` `/design-shotgun` |
| **Debug** | `/investigate` |
| **Testing** | `/qa` `/qa-only` |
| **Security** | `/cso` `/careful` `/freeze` `/guard` |
| **Release** | `/ship` `/land-and-deploy` `/canary` `/benchmark` `/document-release` `/retro` |
| **Browser** | `/browse` `/connect-chrome` |
| **Multi-AI** | `/codex` |

## Browser Commands (via $B)

The browse binary provides headless Chromium automation:
```bash
$B goto https://example.com    # Navigate
$B snapshot                    # Element refs (@e1, @e2...)
$B click @e3                   # Click element
$B fill @e1 "value"           # Fill input
$B text                       # Get page text
$B screenshot                 # Take screenshot
```

## When to Use

- **Before completing ANY coding task**: Run `/review` for code audit
- **When debugging a tricky bug**: Run `/investigate` for systematic analysis
- **Before shipping**: Run `/ship` to handle the full PR workflow
- **For security-sensitive changes**: Run `/cso` for threat modeling
- **For QA/testing**: Run `/qa` with a URL to test
