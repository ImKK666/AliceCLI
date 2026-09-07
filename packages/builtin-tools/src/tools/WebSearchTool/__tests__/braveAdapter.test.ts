import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { setupHttpMock } from '../../../../../../tests/mocks/httpClient'

// Each test below calls `mock.module('src/utils/http.ts', ...)` per-test.
// Without an afterAll cleanup, the LAST per-test stub leaks into every test
// file that runs after this one (mock.module is process-global, last-write-wins).
// The spread-real mock registered here at the end re-routes http to the real
// module, undoing the stub leakage so later suites see real http.
afterAll(() => {
  setupHttpMock()
})

// Defensive mock: agent.test.ts mocks config.js which can corrupt Bun's
// src/* path alias resolution. Provide AbortError directly so the dynamic
// import in createAdapter() never needs to resolve the alias at runtime.
const _abortMock = () => ({
  AbortError: class AbortError extends Error {
    constructor(message?: string) {
      super(message)
      this.name = 'AbortError'
    }
  },
  isAbortError: (e: unknown) =>
    e instanceof Error && (e as Error).name === 'AbortError',
})
mock.module('src/utils/errors.js', _abortMock)
mock.module('src/utils/errors', _abortMock)

const originalBraveSearchApiKey = process.env.BRAVE_SEARCH_API_KEY
const originalBraveApiKey = process.env.BRAVE_API_KEY

// Helper: build an http mock factory for per-test mock.module calls.
function buildHttpMock(
  httpGet: (...args: any[]) => any,
  isAbort?: (e: unknown) => boolean,
) {
  const factory = () => ({
    http: { get: httpGet },
    isHttpAbortError: isAbort ?? (() => false),
    isHttpError: () => false,
    getWebFetchUserAgent: () => 'TestAgent/1.0',
    HttpError: class extends Error {
      status = 0
    },
  })
  mock.module('src/utils/http.ts', factory)
  mock.module('src/utils/http.js', factory)
  mock.module('src/utils/http', factory)
}

describe('BraveSearchAdapter.search', () => {
  const createAdapter = async () => {
    const { BraveSearchAdapter } = await import('../adapters/braveAdapter')
    return new BraveSearchAdapter()
  }

  const SAMPLE_RESPONSE = {
    grounding: {
      generic: [
        {
          title: 'Result One',
          url: 'https://example.com/result1',
          snippets: ['Snippet one'],
        },
        {
          title: 'Result Two',
          url: 'https://example.com/result2',
          snippets: ['Snippet two'],
        },
      ],
    },
  }

  beforeEach(() => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-brave-key'
    delete process.env.BRAVE_API_KEY
  })

  afterEach(() => {
    mock.restore()

    if (originalBraveSearchApiKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY
    } else {
      process.env.BRAVE_SEARCH_API_KEY = originalBraveSearchApiKey
    }

    if (originalBraveApiKey === undefined) {
      delete process.env.BRAVE_API_KEY
    } else {
      process.env.BRAVE_API_KEY = originalBraveApiKey
    }
  })

  test('returns parsed results from Brave LLM context payload', async () => {
    buildHttpMock(
      mock(() =>
        Promise.resolve({
          data: SAMPLE_RESPONSE,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
        }),
      ),
    )

    const adapter = await createAdapter()
    const results = await adapter.search('test query', {})

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: 'Result One',
      url: 'https://example.com/result1',
      snippet: 'Snippet one',
    })
    expect(results[1].title).toBe('Result Two')
  })

  test('calls onProgress with query_update and search_results_received', async () => {
    buildHttpMock(
      mock(() =>
        Promise.resolve({
          data: SAMPLE_RESPONSE,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
        }),
      ),
    )

    const progressCalls: any[] = []
    const onProgress = (p: any) => progressCalls.push(p)

    const adapter = await createAdapter()
    await adapter.search('test', { onProgress })

    expect(progressCalls).toHaveLength(2)
    expect(progressCalls[0]).toEqual({
      type: 'query_update',
      query: 'test',
    })
    expect(progressCalls[1]).toEqual({
      type: 'search_results_received',
      resultCount: 2,
      query: 'test',
    })
  })

  test('filters results by allowedDomains', async () => {
    const mixedResponse = {
      grounding: {
        generic: [
          { title: 'Allowed', url: 'https://allowed.com/a' },
          { title: 'Blocked', url: 'https://blocked.com/b' },
        ],
      },
    }

    buildHttpMock(
      mock(() =>
        Promise.resolve({
          data: mixedResponse,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
        }),
      ),
    )

    const adapter = await createAdapter()
    const results = await adapter.search('test', {
      allowedDomains: ['allowed.com'],
    })

    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://allowed.com/a')
  })

  test('filters results by blockedDomains', async () => {
    const mixedResponse = {
      grounding: {
        generic: [
          { title: 'Good', url: 'https://good.com/a' },
          { title: 'Spam', url: 'https://spam.com/b' },
        ],
      },
    }

    buildHttpMock(
      mock(() =>
        Promise.resolve({
          data: mixedResponse,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
        }),
      ),
    )

    const adapter = await createAdapter()
    const results = await adapter.search('test', {
      blockedDomains: ['spam.com'],
    })

    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://good.com/a')
  })

  test('filters subdomains with allowedDomains', async () => {
    const response = {
      grounding: {
        generic: [
          { title: 'Subdomain', url: 'https://docs.example.com/page' },
          { title: 'Other', url: 'https://other.com/page' },
        ],
      },
    }

    buildHttpMock(
      mock(() =>
        Promise.resolve({
          data: response,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
        }),
      ),
    )

    const adapter = await createAdapter()
    const results = await adapter.search('test', {
      allowedDomains: ['example.com'],
    })

    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://docs.example.com/page')
  })

  test('throws AbortError when signal is already aborted', async () => {
    buildHttpMock(
      mock((_url: string, config: any) => {
        if (config?.signal?.aborted) {
          const err = new DOMException(
            'The operation was aborted.',
            'AbortError',
          )
          return Promise.reject(err)
        }
        return Promise.resolve({
          data: SAMPLE_RESPONSE,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
        }) as any
      }),
      (e: unknown) =>
        (e instanceof DOMException && e.name === 'AbortError') ||
        (e instanceof Error && e.name === 'AbortError'),
    )

    const adapter = await createAdapter()
    const controller = new AbortController()
    controller.abort()

    const { AbortError } = await import('src/utils/errors')
    await expect(
      adapter.search('test', { signal: controller.signal }),
    ).rejects.toThrow(AbortError)
  })

  test('re-throws non-abort http errors', async () => {
    const networkError = new Error('Network error')
    buildHttpMock(mock(() => Promise.reject(networkError)))

    const adapter = await createAdapter()
    await expect(adapter.search('test', {})).rejects.toThrow('Network error')
  })

  test('sends the documented HTTPS endpoint with query params and auth header', async () => {
    const httpGet = mock(() =>
      Promise.resolve({
        data: SAMPLE_RESPONSE,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
      }),
    )
    buildHttpMock(httpGet)

    const adapter = await createAdapter()
    await adapter.search('hello world & special=chars', {})

    expect(httpGet.mock.calls).toHaveLength(1)
    // http.get(url, opts) — url is arg[0], opts is arg[1]
    expect((httpGet.mock.calls as any[][])[0][0]).toBe(
      'https://api.search.brave.com/res/v1/llm/context',
    )
    expect((httpGet.mock.calls as any[][])[0][1]).toMatchObject({
      params: { q: 'hello world & special=chars' },
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': 'test-brave-key',
      },
    })
  })

  test('accepts BRAVE_API_KEY as a fallback env var', async () => {
    delete process.env.BRAVE_SEARCH_API_KEY
    process.env.BRAVE_API_KEY = 'fallback-key'

    const httpGet = mock(() =>
      Promise.resolve({
        data: SAMPLE_RESPONSE,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
      }),
    )
    buildHttpMock(httpGet)

    const adapter = await createAdapter()
    await adapter.search('test', {})

    expect((httpGet.mock.calls as any[][])[0][1].headers).toMatchObject({
      'X-Subscription-Token': 'fallback-key',
    })
  })

  test('throws when no Brave API key is configured', async () => {
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.BRAVE_API_KEY

    buildHttpMock(
      mock(() =>
        Promise.resolve({
          data: SAMPLE_RESPONSE,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
        }),
      ),
    )

    const adapter = await createAdapter()
    await expect(adapter.search('test', {})).rejects.toThrow(
      'BraveSearchAdapter requires BRAVE_SEARCH_API_KEY or BRAVE_API_KEY',
    )
  })
})
