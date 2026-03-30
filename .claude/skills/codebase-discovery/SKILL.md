---
name: codebase-discovery
description: Automated project structure and tech stack discovery at session start
---

# Codebase Discovery Protocol

At the **start of every session**, before writing any code, run these discovery commands to understand the project you're working in.

## Step 1: Project Identity

```bash
# Read project manifest
cat package.json 2>/dev/null | head -30 || cat Cargo.toml 2>/dev/null | head -20 || cat go.mod 2>/dev/null | head -10 || cat requirements.txt 2>/dev/null | head -20 || echo "No recognized project manifest"
```

## Step 2: Project Structure

```bash
# List top-level structure (max 3 levels deep, ignore node_modules/dist/.git)
find . -maxdepth 3 -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.rs" -o -name "*.go" \) \
  ! -path "*/node_modules/*" ! -path "*/dist/*" ! -path "*/.next/*" ! -path "*/build/*" ! -path "*/.git/*" \
  | head -60
```

## Step 3: Key Configuration

```bash
# Check for config files that reveal the tech stack
ls -la tsconfig.json .eslintrc* .prettierrc* next.config.* vite.config.* tailwind.config.* docker-compose.yml Dockerfile Makefile 2>/dev/null
```

## Step 4: Git Context

```bash
# Current branch and recent activity
git branch --show-current 2>/dev/null
git log --oneline -5 2>/dev/null
git status --short 2>/dev/null | head -10
```

## Step 5: Test Infrastructure

```bash
# Discover how to run tests
grep -E '"test"|"build"|"dev"|"lint"' package.json 2>/dev/null | head -10 || echo "Check Makefile or CI config for test commands"
```

## What to Extract

After running discovery, mentally note:
- **Language/Runtime**: Node.js/TypeScript, Python, Rust, Go, etc.
- **Framework**: Next.js, Express, FastAPI, Actix, etc.
- **Package Manager**: npm, pnpm, yarn, pip, cargo
- **Test Command**: `npm test`, `vitest`, `pytest`, `cargo test`
- **Build Command**: `npm run build`, `tsc`, `cargo build`
- **Existing Patterns**: How are files organized? What naming conventions?

## Rules

1. **NEVER skip discovery** — even if you "remember" the project from context
2. **Read existing code before writing** — match the style and patterns already in use
3. **Don't re-implement** what already exists — always check first
4. If the project has a `CLAUDE.md` or `AGENTS.md`, read those FIRST — they contain project-specific instructions
