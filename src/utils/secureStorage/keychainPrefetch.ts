/**
 * Minimal module for firing macOS keychain reads in parallel with main.tsx
 * module evaluation, same pattern as startMdmRawRead() in settings/mdm/rawRead.ts.
 *
 * isRemoteManagedSettingsEligible() reads two separate keychain entries
 * SEQUENTIALLY via sync execSync during applySafeConfigEnvironmentVariables():
 *   1. "Alice CLI-credentials" (OAuth tokens)  — ~32ms
 *   2. "Alice CLI" (legacy API key)            — ~33ms
 * Sequential cost: ~65ms on every macOS startup.
 *
 * Firing both here lets the subprocesses run in parallel with the ~65ms of
 * main.tsx imports. ensureKeychainPrefetchCompleted() is awaited alongside
 * ensureMdmSettingsLoaded() in main.tsx preAction — nearly free since the
 * subprocesses finish during import evaluation. Sync read() and
 * getApiKeyFromConfigOrMacOSKeychain() then hit their caches.
 *
 * Imports stay minimal: Bun.spawn + macOsKeychainHelpers.ts (NOT
 * macOsKeychainStorage.ts — that pulls in execa → human-signals →
 * cross-spawn, ~58ms of synchronous module init). The helpers file's own
 * import chain (envUtils, oauth constants, crypto) is already evaluated by
 * startupProfiler.ts at main.tsx:5, so no new module-init cost lands here.
 */

import { isBareMode } from '../envUtils.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getLegacyKeychainServiceName,
  getMacOsKeychainStorageServiceName,
  getUsername,
  primeKeychainCacheFromPrefetch,
} from './macOsKeychainHelpers.js'

const KEYCHAIN_PREFETCH_TIMEOUT_MS = 10_000

// Shared with auth.ts getApiKeyFromConfigOrMacOSKeychain() so it can skip its
// sync spawn when the prefetch already landed. Distinguishing "not started" (null)
// from "completed with no key" ({ stdout: null }) lets the sync reader only
// trust a completed prefetch.
let legacyApiKeyPrefetch: { stdout: string | null } | null = null

let prefetchPromise: Promise<void> | null = null

type SpawnResult = { stdout: string | null; timedOut: boolean }

async function spawnSecurity(serviceName: string): Promise<SpawnResult> {
  try {
    const proc = Bun.spawn(
      [
        'security',
        'find-generic-password',
        '-a',
        getUsername(),
        '-w',
        '-s',
        serviceName,
      ],
      { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
    )
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, KEYCHAIN_PREFETCH_TIMEOUT_MS)
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ])
    clearTimeout(timer)
    // Exit 44 (entry not found) is a valid "no key" result and safe to
    // prime as null. But timeout means the keychain MAY have a key we
    // couldn't fetch — don't prime, let sync spawn retry.
    return {
      stdout: exitCode !== 0 ? null : stdout?.trim() || null,
      timedOut,
    }
  } catch {
    return { stdout: null, timedOut: false }
  }
}

/**
 * Fire both keychain reads in parallel. Called at main.tsx top-level
 * immediately after startMdmRawRead(). Non-darwin is a no-op.
 */
export function startKeychainPrefetch(): void {
  if (process.platform !== 'darwin' || prefetchPromise || isBareMode()) return

  // Fire both subprocesses immediately (non-blocking). They run in parallel
  // with each other AND with main.tsx imports. The await in Promise.all
  // happens later via ensureKeychainPrefetchCompleted().
  prefetchPromise = (async () => {
    // Try new names first
    const [oauth, legacy] = await Promise.all([
      spawnSecurity(
        getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX),
      ),
      spawnSecurity(getMacOsKeychainStorageServiceName()),
    ])

    // Fallback to legacy names if new names not found
    let oauthResult = oauth
    let legacyResult = legacy

    if (!oauth.timedOut && oauth.stdout === null) {
      const legacyOauth = await spawnSecurity(
        getLegacyKeychainServiceName(CREDENTIALS_SERVICE_SUFFIX),
      )
      if (!legacyOauth.timedOut && legacyOauth.stdout !== null) {
        oauthResult = legacyOauth
      }
    }

    if (!legacy.timedOut && legacy.stdout === null) {
      const legacyKey = await spawnSecurity(getLegacyKeychainServiceName())
      if (!legacyKey.timedOut && legacyKey.stdout !== null) {
        legacyResult = legacyKey
      }
    }

    // Timed-out prefetch: don't prime. Sync read/spawn will retry with its
    // own (longer) timeout. Priming null here would shadow a key that the
    // sync path might successfully fetch.
    if (!oauthResult.timedOut)
      primeKeychainCacheFromPrefetch(oauthResult.stdout)
    if (!legacyResult.timedOut)
      legacyApiKeyPrefetch = { stdout: legacyResult.stdout }
  })()
}

/**
 * Await prefetch completion. Called in main.tsx preAction alongside
 * ensureMdmSettingsLoaded() — nearly free since subprocesses finish during
 * the ~65ms of main.tsx imports. Resolves immediately on non-darwin.
 */
export async function ensureKeychainPrefetchCompleted(): Promise<void> {
  if (prefetchPromise) await prefetchPromise
}

/**
 * Consumed by getApiKeyFromConfigOrMacOSKeychain() in auth.ts before it
 * falls through to sync execSync. Returns null if prefetch hasn't completed.
 */
export function getLegacyApiKeyPrefetchResult(): {
  stdout: string | null
} | null {
  return legacyApiKeyPrefetch
}

/**
 * Clear prefetch result. Called alongside getApiKeyFromConfigOrMacOSKeychain
 * cache invalidation so a stale prefetch doesn't shadow a fresh write.
 */
export function clearLegacyApiKeyPrefetch(): void {
  legacyApiKeyPrefetch = null
}
