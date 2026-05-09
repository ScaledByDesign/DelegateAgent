---
name: delegate-bifrost-models
description: Which model to ask Bifrost for, depending on the work. Cost / latency / quality trade-offs, fallback chain, and how to pick. Load when you're about to call $BIFROST_URL/v1/messages or chat-completion and don't already know which model id to use.
---

# Bifrost Model Selection

Bifrost is Delegate's LLM gateway. It routes any request you send to whichever upstream provider is healthy, applies VK rate limits, and falls back if a provider 5xx's. **Your only job is to pick the right `model` field.**

## Default routing (already set, you usually don't override)

| Request kind | Default model | Rationale |
|---|---|---|
| Chat fast-path (single-turn conversational) | `claude-sonnet-4-6` | Sub-10s latency, good prose, low cost |
| Container agent / tool-use sessions | `claude-sonnet-4-6` (current default) | Solid tool-use, reasonable cost |
| Embeddings | `text-embedding-3-small` (1536 dims) | Required by the Qdrant index |

Override only when you have a clear reason. Most tasks should not override.

## Endpoint

Inside the container, Bifrost is reachable at `$BIFROST_URL` (typically `http://host.docker.internal:4000`).

Two endpoints to know:

```bash
# Chat completion (Claude/GPT-style)
curl -X POST "$BIFROST_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 1024,
    "messages": [{"role":"user","content":"hello"}]
  }'

# Embeddings
curl -X POST "$BIFROST_URL/v1/embeddings" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-3-small",
    "input": "the cat sat on the mat"
  }'
```

Bifrost speaks Anthropic format on `/v1/messages` and OpenAI format on `/v1/embeddings`. It translates internally.

## Picking a model — decision matrix

| Task | Pick | Why not the bigger one |
|---|---|---|
| Two-line chat reply, "yes/no", short clarifying question | `claude-haiku-4-5` | 3-5x cheaper, 2x faster, quality is identical for this scope |
| Code review, debugging, multi-step planning, tool-using agent | `claude-sonnet-4-6` | Sweet spot for tool-use + reasoning |
| Architecture, large-context refactor (50+ files), critic review | `claude-opus-4-7` | Reach for opus only when sonnet isn't producing the right depth |
| Vision (image understanding, screenshot review) | `claude-sonnet-4-6` | Sonnet has good multimodal; opus rarely worth the cost increase |
| Bulk summarization, classification (1000s of items) | `gpt-4o-mini` via `openai-chat-only` provider | Cheapest token cost; quality is fine for short outputs |
| Embeddings (semantic search) | `text-embedding-3-small` | The Qdrant index is 1536-dim; using a different-dim model breaks it |

**Cost ratios at 2026-Q2** (rough order of magnitude vs. sonnet-4-6 input tokens):
- haiku-4-5: 0.2x (5x cheaper)
- sonnet-4-6: 1x (baseline)
- opus-4-7: 5x

## When NOT to override the default

- You're inside the chat fast-path. The dispatch already picked sonnet; don't second-guess it.
- The user's message is conversational ("hi", "thanks", "what's up"). Default is correct.
- You're calling for embeddings. Override the model and you'll generate vectors that don't match the index.

## When to override

- The task is genuinely simple AND you'll do it many times in this session (e.g., classifying 200 emails). Use haiku or gpt-4o-mini, save 5x on cost.
- The task is genuinely hard AND you've tried sonnet and the output is shallow. Use opus.

## Fallback chain

Bifrost handles fallback for you. The configured chain (per `bifrost_gotchas` memory):

```
Anthropic models  → OpenRouter (primary, Anthropic-format) → Anthropic direct (last-tier)
OpenAI models     → OpenAI direct
Embeddings        → OpenAI direct
```

If you see `503 Service Unavailable` or `502 Bad Gateway` from Bifrost, it means **all** providers in the chain failed. Don't immediately retry the same call — check `delegate-error-handling` for the 5xx playbook.

## Token budgets

Per-request budget guidance:
- Chat fast-path: 1024 max_tokens (set by dispatch). Don't exceed.
- Container reasoning calls: 4096-8192 max_tokens depending on complexity.
- Single-tool-call result: 256 tokens is usually enough for a structured response.

Set `max_tokens` explicitly on every call. Without it, Anthropic defaults to a high number that wastes budget.

## Streaming vs. non-streaming

Use streaming when:
- You're in the chat fast-path returning to a UI
- Response will be > 200 tokens AND latency matters

Use non-streaming when:
- You're in a tool loop and need the full response before deciding the next step
- You're using embeddings (no streaming for embeddings anyway)

## Cost-aware shortcut: ask for haiku first, escalate if needed

For ambiguous-difficulty tasks, the cheapest pattern is:

1. Call haiku with the prompt.
2. If the response includes phrases like "I'm not sure" / "this needs more analysis" / "I'd need to consider" or is < 50 tokens for a multi-step ask, **escalate** by calling sonnet with the same prompt + the haiku response as context.
3. Don't escalate to opus unless sonnet also fails.

This is sometimes called the "cascading model" pattern. It's optimal when most of your tasks are simple but some are hard, and you don't know which is which up front.

## What this skill is NOT

- It is not a token-counting library — use the upstream provider's tokenizer for that.
- It is not a model-availability checker — Bifrost's `/health` endpoint tells you that.
- It does not replace `delegate-error-handling` — when a model call fails, that's the skill to load.

## Reference

- `lib/delegate-agent/bifrost-config.json` — provider keys + retry policy on each provider
- `DelegateAgent/src/chat/bifrost-client.ts` — chat fast-path client; reads `CHAT_FAST_PATH_MODEL` env var to override default
- Memory: `bifrost_architecture.md`, `bifrost_gotchas.md`
