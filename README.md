# Provider-agnostic AI gateway

A small Node.js gateway that exposes Anthropic-compatible `POST /v1/messages` and OpenAI-compatible `POST /v1/chat/completions` endpoints while keeping a provider-neutral session history. A session can switch models without resetting its messages, tool calls, or tool results.

## Run

Requires Node.js 22.6 or newer. The only runtime dependency is `codex-as-api`, which runs the optional ChatGPT provider inside the gateway.

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

MTEL remains the default upstream. GPT can also run on your own ChatGPT plan: a provider configured as `"chatgpt": { "embedded": "chatgpt" }` makes the gateway start `codex-as-api` in-process on a random loopback port, so nothing else has to be launched. It reads the same login the Codex app and CLI use (`CODEX_AS_API_AUTH_PATH`, else `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`). Its models are discovered from the ChatGPT catalog and listed with a `codex-` prefix, for example `codex-gpt-5.6-sol`. If you are not signed in, the control panel's ChatGPT section opens the ChatGPT sign-in page; `GET /chatgpt` reports the status and `POST /chatgpt/login` starts a sign-in. Select a ChatGPT model like any other:

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

## Desktop app

The gateway can also run as a macOS menu-bar app so nobody has to install Node or use a terminal. The app starts the gateway on launch, shows a control panel for model, mode, reasoning effort, and connection settings, and stops the gateway on quit.

```bash
npm install
npm run app:dev      # bundle electron/main.ts and launch the app against the working copy
npm run dist         # build release/Local Proxy-<version>-<arch>.dmg (arm64 and x64)
```

The app ships only `electron/gateway.config.json`, which names the MTEL Polycon base URL with no key, plus the embedded ChatGPT provider. Each user pastes their own API key in the Connection section; it is stored with the selected route under the app's user-data folder (`~/Library/Application Support/Local Proxy/`), never inside the bundle, so it survives updates. The key can be changed or removed from the same screen.

The control panel is plain HTML in `ui/` and only calls the gateway's own endpoints, so it can also be opened in a browser at the gateway address when running `npm start` with `GATEWAY_UI_DIR` unset and `startGateway({ uiDir: "ui" })`, or simply from the app window. `GET /settings` reports each provider's base URL and whether a key is saved (last four characters only); `PUT /settings` with `{ "provider", "apiKey", "baseUrl" }` updates them and refreshes the model catalog. An empty `apiKey` removes the saved key. `GATEWAY_USER_SETTINGS` points the standalone server at a settings file; without it, UI-entered settings last for the current run only.

The Activity log section of the control panel shows the same lines as `GATEWAY_LOG_LEVEL=info npm start` prints to the terminal: one JSON line per handled request plus gateway warnings and routing or settings changes. The gateway keeps the latest 500 lines in memory; `GET /logs?since=<id>` returns them as JSON and `GET /logs/stream` is a Server-Sent Events feed the panel follows while open. Log lines carry only the last four characters of an API key, never the key itself.

The Claude Desktop section sets up Claude Desktop's third-party (3p) provider mode in one click. It writes a credential helper under the app's user-data folder, a "Local Proxy" profile in `~/Library/Application Support/Claude-3p/configLibrary/` that points Claude Desktop at the gateway with model discovery on, marks that profile as applied, and sets `deploymentMode` to `3p`; then it opens Claude Desktop. Claude Desktop is quit first if it is running, because it reads the profile at launch. The gateway injects the real MTEL key itself, so the helper only returns a placeholder. A second button switches Claude Desktop between Claude.ai (1p) and this gateway (3p): Claude Desktop reads `deploymentMode` from `Claude-3p/claude_desktop_config.json` at launch whichever mode it is in, so the switch quits it if needed, rewrites that key, and opens it again; the "Local Proxy" profile is kept, so switching back needs no setup. The same endpoints are `GET /claude-desktop` (status, `deploymentMode`, and issues), `POST /claude-desktop/setup`, `PUT /claude-desktop/mode` with `{ "mode": "1p" | "3p" }`, and `POST /claude-desktop/open`. This profile layout was read from Claude 5.1231.2 and 5.11492.2 and is not a documented interface; the Claude Desktop setup page remains the manual fallback.

If port 8787 is taken, for example by a copy started with `npm start`, the app offers to retry and can be launched with `GATEWAY_PORT` set to another port. Rebuilding after a gateway change is `npm run dist` again; users replace the old app and keep their settings. The release is ad-hoc signed, so it runs on the build machine and on Macs where the user allows it in Privacy & Security; distributing widely needs a Developer ID certificate and notarization.

## Routing behavior

- Same client/upstream protocol with complete incoming history: minimally modified passthrough (the selected upstream model is enforced).
- MTEL is the default upstream for both Anthropic- and OpenAI-compatible clients. The embedded ChatGPT provider exposes GPT through its OpenAI-compatible protocol, so selecting a `codex-` model translates Anthropic client requests automatically. Fields the ChatGPT transport rejects (`max_tokens`, `temperature`, `top_p`, `stop`, `stream_options`) are cleared, and stop reasons are translated back to the client's protocol. MTEL's GPT models are served over the same Codex OAuth transport and reject the Anthropic `metadata` field: such a rejection is retried once without it, and the field is left out for that model afterwards. Other models keep it, since it carries the client's session identity. In `force-provider` mode, tier matching stays within the selected model's provider.
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
