# Provider-agnostic AI gateway

A small Node.js gateway that exposes Anthropic-compatible `POST /v1/messages` and OpenAI-compatible `POST /v1/chat/completions` endpoints while keeping a provider-neutral session history. A session can switch models without resetting its messages, tool calls, or tool results.

## Run

Requires Node.js 22.6 or newer and has no runtime dependencies.

```bash
npm start
```

Send `X-Session-Id: <uuid>` on requests to preserve conversation history. When omitted, the gateway creates a UUID and returns it in the `X-Session-Id` response header. Sessions do not control routing.

The client's `User-Agent`, `x-claude-code-agent-id`, `x-claude-code-parent-agent-id`, and `x-claude-code-request-class` headers are forwarded upstream so Meridian-backed providers can pick the right client adapter and resume the client's session instead of replaying a fresh one on every tool round. Credentials and all other client headers are never forwarded.

Routing defaults to `force-model`, where the globally selected proxy model and effort are authoritative for every session. In `force-provider`, same-family requests are forwarded unchanged. Cross-family requests preserve their capability tier (`Fable↔Astra`, `Opus↔Sol`, `Sonnet↔Terra`, `Haiku↔Luna`) within the globally selected generation when that counterpart is available, otherwise they fall back to the globally selected model. Selecting GPT-5.6 never auto-upgrades a route to GPT-6.1; frontier Fable↔Astra routing is the explicit cross-generation exception. Raw forwarding also requires the incoming and selected-model protocols to match.

Change global routing without restarting or clearing any session:

```bash
curl -X PUT http://127.0.0.1:8787/routing \
  -H 'content-type: application/json' \
  -d '{"mode":"force-provider","model":"gpt-5.6-sol","reasoningEffort":"high"}'
```

MTEL remains the default upstream. To route GPT through the local `codex-as-api`
backup instead, start `codex-as-api` on port 18080 and select its model alias:

```bash
curl -X PUT http://127.0.0.1:8787/routing \
  -H 'content-type: application/json' \
  -d '{"mode":"force-model","model":"codex-gpt-5.6-sol","reasoningEffort":"high"}'
```

Switch back to MTEL with the ordinary model ID:

```bash
curl -X PUT http://127.0.0.1:8787/routing \
  -H 'content-type: application/json' \
  -d '{"mode":"force-model","model":"gpt-5.6-sol","reasoningEffort":"high"}'
```

Use `GET /routing` to inspect the active route. `mode` accepts `force-model` or `force-provider`. `reasoningEffort` accepts `none`, `low`, `medium`, `high`, `xhigh`, or `null` to clear the global override. Effort is sent as `output_config.effort` on Anthropic-protocol upstreams and `reasoning_effort` on OpenAI-protocol upstreams when the request is converted or forced to the selected model; numeric `thinking` budgets are never synthesized.

Successful routing updates are saved to `.gateway-state.json` and restored after model discovery on restart. Set `GATEWAY_STATE` to use another path. The file contains only the selected model, mode, and reasoning effort. If the saved model is unavailable, the configured default is used without overwriting the saved state, so a temporarily unavailable discovered model can be restored on a later restart.

Health and status endpoints are `GET /health` and `GET /status`. Other endpoints are `GET /models` and `GET /sessions/:id`. The in-memory session store is deliberately behind an interface so a durable implementation can replace it later.

Providers with `"discoverModels": true` refresh `${baseUrl}/models` at startup and whenever `GET /models` is called. Catalog models are replaced in memory, while entries in `gateway.config.json` remain authoritative overrides. Dated snapshot duplicates such as `claude-haiku-4-5-20251001` are hidden when a stable alias exists. If refresh fails, the last good in-memory catalog is retained; startup without a catalog still uses the static models.

Request logging uses `GATEWAY_LOG_LEVEL=info|debug|silent`. `info` is the default compact JSON log, `debug` emits the full routing observation, and `silent` disables request logs.

## Routing behavior

- Same client/upstream protocol with complete incoming history: minimally modified passthrough (the selected upstream model is enforced).
- MTEL is the default upstream for both Anthropic- and OpenAI-compatible clients. The optional `codex-as-api` provider exposes GPT through its OpenAI-compatible protocol, so selecting its alias translates Anthropic client requests automatically.
- The local `gateway.config.json` reuses OpenCode's MTEL base URL, model IDs, and key file. The key itself is not copied into this repository.
- Different protocols, or an incoming request that lacks stored history: canonical reconstruction and translation.
- Streaming responses are translated one SSE event at a time and are never fully buffered.
- Hidden reasoning, provider state IDs, and prompt caches are not transferred.
- Provider-specific options are applied after common setting mapping.

## Test

```bash
npm test
```

Automatic context compaction, durable persistence, and provider-native cache optimization are intentionally follow-up phases. The context manager currently estimates model-specific fit and returns a normalized context-limit error instead of sending a request that is known not to fit.
