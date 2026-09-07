/**
 * Tests for launchAgentsPlatform.tsx
 *
 * Strategy per feedback_mock_dependency_not_subject:
 * - DO NOT mock agentsApi.ts itself (would pollute api.test.ts)
 * - Mock http (the underlying HTTP layer) to control API responses
 * - Let real agentsApi functions run real code paths
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { setupHttpMock } from '../../../../tests/mocks/httpClient.js'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({
  feature: (_name: string) => true,
}))

// ── Analytics mock ──────────────────────────────────────────────────────────
const realAnalytics = await import('src/services/analytics/index.js')
const logEventMock = mock(() => {})
mock.module('src/services/analytics/index.js', () => ({
  ...realAnalytics,
  logEvent: logEventMock,
}))

// ── Auth / OAuth mocks ──────────────────────────────────────────────────────
const realAuth = await import('src/utils/auth.js')
mock.module('src/utils/auth.js', () => ({
  ...realAuth,
  getClaudeAIOAuthTokens: () => ({ accessToken: 'test-token-ap' }),
}))
mock.module('src/services/oauth/client.js', () => ({
  getOrganizationUUID: async () => 'org-uuid-ap',
}))
mock.module('src/constants/oauth.js', () => ({
  getOauthConfig: () => ({ BASE_API_URL: 'https://api.anthropic.com' }),
}))
const realTeleportApi = await import('src/utils/teleport/api.js')
mock.module('src/utils/teleport/api.js', () => ({
  ...realTeleportApi,
  getOAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
  prepareWorkspaceApiRequest: async () => ({
    apiKey: 'test-workspace-key-ap',
  }),
  prepareApiRequest: async () => ({
    apiKey: 'test-api-key-ap',
  }),
}))
mock.module('src/services/auth/hostGuard.ts', () => ({
  assertSubscriptionBaseUrl: () => {},
  assertWorkspaceHost: () => {},
  assertNoAnthropicEnvForOpenAI: () => {},
}))

// ── cron mock ───────────────────────────────────────────────────────────────
mock.module('src/utils/cron.js', () => ({
  parseCronExpression: (expr: string) =>
    expr.includes('INVALID')
      ? null
      : { minute: [0], hour: [9], dayOfMonth: [1], month: [1], dayOfWeek: [1] },
  cronToHuman: (expr: string) => `Human(${expr})`,
  computeNextCronRun: () => null,
}))

// ── HTTP mock ───────────────────────────────────────────────────────────────
const httpGetMock = mock(async () => ({}))
const httpPostMock = mock(async () => ({}))
const httpDeleteMock = mock(async () => ({}))

const httpHandle = setupHttpMock()
httpHandle.stubs.get = httpGetMock
httpHandle.stubs.post = httpPostMock
httpHandle.stubs.delete = httpDeleteMock

let callAgentsPlatform: typeof import('../launchAgentsPlatform.js').callAgentsPlatform

beforeAll(async () => {
  httpHandle.useStubs = true
  const mod = await import('../launchAgentsPlatform.js')
  callAgentsPlatform = mod.callAgentsPlatform
})

afterAll(() => {
  httpHandle.useStubs = false
})

beforeEach(() => {
  logEventMock.mockClear()
  httpGetMock.mockClear()
  httpPostMock.mockClear()
  httpDeleteMock.mockClear()
})

function makeContext() {
  return {} as Parameters<typeof callAgentsPlatform>[1]
}

describe('callAgentsPlatform', () => {
  test('list (empty args) calls listAgents and returns element', async () => {
    const onDone = mock(() => {})
    httpGetMock.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 'agt_1',
            cron_expr: '0 9 * * 1',
            prompt: 'hello world',
            status: 'active',
            timezone: 'UTC',
            next_run: null,
          },
        ],
      },
      status: 200,
    })
    const result = await callAgentsPlatform(onDone, makeContext(), '')
    expect(httpGetMock).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(result).not.toBeNull()
    expect(logEventMock).toHaveBeenCalledWith(
      'tengu_agents_platform_list',
      expect.anything(),
    )
  })

  test('list sub-command calls listAgents', async () => {
    const onDone = mock(() => {})
    httpGetMock.mockResolvedValueOnce({
      data: { data: [] },
      status: 200,
    })
    await callAgentsPlatform(onDone, makeContext(), 'list')
    expect(httpGetMock).toHaveBeenCalledTimes(1)
  })

  test('create with valid cron calls createAgent', async () => {
    const onDone = mock(() => {})
    httpPostMock.mockResolvedValueOnce({
      data: {
        id: 'agt_new',
        cron_expr: '0 9 * * 1',
        prompt: 'Run standup',
        status: 'active',
        timezone: 'UTC',
        next_run: null,
      },
      status: 201,
    })
    const result = await callAgentsPlatform(
      onDone,
      makeContext(),
      'create 0 9 * * 1 Run standup',
    )
    expect(httpPostMock).toHaveBeenCalledTimes(1)
    const callArgs = httpPostMock.mock.calls[0] as unknown as [
      string,
      unknown,
      unknown,
    ]
    const url = callArgs[0]
    const body = callArgs[1] as Record<string, unknown>
    expect(url).toContain('/v1/agents')
    expect(body.cron_expr).toBe('0 9 * * 1')
    expect(body.prompt).toBe('Run standup')
    expect(result).not.toBeNull()
    expect(logEventMock).toHaveBeenCalledWith(
      'tengu_agents_platform_create',
      expect.anything(),
    )
  })

  test('create with INVALID cron does not call API', async () => {
    // parseCronExpression returns null for expressions containing 'INVALID'
    const onDone = mock(() => {})
    await callAgentsPlatform(
      onDone,
      makeContext(),
      'create INVALID INVALID * * * my prompt',
    )
    // cron = 'INVALID INVALID * * *', mock returns null → no API call
    expect(httpPostMock).not.toHaveBeenCalled()
    expect(logEventMock).toHaveBeenCalledWith(
      'tengu_agents_platform_failed',
      expect.anything(),
    )
  })

  test('delete with id calls deleteAgent', async () => {
    const onDone = mock(() => {})
    httpDeleteMock.mockResolvedValueOnce({ data: {}, status: 204 })
    const result = await callAgentsPlatform(
      onDone,
      makeContext(),
      'delete agt_abc',
    )
    expect(httpDeleteMock).toHaveBeenCalledTimes(1)
    const callArgs = httpDeleteMock.mock.calls[0] as unknown as [
      string,
      unknown,
    ]
    expect(callArgs[0]).toContain('agt_abc')
    expect(result).not.toBeNull()
    expect(logEventMock).toHaveBeenCalledWith(
      'tengu_agents_platform_delete',
      expect.anything(),
    )
  })

  test('run with id calls runAgent', async () => {
    const onDone = mock(() => {})
    httpPostMock.mockResolvedValueOnce({
      data: { run_id: 'run_123' },
      status: 200,
    })
    const result = await callAgentsPlatform(
      onDone,
      makeContext(),
      'run agt_xyz',
    )
    expect(httpPostMock).toHaveBeenCalledTimes(1)
    const callArgs = httpPostMock.mock.calls[0] as unknown as [
      string,
      unknown,
      unknown,
    ]
    expect(callArgs[0]).toContain('agt_xyz')
    expect(callArgs[0]).toContain('/run')
    expect(result).not.toBeNull()
    expect(logEventMock).toHaveBeenCalledWith(
      'tengu_agents_platform_run',
      expect.anything(),
    )
  })

  test('invalid args logs failed and calls onDone', async () => {
    const onDone = mock(() => {})
    await callAgentsPlatform(onDone, makeContext(), 'unknown-cmd foo')
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(logEventMock).toHaveBeenCalledWith(
      'tengu_agents_platform_failed',
      expect.anything(),
    )
    expect(httpGetMock).not.toHaveBeenCalled()
  })

  test('listAgents API error → error view returned', async () => {
    httpGetMock.mockRejectedValueOnce(new Error('network error'))
    const onDone = mock(() => {})
    const result = await callAgentsPlatform(onDone, makeContext(), 'list')
    expect(result).not.toBeNull()
    expect(logEventMock).toHaveBeenCalledWith(
      'tengu_agents_platform_failed',
      expect.anything(),
    )
  })

  test('started event fires on every call', async () => {
    const onDone = mock(() => {})
    httpGetMock.mockResolvedValueOnce({
      data: { data: [] },
      status: 200,
    })
    await callAgentsPlatform(onDone, makeContext(), '')
    expect(logEventMock).toHaveBeenCalledWith(
      'tengu_agents_platform_started',
      expect.anything(),
    )
  })

  // ── Error-path branches ──────────────────────────────────────────────────

  test('createAgent API error → error view returned', async () => {
    httpPostMock.mockRejectedValueOnce(new Error('subscription required'))
    const onDone = mock(() => {})
    const result = await callAgentsPlatform(
      onDone,
      makeContext(),
      'create 0 9 * * 1 My prompt',
    )
    expect(result).not.toBeNull()
    expect(logEventMock).toHaveBeenCalledWith(
      'tengu_agents_platform_failed',
      expect.anything(),
    )
    expect(onDone).toHaveBeenCalledWith(
      expect.stringContaining('subscription required'),
      expect.anything(),
    )
  })

  test('deleteAgent API error → error view returned', async () => {
    httpDeleteMock.mockRejectedValueOnce(new Error('not found'))
    const onDone = mock(() => {})
    const result = await callAgentsPlatform(
      onDone,
      makeContext(),
      'delete agt_abc',
    )
    expect(result).not.toBeNull()
    expect(logEventMock).toHaveBeenCalledWith(
      'tengu_agents_platform_failed',
      expect.anything(),
    )
    expect(onDone).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
      expect.anything(),
    )
  })

  test('runAgent API error → error view returned', async () => {
    httpPostMock.mockRejectedValueOnce(new Error('run failed'))
    const onDone = mock(() => {})
    const result = await callAgentsPlatform(
      onDone,
      makeContext(),
      'run agt_xyz',
    )
    expect(result).not.toBeNull()
    expect(logEventMock).toHaveBeenCalledWith(
      'tengu_agents_platform_failed',
      expect.anything(),
    )
    expect(onDone).toHaveBeenCalledWith(
      expect.stringContaining('run failed'),
      expect.anything(),
    )
  })

  test('create with no prompt part → invalid action', async () => {
    const onDone = mock(() => {})
    // Only 4 cron fields — parseArgs returns invalid
    await callAgentsPlatform(onDone, makeContext(), 'create 0 9 * *')
    expect(httpPostMock).not.toHaveBeenCalled()
    expect(logEventMock).toHaveBeenCalledWith(
      'tengu_agents_platform_failed',
      expect.anything(),
    )
  })
})
