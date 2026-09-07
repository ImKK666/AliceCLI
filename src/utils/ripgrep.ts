import type { ExecFileException } from 'child_process'
import { existsSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import * as path from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import { isInBundledMode } from './bundledMode.js'
import { logForDebugging } from './debug.js'
import { distRoot } from './distRoot.js'
import { isEnvDefinedFalsy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { findExecutable } from './findExecutable.js'
import { logError } from './log.js'
import { getPlatform } from './platform.js'
import { countCharInString } from './stringUtils.js'

const __dirname = (() => {
  if (process.env.NODE_ENV === 'test') return path.resolve(distRoot)
  return distRoot
})()

type RipgrepConfig = {
  mode: 'system' | 'builtin' | 'embedded'
  command: string
  args: string[]
  argv0?: string
  note?: string
}

export const getRipgrepConfig = memoize((): RipgrepConfig => {
  const userWantsSystemRipgrep = isEnvDefinedFalsy(
    process.env.USE_BUILTIN_RIPGREP,
  )

  // Try system ripgrep if user wants it
  if (userWantsSystemRipgrep) {
    const { cmd: systemPath } = findExecutable('rg', [])
    if (systemPath !== 'rg') {
      // SECURITY: Use command name 'rg' instead of systemPath to prevent PATH hijacking
      // If we used systemPath, a malicious ./rg.exe in current directory could be executed
      // Using just 'rg' lets the OS resolve it safely with NoDefaultCurrentDirectoryInExePath protection
      return { mode: 'system', command: 'rg', args: [] }
    }
  }

  // In bundled (native) mode, ripgrep is statically compiled into bun-internal
  // and dispatches based on argv[0]. We spawn ourselves with argv0='rg'.
  if (isInBundledMode()) {
    return {
      mode: 'embedded',
      command: process.execPath,
      args: ['--no-config'],
      argv0: 'rg',
    }
  }

  const rgRoot = path.resolve(__dirname, 'vendor', 'ripgrep')
  const command =
    process.platform === 'win32'
      ? path.resolve(rgRoot, `${process.arch}-win32`, 'rg.exe')
      : path.resolve(rgRoot, `${process.arch}-${process.platform}`, 'rg')

  return resolveBuiltinWithFallback(command)
})

/**
 * Pure function: decide what to do when the builtin rg binary may be missing.
 * Extracted so it can be tested without any module mocking.
 *
 * @param builtinPath  Path to the vendored rg binary.
 * @param systemRgPath  When omitted, calls `findExecutable('rg')` (production path).
 *                     Pass a string to force a specific system path, or `null` to
 *                     simulate "system rg not found".
 * @param platform     Override for `process.platform` (tests only).
 */
export function resolveBuiltinWithFallback(
  builtinPath: string,
  systemRgPath?: string | null,
  platform?: string,
): {
  mode: 'system' | 'builtin'
  command: string
  args: string[]
  note?: string
} {
  const p = platform ?? process.platform

  // Builtin exists — use it, no note.
  if (existsSync(builtinPath)) {
    return { mode: 'builtin', command: builtinPath, args: [] }
  }

  // Builtin missing — check system rg.
  // When systemRgPath is explicitly passed (including null), use it directly.
  // When undefined, call findExecutable (production path).
  const resolvedSystem =
    systemRgPath === undefined
      ? findExecutable('rg', []).cmd
      : (systemRgPath ?? 'rg')
  if (resolvedSystem !== 'rg') {
    return {
      mode: 'system',
      command: 'rg',
      args: [],
      note: `fallback: builtin rg unavailable on ${p}, using system rg`,
    }
  }

  // Neither available.
  return {
    mode: 'builtin',
    command: builtinPath,
    args: [],
    note: `no ripgrep available on ${p}; install ripgrep via apt/pkg/brew`,
  }
}

export function ripgrepCommand(): {
  rgPath: string
  rgArgs: string[]
  argv0?: string
} {
  const config = getRipgrepConfig()
  return {
    rgPath: config.command,
    rgArgs: config.args,
    argv0: config.argv0,
  }
}

const MAX_BUFFER_SIZE = 20_000_000 // 20MB; large monorepos can have 200k+ files

/**
 * Check if an error is EAGAIN (resource temporarily unavailable).
 * This happens in resource-constrained environments (Docker, CI) when
 * ripgrep tries to spawn too many threads.
 */
function isEagainError(stderr: string): boolean {
  return (
    stderr.includes('os error 11') ||
    stderr.includes('Resource temporarily unavailable')
  )
}

/**
 * Custom error class for ripgrep timeouts.
 * This allows callers to distinguish between "no matches" and "timed out".
 */
export class RipgrepTimeoutError extends Error {
  constructor(
    message: string,
    public readonly partialResults: string[],
  ) {
    super(message)
    this.name = 'RipgrepTimeoutError'
  }
}

function ripGrepRaw(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void,
  singleThread = false,
): void {
  // NB: When running interactively, ripgrep does not require a path as its last
  // argument, but when run non-interactively, it will hang unless a path or file
  // pattern is provided

  const { rgPath, rgArgs, argv0 } = ripgrepCommand()

  // Use single-threaded mode only if explicitly requested for this call's retry
  const threadArgs = singleThread ? ['-j', '1'] : []
  const fullArgs = [...rgArgs, ...threadArgs, ...args, target]
  // Allow timeout to be configured via env var (in seconds), otherwise use platform defaults
  // WSL has severe performance penalty for file reads (3-5x slower on WSL2)
  const defaultTimeout = getPlatform() === 'wsl' ? 60_000 : 20_000
  const parsedSeconds =
    parseInt(process.env.CLAUDE_CODE_GLOB_TIMEOUT_SECONDS || '', 10) || 0
  const timeout = parsedSeconds > 0 ? parsedSeconds * 1000 : defaultTimeout

  const proc = Bun.spawn([rgPath, ...fullArgs], {
    argv0,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // Replicate AbortSignal behavior (child_process.spawn signal option)
  let aborted = false
  const onAbort = (): void => {
    aborted = true
    proc.kill()
  }
  if (abortSignal.aborted) {
    aborted = true
    proc.kill()
  } else {
    abortSignal.addEventListener('abort', onAbort, { once: true })
  }

  let stdout = ''
  let stderr = ''
  let stdoutTruncated = false
  let stderrTruncated = false

  // Read stdout with truncation at MAX_BUFFER_SIZE
  const readStdout = (async () => {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!stdoutTruncated) {
        stdout += decoder.decode(value, { stream: true })
        if (stdout.length > MAX_BUFFER_SIZE) {
          stdout = stdout.slice(0, MAX_BUFFER_SIZE)
          stdoutTruncated = true
        }
      }
    }
  })()

  // Read stderr with truncation at MAX_BUFFER_SIZE
  const readStderr = (async () => {
    const reader = proc.stderr.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!stderrTruncated) {
        stderr += decoder.decode(value, { stream: true })
        if (stderr.length > MAX_BUFFER_SIZE) {
          stderr = stderr.slice(0, MAX_BUFFER_SIZE)
          stderrTruncated = true
        }
      }
    }
  })()

  // Set up timeout with SIGKILL escalation.
  // SIGTERM alone may not kill ripgrep if it's blocked in uninterruptible I/O.
  let killTimeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutId = setTimeout(() => {
    if (process.platform === 'win32') {
      proc.kill()
    } else {
      proc.kill('SIGTERM')
      killTimeoutId = setTimeout(() => proc.kill('SIGKILL'), 5_000)
    }
  }, timeout)

  // Wait for streams and process exit, then invoke callback
  void Promise.all([readStdout, readStderr, proc.exited]).then(
    ([, , code]) => {
      clearTimeout(timeoutId)
      clearTimeout(killTimeoutId)
      abortSignal.removeEventListener('abort', onAbort)

      if (code === 0 || code === 1) {
        callback(null, stdout, stderr)
      } else if (aborted) {
        const error: ExecFileException = new Error('ripgrep aborted')
        error.code = 'ABORT_ERR'
        callback(error, stdout, stderr)
      } else {
        const error: ExecFileException = new Error(
          `ripgrep exited with code ${code}`,
        )
        error.code = code ?? undefined
        callback(error, stdout, stderr)
      }
    },
    (err: unknown) => {
      clearTimeout(timeoutId)
      clearTimeout(killTimeoutId)
      abortSignal.removeEventListener('abort', onAbort)
      const error: ExecFileException =
        err instanceof Error ? err : new Error(String(err))
      callback(error, stdout, stderr)
    },
  )
}

/**
 * Stream-count lines from `rg --files` without buffering stdout.
 *
 * On large repos (e.g. 247k files, 16MB of paths), calling `ripGrep()` just
 * to read `.length` materializes the full stdout string plus a 247k-element
 * array. This counts newline bytes per chunk instead; peak memory is one
 * stream chunk (~64KB).
 *
 * Intentionally minimal: the only caller is telemetry (countFilesRoundedRg),
 * which swallows all errors. No EAGAIN retry, no stderr capture, no internal
 * timeout (callers pass AbortSignal.timeout; spawn's signal option kills rg).
 */
async function ripGrepFileCount(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<number> {
  await codesignRipgrepIfNecessary()
  const { rgPath, rgArgs, argv0 } = ripgrepCommand()

  const proc = Bun.spawn([rgPath, ...rgArgs, ...args, target], {
    argv0,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })

  const onAbort = (): void => {
    proc.kill()
  }
  if (abortSignal.aborted) {
    proc.kill()
  } else {
    abortSignal.addEventListener('abort', onAbort, { once: true })
  }

  let lines = 0
  const reader = proc.stdout.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      lines += countCharInString(Buffer.from(value), '\n')
    }
  } finally {
    abortSignal.removeEventListener('abort', onAbort)
  }

  const code = await proc.exited
  if (code === 0 || code === 1) return lines
  throw new Error(`rg --files exited ${code}`)
}

/**
 * Stream lines from ripgrep as they arrive, calling `onLines` per stdout chunk.
 *
 * Unlike `ripGrep()` which buffers the entire stdout, this flushes complete
 * lines as soon as each chunk arrives — first results paint while rg is still
 * walking the tree (the fzf `change:reload` pattern). Partial trailing lines
 * are carried across chunk boundaries.
 *
 * Callers that want to stop early (e.g. after N matches) should abort the
 * signal — spawn's signal option kills rg. No EAGAIN retry, no internal
 * timeout, stderr is ignored; interactive callers own recovery.
 */
export async function ripGrepStream(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  onLines: (lines: string[]) => void,
): Promise<void> {
  await codesignRipgrepIfNecessary()
  const { rgPath, rgArgs, argv0 } = ripgrepCommand()

  const proc = Bun.spawn([rgPath, ...rgArgs, ...args, target], {
    argv0,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })

  const onAbort = (): void => {
    proc.kill()
  }
  if (abortSignal.aborted) {
    proc.kill()
  } else {
    abortSignal.addEventListener('abort', onAbort, { once: true })
  }

  const stripCR = (l: string): string => (l.endsWith('\r') ? l.slice(0, -1) : l)
  let remainder = ''
  const decoder = new TextDecoder()
  const reader = proc.stdout.getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const data = remainder + decoder.decode(value, { stream: true })
      const lines = data.split('\n')
      remainder = lines.pop() ?? ''
      if (lines.length) onLines(lines.map(stripCR))
    }
  } finally {
    abortSignal.removeEventListener('abort', onAbort)
  }

  const code = await proc.exited
  if (abortSignal.aborted) return

  if (code === 0 || code === 1) {
    if (remainder) onLines([stripCR(remainder)])
  } else {
    throw new Error(`ripgrep exited with code ${code}`)
  }
}

export async function ripGrep(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<string[]> {
  await codesignRipgrepIfNecessary()

  // Test ripgrep on first use and cache the result (fire and forget)
  void testRipgrepOnFirstUse().catch(error => {
    logError(error)
  })

  return new Promise((resolve, reject) => {
    const handleResult = (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
      isRetry: boolean,
    ): void => {
      // Success case
      if (!error) {
        resolve(
          stdout
            .trim()
            .split('\n')
            .map(line => line.replace(/\r$/, ''))
            .filter(Boolean),
        )
        return
      }

      // Exit code 1 is normal "no matches"
      if (error.code === 1) {
        resolve([])
        return
      }

      // Critical errors that indicate ripgrep is broken, not "no matches"
      // These should be surfaced to the user rather than silently returning empty results
      const CRITICAL_ERROR_CODES = ['ENOENT', 'EACCES', 'EPERM']
      if (CRITICAL_ERROR_CODES.includes(error.code as string)) {
        reject(error)
        return
      }

      // If we hit EAGAIN and haven't retried yet, retry with single-threaded mode
      // Note: We only use -j 1 for this specific retry, not for future calls.
      // Persisting single-threaded mode globally caused timeouts on large repos
      // where EAGAIN was just a transient startup error.
      if (!isRetry && isEagainError(stderr)) {
        logForDebugging(
          `rg EAGAIN error detected, retrying with single-threaded mode (-j 1)`,
        )
        logEvent('tengu_ripgrep_eagain_retry', {})
        ripGrepRaw(
          args,
          target,
          abortSignal,
          (retryError, retryStdout, retryStderr) => {
            handleResult(retryError, retryStdout, retryStderr, true)
          },
          true, // Force single-threaded mode for this retry only
        )
        return
      }

      // For all other errors, try to return partial results if available
      const hasOutput = stdout && stdout.trim().length > 0
      const isTimeout =
        error.signal === 'SIGTERM' ||
        error.signal === 'SIGKILL' ||
        error.code === 'ABORT_ERR'
      const isBufferOverflow =
        error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

      let lines: string[] = []
      if (hasOutput) {
        lines = stdout
          .trim()
          .split('\n')
          .map(line => line.replace(/\r$/, ''))
          .filter(Boolean)
        // Drop last line for timeouts and buffer overflow - it may be incomplete
        if (lines.length > 0 && (isTimeout || isBufferOverflow)) {
          lines = lines.slice(0, -1)
        }
      }

      logForDebugging(
        `rg error (signal=${error.signal}, code=${error.code}, stderr: ${stderr}), ${lines.length} results`,
      )

      // code 2 = ripgrep usage error (already handled); ABORT_ERR = caller
      // explicitly aborted (not an error, just a cancellation — interactive
      // callers may abort on every keystroke-after-debounce).
      if (error.code !== 2 && error.code !== 'ABORT_ERR') {
        logError(error)
      }

      // If we timed out with no results, throw an error so Claude knows the search
      // didn't complete rather than thinking there were no matches
      if (isTimeout && lines.length === 0) {
        reject(
          new RipgrepTimeoutError(
            `Ripgrep search timed out after ${getPlatform() === 'wsl' ? 60 : 20} seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern.`,
            lines,
          ),
        )
        return
      }

      resolve(lines)
    }

    ripGrepRaw(args, target, abortSignal, (error, stdout, stderr) => {
      handleResult(error, stdout, stderr, false)
    })
  })
}

/**
 * Count files in a directory recursively using ripgrep and round to the nearest power of 10 for privacy
 *
 * This is much more efficient than using native Node.js methods for counting files
 * in large directories since it uses ripgrep's highly optimized file traversal.
 *
 * @param path Directory path to count files in
 * @param abortSignal AbortSignal to cancel the operation
 * @param ignorePatterns Optional additional patterns to ignore (beyond .gitignore)
 * @returns Approximate file count rounded to the nearest power of 10
 */
export const countFilesRoundedRg = memoize(
  async (
    dirPath: string,
    abortSignal: AbortSignal,
    ignorePatterns: string[] = [],
  ): Promise<number | undefined> => {
    // Skip file counting if we're in the home directory to avoid triggering
    // macOS TCC permission dialogs for Desktop, Downloads, Documents, etc.
    if (path.resolve(dirPath) === path.resolve(homedir())) {
      return undefined
    }

    try {
      // Build ripgrep arguments:
      // --files: List files that would be searched (rather than searching them)
      // --count: Only print a count of matching lines for each file
      // --no-ignore-parent: Don't respect ignore files in parent directories
      // --hidden: Search hidden files and directories
      const args = ['--files', '--hidden']

      // Add ignore patterns if provided
      ignorePatterns.forEach(pattern => {
        args.push('--glob', `!${pattern}`)
      })

      const count = await ripGrepFileCount(args, dirPath, abortSignal)

      // Round to nearest power of 10 for privacy
      if (count === 0) return 0

      const magnitude = Math.floor(Math.log10(count))
      const power = 10 ** magnitude

      // Round to nearest power of 10
      // e.g., 8 -> 10, 42 -> 100, 350 -> 100, 750 -> 1000
      return Math.round(count / power) * power
    } catch (error) {
      // AbortSignal.timeout firing is expected on large/slow repos, not an error.
      if ((error as Error)?.name !== 'AbortError') logError(error)
    }
  },
  // lodash memoize's default resolver only uses the first argument.
  // ignorePatterns affect the result, so include them in the cache key.
  // abortSignal is intentionally excluded — it doesn't affect the count.
  (dirPath, _abortSignal, ignorePatterns = []) =>
    `${dirPath}|${ignorePatterns.join(',')}`,
)

// Singleton to store ripgrep availability status
let ripgrepStatus: {
  working: boolean
  lastTested: number
  config: RipgrepConfig
  note?: string
} | null = null

/**
 * Get ripgrep status and configuration info
 * Returns current configuration immediately, with working status if available
 */
export function getRipgrepStatus(): {
  mode: 'system' | 'builtin' | 'embedded'
  path: string
  working: boolean | null // null if not yet tested
  note?: string
} {
  const config = getRipgrepConfig()
  return {
    mode: config.mode,
    path: config.command,
    working: ripgrepStatus?.working ?? null,
    note: ripgrepStatus?.note ?? config.note,
  }
}

/**
 * Test ripgrep availability on first use and cache the result
 */
const testRipgrepOnFirstUse = memoize(async (): Promise<void> => {
  // Already tested
  if (ripgrepStatus !== null) {
    return
  }

  const config = getRipgrepConfig()

  try {
    let test: { code: number; stdout: string }

    // For embedded ripgrep, use Bun.spawn with argv0
    if (config.argv0) {
      // Only Bun embeds ripgrep.
      // eslint-disable-next-line custom-rules/require-bun-typeof-guard
      const proc = Bun.spawn([config.command, '--version'], {
        argv0: config.argv0,
        stderr: 'ignore',
        stdout: 'pipe',
      })

      // Bun's ReadableStream has .text() at runtime, but TS types don't reflect it
      const [stdout, code] = await Promise.all([
        (proc.stdout as unknown as Blob).text(),
        proc.exited,
      ])
      test = {
        code,
        stdout,
      }
    } else {
      test = await execFileNoThrow(
        config.command,
        [...config.args, '--version'],
        {
          timeout: 5000,
        },
      )
    }

    const working =
      test.code === 0 && !!test.stdout && test.stdout.startsWith('ripgrep ')

    ripgrepStatus = {
      working,
      lastTested: Date.now(),
      config,
      note: config.note,
    }

    logForDebugging(
      `Ripgrep first use test: ${working ? 'PASSED' : 'FAILED'} (mode=${config.mode}, path=${config.command})`,
    )

    // Log telemetry for actual ripgrep availability
    logEvent('tengu_ripgrep_availability', {
      working: working ? 1 : 0,
      using_system: config.mode === 'system' ? 1 : 0,
    })
  } catch (error) {
    ripgrepStatus = {
      working: false,
      lastTested: Date.now(),
      config,
      note: config.note,
    }
    logError(error)
  }
})

let alreadyDoneSignCheck = false
async function codesignRipgrepIfNecessary() {
  if (process.platform !== 'darwin' || alreadyDoneSignCheck) {
    return
  }

  alreadyDoneSignCheck = true

  // Only sign the standalone vendored rg binary (npm builds)
  const config = getRipgrepConfig()
  if (config.mode !== 'builtin') {
    return
  }
  const builtinPath = config.command

  // First, check to see if ripgrep is already signed
  const lines = (
    await execFileNoThrow('codesign', ['-vv', '-d', builtinPath], {
      preserveOutputOnError: false,
    })
  ).stdout.split('\n')

  const needsSigned = lines.find(line => line.includes('linker-signed'))
  if (!needsSigned) {
    return
  }

  try {
    const signResult = await execFileNoThrow('codesign', [
      '--sign',
      '-',
      '--force',
      '--preserve-metadata=entitlements,requirements,flags,runtime',
      builtinPath,
    ])

    if (signResult.code !== 0) {
      logError(
        new Error(
          `Failed to sign ripgrep: ${signResult.stdout} ${signResult.stderr}`,
        ),
      )
    }

    const quarantineResult = await execFileNoThrow('xattr', [
      '-d',
      'com.apple.quarantine',
      builtinPath,
    ])

    if (quarantineResult.code !== 0) {
      logError(
        new Error(
          `Failed to remove quarantine: ${quarantineResult.stdout} ${quarantineResult.stderr}`,
        ),
      )
    }
  } catch (e) {
    logError(e)
  }
}
