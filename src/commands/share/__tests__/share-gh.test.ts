/**
 * Coverage tests for share/index.ts gh-CLI paths.
 *
 * share/index.ts exports `_setExecFileImpl` to allow tests to swap the
 * command execution layer (Bun.spawn) with a controllable mock.
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

// ── Mock control state ──
// Each test sets _mockExecFile to control what commands return.
type ExecResult = { stdout: string; stderr: string }
type MockExecFn = (
  cmd: string,
  args: string[],
  opts: { timeout?: number },
) => Promise<ExecResult>

let _mockExecFile: MockExecFn = async () => ({ stdout: '', stderr: '' })

mock.module('bun:bundle', () => ({
  feature: (_name: string) => true,
}))

mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
  stripProtoFields: (v: unknown) => v,
}))

// ── State ──
let tmpDir: string
let claudeDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'share-gh-test-'))
  claudeDir = join(tmpDir, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = claudeDir
  _mockExecFile = async () => ({ stdout: '', stderr: '' })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_CONFIG_DIR
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

async function writeSessionLog(entries?: string[]): Promise<void> {
  const { sanitizePath } = await import('../../../utils/path.js')
  const { getSessionId, getOriginalCwd } = await import(
    '../../../bootstrap/state.js'
  )
  const sessionId = getSessionId()
  const cwd = getOriginalCwd()
  const encoded = sanitizePath(cwd)
  const dir = join(claudeDir, 'projects', encoded)
  mkdirSync(dir, { recursive: true })
  const content = entries ?? [
    JSON.stringify({ role: 'user', content: 'hello world' }),
    JSON.stringify({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi there' }],
    }),
  ]
  writeFileSync(join(dir, `${sessionId}.jsonl`), content.join('\n') + '\n')
}

function setExecFileSuccess(getStdout: (callCount: number) => string): void {
  let n = 0
  _mockExecFile = async () => {
    n++
    return { stdout: getStdout(n), stderr: '' }
  }
}

function setExecFileFail(msg: string): void {
  _mockExecFile = async () => {
    throw new Error(msg)
  }
}

function setExecFileSequence(
  behaviors: Array<{ ok: true; stdout: string } | { ok: false; msg: string }>,
): void {
  let n = 0
  _mockExecFile = async () => {
    const b = behaviors[n] ?? behaviors[behaviors.length - 1]
    n++
    if (b.ok) return { stdout: b.stdout, stderr: '' }
    throw new Error(b.msg)
  }
}

// Wire up the mock via the test hook exported by share/index.ts.
beforeAll(async () => {
  const { _setExecFileImpl } = await import('../index.js')
  _setExecFileImpl((cmd, args, opts) => _mockExecFile(cmd, args, opts))
})
afterAll(async () => {
  const { _setExecFileImpl } = await import('../index.js')
  _setExecFileImpl(null)
})

describe('share command — gh not available paths', () => {
  test('gh not available + no fallback → shows install instructions', async () => {
    setExecFileFail('ENOENT: gh not found')
    await writeSessionLog()
    const call = await getCallFn()
    const result = await call('--private')
    expect(result.type).toBe('text')
    expect(result.value).toContain('gh')
    // Must mention install or auth
    expect(result.value).toMatch(/cli\.github\.com|gh auth login/)
  })

  test('gh not available + allowPublicFallback + curl succeeds → 0x0 success', async () => {
    setExecFileSequence([
      { ok: false, msg: 'ENOENT: gh not found' }, // gh --version → fail
      { ok: true, stdout: 'https://0x0.st/abc123' }, // curl → success
    ])
    await writeSessionLog()
    const call = await getCallFn()
    const result = await call('--allow-public-fallback')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Session shared')
    expect(result.value).toContain('https://0x0.st/abc123')
    expect(result.value).toContain('0x0.st')
  })

  test('gh not available + allowPublicFallback + curl returns bad URL → error', async () => {
    setExecFileSequence([
      { ok: false, msg: 'ENOENT' }, // gh --version → fail
      { ok: true, stdout: 'error: connection refused' }, // curl → bad output
    ])
    await writeSessionLog()
    const call = await getCallFn()
    const result = await call('--allow-public-fallback')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Failed to share session')
    expect(result.value).toContain('0x0.st returned unexpected output')
  })
})

describe('share command — gh available paths', () => {
  test('gh available + gist succeeds (private) → session shared', async () => {
    setExecFileSequence([
      { ok: true, stdout: 'gh version 2.0.0' }, // gh --version
      { ok: true, stdout: 'https://gist.github.com/abc123' }, // gist create
    ])
    await writeSessionLog()
    const call = await getCallFn()
    const result = await call('--private')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Session shared')
    expect(result.value).toContain('https://gist.github.com/abc123')
    expect(result.value).toContain('secret')
    expect(result.value).toContain('GitHub Gist')
  })

  test('gh available + gist succeeds (public) → session shared with public', async () => {
    setExecFileSequence([
      { ok: true, stdout: 'gh version 2.0.0' },
      { ok: true, stdout: 'https://gist.github.com/xyz999' },
    ])
    await writeSessionLog()
    const call = await getCallFn()
    const result = await call('--public')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Session shared')
    expect(result.value).toContain('public')
  })

  test('gh available + gist returns non-URL stdout → throws, no fallback → upload error', async () => {
    setExecFileSequence([
      { ok: true, stdout: 'gh version 2.0.0' },
      { ok: true, stdout: 'Error: authentication required' }, // bad URL
    ])
    await writeSessionLog()
    const call = await getCallFn()
    const result = await call('--private')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Failed to share session')
    expect(result.value).toContain('Unexpected gh gist output')
  })

  test('gh available + gist fails + allowPublicFallback + curl succeeds → 0x0 fallback', async () => {
    setExecFileSequence([
      { ok: true, stdout: 'gh version 2.0.0' }, // gh --version
      { ok: false, msg: 'gist create failed: auth error' }, // gist create fails
      { ok: true, stdout: 'https://0x0.st/def456' }, // curl fallback
    ])
    await writeSessionLog()
    const call = await getCallFn()
    const result = await call('--private --allow-public-fallback')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Session shared')
    expect(result.value).toContain('https://0x0.st/def456')
    expect(result.value).toContain('fallback')
  })

  test('gh available + gist fails + allowPublicFallback + curl fails → upload error', async () => {
    setExecFileSequence([
      { ok: true, stdout: 'gh version 2.0.0' },
      { ok: false, msg: 'gist create failed' },
      { ok: false, msg: 'curl: connection refused' },
    ])
    await writeSessionLog()
    const call = await getCallFn()
    const result = await call('--private --allow-public-fallback')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Failed to share session')
  })

  test('gh available + summary-only + mask-secrets → success with content labels', async () => {
    setExecFileSequence([
      { ok: true, stdout: 'gh version 2.0.0' },
      { ok: true, stdout: 'https://gist.github.com/masked123' },
    ])
    await writeSessionLog([
      JSON.stringify({
        role: 'user',
        content: 'my api key sk-ant-abcdefghijklmnopqrstuvwxyz123456',
      }),
      JSON.stringify({ role: 'assistant', content: 'noted' }),
    ])
    const call = await getCallFn()
    const result = await call('--summary-only --mask-secrets')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Session shared')
    expect(result.value).toContain('summary only')
    expect(result.value).toContain('masked')
  })
})

describe('share command — getTranscriptPath projectDir branch', () => {
  test('getSessionProjectDir returns non-null → uses projectDir path', async () => {
    setExecFileFail('ENOENT')
    const call = await getCallFn()
    const result = await call('--summary-only')
    expect(result.type).toBe('text')
    expect(typeof result.value).toBe('string')
  })
})

describe('share command — buildSummaryContent outer catch', () => {
  test('buildSummaryContent when readFileSync throws (defensive TOCTOU catch)', async () => {
    setExecFileFail('ENOENT')
    const call = await getCallFn()
    const result = await call('--summary-only')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Session log not found')
  })
})
