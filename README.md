# dsh-kimi-formula

Use [Kimi (Moonshot AI)](https://platform.kimi.com) official **Formula API** tools inside [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) — including **web search** — with nothing but the Kimi API key you already use for chat. No DeepSeek, Exa, or Perplexity key required.

[中文文档](README.zh.md)

## What is this?

DSH's built-in `web_search` tool ships with three search providers (DeepSeek, Exa, Perplexity). If you run a Kimi model (e.g. `kimi-k3` through `moonshotai-cn`) but have no key for any of those providers, the tool is dead. This plugin closes the gap by speaking to Kimi's own [Formula API](https://platform.kimi.com/docs/guide/use-official-tools) — the official-tools channel the Kimi platform recommends for `kimi-k3`:

1. **A `ctx.web` search provider (`kimi-official`)** — plugs into DSH's web capability seam, so the *built-in* `web_search` tool gains Kimi-native retrieval. Each search runs an auxiliary chat loop: the model declares the official `web_search` function tool, emits `tool_calls`, the plugin executes them verbatim through `POST /formulas/moonshot/web-search:latest/fibers` (protected results arrive as an encrypted envelope and are fed back untouched), and the model composes a cited answer. The answer is returned as `content`; `sources[]` is extracted from the links the model itself cites (Kimi exposes no structured result list to clients).

2. **Ten model-facing `kimi_*` tools** — one per remaining official formula, each executing a fiber call directly: `kimi_convert`, `kimi_date`, `kimi_base64_encode`, `kimi_base64_decode`, `kimi_random_choice`, `kimi_memory`, `kimi_excel`, `kimi_fetch`, `kimi_rethink`, `kimi_mew`.

> Kimi's docs also list `quickjs` and `code-runner`, but both currently answer `404 formula not found` on `api.moonshot.cn`, so they are not registered. Re-run `node scripts/fetch-formula-tools.mjs` to check; adding them later is a two-line change in `src/formula-tools.js`.

## Requirements

- A working [DSH](https://github.com/deepseek-ai/deepseek-harness) setup (the `web` profile — i.e. you run `dsh web`), Node.js ≥ 22.19.
- A Kimi API key from [platform.kimi.com](https://platform.kimi.com). If you already configured a Moonshot provider on the DSH **Models** page, the plugin reuses that very credential (`MOONSHOTAI_CN_API_KEY`) — nothing else to set up.

## Install

**One command** — pnpm (which `dsh plugin` forwards to) fetches straight from GitHub and installs the runtime dependencies automatically:

```bash
dsh plugin --profile web add github:Medesol/dsh-kimi-formula
# → "dsh-kimi-formula declares no dsh.bundle — installed as a plain dependency"
#    (expected; the plugin is activated by a patch row below)
```

<details>
<summary>Alternative: install from a local clone (for development)</summary>

```bash
git clone https://github.com/Medesol/dsh-kimi-formula.git
cd dsh-kimi-formula
pnpm install   # a bare-path add links the directory; its deps resolve from here
dsh plugin --profile web add "$PWD"
```

</details>

Edit the profile's user patch layer `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
# Switch the web seam's search provider to Kimi.
# (A patch replaces the targeted row's whole `config`, so fetchProvider is restated.)
- id: web
  config:
    searchProvider: kimi-official
    fetchProvider: http

# Mount the plugin.
- insert:
    - id: kimi-formula
      name: 'dsh-kimi-formula'
```

Restart `dsh web` (new modules cannot hot-load; profiles with `patchReload: live` apply the change on save without a restart).

**Verify it works** — in a new session, ask:

```
用 web_search 查一下 Kimi K3 的最新消息
```

and

```
用 kimi_date 算一下 2026-01-01 到今天有多少天
```

Uninstall: `dsh plugin --profile web remove dsh-kimi-formula`, then delete the patch rows above.

## Configuration

All fields are optional; the plugin installs a `kimi-formula` section under **Settings → Plugins** when the settings service is present. You can also set them in the patch row's `config:` block.

| Field | Default | Description |
|---|---|---|
| `apiKey` | — | Literal Kimi API key (prefer `apiKeyEnv`; never commit secrets) |
| `apiKeyEnv` | `MOONSHOTAI_CN_API_KEY` | Credential reference resolved per call. Matches what the Models page writes for `moonshotai-cn`. Set to `MOONSHOT_API_KEY` if you only exported that one |
| `baseURL` | `https://api.moonshot.cn/v1` | OpenAI-compatible base. Use `https://api.moonshot.ai/v1` for the international platform; env override: `KIMI_FORMULA_BASE_URL` |
| `searchProvider` | `true` | Register the `kimi-official` ctx.web search provider |
| `searchModel` | `kimi-k3` | Model driving the auxiliary search loop |
| `searchReasoningEffort` | `low` | `low` / `high` / `max` — `low` keeps auxiliary searches cheap and fast |
| `searchMaxTokens` | `8192` | `max_tokens` per auxiliary request |
| `searchMaxRounds` | `8` | Chat-round cap (initial + tool continuations) per search |
| `formulaTools` | `true` | Register the `kimi_*` tools |
| `toolsTimeoutMs` | `60000` | Cooperative per-call budget for the formula tools |

> `web-search` is billed per call (see [pricing](https://platform.kimi.com/docs/pricing/tools)); the other official tools are free for a limited time. The built-in `web_search` tool has a 60s timeout in the base composition (`tool-web.searchTimeoutMs`) — raise it via a patch row if slow searches ever time out.

## Tools & examples

Every example below was executed against the live Formula API by `node scripts/test-examples.mjs` (outputs are real).

### `kimi_convert` — unit conversion

```json
{ "value": 72, "from_unit": "°F", "to_unit": "°C" }
```
```
72.0 °F = 22.22 °C
```

### `kimi_date` — date/time math

```json
{ "operation": "between", "date1": "2026-01-01", "date2": "2026-08-13" }
```
```
224 days
```

### `kimi_base64_encode` / `kimi_base64_decode`

```json
{ "data": "Hello, Kimi!" }
```
```
SGVsbG8sIEtpbWkh
```
```json
{ "data": "SGVsbG8sIEtpbWkh" }
```
```
Hello, Kimi!
```

### `kimi_random_choice` — random / weighted picks

```json
{ "candidates": ["apple", "banana", "cherry", "durian"], "count": 2, "seed": 42 }
```
```
apple, durian
```

### `kimi_memory` — server-side key/value memory

```json
{ "action": "store", "key": "dsh-kimi-formula-demo", "data": { "note": "hello from dsh" }, "ttl": 300 }
{ "action": "retrieve", "key": "dsh-kimi-formula-demo" }
```
```
{"note": "hello from dsh"}
```

### `kimi_fetch` — server-side URL fetch (alternative to `web_fetch`)

```json
{ "url": "https://example.com", "max_length": 300 }
```
```
URL: https://example.com
Title: Example Domain

This domain is for use in documentation examples without needing permission. Avoid use in operations.
```

### `kimi_rethink` — thought organization

```json
{ "thought": "Publishing a DSH plugin: 1) test every tool, 2) write the README, 3) push to GitHub with topics." }
```
```
{"thought": "I have thought about it and I think it is a good idea to do something."}
```

### `kimi_mew` — cat sounds + a blessing (official easter egg)

```json
{ "mood": "happy" }
```
```
{"sound": "喵喵喵~", "blessing": "愿你的生活像猫咪一样悠闲自在！", "mood": "happy"}
```

### `kimi_excel` — Excel/CSV analysis (17 operators)

`function` picks the operator (`read_file`, `list_sheets`, `describe`, `inspect`, `pipe`, `groupby`, `orderby`, `filter`, `head`, `value_counts`, `correlation`, `sample`, `select`, `count`, `sum`, `distinct`, `add_column`); `arguments` carries that operator's parameters. `file_id` must be a Kimi Files API file ID, not a local path:

```json
{ "function": "groupby", "arguments": { "file_id": "file_xxx", "by": "city", "agg": { "sales": "sum" } } }
```

> ⚠️ **Platform migration caveat (2026-09-01):** the Kimi file service is migrating to `file_`-prefixed IDs ([announcement](https://platform.kimi.com/docs/api/files-upload)), and the excel lambda currently rejects legacy IDs returned by `POST /v1/files` with `File <id> is empty or not found`. Use a `file_`-prefixed ID (e.g. a file uploaded via the Kimi workbench), or retry after the migration completes. `scripts/test-examples.mjs` demonstrates the full upload → analyze → cleanup flow and reports this exact case as `SKIP`.

### `web_search` (built-in tool, via the `kimi-official` provider)

Once the patch row switches `searchProvider`, the stock `web_search` tool just works — the model issues its usual queries, the provider runs the Kimi search loop, and results come back as an answer plus a source list:

```
> What is the latest Kimi model from Moonshot AI, and what is it known for?

The latest flagship from Moonshot AI is Kimi K3, released in July 2026. …
Sources: poyo.ai/hub/kimi-k3-review, huggingface.co/moonshotai, whatllm.org/blog/kimi-k3
```

## Troubleshooting

- **`configured web provider "kimi-official" is not registered`** — the plugin row didn't load: check the patch file, then restart `dsh web`.
- **`Kimi search has no API key for "MOONSHOTAI_CN_API_KEY"`** — configure a Moonshot provider on the Models page, export the variable in the launching environment, or set `apiKeyEnv` / `apiKey`.
- **`kimi_excel` says `File ... is empty or not found`** — see the migration caveat above.
- **International platform** — set `baseURL` to `https://api.moonshot.ai/v1` (and your credential to the international key).
- **`formula not found` for quickjs / code-runner** — not yet available on the platform; nothing to fix locally.

## Development

```
src/
  index.js           plugin entry: Config schema, apply(), credential resolution
  search-provider.js ctx.web provider: the auxiliary web_search chat loop
  formula-tools.js   the ten kimi_* tools (static declaration table)
  kimi-api.js        minimal fetch client for chat completions + formulas
scripts/
  resolve-credential.mjs    env → ~/.dsh/.credentials.yaml key resolution (never printed)
  fetch-formula-tools.mjs   refresh formula-tools.snapshot.json from the live API
  test-examples.mjs         runs every README example against the live API (one paid search)
```

Dev-time dependencies resolve from your DSH checkout or npm (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-web`, `@deepseek-ai/schemastery`); the plugin itself is plain dependency-free-style ESM and needs no build step.

## License

[MIT](LICENSE)
