/**
 * dsh-kimi-formula: Kimi (Moonshot AI) official Formula tools for DeepSeek Harness.
 *
 * Registers two things into a running profile:
 * - a `ctx.web` search provider (`kimi-official`) that runs Kimi's official
 *   `moonshot/web-search` formula as an auxiliary chat loop, giving the
 *   built-in `web_search` tool Kimi-native retrieval without any
 *   DeepSeek/Exa/Perplexity key;
 * - model-facing `kimi_*` tools for the remaining official formulas (convert,
 *   rethink, random-choice, mew, memory, excel, date, base64, fetch).
 *
 * The provider reuses the same `MOONSHOTAI_CN_API_KEY` credential the Models
 * page manages for `moonshotai-cn` chat by default.
 * @module dsh-kimi-formula
 */

import { appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { KimiApi } from './kimi-api.js'
import {
  KimiSearchProvider,
  KIMI_DEFAULT_BASE_URL,
  KIMI_DEFAULT_MAX_SEARCH_ROUNDS,
  KIMI_DEFAULT_MAX_TOKENS,
  KIMI_DEFAULT_MODEL,
  KIMI_DEFAULT_REASONING_EFFORT,
} from './search-provider.js'
import { registerFormulaTools } from './formula-tools.js'

export {
  KimiSearchProvider,
  KIMI_DEFAULT_BASE_URL,
  KIMI_DEFAULT_MAX_SEARCH_ROUNDS,
  KIMI_DEFAULT_MAX_TOKENS,
  KIMI_DEFAULT_MODEL,
  KIMI_DEFAULT_REASONING_EFFORT,
  KIMI_PROVIDER_ID,
  KIMI_WEB_SEARCH_FORMULA,
} from './search-provider.js'
export { KimiApi } from './kimi-api.js'
export { registerFormulaTools } from './formula-tools.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'kimi-formula'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Default credential reference: the same one the Models page writes for `moonshotai-cn`. */
const DEFAULT_API_KEY_ENV = 'MOONSHOTAI_CN_API_KEY'

/** Default cooperative budget (ms) for one formula tool call. */
const DEFAULT_TOOLS_TIMEOUT_MS = 60_000

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export const Config = z.object({
  /** Literal Kimi API key; prefer `apiKeyEnv` so no secret enters configuration files. */
  apiKey: z.string().role('secret'),
  /** Credential reference resolved for each call; defaults to `MOONSHOTAI_CN_API_KEY`. */
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  /** OpenAI-compatible endpoint base (`/v1` included). Defaults to the China platform. */
  baseURL: z.string(),
  /** Register the `kimi-official` ctx.web search provider. Defaults to true. */
  searchProvider: z.boolean().default(true),
  /** Model driving the auxiliary search loop. Defaults to `kimi-k3`. */
  searchModel: z.string().default(KIMI_DEFAULT_MODEL),
  /** Reasoning effort for the auxiliary search loop (`low`/`high`/`max`). Defaults to `low`. */
  searchReasoningEffort: z.string().default(KIMI_DEFAULT_REASONING_EFFORT),
  /** Upper bound on generated tokens per auxiliary request. Defaults to 8192. */
  searchMaxTokens: z.number().step(1).min(1).default(KIMI_DEFAULT_MAX_TOKENS),
  /** Cap on chat rounds (initial + tool continuations) per search. Defaults to 8. */
  searchMaxRounds: z.number().step(1).min(1).default(KIMI_DEFAULT_MAX_SEARCH_ROUNDS),
  /** Register the model-facing `kimi_*` formula tools. Defaults to true. */
  formulaTools: z.boolean().default(true),
  /** Cooperative budget (ms) for one formula tool call. Defaults to 60000. */
  toolsTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TOOLS_TIMEOUT_MS),
})

/**
 * Environment variable naming this plugin's endpoint. Distinct from any chat
 * adapter variable: the Formula API base is a search/tool concern, not chat.
 */
const BASE_URL_ENV = 'KIMI_FORMULA_BASE_URL'

/** Settings namespace carrying this plugin's section. */
export const KIMI_FORMULA_SETTINGS_NAMESPACE = 'kimi-formula'

/**
 * Best-effort side record of one outgoing Kimi search request.
 *
 * This deliberately does NOT append to the Session log: DSH's persistence read
 * path refuses a log containing an event type it does not know unless the
 * writer sets the envelope's `ignorable: true` marker, and `Session.append()`
 * exposes no way to set it. Appending `web/kimi-search-llm-request` therefore
 * made every affected Session unreadable, un-resumable and un-exportable
 * (session-log-export answered HTTP 500). Keep observability out of the log.
 * @param {object} request - the recorded search request summary.
 * @returns {Promise<void>} resolves after the record is written or skipped.
 */
async function recordSearchRequest(request) {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    await appendFile(join(home, 'kimi-search-requests.jsonl'), JSON.stringify({ time: Date.now(), ...request }) + '\n')
  } catch {
    // Debug-only record: an unwritable side log must never fail a search.
  }
}

/**
 * Project one resolved config into per-operation options. Credential resolution
 * prefers the credentials service (the web Models page writes it) and falls
 * back to the launching environment.
 * @param {object} ctx - plugin context supplying the credential plane.
 * @param {Record<string, any>} config - the currently authoritative section.
 * @returns {Record<string, any>} options for one operation.
 */
function resolveOptions(ctx, config) {
  const apiKeyEnv = typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0
    ? config.apiKeyEnv
    : DEFAULT_API_KEY_ENV
  const literalApiKey = typeof config.apiKey === 'string' && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      const ambient = process.env[apiKeyEnv]
      return ambient !== undefined && ambient.length > 0 ? ambient : undefined
    },
    apiKeyEnv,
    baseURL: typeof config.baseURL === 'string' && config.baseURL.length > 0
      ? config.baseURL
      : process.env[BASE_URL_ENV] ?? KIMI_DEFAULT_BASE_URL,
    model: config.searchModel ?? KIMI_DEFAULT_MODEL,
    reasoningEffort: config.searchReasoningEffort ?? KIMI_DEFAULT_REASONING_EFFORT,
    maxTokens: config.searchMaxTokens ?? KIMI_DEFAULT_MAX_TOKENS,
    maxSearchRounds: config.searchMaxRounds ?? KIMI_DEFAULT_MAX_SEARCH_ROUNDS,
    timeoutMs: config.toolsTimeoutMs ?? DEFAULT_TOOLS_TIMEOUT_MS,
    recordRequest: (request) => {
      void recordSearchRequest(request)
    },
  }
}

/**
 * Register the Kimi search provider and the formula tools. The settings
 * section, when the settings service is present, lets the web UI edit every
 * field; the provider/tools project the section per call, so a committed
 * change needs no re-registration.
 * @param {object} ctx - plugin context.
 * @param {Record<string, any>} config - the schema-resolved plugin config.
 */
export function apply(ctx, config) {
  let current = () => config
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      settingsCtx.settings.installSection(ctx, KIMI_FORMULA_SETTINGS_NAMESPACE, Config, config, {
        setSource: (source) => { current = source },
        onChange: () => {},
      })
    } catch (error) {
      // The Settings UI section is auxiliary; the plugin must still work when
      // the section cannot be installed (e.g. a schema-runtime mismatch).
      console.warn('dsh-kimi-formula: settings section unavailable:', error)
    }
  })

  const resolved = config
  if (resolved.searchProvider !== false) {
    ctx.web.registerSearchProvider(new KimiSearchProvider(() => resolveOptions(ctx, current())))
  }
  if (resolved.formulaTools !== false) {
    ctx.inject(['tools', 'systemPrompt'], (toolCtx) => {
      registerFormulaTools(toolCtx, {
        timeoutMs: current().toolsTimeoutMs ?? DEFAULT_TOOLS_TIMEOUT_MS,
        resolveApi: async (signal) => {
          const options = resolveOptions(ctx, current())
          let apiKey = options.apiKey
          if (apiKey === undefined) {
            if (signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
            apiKey = await options.resolveApiKey()
          }
          if (typeof apiKey !== 'string' || apiKey.length === 0) {
            throw new Error(
              `kimi formula tools have no API key for "${options.apiKeyEnv}"; store it through the`
              + ' credentials service (the web Models page writes it when a Moonshot provider is'
              + ' configured), export it in the launching environment, or set a literal "apiKey"'
              + ' in the kimi-formula config',
            )
          }
          return new KimiApi({ baseURL: options.baseURL, apiKey })
        },
      })
    })
  }
}
