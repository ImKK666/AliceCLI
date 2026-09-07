/**
 * Covers the getTranscriptPath projectDir branch (line 127 in share/index.ts).
 *
 * This file mocks src/bootstrap/state.js to return a non-null projectDir,
 * which exercises the if (projectDir) branch of getTranscriptPath.
 *
 * It is isolated in a separate file to avoid state mock contamination.
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── Mock: all commands fail (gh not available) ──
type ExecResult = { stdout: string; stderr: string }
let _mockExecFile: (
  cmd: string,
  args: string[],
  opts: { timeout?: number },
) => Promise<ExecResult> = async () => {
  throw new Error('ENOENT')
}

mock.module('bun:bundle', () => ({
  feature: (_name: string) => true,
}))

mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
  stripProtoFields: (v: unknown) => v,
}))

// ── State mock with non-null projectDir ──
let _mockProjectDir: string | null = null

mock.module('src/bootstrap/state.js', () => ({
  getSessionId: () => 'test-session-pd',
  getSessionProjectDir: () => _mockProjectDir,
  getOriginalCwd: () => '/mock/cwd',
  getProjectRoot: () => '/mock/project',
  getIsNonInteractiveSession: () => false,
  regenerateSessionId: () => {},
  getParentSessionId: () => undefined,
  switchSession: () => {},
  onSessionSwitch: () => () => {},
  setOriginalCwd: () => {},
  setProjectRoot: () => {},
  getDirectConnectServerUrl: () => undefined,
  setDirectConnectServerUrl: () => {},
  addToTotalDurationState: () => {},
  resetTotalDurationStateAndCost_FOR_TESTS_ONLY: () => {},
  addToTotalCostState: () => {},
  getTotalCostUSD: () => 0,
  getTotalAPIDuration: () => 0,
  getTotalDuration: () => 0,
  getTotalAPIDurationWithoutRetries: () => 0,
  getTotalToolDuration: () => 0,
  addToToolDuration: () => {},
  getTurnHookDurationMs: () => 0,
  addToTurnHookDuration: () => {},
  resetTurnHookDuration: () => {},
  getTurnHookCount: () => 0,
  getTurnToolDurationMs: () => 0,
  resetTurnToolDuration: () => {},
  getTurnToolCount: () => 0,
  getTurnClassifierDurationMs: () => 0,
  addToTurnClassifierDuration: () => {},
  resetTurnClassifierDuration: () => {},
  getTurnClassifierCount: () => 0,
  getStatsStore: () => ({}),
  setStatsStore: () => {},
  updateLastInteractionTime: () => {},
  flushInteractionTime: () => {},
  addToTotalLinesChanged: () => {},
  getTotalLinesAdded: () => 0,
  getTotalLinesRemoved: () => 0,
  getTotalInputTokens: () => 0,
  getTotalOutputTokens: () => 0,
  getTotalCacheReadInputTokens: () => 0,
  getTotalCacheCreationInputTokens: () => 0,
  getTotalWebSearchRequests: () => 0,
  getTurnOutputTokens: () => 0,
  getCurrentTurnTokenBudget: () => null,
  setLastAPIRequest: () => {},
  getLastAPIRequest: () => null,
  setLastAPIRequestMessages: () => {},
  getLastAPIRequestMessages: () => [],
  getSdkAgentProgressSummariesEnabled: () => false,
  addSlowOperation: () => {},
  getCwdState: () => '/mock/cwd',
  setCwdState: () => {},
}))

// ── State ──
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'share-pd-test-'))
  _mockExecFile = async () => {
    throw new Error('ENOENT')
  }
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  _mockProjectDir = null
})

// ── Helpers ──
type CallFn = (args: string) => Promise<{ type: string; value: string }>

async function getCallFn(): Promise<CallFn> {
  const mod = await import('../index.js')
  const loaded = await (
    mod.default as unknown as { load: () => Promise<{ call: CallFn }> }
  ).load()
  return loaded.call.bind(loaded) as CallFn
}

// Wire up the mock.
beforeAll(async () => {
  const { _setExecFileImpl } = await import('../index.js')
  _setExecFileImpl((cmd, args, opts) => _mockExecFile(cmd, args, opts))
})
afterAll(async () => {
  const { _setExecFileImpl } = await import('../index.js')
  _setExecFileImpl(null)
})

describe('share command — getTranscriptPath projectDir branch', () => {
  test('getSessionProjectDir non-null → uses projectDir path (session log not found)', async () => {
    _mockProjectDir = tmpDir
    const call = await getCallFn()
    const result = await call('--private')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Session log not found')
    expect(result.value).toContain('test-session-pd')
  })

  test('getSessionProjectDir non-null + log exists → proceeds past log check', async () => {
    _mockProjectDir = tmpDir
    const logPath = join(tmpDir, 'test-session-pd.jsonl')
    writeFileSync(
      logPath,
      JSON.stringify({ role: 'user', content: 'test' }) + '\n',
    )
    const call = await getCallFn()
    const result = await call('--private')
    expect(result.type).toBe('text')
    expect(typeof result.value).toBe('string')
    expect(result.value.length).toBeGreaterThan(0)
  })
})
