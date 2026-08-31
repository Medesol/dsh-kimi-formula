/**
 * Minimal fetch client for Kimi's OpenAI-compatible Chat Completions API and the
 * Formula API (`GET /formulas/{uri}/tools`, `POST /formulas/{uri}/fibers`).
 * Plain `Error`s carry the HTTP status and any provider detail; callers wrap
 * them in seam-appropriate error types. The wire format is provider-private and
 * does not use `ctx.llm`.
 * @module dsh-kimi-formula/kimi-api
 */

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'dsh-kimi-formula/0.1.0'

/**
 * True for a fetch/`AbortSignal` abort; callers surface cancellation as their
 * own stable aborted error, not as a provider failure.
 * @param {unknown} error - the caught value.
 * @returns {boolean} whether the value is an abort.
 */
export function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Extract a human-readable detail from Kimi's OpenAI-style error envelope. */
function errorDetail(parsed) {
  if (parsed === null || typeof parsed !== 'object') return undefined
  const error = /** @type {{ error?: { message?: string } | string, message?: string }} */ (parsed)
  const detail = typeof error.error === 'string' ? error.error : error.error?.message ?? error.message
  return typeof detail === 'string' && detail.length > 0 ? detail : undefined
}

export class KimiApi {
  /**
   * @param {object} options - resolved per-operation options.
   * @param {string} options.baseURL - OpenAI-compatible base (`/v1` included).
   * @param {string} options.apiKey - bearer credential for this operation.
   */
  constructor(options) {
    this.baseURL = options.baseURL.replace(/\/+$/, '')
    this.apiKey = options.apiKey
  }

  /** @returns {Record<string, string>} the headers sent on every request. */
  headers() {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': USER_AGENT,
    }
  }

  /**
   * One non-streaming `POST /chat/completions`.
   * @param {Record<string, unknown>} body - the full request body.
   * @param {AbortSignal} [signal] - cancellation forwarded to fetch.
   * @returns {Promise<Record<string, any>>} the parsed response envelope.
   */
  async chatCompletions(body, signal) {
    return this.post(`${this.baseURL}/chat/completions`, body, signal)
  }

  /**
   * `GET /formulas/{uri}/tools` — the formula's tool declaration list.
   * @param {string} formulaUri - e.g. `moonshot/web-search:latest`.
   * @param {AbortSignal} [signal] - cancellation forwarded to fetch.
   * @returns {Promise<Record<string, any>>} the parsed `{ tools: [...] }` envelope.
   */
  async formulaTools(formulaUri, signal) {
    const endpoint = `${this.baseURL}/formulas/${formulaUri}/tools`
    let response
    try {
      response = await fetch(endpoint, {
        method: 'GET',
        redirect: 'error',
        headers: this.headers(),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw error
      throw new Error(`Kimi formula tools request failed: ${String(error)}`, { cause: error })
    }
    return this.parse(endpoint, response, signal)
  }

  /**
   * `POST /formulas/{uri}/fibers` — execute one tool call verbatim. `arguments`
   * is the model-emitted JSON string and is passed through untouched.
   * @param {string} formulaUri - the formula owning the tool.
   * @param {string} name - `tool_calls[].function.name`.
   * @param {string} argumentsJson - `tool_calls[].function.arguments`, verbatim.
   * @param {AbortSignal} [signal] - cancellation forwarded to fetch.
   * @returns {Promise<Record<string, any>>} the parsed fiber envelope.
   */
  async fiber(formulaUri, name, argumentsJson, signal) {
    return this.post(`${this.baseURL}/formulas/${formulaUri}/fibers`, { name, arguments: argumentsJson }, signal)
  }

  /** Shared POST helper with redirect rejection and abort passthrough. */
  async post(endpoint, body, signal) {
    let response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: this.headers(),
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw error
      throw new Error(`Kimi API request failed: ${String(error)}`, { cause: error })
    }
    return this.parse(endpoint, response, signal)
  }

  /** Parse one response, raising a detail-carrying `Error` on non-2xx. */
  async parse(endpoint, response, signal) {
    if (!response.ok) {
      let message = `Kimi API error (HTTP ${response.status})`
      try {
        const detail = errorDetail(await response.json())
        if (detail !== undefined) message += `: ${detail}`
      } catch (error) {
        // An abort fired mid-body must surface as an abort, not be swallowed
        // into a generic HTTP-error message.
        if (signal?.aborted === true || isAbortError(error)) throw error
      }
      throw new Error(message)
    }
    try {
      return await response.json()
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw error
      throw new Error(`Kimi returned an unprocessable response body: ${String(error)}`, { cause: error })
    }
  }
}

/**
 * Project one fiber envelope into the tool-result text the model continues with.
 * Protected formulas (web-search) answer in `context.encrypted_output`, an
 * opaque envelope only the model side decrypts; it must be fed back verbatim.
 * @param {Record<string, any>} fiber - the parsed fiber response.
 * @returns {{ ok: boolean, result: string }} the tool result and success flag.
 */
export function fiberResult(fiber) {
  const status = typeof fiber?.status === 'string' ? fiber.status : 'unknown'
  if (status === 'succeeded') {
    const context = fiber.context ?? {}
    const result = context.output ?? context.encrypted_output ?? ''
    return { ok: true, result: typeof result === 'string' ? result : JSON.stringify(result) }
  }
  const detail = errorDetail(fiber) ?? `fiber ${typeof fiber?.id === 'string' ? fiber.id : ''} ended with status "${status}"`
  return { ok: false, result: `Error: formula execution failed — ${detail}` }
}
