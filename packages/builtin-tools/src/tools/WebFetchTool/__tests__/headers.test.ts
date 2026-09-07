import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { setupHttpMock } from '../../../../../../tests/mocks/httpClient'

type MockHttpResponse = {
  data: ArrayBuffer
  headers: Headers
  status: number
  statusText: string
}

let getMock: (url: string, opts?: unknown) => Promise<MockHttpResponse>

const httpHandle = setupHttpMock()
httpHandle.stubs.get = (url: string, opts?: unknown) => getMock(url, opts)

mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
}))

mock.module('src/services/api/claude.js', () => ({
  queryHaiku: async () => ({ message: { content: [] } }),
}))

mock.module('src/utils/log.ts', logMock)

mock.module('src/utils/mcpOutputStorage.js', () => ({
  isBinaryContentType: (contentType: string) =>
    !contentType.toLowerCase().startsWith('text/'),
  persistBinaryContent: async () => ({
    filepath: '/tmp/webfetch-test.bin',
    size: 0,
  }),
}))

mock.module('src/utils/settings/settings.js', () => ({
  getInitialSettings: () => ({}),
  getSettings_DEPRECATED: () => ({ skipWebFetchPreflight: true }),
}))

beforeEach(() => {
  getMock = async () => ({
    data: new TextEncoder().encode('hello').buffer as ArrayBuffer,
    headers: new Headers({ 'content-type': 'text/plain' }),
    status: 200,
    statusText: 'OK',
  })
})

beforeAll(() => {
  httpHandle.useStubs = true
})

afterAll(() => {
  httpHandle.useStubs = false
})

describe('WebFetch response headers', () => {
  test('reads redirect Location from Headers', async () => {
    // With http wrapper + validateStatus: () => true, redirects are returned
    // as successful responses (not thrown as errors). The production code
    // checks response.status for redirect codes and reads Location from
    // the Headers object.
    getMock = async () => ({
      data: new ArrayBuffer(0),
      headers: new Headers({ location: '/next' }),
      status: 302,
      statusText: 'Found',
    })

    const { getWithPermittedRedirects } = await import('../utils')
    const result = await getWithPermittedRedirects(
      'https://example.com/old',
      new AbortController().signal,
      () => false,
    )

    expect(result).toEqual({
      type: 'redirect',
      originalUrl: 'https://example.com/old',
      redirectUrl: 'https://example.com/next',
      statusCode: 302,
    })
  })

  test('reads proxy block markers from normalized headers', async () => {
    // With http wrapper + validateStatus: () => true, 403 responses are
    // returned as successful responses. The production code checks for
    // the x-proxy-error header on 403 status.
    getMock = async () => ({
      data: new ArrayBuffer(0),
      headers: new Headers({ 'x-proxy-error': 'blocked-by-allowlist' }),
      status: 403,
      statusText: 'Forbidden',
    })

    const { getWithPermittedRedirects } = await import('../utils')

    await expect(
      getWithPermittedRedirects(
        'https://blocked.example/path',
        new AbortController().signal,
        () => false,
      ),
    ).rejects.toThrow('EGRESS_BLOCKED')
  })

  test('normalizes array content-type before cache and parsing', async () => {
    // Headers combine multiple values with commas when using append.
    const h = new Headers()
    h.append('content-type', 'text/plain')
    h.append('content-type', 'charset=utf-8')

    getMock = async () => ({
      data: new TextEncoder().encode('plain body').buffer as ArrayBuffer,
      headers: h,
      status: 200,
      statusText: 'OK',
    })

    const { clearWebFetchCache, getURLMarkdownContent } = await import(
      '../utils'
    )
    clearWebFetchCache()

    const result = await getURLMarkdownContent(
      'https://example.com/plain.txt',
      new AbortController(),
    )

    expect('type' in result).toBe(false)
    if ('type' in result) {
      throw new Error('unexpected redirect result')
    }
    expect(result.content).toBe('plain body')
    expect(result.contentType).toBe('text/plain, charset=utf-8')
  })
})
