# Providers, routing & failover

## Supported providers

| Provider | Type | Default endpoint | Auth |
|---|---|---|---|
| `openai` | OpenAI-compatible chat | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `anthropic` | Anthropic Messages | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `google` | Gemini | `https://generativelanguage.googleapis.com` | `GOOGLE_API_KEY` |
| `openrouter` | OpenAI-compatible | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `ollama` | OpenAI-compatible (local) | `http://127.0.0.1:11434/v1` | none |
| `lmstudio` | OpenAI-compatible (local) | `http://127.0.0.1:1234/v1` | none |

Any OpenAI-compatible endpoint (vLLM, llama.cpp server, …) works via the
`openai` provider with a custom `baseUrl`.

## Model references

`provider:model` — e.g. `openai:gpt-4o`, `ollama:llama3.1`,
`anthropic:claude-sonnet-4-5`. Bare names (`gpt-4o`) resolve against
configured providers. `forge model list` shows availability.

## Health (measured, never assumed)

At boot, Core probes every configured provider (`refreshProviderHealth`)
and records `available` (latency ms), `offline` (with reason), or
`unconfigured` (no key/endpoint). Every completion updates the record
(consecutive failures trip a circuit breaker, successes reset it).
`forge model status` prints this table — if Ollama isn't running, it says
`offline (fetch failed)`, not "configured".

## Routing

`router.complete(request)`:

1. Match provider by capability (`tools`, `vision`, `longContext`, …).
2. Try with per-attempt timeout + exponential backoff (`maxRetries`).
3. On terminal failure, walk the `fallbacks` chain (cross-provider).
4. Record token usage per session/agent/task for budgets.

Streaming completions forward deltas to tool-loop and event bus; aborting a
run cancels the HTTP request via `AbortController`.

## Simulated output (honesty)

Two paths produce non-model output, both flagged `simulated: true` and
rendered **SIMULATED** in clients:

- `forge demo` scripted models (deterministic E2E smoke test).
- The `echo` provider fallback (only when explicitly configured).
