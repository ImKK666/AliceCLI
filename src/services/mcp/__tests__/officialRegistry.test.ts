import {
  mock,
  describe,
  expect,
  test,
  afterEach,
  beforeAll,
  afterAll,
} from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug'
import { setupHttpMock } from '../../../../tests/mocks/httpClient'

const httpHandle = setupHttpMock()
httpHandle.stubs.get = async () => ({
  data: { servers: [] },
  status: 200,
  statusText: 'OK',
  headers: new Headers(),
})

beforeAll(() => {
  httpHandle.useStubs = true
})

afterAll(() => {
  httpHandle.useStubs = false
})

mock.module('src/utils/debug.ts', debugMock)

const { isOfficialMcpUrl, resetOfficialMcpUrlsForTesting } = await import(
  '../officialRegistry'
)

describe('isOfficialMcpUrl', () => {
  afterEach(() => {
    resetOfficialMcpUrlsForTesting()
  })

  test('returns false when registry not loaded (initial state)', () => {
    resetOfficialMcpUrlsForTesting()
    expect(isOfficialMcpUrl('https://example.com')).toBe(false)
  })

  test('returns false for non-registered URL', () => {
    expect(isOfficialMcpUrl('https://random-server.com/mcp')).toBe(false)
  })

  test('returns false for empty string', () => {
    expect(isOfficialMcpUrl('')).toBe(false)
  })
})

describe('resetOfficialMcpUrlsForTesting', () => {
  test('can be called without error', () => {
    expect(() => resetOfficialMcpUrlsForTesting()).not.toThrow()
  })

  test('clears state so subsequent lookups return false', () => {
    resetOfficialMcpUrlsForTesting()
    expect(isOfficialMcpUrl('https://anything.com')).toBe(false)
  })
})
