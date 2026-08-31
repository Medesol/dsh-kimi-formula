/**
 * The Kimi-backed `ctx.web` search provider. One search runs an auxiliary
 * chat-completions loop against a Kimi model with the official
 * `moonshot/web-search` formula declared as a standard `function` tool: the
 * model emits `tool_calls`, each call is executed verbatim through
 * `POST /formulas/{uri}/fibers` (the result, usually an encrypted envelope, is
 * fed back untouched), and the loop ends when the model answers without tool
 * calls. Kimi returns no structured source list — the encrypted fiber output is
 * only readable by the model — so `sources[]` is extracted from the links the
 * model itself cites in its final answer, and `content` carries the answer.
 * @module dsh-kimi-formula/search-provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import { KimiApi, fiberResult, isAbortError } from './kimi-api.js'

/** Stable id this provider registers under. */
export const KIMI_PROVIDER_ID = 'kimi-official'

/** Default endpoint base (`/v1` included; China platform, matching `moonshotai-cn`). */
export const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.cn/v1'

/** Default model driving the auxiliary search loop. */
export const KIMI_DEFAULT_MODEL = 'kimi-k3'

/** Default upper bound on generated tokens per auxiliary request. */
export const KIMI_DEFAULT_MAX_TOKENS = 8192

/**
 * Default reasoning effort for the auxiliary search loop. `low` keeps an
 * auxiliary call cheap and fast; kimi-k3 supports `low`/`high`/`max`.
 */
export const KIMI_DEFAULT_REASONING_EFFORT = 'low'

/** Default cap on chat-completions rounds (initial + tool continuations). */
export const KIMI_DEFAULT_MAX_SEARCH_ROUNDS = 8

/** Formula carrying Kimi's official web search. */
export const KIMI_WEB_SEARCH_FORMULA = 'moonshot/web-search:latest'

/** Cap on source links extracted from the model's cited answer. */
const MAX_EXTRACTED_SOURCES = 10

/**
 * The `web_search` tool declaration, snapshotted from
 * `GET /formulas/moonshot/web-search:latest/tools` (2026-08). Declared on every
 * request of the loop, as the Formula API requires.
 */
export const KIMI_WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: '用于信息检索的网络搜索',
    parameters: {
      type: 'object',
      properties: {
        query: { description: '要搜索的内容', type: 'string' },
        classes: {
          description: "要关注的搜索领域。如果未指定，则默认为 'all'。",
          type: 'array',
          items: {
            type: 'string',
            enum: ['all', 'academic', 'social', 'library', 'finance', 'code', 'ecommerce', 'medical'],
          },
        },
      },
      required: ['query'],
    },
  },
}

/** System prompt steering the auxiliary search loop. */
const SEARCH_SYSTEM_PROMPT = 'You are a web research assistant. Use the web_search tool to find '
  + 'current, reliable information for the user\'s query, then write a concise summary answer in '
  + 'the query\'s language. Cite every key fact with a markdown source link.'

/**
 * Extract citeable sources from the model's final answer: markdown links first
 * (link text becomes the title), then bare URLs. Deduped by URL, capped at
 * {@link MAX_EXTRACTED_SOURCES}. These are links the model itself cited — Kimi
 * exposes no structured result list to the client.
 * @param {string} content - the final answer text.
 * @returns {Array<{ url: string, title?: string }>} the extracted sources.
 */
export function extractSources(content) {
  const seen = new Set()
  const sources = []
  const push = (url, title) => {
    if (seen.has(url) || sources.length >= MAX_EXTRACTED_SOURCES) return
    seen.add(url)
    const source = { url }
    if (title !== undefined && title.length > 0 && title !== url) source.title = title
    sources.push(source)
  }
  for (const match of content.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)) {
    push(match[2], match[1].trim())
  }
  for (const match of content.matchAll(/(?<!\]\()(?<!\()(https?:\/\/[^\s)\]}"'>]+)/g)) {
    push(match[1].replace(/[.,;:!?，。；：！？]+$/, ''))
  }
  return sources
}

/**
 * The Kimi-backed search provider. Failures after dispatch name the operation;
 * a missing credential fails with `WEB_PROVIDER_CREDENTIAL_MISSING`.
 */
export class KimiSearchProvider {
  /** @param {() => object} resolveOptions - options for the NEXT operation (snapshotted per search). */
  constructor(resolveOptions) {
    this.id = KIMI_PROVIDER_ID
    this.resolveOptions = resolveOptions
  }

  /** Cheap local usability check; never makes network calls. */
  available() {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && isPositiveInteger(options.maxTokens)
      && isPositiveInteger(options.maxSearchRounds)
  }

  /**
   * Run one search as an auxiliary tool-call loop.
   * @param {{ query: string }} request - the search request (`maxResults` is
   *   enforced by the seam on the extracted sources).
   * @param {AbortSignal} [signal] - cancellation forwarded to every request.
   * @returns {Promise<{ content?: string, sources: Array<object>, truncated: boolean }>}
   */
  async search(request, signal) {
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options, signal)
    throwIfAborted(signal)
    const api = new KimiApi({ baseURL: options.baseURL, apiKey })
    const messages = [
      { role: 'system', content: SEARCH_SYSTEM_PROMPT },
      { role: 'user', content: request.query },
    ]
    options.recordRequest?.({
      endpoint: `${options.baseURL}/chat/completions`,
      formula: KIMI_WEB_SEARCH_FORMULA,
      model: options.model,
      query: request.query,
    })

    for (let round = 0; round < options.maxSearchRounds; round++) {
      throwIfAborted(signal)
      let payload
      try {
        payload = await api.chatCompletions({
          model: options.model,
          max_tokens: options.maxTokens,
          reasoning_effort: options.reasoningEffort,
          messages,
          tools: [KIMI_WEB_SEARCH_TOOL],
        }, signal)
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
        throw providerError(`Kimi search request failed: ${errorMessage(error)}`, error)
      }
      const choice = payload?.choices?.[0]
      const message = choice?.message
      if (message === undefined || message === null) {
        throw providerError('Kimi returned a response without a message choice')
      }
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      if (choice.finish_reason !== 'tool_calls' || toolCalls.length === 0) {
        const content = typeof message.content === 'string' ? message.content.trim() : ''
        if (content.length === 0) {
          throw providerError('Kimi ended the search loop with an empty answer')
        }
        return { content, sources: extractSources(content), truncated: false }
      }

      // Continue the loop: assistant message (role/content/tool_calls only, per
      // the Formula API guide), then one tool message per call.
      messages.push({
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : null,
        tool_calls: toolCalls,
      })
      for (const toolCall of toolCalls) {
        throwIfAborted(signal)
        const fn = toolCall?.function ?? {}
        let result
        if (fn.name === KIMI_WEB_SEARCH_TOOL.function.name && typeof fn.arguments === 'string') {
          try {
            const fiber = await api.fiber(KIMI_WEB_SEARCH_FORMULA, fn.name, fn.arguments, signal)
            result = fiberResult(fiber).result
          } catch (error) {
            if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
            result = `Error: web_search execution failed — ${errorMessage(error)}`
          }
        } else {
          result = `Error: unable to find tool by name '${String(fn.name)}'`
        }
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
      }
    }
    throw providerError(`Kimi search exceeded ${options.maxSearchRounds} rounds without a final answer`)
  }

  /** Resolve one operation's credential without retaining it on the provider. */
  async apiKey(options, signal) {
    throwIfAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved
    try {
      resolved = await options.resolveApiKey?.()
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(`Kimi search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (typeof resolved === 'string' && resolved.length > 0) return resolved
    const ref = options.apiKeyEnv ?? 'MOONSHOTAI_CN_API_KEY'
    throw new WebError(
      `Kimi search has no API key for "${ref}"; store it through the credentials service`
      + ' (the web Models page writes it when a Moonshot provider is configured), export it in the'
      + ' launching environment, or set a literal "apiKey" in the kimi-formula config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** Wrap a post-dispatch failure as a seam provider error. */
function providerError(message, cause) {
  return new WebError(message, 'WEB_PROVIDER_ERROR', cause === undefined ? undefined : { cause })
}

/** The provider's stable cancellation error. */
function aborted(signal, fallback) {
  return new WebError('Kimi search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw aborted(signal)
}

/** True for limits that can be sent to the API. */
function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

/** Lossless message extraction from a caught value. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
