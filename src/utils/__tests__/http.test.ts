import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  HttpError,
  http,
  isHttpAbortError,
  isHttpError,
  type HttpResponse,
} from '../http'

// ---------------------------------------------------------------------------
// fetch mock infrastructure
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch
let originalFetch: FetchFn
let mockFetch: ReturnType<typeof mock>

function createMockResponse(
  body: string | null,
  init: ResponseInit & { url?: string } = {},
): Response {
  const { url: _url, ...responseInit } = init
  return new Response(body, {
    status: 200,
    statusText: 'OK',
    ...responseInit,
  })
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  mockFetch = mock((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(createMockResponse('{}', { status: 200 })),
  )
  globalThis.fetch = mockFetch as unknown as FetchFn
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// GET / POST with JSON body
// ---------------------------------------------------------------------------

describe('http.get', () => {
  test('makes a GET request and parses JSON response', async () => {
    const payload = { id: 1, name: 'Ada' }
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        createMockResponse(JSON.stringify(payload), { status: 200 }),
      ),
    )

    const res = await http.get<typeof payload>('https://api.test/users/1')

    expect(res.data).toEqual(payload)
    expect(res.status).toBe(200)
    expect(res.statusText).toBe('OK')
    expect(res.headers).toBeInstanceOf(Headers)

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test/users/1')
    expect(init.method).toBe('GET')
  })

  test('returns null data for empty body (204)', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse('', { status: 204 })),
    )

    const res = await http.get('https://api.test/empty')
    expect(res.data).toBeNull()
    expect(res.status).toBe(204)
  })
})

describe('http.post', () => {
  test('sends JSON body with correct Content-Type', async () => {
    const body = { name: 'Ada', age: 36 }
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        createMockResponse(JSON.stringify({ ok: true }), { status: 201 }),
      ),
    )

    const res = await http.post('https://api.test/users', body)

    expect(res.status).toBe(201)
    expect(res.data).toEqual({ ok: true })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify(body))
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    )
  })

  test('sends string body without auto-serialization', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse('"ok"', { status: 200 })),
    )

    await http.post('https://api.test/raw', 'raw text', {
      headers: { 'Content-Type': 'text/plain' },
    })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.body).toBe('raw text')
  })

  test('does not set Content-Type for FormData', async () => {
    const form = new FormData()
    form.append('file', 'data')
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse('{}', { status: 200 })),
    )

    await http.post('https://api.test/upload', form)

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    // FormData — browser/runtime sets the boundary automatically; we must
    // NOT set Content-Type ourselves.
    expect(
      (init.headers as Record<string, string>)['Content-Type'],
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// PUT / PATCH / DELETE
// ---------------------------------------------------------------------------

describe('http.put', () => {
  test('sends PUT request with body', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse('{}', { status: 200 })),
    )
    await http.put('https://api.test/item/1', { name: 'updated' })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('PUT')
  })
})

describe('http.patch', () => {
  test('sends PATCH request with body', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse('{}', { status: 200 })),
    )
    await http.patch('https://api.test/item/1', { name: 'patched' })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('PATCH')
  })
})

describe('http.delete', () => {
  test('sends DELETE request without body', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse('', { status: 204 })),
    )
    const res = await http.delete('https://api.test/item/1')

    expect(res.status).toBe(204)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// http.request (generic method)
// ---------------------------------------------------------------------------

describe('http.request', () => {
  test('accepts arbitrary HTTP methods', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse('{}', { status: 200 })),
    )
    await http.request('OPTIONS', 'https://api.test/cors')

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('OPTIONS')
  })
})

// ---------------------------------------------------------------------------
// Non-2xx throws HttpError
// ---------------------------------------------------------------------------

describe('HttpError on non-2xx', () => {
  test('throws HttpError for 404', async () => {
    const errorBody = { error: 'not found' }
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        createMockResponse(JSON.stringify(errorBody), {
          status: 404,
          statusText: 'Not Found',
        }),
      ),
    )

    try {
      await http.get('https://api.test/missing')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError)
      const httpErr = err as HttpError
      expect(httpErr.status).toBe(404)
      expect(httpErr.statusText).toBe('Not Found')
      expect(httpErr.data).toEqual(errorBody)
      expect(httpErr.message).toBe('HTTP 404 Not Found')
    }
  })

  test('throws HttpError for 500', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        createMockResponse('"server error"', {
          status: 500,
          statusText: 'Internal Server Error',
        }),
      ),
    )

    expect(http.get('https://api.test/boom')).rejects.toBeInstanceOf(HttpError)
  })
})

// ---------------------------------------------------------------------------
// HttpError.is() / isHttpError()
// ---------------------------------------------------------------------------

describe('HttpError.is', () => {
  test('returns true for HttpError instances', () => {
    const err = new HttpError(new Response('', { status: 400 }), 'bad request')
    expect(HttpError.is(err)).toBe(true)
    expect(isHttpError(err)).toBe(true)
  })

  test('returns false for plain Error', () => {
    expect(HttpError.is(new Error('nope'))).toBe(false)
    expect(isHttpError(new Error('nope'))).toBe(false)
  })

  test('returns false for non-error values', () => {
    expect(HttpError.is(null)).toBe(false)
    expect(HttpError.is(undefined)).toBe(false)
    expect(HttpError.is('string')).toBe(false)
    expect(HttpError.is(42)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Timeout via AbortController
// ---------------------------------------------------------------------------

describe('timeout', () => {
  test('aborts request when timeout elapses', async () => {
    // Mock fetch that respects the signal, like real fetch does
    mockFetch.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal) {
            if (signal.aborted) {
              reject(
                new DOMException('The operation was aborted.', 'AbortError'),
              )
              return
            }
            signal.addEventListener('abort', () => {
              reject(
                new DOMException('The operation was aborted.', 'AbortError'),
              )
            })
          }
        }),
    )

    try {
      await http.get('https://api.test/slow', { timeout: 50 })
      throw new Error('should have thrown')
    } catch (err) {
      expect(isHttpAbortError(err)).toBe(true)
    }
  })

  test('does not abort when request completes before timeout', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse('{"ok":true}', { status: 200 })),
    )

    const res = await http.get('https://api.test/fast', { timeout: 5000 })
    expect(res.data).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// isHttpAbortError
// ---------------------------------------------------------------------------

describe('isHttpAbortError', () => {
  test('detects DOMException with name AbortError', () => {
    const err = new DOMException('The operation was aborted.', 'AbortError')
    expect(isHttpAbortError(err)).toBe(true)
  })

  test('detects Error with name AbortError', () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    expect(isHttpAbortError(err)).toBe(true)
  })

  test('detects TypeError wrapping AbortError cause', () => {
    const cause = new DOMException('aborted', 'AbortError')
    const err = new TypeError('fetch failed', { cause })
    expect(isHttpAbortError(err)).toBe(true)
  })

  test('returns false for unrelated errors', () => {
    expect(isHttpAbortError(new Error('network'))).toBe(false)
    expect(isHttpAbortError(null)).toBe(false)
    expect(isHttpAbortError(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// External signal passthrough
// ---------------------------------------------------------------------------

describe('external signal', () => {
  test('respects external AbortSignal', async () => {
    // Mock fetch that respects the signal, like real fetch does
    mockFetch.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal) {
            if (signal.aborted) {
              reject(
                new DOMException('The operation was aborted.', 'AbortError'),
              )
              return
            }
            signal.addEventListener('abort', () => {
              reject(
                new DOMException('The operation was aborted.', 'AbortError'),
              )
            })
          }
        }),
    )

    const controller = new AbortController()
    const promise = http.get('https://api.test/slow', {
      signal: controller.signal,
    })

    // Abort after a short delay
    setTimeout(() => controller.abort(), 10)

    try {
      await promise
      throw new Error('should have thrown')
    } catch (err) {
      expect(isHttpAbortError(err)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// responseType: text, arraybuffer
// ---------------------------------------------------------------------------

describe('responseType', () => {
  test('responseType text returns string', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse('plain text body', { status: 200 })),
    )

    const res = await http.get<string>('https://api.test/text', {
      responseType: 'text',
    })
    expect(res.data).toBe('plain text body')
    expect(typeof res.data).toBe('string')
  })

  test('responseType arraybuffer returns ArrayBuffer', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(bytes, { status: 200 })),
    )

    const res = await http.get<ArrayBuffer>('https://api.test/binary', {
      responseType: 'arraybuffer',
    })
    expect(res.data).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(res.data)).toEqual(bytes)
  })

  test('responseType stream returns ReadableStream', async () => {
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk'))
        controller.close()
      },
    })
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(readable, { status: 200, statusText: 'OK' }),
      ),
    )

    const res = await http.get<ReadableStream>('https://api.test/stream', {
      responseType: 'stream',
    })
    expect(res.data).toBeInstanceOf(ReadableStream)
  })
})

// ---------------------------------------------------------------------------
// validateStatus prevents throwing
// ---------------------------------------------------------------------------

describe('validateStatus', () => {
  test('does not throw when validateStatus returns true for 404', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        createMockResponse('{"msg":"not found"}', {
          status: 404,
          statusText: 'Not Found',
        }),
      ),
    )

    const res = await http.get('https://api.test/maybe', {
      validateStatus: () => true,
    })
    expect(res.status).toBe(404)
    expect(res.data).toEqual({ msg: 'not found' })
  })

  test('throws when validateStatus returns false for 200', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse('{}', { status: 200 })),
    )

    expect(
      http.get('https://api.test/strict', {
        validateStatus: () => false,
      }),
    ).rejects.toBeInstanceOf(HttpError)
  })

  test('accepts status < 500 pattern used in codebase', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        createMockResponse('{"error":"forbidden"}', { status: 403 }),
      ),
    )

    const res = await http.get('https://api.test/bridge', {
      validateStatus: (s: number) => s < 500,
    })
    expect(res.status).toBe(403)
    expect(res.data).toEqual({ error: 'forbidden' })
  })
})

// ---------------------------------------------------------------------------
// Query params appended to URL
// ---------------------------------------------------------------------------

describe('params', () => {
  test('appends query params to URL without existing query string', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse('{}', { status: 200 })),
    )

    await http.get('https://api.test/search', {
      params: { q: 'hello', page: '1' },
    })

    const [url] = mockFetch.mock.calls[0] as [string]
    expect(url).toContain('q=hello')
    expect(url).toContain('page=1')
    expect(url).toMatch(/^https:\/\/api\.test\/search\?/)
  })

  test('appends query params to URL with existing query string', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse('{}', { status: 200 })),
    )

    await http.get('https://api.test/search?existing=1', {
      params: { extra: 'yes' },
    })

    const [url] = mockFetch.mock.calls[0] as [string]
    expect(url).toBe('https://api.test/search?existing=1&extra=yes')
  })

  test('empty params object does not modify URL', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse('{}', { status: 200 })),
    )

    await http.get('https://api.test/clean', { params: {} })

    const [url] = mockFetch.mock.calls[0] as [string]
    expect(url).toBe('https://api.test/clean')
  })
})

// ---------------------------------------------------------------------------
// Custom headers
// ---------------------------------------------------------------------------

describe('custom headers', () => {
  test('merges custom headers into request', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse('{}', { status: 200 })),
    )

    await http.get('https://api.test/auth', {
      headers: {
        Authorization: 'Bearer tok_123',
        'X-Custom': 'value',
      },
    })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer tok_123')
    expect(headers['X-Custom']).toBe('value')
  })

  test('does not override explicit Content-Type for JSON body', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse('{}', { status: 200 })),
    )

    await http.post(
      'https://api.test/custom',
      { key: 'value' },
      {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      },
    )

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json; charset=utf-8')
  })
})

// ---------------------------------------------------------------------------
// JSON parse fallback
// ---------------------------------------------------------------------------

describe('json parse edge cases', () => {
  test('returns raw text when JSON parse fails', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse('not json at all', { status: 200 })),
    )

    const res = await http.get<string>('https://api.test/html')
    expect(res.data).toBe('not json at all')
  })
})
