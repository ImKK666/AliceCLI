/**
 * Tests for launchVault.tsx
 *
 * IMPORTANT: Per feedback_mock_dependency_not_subject.md, we mock http (lower dep),
 * NOT the vaultsApi module itself, to avoid Bun mock.module process-level pollution.
 *
 * SECURITY: Tests verify credential value never appears in onDone message text.
 */

import {
  afterAll,
  afterEach,
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

// ── Auth / OAuth mocks ──────────────────────────────────────────────────────
mock.module('src/utils/auth.js', () => ({
  getClaudeAIOAuthTokens: () => ({ accessToken: 'test-token' }),
}))
mock.module('src/services/oauth/client.js', () => ({
  getOrganizationUUID: async () => 'org-uuid-test',
}))
mock.module('src/constants/oauth.js', () => ({
  getOauthConfig: () => ({ BASE_API_URL: 'https://api.anthropic.com' }),
}))
mock.module('src/utils/teleport/api.js', () => ({
  getOAuthHeaders: (token: string) => ({
    Authorization: `Bearer ${token}`,
  }),
  prepareWorkspaceApiRequest: async () => ({
    apiKey: 'test-workspace-key',
  }),
}))

// ── HTTP mock ───────────────────────────────────────────────────────────────
const httpGetMock = mock(async () => ({}))
const httpPostMock = mock(async () => ({}))
const httpDeleteMock = mock(async () => ({}))

const httpHandle = setupHttpMock()
httpHandle.stubs.get = httpGetMock
httpHandle.stubs.post = httpPostMock
httpHandle.stubs.delete = httpDeleteMock

// ── Lazy import after mocks ─────────────────────────────────────────────────
let callVault: typeof import('../launchVault.js').callVault

beforeAll(async () => {
  httpHandle.useStubs = true
  const mod = await import('../launchVault.js')
  callVault = mod.callVault
})

afterAll(() => {
  httpHandle.useStubs = false
})

beforeEach(() => {
  httpGetMock.mockClear()
  httpPostMock.mockClear()
})

afterEach(() => {})

// ── list ──────────────────────────────────────────────────────────────────
describe('callVault list', () => {
  test('calls listVaults and returns vault count in onDone', async () => {
    const vaults = [{ vault_id: 'v1', name: 'Test Vault' }]
    httpGetMock.mockResolvedValueOnce({ data: { data: vaults }, status: 200 })

    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    const result = await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'list',
    )
    expect(onDoneMsg).toMatch(/1 vault/)
    expect(result).not.toBeNull()
  })

  test('empty vault list shows friendly message', async () => {
    httpGetMock.mockResolvedValueOnce({ data: { data: [] }, status: 200 })
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      '',
    )
    expect(onDoneMsg).toMatch(/no vaults/i)
  })

  test('API error shows error in onDone', async () => {
    const err = Object.assign(new Error('Unauthorized'), {
      status: 401,
      data: {},
      statusText: 'Unauthorized',
      response: new Response(null, { status: 401 }),
    })
    httpGetMock.mockRejectedValueOnce(err)
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'list',
    )
    expect(onDoneMsg).toMatch(/failed|error|login|authenticate/i)
  })
})

// ── create ────────────────────────────────────────────────────────────────
describe('callVault create', () => {
  test('creates vault and returns vault_id in onDone', async () => {
    httpPostMock.mockResolvedValueOnce({
      data: { vault_id: 'vault_new', name: 'My Vault' },
      status: 201,
    })
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'create My Vault',
    )
    expect(onDoneMsg).toMatch(/created/)
    expect(onDoneMsg).toMatch(/vault_new/)
  })

  test('create with no name → invalid args message', async () => {
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'create',
    )
    expect(onDoneMsg).toMatch(/usage|name/i)
  })
})

// ── get ───────────────────────────────────────────────────────────────────
describe('callVault get', () => {
  test('fetches vault and displays detail', async () => {
    httpGetMock.mockResolvedValueOnce({
      data: { vault_id: 'vault_123', name: 'Work' },
      status: 200,
    })
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    const result = await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'get vault_123',
    )
    expect(onDoneMsg).toMatch(/fetched/i)
    expect(result).not.toBeNull()
  })

  test('get with no id → invalid args', async () => {
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'get',
    )
    expect(onDoneMsg).toMatch(/usage|id/i)
  })
})

// ── archive vault ─────────────────────────────────────────────────────────
describe('callVault archive', () => {
  test('archives vault and confirms in onDone', async () => {
    httpPostMock.mockResolvedValueOnce({
      data: {
        vault_id: 'vault_arc',
        name: 'Old',
        archived_at: '2026-01-01T00:00:00Z',
      },
      status: 200,
    })
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'archive vault_arc',
    )
    expect(onDoneMsg).toMatch(/archived/i)
  })
})

// ── add-credential ────────────────────────────────────────────────────────
describe('callVault add-credential', () => {
  test('adds credential and confirms without leaking secret value in onDone', async () => {
    httpPostMock.mockResolvedValueOnce({
      data: { credential_id: 'cred_new', vault_id: 'vault_1', kind: 'api_key' },
      status: 201,
    })
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'add-credential vault_1 MY_SECRET the-actual-secret-value-xyz',
    )
    // onDone message must confirm credential added
    expect(onDoneMsg).toMatch(/added|created/i)
    // SECURITY: the actual secret value must NOT appear in onDone message
    expect(onDoneMsg).not.toContain('the-actual-secret-value-xyz')
  })

  test('add-credential missing value → invalid args', async () => {
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'add-credential vault_1 MY_KEY',
    )
    expect(onDoneMsg).toMatch(/usage|value|non-empty/i)
  })

  test('credential value does not appear in stdout output at all', async () => {
    httpPostMock.mockResolvedValueOnce({
      data: { credential_id: 'cred_secure', vault_id: 'v1', kind: 'api_key' },
      status: 201,
    })
    const messages: string[] = []
    const onDone = (msg: string) => {
      messages.push(msg)
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'add-credential v1 KEY super-secret-do-not-leak',
    )
    // grep: none of the captured messages must contain the secret
    for (const msg of messages) {
      expect(msg).not.toContain('super-secret-do-not-leak')
    }
  })
})

// ── archive-credential ────────────────────────────────────────────────────
describe('callVault archive-credential', () => {
  test('archives credential and confirms in onDone', async () => {
    httpPostMock.mockResolvedValueOnce({
      data: {
        credential_id: 'cred_arc',
        vault_id: 'vault_1',
        archived_at: '2026-01-01T00:00:00Z',
      },
      status: 200,
    })
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'archive-credential vault_1 cred_arc',
    )
    expect(onDoneMsg).toMatch(/archived/i)
  })

  test('archive-credential missing cred_id → invalid args', async () => {
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'archive-credential vault_1',
    )
    expect(onDoneMsg).toMatch(/usage|credential_id|cred/i)
  })
})

// ── invalid subcommand ────────────────────────────────────────────────────
describe('callVault invalid subcommand', () => {
  test('unknown subcommand → usage message in onDone', async () => {
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'delete vault_123',
    )
    expect(onDoneMsg).toMatch(/usage/i)
  })
})
