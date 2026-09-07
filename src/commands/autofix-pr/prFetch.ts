// gh CLI integration for autofix-pr: fetches PR snapshots and feeds them
// through the pure decision matrix in prOutcomeCheck.ts. Kept separate so
// tests of the decision matrix never have to mock child_process — and
// tests of callAutofixPr can mock this module without polluting the pure
// decision matrix module (Bun mock.module is process-global).

import {
  type AutofixOutcomeProbeResult,
  type PrViewPayload,
  summariseAutofixOutcome,
} from './prOutcomeCheck.js'

export interface AutofixOutcomeProbeInput {
  owner: string
  repo: string
  prNumber: number
  /**
   * Head commit SHA captured at /autofix-pr launch. When this differs from
   * the current head, autofix has pushed at least one commit.
   */
  initialHeadSha?: string
  /**
   * Timeout for the gh CLI invocation. Caller is the framework's per-tick
   * poller, so failures must be bounded — a hung gh process would stall
   * the entire poll loop.
   */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000

/**
 * Fetch the PR's current head SHA, state, and CI rollup, and decide whether
 * autofix has finished. Returns `{ completed: true, summary }` if so;
 * otherwise `{ completed: false }`. Never throws.
 */
export async function checkPrAutofixOutcome(
  input: AutofixOutcomeProbeInput,
): Promise<AutofixOutcomeProbeResult> {
  const { owner, repo, prNumber, initialHeadSha, timeoutMs } = input

  let payload: PrViewPayload
  try {
    payload = await runGhPrView(
      owner,
      repo,
      prNumber,
      timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
  } catch {
    return { completed: false }
  }

  return summariseAutofixOutcome(payload, {
    owner,
    repo,
    prNumber,
    initialHeadSha,
  })
}

/**
 * Resolve the PR's current head commit SHA. Used at /autofix-pr launch to
 * capture a baseline; later compared against the live SHA to detect pushes.
 * Returns null on any failure (network, missing gh, permissions) — the
 * caller treats null as "no baseline" and falls back to terminal-state-only
 * completion detection.
 */
export async function fetchPrHeadSha(
  owner: string,
  repo: string,
  prNumber: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const payload = await runGhPrView(owner, repo, prNumber, timeoutMs)
    return payload.headRefOid || null
  } catch {
    return null
  }
}

/**
 * Spawn `gh pr view {n} --repo {owner}/{repo} --json ...` and parse the
 * result. Rejects on non-zero exit, timeout, or JSON parse failure.
 */
async function runGhPrView(
  owner: string,
  repo: string,
  prNumber: number,
  timeoutMs: number,
): Promise<PrViewPayload> {
  const proc = Bun.spawn(
    [
      'gh',
      'pr',
      'view',
      String(prNumber),
      '--repo',
      `${owner}/${repo}`,
      '--json',
      'headRefOid,state,statusCheckRollup',
    ],
    { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
  )

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill(9)
  }, timeoutMs)

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  clearTimeout(timer)

  if (timedOut) {
    throw new Error(`gh pr view timed out after ${timeoutMs}ms`)
  }

  if (exitCode !== 0) {
    throw new Error(
      `gh pr view exited ${exitCode}: ${stderr.trim() || '<no stderr>'}`,
    )
  }

  try {
    return JSON.parse(stdout.trim()) as PrViewPayload
  } catch (e) {
    throw new Error(`gh pr view JSON parse failed: ${(e as Error).message}`)
  }
}
