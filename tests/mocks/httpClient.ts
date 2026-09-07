/**
 * Per-file http mock helper (replaces setupAxiosMock for the fetch-based http wrapper).
 *
 * Usage:
 *
 *   import { setupHttpMock } from '../../../tests/mocks/httpClient'
 *
 *   const httpHandle = setupHttpMock()
 *   httpHandle.stubs.get = (url, opts) => Promise.resolve({ data: {...}, status: 200, statusText: 'OK', headers: new Headers() })
 *   httpHandle.stubs.post = (url, body, opts) => Promise.resolve({ data: {...}, status: 200, statusText: 'OK', headers: new Headers() })
 *
 *   beforeAll(() => { httpHandle.useStubs = true })
 *   afterAll(() => { httpHandle.useStubs = false })
 */

import { mock } from 'bun:test'

type AnyFn = (...args: any[]) => unknown

export type HttpMethodStubs = {
  get?: AnyFn
  post?: AnyFn
  put?: AnyFn
  patch?: AnyFn
  delete?: AnyFn
  request?: AnyFn
}

export type HttpMockHandle = {
  useStubs: boolean
  stubs: HttpMethodStubs
}

// Pre-load the real module BEFORE mock.module is called to avoid circular
// require inside the factory (mock.module intercepts subsequent requires).
let _realModule: Record<string, unknown> | undefined
try {
  _realModule = require('src/utils/http.ts') as Record<string, unknown>
} catch {
  // Module may fail to load in some test contexts (MACRO undefined, etc.)
  _realModule = undefined
}

export function setupHttpMock(): HttpMockHandle {
  const handle: HttpMockHandle = { useStubs: false, stubs: {} }

  const factory = () => {
    const realHttp = (_realModule?.http ?? {}) as Record<string, AnyFn>
    const realHttpError = _realModule?.HttpError as any

    const methods: (keyof HttpMethodStubs)[] = [
      'get',
      'post',
      'put',
      'patch',
      'delete',
      'request',
    ]

    const mockedHttp: Record<string, unknown> = { ...realHttp }
    for (const method of methods) {
      mockedHttp[method] = (...args: unknown[]) => {
        if (handle.useStubs && handle.stubs[method]) {
          return (handle.stubs[method] as AnyFn)(...args)
        }
        return (realHttp[method] as AnyFn)(...args)
      }
    }

    return {
      ...(_realModule ?? {}),
      http: mockedHttp,
      isHttpError: (e: unknown) =>
        realHttpError?.is?.(e) || (e instanceof Error && 'status' in e),
      isHttpAbortError:
        _realModule?.isHttpAbortError ??
        ((e: unknown) =>
          (e instanceof DOMException && e.name === 'AbortError') ||
          (e instanceof Error && e.name === 'AbortError')),
    }
  }

  // Register mock for all three specifier variants that production code may use.
  mock.module('src/utils/http.ts', factory)
  mock.module('src/utils/http.js', factory)
  mock.module('src/utils/http', factory)

  return handle
}
