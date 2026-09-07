/**
 * Phase 1: parseAndValidateOptions
 *
 * Handles everything from action_handler_start through system prompt file
 * reading, teammate prompt addendum, but NOT including permission mode
 * computation. Extracted from main.tsx .action() handler.
 */

import { feature } from 'bun:bundle'
import chalk from 'chalk'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { profileCheckpoint } from '../../utils/startupProfiler.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  getIsNonInteractiveSession,
  getSessionId,
  setKairosActive,
} from '../../bootstrap/state.js'
import { setAllHookEventsEnabled } from 'src/utils/hooks/hookEvents.js'
import {
  checkHasTrustDialogAccepted,
  getGlobalConfig,
} from '../../utils/config.js'
import { seedEarlyInput } from '../../utils/earlyInput.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { isWorktreeModeEnabled } from '../../utils/worktreeModeEnabled.js'
import { getPlatform } from '../../utils/platform.js'
import {
  isTmuxAvailable,
  getTmuxInstallInstructions,
  parsePRReference,
} from '../../utils/worktree.js'
import { extractTeammateOptions, type TeammateOptions } from '../mainHelpers.js'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  type DownloadResult,
  downloadSessionFiles,
  type FilesApiConfig,
  parseFileSpecs,
} from '../../services/api/filesApi.js'
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js'
import { validateUuid } from '../../utils/uuid.js'
import { sessionIdExists } from '../../utils/sessionStorage.js'
import { errorMessage, getErrnoCode } from '../../utils/errors.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { DEFAULT_TASKS_MODE_TASK_LIST_ID } from '../../utils/tasks.js'

// Lazy require to avoid circular dependency: teammate.ts -> AppState.tsx -> ... -> main.tsx
/* eslint-disable @typescript-eslint/no-require-imports */
const getTeammateUtils = () =>
  require('../../utils/teammate.js') as typeof import('../../utils/teammate.js')
const getTeammatePromptAddendum = () =>
  require('../../utils/swarm/teammatePromptAddendum.js') as typeof import('../../utils/swarm/teammatePromptAddendum.js')
const getTeammateModeSnapshot = () =>
  require('../../utils/swarm/backends/teammateModeSnapshot.js') as typeof import('../../utils/swarm/backends/teammateModeSnapshot.js')
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Result of parseAndValidateOptions — all local variables that later
 * phases need.
 */
export type ParsedOptions = {
  // Raw/extracted option values
  debug: boolean
  debugToStderr: boolean
  dangerouslySkipPermissions: boolean | undefined
  allowDangerouslySkipPermissions: boolean
  baseTools: string[]
  allowedTools: string[]
  disallowedTools: string[]
  mcpConfig: string[]
  permissionModeCli: string | undefined
  addDir: string[]
  fallbackModel: string | undefined
  betas: string[]
  ide: boolean
  sessionId: string | undefined
  includeHookEvents: boolean | undefined
  includePartialMessages: boolean | undefined

  // Computed values
  agentsJson: string | undefined
  agentCli: string | undefined
  outputFormat: string | undefined
  inputFormat: string | undefined
  verbose: boolean | undefined
  print: boolean | undefined
  init: boolean
  initOnly: boolean
  maintenance: boolean
  disableSlashCommands: boolean
  taskListId: string | undefined
  worktreeOption: boolean | string | undefined
  worktreeName: string | undefined
  worktreeEnabled: boolean
  worktreePRNumber: number | undefined
  tmuxEnabled: boolean
  storedTeammateOpts: TeammateOptions | undefined
  sdkUrl: string | undefined
  effectiveIncludePartialMessages: boolean
  teleport: string | true | null
  remote: string | null
  remoteControl: boolean
  remoteControlName: string | undefined
  remoteControlOption: string | true | undefined
  isNonInteractiveSession: boolean
  fileDownloadPromise: Promise<DownloadResult[]> | undefined
  systemPrompt: string | undefined
  appendSystemPrompt: string | undefined

  // Kairos/assistant state
  kairosEnabled: boolean
  assistantTeamContext:
    | Awaited<
        ReturnType<
          NonNullable<
            typeof import('../../assistant/index.js')
          >['initializeAssistantTeam']
        >
      >
    | undefined

  // Module references needed by later phases
  assistantModule: typeof import('../../assistant/index.js') | null
  kairosGate: typeof import('../../assistant/gate.js') | null
  autoModeStateModule:
    | typeof import('../../utils/permissions/autoModeState.js')
    | null

  // The original options object (pass-through)
  options: Record<string, any>
  prompt: string | undefined
}

export async function parseAndValidateOptions(
  prompt: string | undefined,
  options: Record<string, any>,
  // Module-scope conditional requires from main.tsx
  assistantModule: typeof import('../../assistant/index.js') | null,
  kairosGate: typeof import('../../assistant/gate.js') | null,
  autoModeStateModule:
    | typeof import('../../utils/permissions/autoModeState.js')
    | null,
): Promise<ParsedOptions> {
  profileCheckpoint('action_handler_start')

  // --bare = one-switch minimal mode. Sets SIMPLE so all the existing
  // gates fire (CLAUDE.md, skills, hooks inside executeHooks, agent
  // dir-walk). Must be set before setup() / any of the gated work runs.
  if ((options as { bare?: boolean }).bare) {
    process.env.CLAUDE_CODE_SIMPLE = '1'
  }

  // Ignore "code" as a prompt - treat it the same as no prompt
  if (prompt === 'code') {
    logEvent('tengu_code_prompt_ignored', {})
    console.warn(
      chalk.yellow('Tip: You can launch Alice CLI with just `alice`'),
    )
    prompt = undefined
  }

  // Log event for any single-word prompt
  if (
    prompt &&
    typeof prompt === 'string' &&
    !/\s/.test(prompt) &&
    prompt.length > 0
  ) {
    logEvent('tengu_single_word_prompt', { length: prompt.length })
  }

  // Assistant mode: when .claude/settings.json has assistant: true AND
  // the tengu_kairos GrowthBook gate is on, force brief on.
  let kairosEnabled = false
  let assistantTeamContext:
    | Awaited<
        ReturnType<
          NonNullable<typeof assistantModule>['initializeAssistantTeam']
        >
      >
    | undefined
  if (
    feature('KAIROS') &&
    (options as { assistant?: boolean }).assistant &&
    assistantModule
  ) {
    assistantModule.markAssistantForced()
  }
  if (
    feature('KAIROS') &&
    assistantModule &&
    (assistantModule.isAssistantForced() ||
      (options as Record<string, unknown>).assistant === true) &&
    !(options as { agentId?: unknown }).agentId &&
    kairosGate
  ) {
    if (!checkHasTrustDialogAccepted()) {
      console.warn(
        chalk.yellow(
          'Assistant mode disabled: directory is not trusted. Accept the trust dialog and restart.',
        ),
      )
    } else {
      kairosEnabled =
        assistantModule.isAssistantForced() ||
        (await kairosGate.isKairosEnabled())
      if (kairosEnabled) {
        const opts = options as { brief?: boolean }
        opts.brief = true
        setKairosActive(true)
        assistantTeamContext = await assistantModule.initializeAssistantTeam()
      }
    }
  }

  const {
    debug = false,
    debugToStderr = false,
    dangerouslySkipPermissions,
    allowDangerouslySkipPermissions = false,
    tools: baseTools = [],
    allowedTools = [],
    disallowedTools = [],
    mcpConfig = [],
    permissionMode: permissionModeCli,
    addDir = [],
    fallbackModel,
    betas = [],
    ide = false,
    sessionId,
    includeHookEvents,
    includePartialMessages,
  } = options

  if (options.prefill) {
    seedEarlyInput(options.prefill)
  }

  // Promise for file downloads - started early, awaited before REPL renders
  let fileDownloadPromise: Promise<DownloadResult[]> | undefined

  const agentsJson = options.agents
  const agentCli = options.agent
  if (feature('BG_SESSIONS') && agentCli) {
    process.env.CLAUDE_CODE_AGENT = agentCli
  }

  // Extract these separately so they can be modified if needed
  let outputFormat = options.outputFormat
  let inputFormat = options.inputFormat
  let verbose = options.verbose ?? getGlobalConfig().verbose
  let print = options.print
  const init = options.init ?? false
  const initOnly = options.initOnly ?? false
  const maintenance = options.maintenance ?? false

  // Extract disable slash commands flag
  const disableSlashCommands = options.disableSlashCommands || false

  // Extract tasks mode options (ant-only)
  const tasksOption =
    process.env.USER_TYPE === 'ant' &&
    (options as { tasks?: boolean | string }).tasks
  const taskListId = tasksOption
    ? typeof tasksOption === 'string'
      ? tasksOption
      : DEFAULT_TASKS_MODE_TASK_LIST_ID
    : undefined
  if (process.env.USER_TYPE === 'ant' && taskListId) {
    process.env.CLAUDE_CODE_TASK_LIST_ID = taskListId
  }

  // Extract worktree option
  const worktreeOption = isWorktreeModeEnabled()
    ? (options as { worktree?: boolean | string }).worktree
    : undefined
  let worktreeName =
    typeof worktreeOption === 'string' ? worktreeOption : undefined
  const worktreeEnabled = worktreeOption !== undefined

  // Check if worktree name is a PR reference (#N or GitHub PR URL)
  let worktreePRNumber: number | undefined
  if (worktreeName) {
    const prNum = parsePRReference(worktreeName)
    if (prNum !== null) {
      worktreePRNumber = prNum
      worktreeName = undefined // slug will be generated in setup()
    }
  }

  // Extract tmux option (requires --worktree)
  const tmuxEnabled =
    isWorktreeModeEnabled() && (options as { tmux?: boolean }).tmux === true

  // Validate tmux option
  if (tmuxEnabled) {
    if (!worktreeEnabled) {
      process.stderr.write(chalk.red('Error: --tmux requires --worktree\n'))
      process.exit(1)
    }
    if (getPlatform() === 'windows') {
      process.stderr.write(
        chalk.red('Error: --tmux is not supported on Windows\n'),
      )
      process.exit(1)
    }
    if (!(await isTmuxAvailable())) {
      process.stderr.write(
        chalk.red(
          `Error: tmux is not installed.\n${getTmuxInstallInstructions()}\n`,
        ),
      )
      process.exit(1)
    }
  }

  // Extract teammate options (for tmux-spawned agents)
  let storedTeammateOpts: TeammateOptions | undefined
  if (isAgentSwarmsEnabled()) {
    const teammateOpts = extractTeammateOptions(options)
    storedTeammateOpts = teammateOpts

    const hasAnyTeammateOpt =
      teammateOpts.agentId || teammateOpts.agentName || teammateOpts.teamName
    const hasAllRequiredTeammateOpts =
      teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName

    if (hasAnyTeammateOpt && !hasAllRequiredTeammateOpts) {
      process.stderr.write(
        chalk.red(
          'Error: --agent-id, --agent-name, and --team-name must all be provided together\n',
        ),
      )
      process.exit(1)
    }

    if (
      teammateOpts.agentId &&
      teammateOpts.agentName &&
      teammateOpts.teamName
    ) {
      getTeammateUtils().setDynamicTeamContext?.({
        agentId: teammateOpts.agentId,
        agentName: teammateOpts.agentName,
        teamName: teammateOpts.teamName,
        color: teammateOpts.agentColor,
        planModeRequired: teammateOpts.planModeRequired ?? false,
        parentSessionId: teammateOpts.parentSessionId,
      })
    }

    if (teammateOpts.teammateMode) {
      getTeammateModeSnapshot().setCliTeammateModeOverride?.(
        teammateOpts.teammateMode,
      )
    }
  }

  // Extract remote sdk options
  const sdkUrl = (options as { sdkUrl?: string }).sdkUrl ?? undefined

  // Allow env var to enable partial messages (used by sandbox gateway for baku)
  const effectiveIncludePartialMessages =
    includePartialMessages ||
    isEnvTruthy(process.env.CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES)

  // Enable all hook event types when explicitly requested via SDK option
  if (includeHookEvents || isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
    setAllHookEventsEnabled(true)
  }

  // Auto-set input/output formats, verbose mode, and print mode when SDK URL is provided
  if (sdkUrl) {
    if (!inputFormat) {
      inputFormat = 'stream-json'
    }
    if (!outputFormat) {
      outputFormat = 'stream-json'
    }
    if (options.verbose === undefined) {
      verbose = true
    }
    if (!options.print) {
      print = true
    }
  }

  // Extract teleport option
  const teleport = (options as { teleport?: string | true }).teleport ?? null

  // Extract remote option (can be true if no description provided, or a string)
  const remoteOption = (options as { remote?: string | true }).remote
  const remote = remoteOption === true ? '' : (remoteOption ?? null)

  // Extract --remote-control / --rc flag (enable bridge in interactive session)
  const remoteControlOption =
    (options as { remoteControl?: string | true }).remoteControl ??
    (options as { rc?: string | true }).rc
  const remoteControl = false
  const remoteControlName =
    typeof remoteControlOption === 'string' && remoteControlOption.length > 0
      ? remoteControlOption
      : undefined

  // Validate session ID if provided
  if (sessionId) {
    if ((options.continue || options.resume) && !options.forkSession) {
      process.stderr.write(
        chalk.red(
          'Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.\n',
        ),
      )
      process.exit(1)
    }

    if (!sdkUrl) {
      const validatedSessionId = validateUuid(sessionId)
      if (!validatedSessionId) {
        process.stderr.write(
          chalk.red('Error: Invalid session ID. Must be a valid UUID.\n'),
        )
        process.exit(1)
      }

      if (sessionIdExists(validatedSessionId)) {
        process.stderr.write(
          chalk.red(
            `Error: Session ID ${validatedSessionId} is already in use.\n`,
          ),
        )
        process.exit(1)
      }
    }
  }

  // Download file resources if specified via --file flag
  const fileSpecs = (options as { file?: string[] }).file
  if (fileSpecs && fileSpecs.length > 0) {
    const sessionToken = getSessionIngressAuthToken()
    if (!sessionToken) {
      process.stderr.write(
        chalk.red(
          'Error: Session token required for file downloads. CLAUDE_CODE_SESSION_ACCESS_TOKEN must be set.\n',
        ),
      )
      process.exit(1)
    }

    const fileSessionId =
      process.env.CLAUDE_CODE_REMOTE_SESSION_ID || getSessionId()

    const files = parseFileSpecs(fileSpecs)
    if (files.length > 0) {
      const config: FilesApiConfig = {
        baseUrl:
          process.env.ANTHROPIC_BASE_URL || getOauthConfig().BASE_API_URL,
        oauthToken: sessionToken,
        sessionId: fileSessionId,
      }

      fileDownloadPromise = downloadSessionFiles(files, config)
    }
  }

  // Get isNonInteractiveSession from state (was set before init())
  const isNonInteractiveSession = getIsNonInteractiveSession()

  // Validate that fallback model is different from main model
  if (fallbackModel && options.model && fallbackModel === options.model) {
    process.stderr.write(
      chalk.red(
        'Error: Fallback model cannot be the same as the main model. Please specify a different model for --fallback-model.\n',
      ),
    )
    process.exit(1)
  }

  // Handle system prompt options
  let systemPrompt = options.systemPrompt
  if (options.systemPromptFile) {
    if (options.systemPrompt) {
      process.stderr.write(
        chalk.red(
          'Error: Cannot use both --system-prompt and --system-prompt-file. Please use only one.\n',
        ),
      )
      process.exit(1)
    }

    try {
      const filePath = resolve(options.systemPromptFile)
      systemPrompt = readFileSync(filePath, 'utf8')
    } catch (error) {
      const code = getErrnoCode(error)
      if (code === 'ENOENT') {
        process.stderr.write(
          chalk.red(
            `Error: System prompt file not found: ${resolve(options.systemPromptFile)}\n`,
          ),
        )
        process.exit(1)
      }
      process.stderr.write(
        chalk.red(`Error reading system prompt file: ${errorMessage(error)}\n`),
      )
      process.exit(1)
    }
  }

  // Handle append system prompt options
  let appendSystemPrompt = options.appendSystemPrompt
  if (options.appendSystemPromptFile) {
    if (options.appendSystemPrompt) {
      process.stderr.write(
        chalk.red(
          'Error: Cannot use both --append-system-prompt and --append-system-prompt-file. Please use only one.\n',
        ),
      )
      process.exit(1)
    }

    try {
      const filePath = resolve(options.appendSystemPromptFile)
      appendSystemPrompt = readFileSync(filePath, 'utf8')
    } catch (error) {
      const code = getErrnoCode(error)
      if (code === 'ENOENT') {
        process.stderr.write(
          chalk.red(
            `Error: Append system prompt file not found: ${resolve(options.appendSystemPromptFile)}\n`,
          ),
        )
        process.exit(1)
      }
      process.stderr.write(
        chalk.red(
          `Error reading append system prompt file: ${errorMessage(error)}\n`,
        ),
      )
      process.exit(1)
    }
  }

  // Add teammate-specific system prompt addendum for tmux teammates
  if (
    isAgentSwarmsEnabled() &&
    storedTeammateOpts?.agentId &&
    storedTeammateOpts?.agentName &&
    storedTeammateOpts?.teamName
  ) {
    const addendum = getTeammatePromptAddendum().TEAMMATE_SYSTEM_PROMPT_ADDENDUM
    appendSystemPrompt = appendSystemPrompt
      ? `${appendSystemPrompt}\n\n${addendum}`
      : addendum
  }

  return {
    debug,
    debugToStderr,
    dangerouslySkipPermissions,
    allowDangerouslySkipPermissions,
    baseTools,
    allowedTools,
    disallowedTools,
    mcpConfig,
    permissionModeCli,
    addDir,
    fallbackModel,
    betas,
    ide,
    sessionId,
    includeHookEvents,
    includePartialMessages,
    agentsJson,
    agentCli,
    outputFormat,
    inputFormat,
    verbose,
    print,
    init,
    initOnly,
    maintenance,
    disableSlashCommands,
    taskListId,
    worktreeOption,
    worktreeName,
    worktreeEnabled,
    worktreePRNumber,
    tmuxEnabled,
    storedTeammateOpts,
    sdkUrl,
    effectiveIncludePartialMessages,
    teleport,
    remote,
    remoteControl,
    remoteControlName,
    remoteControlOption,
    isNonInteractiveSession,
    fileDownloadPromise,
    systemPrompt,
    appendSystemPrompt,
    kairosEnabled,
    assistantTeamContext,
    assistantModule,
    kairosGate,
    autoModeStateModule,
    options,
    prompt,
  }
}
