/**
 * HTTP utility constants and helpers
 *
 * Includes a thin fetch wrapper (`http`) that provides axios-like convenience
 * over native `fetch()`. The wrapper is the migration target for the 67 files
 * that still import axios directly.
 */

import axios from 'axios'
import { OAUTH_BETA_HEADER } from '../constants/oauth.js'
import {
  getAnthropicApiKey,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
  isClaudeAISubscriber,
} from './auth.js'
import { getClaudeCodeUserAgent } from './userAgent.js'
import { getWorkload } from './workloadContext.js'

// WARNING: We rely on `claude-cli` in the user agent for log filtering.
// Please do NOT change this without making sure that logging also gets updated!
export function getUserAgent(): string {
  const agentSdkVersion = process.env.CLAUDE_AGENT_SDK_VERSION
    ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`
    : ''
  // SDK consumers can identify their app/library via CLAUDE_AGENT_SDK_CLIENT_APP
  // e.g., "my-app/1.0.0" or "my-library/2.1"
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    ? `, client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`
    : ''
  // Turn-/process-scoped workload tag for cron-initiated requests. 1P-only
  // observability — proxies strip HTTP headers; QoS routing uses cc_workload
  // in the billing-header attribution block instead (see constants/system.ts).
  // getAnthropicClient (client.ts:98) calls this per-request inside withRetry,
  // so the read picks up the same setWorkload() value as getAttributionHeader.
  const workload = getWorkload()
  const workloadSuffix = workload ? `, workload/${workload}` : ''
  return `claude-cli/${MACRO.VERSION} (${process.env.USER_TYPE}, ${process.env.CLAUDE_CODE_ENTRYPOINT ?? 'cli'}${agentSdkVersion}${clientApp}${workloadSuffix})`
}

export function getMCPUserAgent(): string {
  const parts: string[] = []
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    parts.push(process.env.CLAUDE_CODE_ENTRYPOINT)
  }
  if (process.env.CLAUDE_AGENT_SDK_VERSION) {
    parts.push(`agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`)
  }
  if (process.env.CLAUDE_AGENT_SDK_CLIENT_APP) {
    parts.push(`client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`)
  }
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `claude-code/${MACRO.VERSION}${suffix}`
}

// User-Agent for WebFetch requests to arbitrary sites. `Claude-User` is
// Anthropic's publicly documented agent for user-initiated fetches (what site
// operators match in robots.txt); the claude-code suffix lets them distinguish
// local CLI traffic from claude.ai server-side fetches.
export function getWebFetchUserAgent(): string {
  return `Claude-User (${getClaudeCodeUserAgent()}; +https://support.anthropic.com/)`
}

export type AuthHeaders = {
  headers: Record<string, string>
  error?: string
}

/**
 * Get authentication headers for API requests
 * Returns either OAuth headers for Max/Pro users or API key headers for regular users
 */
export function getAuthHeaders(): AuthHeaders {
  if (isClaudeAISubscriber()) {
    const oauthTokens = getClaudeAIOAuthTokens()
    if (!oauthTokens?.accessToken) {
      return {
        headers: {},
        error: 'No OAuth token available',
      }
    }
    return {
      headers: {
        Authorization: `Bearer ${oauthTokens.accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
    }
  }
  // TODO: this will fail if the API key is being set to an LLM Gateway key
  // should we try to query keychain / credentials for a valid Anthropic key?
  const apiKey = getAnthropicApiKey()
  if (!apiKey) {
    return {
      headers: {},
      error: 'No API key available',
    }
  }
  return {
    headers: {
      'x-api-key': apiKey,
    },
  }
}

/**
 * Wrapper that handles OAuth 401 errors by force-refreshing the token and
 * retrying once. Addresses clock drift scenarios where the local expiration
 * check disagrees with the server.
 *
 * The request closure is called again on retry, so it should re-read auth
 * (e.g., via getAuthHeaders()) to pick up the refreshed token.
 *
 * Note: bridgeApi.ts has its own DI-injected version — handleOAuth401Error
 * transitively pulls in config.ts (~1300 modules), which breaks the SDK bundle.
 *
 * @param opts.also403Revoked - Also retry on 403 with "OAuth token has been
 *   revoked" body (some endpoints signal revocation this way instead of 401).
 */
export async function withOAuth401Retry<T>(
  request: () => Promise<T>,
  opts?: { also403Revoked?: boolean },
): Promise<T> {
  try {
    return await request()
  } catch (err) {
    if (!axios.isAxiosError(err)) throw err
    const status = err.response?.status
    const isAuthError =
      status === 401 ||
      (opts?.also403Revoked &&
        status === 403 &&
        typeof err.response?.data === 'string' &&
        err.response.data.includes('OAuth token has been revoked'))
    if (!isAuthError) throw err
    const failedAccessToken = getClaudeAIOAuthTokens()?.accessToken
    if (!failedAccessToken) throw err
    await handleOAuth401Error(failedAccessToken)
    return await request()
  }
}

// ---------------------------------------------------------------------------
// Thin fetch wrapper — axios-compatible response shape
// ---------------------------------------------------------------------------

/**
 * Response shape returned by the `http` wrapper. Matches the axios response
 * interface (`{ data, status, statusText, headers }`) so call sites can be
 * migrated with minimal churn.
 */
export interface HttpResponse<T = unknown> {
  data: T
  status: number
  statusText: string
  headers: Headers
}

/**
 * Error thrown by the `http` wrapper for non-2xx responses (or when
 * `validateStatus` returns `false`). Replaces `AxiosError` — use
 * `HttpError.is(err)` as a drop-in for `axios.isAxiosError(err)`.
 */
export class HttpError extends Error {
  readonly status: number
  readonly statusText: string
  readonly data: unknown
  readonly response: Response

  constructor(response: Response, data: unknown) {
    super(`HTTP ${response.status} ${response.statusText}`)
    this.name = 'HttpError'
    this.status = response.status
    this.statusText = response.statusText
    this.data = data
    this.response = response
  }

  /** Drop-in replacement for `axios.isAxiosError(err)`. */
  static is(err: unknown): err is HttpError {
    return err instanceof HttpError
  }
}

/**
 * Drop-in replacement for `axios.isAxiosError(err)`.
 * Identical to `HttpError.is()` — exported as a standalone function for
 * call sites that prefer a free function over a static method.
 */
export function isHttpError(err: unknown): err is HttpError {
  return HttpError.is(err)
}

/**
 * Drop-in replacement for `axios.isCancel(err)`.
 * Returns `true` when the error originated from an `AbortController.abort()`
 * or an `AbortSignal` timeout — i.e. a `DOMException` with name `AbortError`.
 */
export function isHttpAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  // Node/Bun sometimes wrap the reason in a TypeError with cause
  if (
    err instanceof TypeError &&
    err.cause instanceof DOMException &&
    (err.cause as DOMException).name === 'AbortError'
  ) {
    return true
  }
  return false
}

/** Options accepted by every `http.*` method. */
export interface HttpRequestOptions {
  headers?: Record<string, string>
  /** Timeout in milliseconds. Uses an internal AbortController. */
  timeout?: number
  /** External abort signal. Linked with the timeout signal if both are set. */
  signal?: AbortSignal
  /** How to decode the response body. Defaults to `'json'`. */
  responseType?: 'json' | 'text' | 'arraybuffer' | 'stream'
  /**
   * Return `true` to treat the status as success (no `HttpError` thrown).
   * Defaults to `(s) => s >= 200 && s < 300`.
   */
  validateStatus?: (status: number) => boolean
  /** URL query parameters appended via `URLSearchParams`. */
  params?: Record<string, string>
}

// ---- internal helpers -----------------------------------------------------

function defaultValidateStatus(status: number): boolean {
  return status >= 200 && status < 300
}

function buildUrl(
  base: string,
  params: Record<string, string> | undefined,
): string {
  if (!params || Object.keys(params).length === 0) return base
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}${new URLSearchParams(params).toString()}`
}

function isPlainBody(body: unknown): boolean {
  if (body === null || body === undefined) return false
  if (typeof body === 'string') return false
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return false
  if (typeof FormData !== 'undefined' && body instanceof FormData) return false
  if (typeof Blob !== 'undefined' && body instanceof Blob) return false
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)
    return false
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
    return false
  return typeof body === 'object'
}

async function parseResponseBody(
  response: Response,
  responseType: HttpRequestOptions['responseType'],
): Promise<unknown> {
  switch (responseType) {
    case 'text':
      return response.text()
    case 'arraybuffer':
      return response.arrayBuffer()
    case 'stream':
      return response.body
    case 'json':
    default: {
      // Gracefully handle empty bodies (204 No Content, etc.)
      const text = await response.text()
      if (text.length === 0) return null
      try {
        return JSON.parse(text)
      } catch {
        // If the server returns non-JSON, surface the raw text
        return text
      }
    }
  }
}

async function doRequest<T>(
  method: string,
  url: string,
  body: unknown | undefined,
  options: HttpRequestOptions = {},
): Promise<HttpResponse<T>> {
  const {
    headers: extraHeaders,
    timeout,
    signal: externalSignal,
    responseType = 'json',
    validateStatus = defaultValidateStatus,
    params,
  } = options

  const finalUrl = buildUrl(url, params)

  // --- headers ---
  const headers: Record<string, string> = { ...extraHeaders }
  if (
    body !== undefined &&
    isPlainBody(body) &&
    !headers['Content-Type'] &&
    !headers['content-type']
  ) {
    headers['Content-Type'] = 'application/json'
  }

  // --- body serialization ---
  let fetchBody: BodyInit | undefined
  if (body === undefined || body === null) {
    fetchBody = undefined
  } else if (isPlainBody(body)) {
    fetchBody = JSON.stringify(body)
  } else {
    // string, ArrayBuffer, FormData, Blob, ReadableStream, etc.
    fetchBody = body as BodyInit
  }

  // --- abort / timeout ---
  let signal: AbortSignal | undefined = externalSignal
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  if (timeout !== undefined && timeout > 0) {
    const timeoutController = new AbortController()
    timeoutId = setTimeout(() => timeoutController.abort(), timeout)
    timeoutId.unref?.()

    if (externalSignal) {
      // Link external signal and timeout signal
      signal = AbortSignal.any([externalSignal, timeoutController.signal])
    } else {
      signal = timeoutController.signal
    }
  }

  try {
    const response = await fetch(finalUrl, {
      method: method.toUpperCase(),
      headers,
      body: fetchBody,
      signal,
      redirect: 'follow',
    })

    const data = (await parseResponseBody(response, responseType)) as T

    if (!validateStatus(response.status)) {
      throw new HttpError(response, data)
    }

    return {
      data,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

// ---- public API -----------------------------------------------------------

/**
 * Thin fetch wrapper with an axios-compatible interface.
 *
 * ```ts
 * const { data } = await http.get<User[]>('/api/users')
 * await http.post('/api/users', { name: 'Ada' })
 * ```
 */
export const http = {
  get<T = unknown>(
    url: string,
    options?: HttpRequestOptions,
  ): Promise<HttpResponse<T>> {
    return doRequest<T>('GET', url, undefined, options)
  },

  post<T = unknown>(
    url: string,
    body?: unknown,
    options?: HttpRequestOptions,
  ): Promise<HttpResponse<T>> {
    return doRequest<T>('POST', url, body, options)
  },

  put<T = unknown>(
    url: string,
    body?: unknown,
    options?: HttpRequestOptions,
  ): Promise<HttpResponse<T>> {
    return doRequest<T>('PUT', url, body, options)
  },

  patch<T = unknown>(
    url: string,
    body?: unknown,
    options?: HttpRequestOptions,
  ): Promise<HttpResponse<T>> {
    return doRequest<T>('PATCH', url, body, options)
  },

  delete<T = unknown>(
    url: string,
    options?: HttpRequestOptions,
  ): Promise<HttpResponse<T>> {
    return doRequest<T>('DELETE', url, undefined, options)
  },

  request<T = unknown>(
    method: string,
    url: string,
    body?: unknown,
    options?: HttpRequestOptions,
  ): Promise<HttpResponse<T>> {
    return doRequest<T>(method, url, body, options)
  },
}
