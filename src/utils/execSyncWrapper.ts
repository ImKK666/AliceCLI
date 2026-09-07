import type {
  ExecSyncOptions,
  ExecSyncOptionsWithBufferEncoding,
  ExecSyncOptionsWithStringEncoding,
} from 'child_process'
import { slowLogging } from './slowOperations.js'

/**
 * @deprecated Use async alternatives when possible. Sync exec calls block the event loop.
 *
 * Wrapped execSync with slow operation logging.
 * Use this instead of child_process execSync directly to detect performance issues.
 *
 * NOTE: Uses Bun.spawnSync internally. The `timeout`, `maxBuffer`, and `killSignal`
 * options from ExecSyncOptions are not supported by Bun.spawnSync and are ignored.
 *
 * @example
 * import { execSync_DEPRECATED } from './execSyncWrapper.js'
 * const result = execSync_DEPRECATED('git status', { encoding: 'utf8' })
 */
export function execSync_DEPRECATED(command: string): Buffer
export function execSync_DEPRECATED(
  command: string,
  options: ExecSyncOptionsWithStringEncoding,
): string
export function execSync_DEPRECATED(
  command: string,
  options: ExecSyncOptionsWithBufferEncoding,
): Buffer
export function execSync_DEPRECATED(
  command: string,
  options?: ExecSyncOptions,
): Buffer | string
export function execSync_DEPRECATED(
  command: string,
  options?: ExecSyncOptions,
): Buffer | string {
  using _ = slowLogging`execSync: ${command.slice(0, 100)}`
  const result = Bun.spawnSync(['sh', '-c', command], {
    cwd:
      typeof options?.cwd === 'string' ? options.cwd : options?.cwd?.toString(),
    env: options?.env as Record<string, string | undefined> | undefined,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (!result.success) {
    const error = new Error(
      `Command failed: ${command}\n${result.stderr?.toString() ?? ''}`,
    ) as Error & { status: number; stderr: Buffer; stdout: Buffer }
    error.status = result.exitCode
    error.stderr = result.stderr
    error.stdout = result.stdout
    throw error
  }
  // Handle encoding option: return string for string encodings, Buffer otherwise
  if (options && 'encoding' in options) {
    const encoding = (options as ExecSyncOptionsWithStringEncoding).encoding
    if (encoding && (encoding as string) !== 'buffer') {
      return result.stdout.toString(encoding)
    }
  }
  return result.stdout
}
