/**
 * Phase 3: initializeSession
 *
 * From getInputPrompt() through plugin init and the initOnly early exit.
 * Handles input prompt resolution, tool loading, setup(), model resolution,
 * agent parsing, system prompt assembly, interactive setup screens, MCP
 * resolve, prefetch, hooks, thinking config, session registration, plugin
 * init, and initOnly early exit. Extracted from main.tsx .action() handler.
 */

import { feature } from 'bun:bundle'
import chalk from 'chalk'
import uniqBy from 'lodash-es/uniqBy.js'
import type { Root } from '@anthropic/ink'
import { profileCheckpoint } from '../../utils/startupProfiler.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  getInitialMainLoopModel,
  getIsNonInteractiveSession,
  getUserMsgOptIn,
  setInitialMainLoopModel,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  setUserMsgOptIn,
} from '../../bootstrap/state.js'
import {
  getFeatureValue_CACHED_MAY_BE_STALE,
  hasGrowthBookEnvOverride,
  initializeGrowthBook,
  refreshGrowthBookAfterAuthChange,
} from '../../services/analytics/growthbook.js'
import { checkQuotaStatus } from '../../services/claudeAiLimits.js'
import { fetchBootstrapData } from '../../services/api/bootstrap.js'
import { prefetchPassesEligibility } from '../../services/api/referral.js'
import {
  prefetchFastModeStatus,
  resolveFastModeStatusFromCache,
} from '../../utils/fastMode.js'
import {
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import { isBareMode, isEnvTruthy } from '../../utils/envUtils.js'
import { getSystemContext, getUserContext } from '../../context.js'
import { applyConfigEnvironmentVariables } from '../../utils/managedEnv.js'
import { ensureModelStringsInitialized } from '../../utils/model/modelStrings.js'
import { getCwd } from 'src/utils/cwd.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from '../../utils/log.js'
import { errorMessage } from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'
import { jsonParse } from '../../utils/slowOperations.js'
import { getTools } from '../../tools.js'
import {
  createSyntheticOutputTool,
  isSyntheticOutputToolEnabled,
} from '@claude-code-best/builtin-tools/tools/SyntheticOutputTool/SyntheticOutputTool.js'
import type { ToolInputJSONSchema } from '../../Tool.js'
import type { Tool } from '../../Tool.js'
import {
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
  isBuiltInAgent,
  isCustomAgent,
  parseAgentsFromJson,
  type AgentDefinitionsResult,
} from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { filterCommandsForRemoteMode, getCommands } from '../../commands.js'
import {
  cacheSessionTitle,
  saveAgentSetting,
} from '../../utils/sessionStorage.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { getSettingsWithErrors } from '../../utils/settings/settings.js'
import {
  getDefaultMainLoopModel,
  getUserSpecifiedModelSetting,
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import {
  canUserConfigureAdvisor,
  getInitialAdvisorSetting,
  isAdvisorEnabled,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from '../../utils/advisor.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { initBuiltinPlugins } from '../../plugins/bundled/index.js'
import { initBundledSkills } from '../../skills/bundled/index.js'
import { validateUuid } from '../../utils/uuid.js'
import { installAsciicastRecorder } from '../../utils/asciicast.js'
import {
  exitWithError,
  getRenderContext,
  showSetupScreens,
} from '../../interactiveHelpers.js'
import {
  launchInvalidSettingsDialog,
  launchSnapshotUpdateDialog,
} from '../../dialogLaunchers.js'
import { prefetchAllMcpResources } from '../../services/mcp/client.js'
import type {
  ScopedMcpServerConfig,
  McpSdkServerConfig,
} from '../../services/mcp/types.js'
import type { Command } from '../../types/command.js'
import type { HookResultMessage } from '../../types/message.js'
import {
  processSessionStartHooks,
  processSetupHooks,
} from '../../utils/sessionStart.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from '../../utils/thinking.js'
import { isInBundledMode } from '../../utils/bundledMode.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { registerCleanup } from 'src/utils/cleanupRegistry.js'
import { logContextMetrics } from 'src/utils/api.js'
import { logPermissionContextForAnts } from 'src/services/internalLogging.js'
import {
  countConcurrentSessions,
  registerSession,
  updateSessionName,
} from 'src/utils/concurrentSessions.js'
import { initializeVersionedPlugins } from '../../utils/plugins/installedPluginsManager.js'
import { cleanupOrphanedPluginVersionsInBackground } from '../../utils/plugins/cacheUtils.js'
import { getGlobExclusionsForPluginCache } from '../../utils/plugins/orphanedPluginFilter.js'
import { refreshExampleCommands } from '../../utils/exampleCommands.js'
import { gracefulShutdownSync } from 'src/utils/gracefulShutdown.js'
import { initializeLspServerManager } from '../../services/lsp/manager.js'
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js'
import { refreshPolicyLimits } from '../../services/policyLimits/index.js'
import { resetUserCache } from '../../utils/user.js'
import { validateForceLoginOrg } from '../../utils/auth.js'
import type { StatsStore } from '../../context/stats.js'
import type { FpsMetrics } from '../../utils/fpsTracker.js'
import type { ToolPermissionContext, Tools } from '../../Tool.js'
import type { PermissionMode } from '../../types/permissions.js'
import {
  maybeActivateBrief,
  maybeActivateProactive,
  logTenguInit,
  logManagedSettings,
} from '../mainHelpers.js'
import type { ParsedOptions } from './parseOptions.js'
import type { PermissionsAndMcpResult } from './setupPermissions.js'
import { peekForStdinData, writeToStderr } from 'src/utils/process.js'

/**
 * Result of initializeSession
 */
export type SessionResult = {
  inputPrompt: string | AsyncIterable<string>
  tools: Tools
  jsonSchema: ToolInputJSONSchema | undefined
  commands: Command[]
  agentDefinitions: AgentDefinitionsResult
  cliAgents: AgentDefinitionsResult['activeAgents']
  mainThreadAgentDefinition:
    | AgentDefinitionsResult['activeAgents'][number]
    | undefined
  agentSetting: string | undefined
  effectiveModel: string | undefined
  userSpecifiedFallbackModel: string | undefined
  initialMainLoopModel: string | null
  resolvedInitialModel: string
  advisorModel: string | undefined
  currentCwd: string
  effectiveReplayUserMessages: boolean
  thinkingEnabled: boolean
  thinkingConfig: ThinkingConfig
  systemPrompt: string | undefined
  appendSystemPrompt: string | undefined
  setupTrigger: 'init' | 'maintenance' | null
  sessionNameArg: string | undefined
  regularMcpConfigs: Record<string, ScopedMcpServerConfig>
  sdkMcpConfigs: Record<string, McpSdkServerConfig>
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig>
  mcpClients: Awaited<ReturnType<typeof prefetchAllMcpResources>>['clients']
  mcpTools: Tool[]
  mcpCommands: Command[]
  hooksPromise: Promise<HookResultMessage[]> | null
  hookMessages: HookResultMessage[]
  root: Root
  getFpsMetrics: () => FpsMetrics | undefined
  stats: StatsStore
  remoteControl: boolean
  devChannels: import('../../bootstrap/state.js').ChannelEntry[] | undefined
  // initOnly exit flag — when true, the caller should return immediately
  initOnlyExited: boolean
}

/**
 * Read input from stdin or return the prompt.
 */
async function getInputPrompt(
  prompt: string,
  inputFormat: 'text' | 'stream-json',
): Promise<string | AsyncIterable<string>> {
  if (
    !process.stdin.isTTY &&
    // Input hijacking breaks MCP.
    !process.argv.includes('mcp')
  ) {
    if (inputFormat === 'stream-json') {
      return process.stdin
    }
    process.stdin.setEncoding('utf8')
    let data = ''
    const onData = (chunk: string) => {
      data += chunk
    }
    process.stdin.on('data', onData)
    const timedOut = await peekForStdinData(process.stdin, 3000)
    process.stdin.off('data', onData)
    if (timedOut) {
      process.stderr.write(
        'Warning: no stdin data received in 3s, proceeding without it. ' +
          'If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.\n',
      )
    }
    return [prompt, data].filter(Boolean).join('\n')
  }
  return prompt
}

export async function initializeSession(
  parsed: ParsedOptions,
  permMcp: PermissionsAndMcpResult,
): Promise<SessionResult> {
  const {
    options,
    prompt,
    sdkUrl,
    worktreeEnabled,
    worktreeName,
    worktreePRNumber,
    tmuxEnabled,
    sessionId,
    isNonInteractiveSession,
    init: initFlag,
    initOnly,
    maintenance,
    kairosEnabled,
    assistantModule,
    agentsJson,
    agentCli,
    fallbackModel,
    storedTeammateOpts,
  } = parsed
  let { outputFormat, inputFormat, systemPrompt } = parsed
  let appendSystemPrompt = permMcp.appendSystemPrompt

  const {
    permissionMode,
    toolPermissionContext,
    dynamicMcpConfig,
    strictMcpConfig,
    claudeaiConfigPromise,
    mcpConfigPromise,
    mcpConfigStart,
    enableClaudeInChrome,
    devChannels,
    allowedTools,
    remoteControlOption,
  } = permMcp
  let { mcpConfigResolvedMs } = permMcp
  const { allowDangerouslySkipPermissions } = parsed

  const coordinatorModeModule = feature('COORDINATOR_MODE')
    ? (require('../../coordinator/coordinatorMode.js') as typeof import('../../coordinator/coordinatorMode.js'))
    : null

  const effectivePrompt = prompt || ''
  let inputPrompt = await getInputPrompt(
    effectivePrompt,
    (inputFormat ?? 'text') as 'text' | 'stream-json',
  )
  profileCheckpoint('action_after_input_prompt')

  // Activate proactive mode BEFORE getTools()
  maybeActivateProactive(options)

  let tools: Tools = getTools(toolPermissionContext)

  // Apply coordinator mode tool filtering for headless path
  if (
    feature('COORDINATOR_MODE') &&
    isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  ) {
    const { applyCoordinatorToolFilter } = await import(
      '../../utils/toolPool.js'
    )
    tools = applyCoordinatorToolFilter(tools)
  }

  profileCheckpoint('action_tools_loaded')

  let jsonSchema: ToolInputJSONSchema | undefined
  if (
    isSyntheticOutputToolEnabled({ isNonInteractiveSession }) &&
    options.jsonSchema
  ) {
    jsonSchema = jsonParse(options.jsonSchema) as ToolInputJSONSchema
  }

  if (jsonSchema) {
    const syntheticOutputResult = createSyntheticOutputTool(jsonSchema)
    if ('tool' in syntheticOutputResult) {
      tools = [...tools, syntheticOutputResult.tool] as Tools

      logEvent('tengu_structured_output_enabled', {
        schema_property_count: Object.keys(
          (jsonSchema.properties as Record<string, unknown>) || {},
        ).length as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        has_required_fields: Boolean(
          jsonSchema.required,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    } else {
      logEvent('tengu_structured_output_failure', {
        error:
          'Invalid JSON schema' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  }

  // IMPORTANT: setup() must be called before any other code that depends on the cwd or worktree setup
  profileCheckpoint('action_before_setup')
  logForDebugging('[STARTUP] Running setup()...')
  const setupStart = Date.now()
  const { setup } = await import('../../setup.js')
  const messagingSocketPath = feature('UDS_INBOX')
    ? (options as { messagingSocketPath?: string }).messagingSocketPath
    : undefined
  const preSetupCwd = getCwd()
  if (process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent') {
    initBuiltinPlugins()
    initBundledSkills()
  }
  const setupPromise = setup(
    preSetupCwd,
    permissionMode,
    allowDangerouslySkipPermissions,
    worktreeEnabled,
    worktreeName,
    tmuxEnabled,
    sessionId ? validateUuid(sessionId) : undefined,
    worktreePRNumber,
    messagingSocketPath,
  )
  const commandsPromise = worktreeEnabled ? null : getCommands(preSetupCwd)
  const agentDefsPromise = worktreeEnabled
    ? null
    : getAgentDefinitionsWithOverrides(preSetupCwd)
  commandsPromise?.catch(() => {})
  agentDefsPromise?.catch(() => {})
  await setupPromise
  logForDebugging(`[STARTUP] setup() completed in ${Date.now() - setupStart}ms`)
  profileCheckpoint('action_after_setup')

  // Replay user messages
  let effectiveReplayUserMessages = !!options.replayUserMessages
  if (feature('UDS_INBOX')) {
    if (!effectiveReplayUserMessages && outputFormat === 'stream-json') {
      effectiveReplayUserMessages = !!(
        options as { messagingSocketPath?: string }
      ).messagingSocketPath
    }
  }

  if (getIsNonInteractiveSession()) {
    applyConfigEnvironmentVariables()
    void getSystemContext()
    void getUserContext()
    void ensureModelStringsInitialized()
  }

  // Apply --name
  const sessionNameArg = options.name?.trim()
  if (sessionNameArg) {
    cacheSessionTitle(sessionNameArg)
  }

  // Ant model aliases
  const explicitModel = options.model || process.env.ANTHROPIC_MODEL
  if (
    process.env.USER_TYPE === 'ant' &&
    explicitModel &&
    explicitModel !== 'default' &&
    !hasGrowthBookEnvOverride('tengu_ant_model_override') &&
    getGlobalConfig().cachedGrowthBookFeatures?.['tengu_ant_model_override'] ==
      null
  ) {
    await initializeGrowthBook()
  }

  const userSpecifiedModel =
    options.model === 'default' ? getDefaultMainLoopModel() : options.model
  const userSpecifiedFallbackModel =
    fallbackModel === 'default' ? getDefaultMainLoopModel() : fallbackModel

  const currentCwd = worktreeEnabled ? getCwd() : preSetupCwd
  logForDebugging('[STARTUP] Loading commands and agents...')
  const commandsStart = Date.now()
  const [commands, agentDefinitionsResult] = await Promise.all([
    commandsPromise ?? getCommands(currentCwd),
    agentDefsPromise ?? getAgentDefinitionsWithOverrides(currentCwd),
  ])
  logForDebugging(
    `[STARTUP] Commands and agents loaded in ${Date.now() - commandsStart}ms`,
  )
  profileCheckpoint('action_commands_loaded')

  // Parse CLI agents if provided via --agents flag
  let cliAgents: typeof agentDefinitionsResult.activeAgents = []
  if (agentsJson) {
    try {
      const parsedAgents = safeParseJSON(agentsJson)
      if (parsedAgents) {
        cliAgents = parseAgentsFromJson(parsedAgents, 'flagSettings')
      }
    } catch (error) {
      logError(error)
    }
  }

  // Merge CLI agents with existing ones
  const allAgents = [...agentDefinitionsResult.allAgents, ...cliAgents]
  const agentDefinitions = {
    ...agentDefinitionsResult,
    allAgents,
    activeAgents: getActiveAgentsFromList(allAgents),
  }

  // Look up main thread agent
  const agentSetting = agentCli ?? getInitialSettings().agent
  let mainThreadAgentDefinition:
    | (typeof agentDefinitions.activeAgents)[number]
    | undefined
  if (agentSetting) {
    mainThreadAgentDefinition = agentDefinitions.activeAgents.find(
      agent => agent.agentType === agentSetting,
    )
    if (!mainThreadAgentDefinition) {
      logForDebugging(
        `Warning: agent "${agentSetting}" not found. ` +
          `Available agents: ${agentDefinitions.activeAgents.map(a => a.agentType).join(', ')}. ` +
          `Using default behavior.`,
      )
    }
  }

  setMainThreadAgentType(mainThreadAgentDefinition?.agentType)

  // Log agent flag usage
  if (mainThreadAgentDefinition) {
    logEvent('tengu_agent_flag', {
      agentType: isBuiltInAgent(mainThreadAgentDefinition)
        ? (mainThreadAgentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
        : ('custom' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
      ...(agentCli && {
        source:
          'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    })
  }

  // Persist agent setting
  if (mainThreadAgentDefinition?.agentType) {
    saveAgentSetting(mainThreadAgentDefinition.agentType)
  }

  // Apply the agent's system prompt for non-interactive sessions
  if (
    isNonInteractiveSession &&
    mainThreadAgentDefinition &&
    !systemPrompt &&
    !isBuiltInAgent(mainThreadAgentDefinition)
  ) {
    const agentSystemPrompt = mainThreadAgentDefinition.getSystemPrompt()
    if (agentSystemPrompt) {
      systemPrompt = agentSystemPrompt
    }
  }

  // Prepend initialPrompt
  if (mainThreadAgentDefinition?.initialPrompt) {
    if (typeof inputPrompt === 'string') {
      inputPrompt = inputPrompt
        ? `${mainThreadAgentDefinition.initialPrompt}\n\n${inputPrompt}`
        : mainThreadAgentDefinition.initialPrompt
    } else if (!inputPrompt) {
      inputPrompt = mainThreadAgentDefinition.initialPrompt
    }
  }

  // Compute effective model
  let effectiveModel = userSpecifiedModel
  if (
    !effectiveModel &&
    mainThreadAgentDefinition?.model &&
    mainThreadAgentDefinition.model !== 'inherit'
  ) {
    effectiveModel = parseUserSpecifiedModel(mainThreadAgentDefinition.model)
  }

  setMainLoopModelOverride(effectiveModel)

  setInitialMainLoopModel(getUserSpecifiedModelSetting() || null)
  const initialMainLoopModel = getInitialMainLoopModel()
  const resolvedInitialModel = parseUserSpecifiedModel(
    initialMainLoopModel ?? getDefaultMainLoopModel(),
  )

  let advisorModel: string | undefined
  if (isAdvisorEnabled()) {
    const advisorOption = canUserConfigureAdvisor()
      ? (options as { advisor?: string }).advisor
      : undefined
    if (advisorOption) {
      logForDebugging(`[AdvisorTool] --advisor ${advisorOption}`)
      if (!modelSupportsAdvisor(resolvedInitialModel)) {
        process.stderr.write(
          chalk.red(
            `Error: The model "${resolvedInitialModel}" does not support the advisor tool.\n`,
          ),
        )
        process.exit(1)
      }
      const normalizedAdvisorModel = normalizeModelStringForAPI(
        parseUserSpecifiedModel(advisorOption),
      )
      if (!isValidAdvisorModel(normalizedAdvisorModel)) {
        process.stderr.write(
          chalk.red(
            `Error: The model "${advisorOption}" cannot be used as an advisor.\n`,
          ),
        )
        process.exit(1)
      }
    }
    advisorModel = canUserConfigureAdvisor()
      ? (advisorOption ?? getInitialAdvisorSetting())
      : advisorOption
    if (advisorModel) {
      logForDebugging(`[AdvisorTool] Advisor model: ${advisorModel}`)
    }
  }

  // For tmux teammates with --agent-type, append the custom agent's prompt
  if (
    isAgentSwarmsEnabled() &&
    storedTeammateOpts?.agentId &&
    storedTeammateOpts?.agentName &&
    storedTeammateOpts?.teamName &&
    storedTeammateOpts?.agentType
  ) {
    const customAgent = agentDefinitions.activeAgents.find(
      a => a.agentType === storedTeammateOpts.agentType,
    )
    if (customAgent) {
      let customPrompt: string | undefined
      if (customAgent.source === 'built-in') {
        logForDebugging(
          `[teammate] Built-in agent ${storedTeammateOpts.agentType} - skipping custom prompt (not supported)`,
        )
      } else {
        customPrompt = customAgent.getSystemPrompt()
      }

      if (customAgent.memory) {
        logEvent('tengu_agent_memory_loaded', {
          ...(process.env.USER_TYPE === 'ant' && {
            agent_type:
              customAgent.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          }),
          scope:
            customAgent.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          source:
            'teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }

      if (customPrompt) {
        const customInstructions = `\n# Custom Agent Instructions\n${customPrompt}`
        appendSystemPrompt = appendSystemPrompt
          ? `${appendSystemPrompt}\n\n${customInstructions}`
          : customInstructions
      }
    } else {
      logForDebugging(
        `[teammate] Custom agent ${storedTeammateOpts.agentType} not found in available agents`,
      )
    }
  }

  maybeActivateBrief(options)
  // defaultView: 'chat' opt-in
  if (
    (feature('KAIROS') || feature('KAIROS_BRIEF')) &&
    !getIsNonInteractiveSession() &&
    !getUserMsgOptIn() &&
    getInitialSettings().defaultView === 'chat'
  ) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isBriefEntitled } =
      require('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js') as typeof import('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isBriefEntitled()) {
      setUserMsgOptIn(true)
    }
  }
  // Proactive prompt
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    ((options as { proactive?: boolean }).proactive ||
      isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE)) &&
    !coordinatorModeModule?.isCoordinatorMode()
  ) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const briefVisibility =
      feature('KAIROS') || feature('KAIROS_BRIEF')
        ? (
            require('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js') as typeof import('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js')
          ).isBriefEnabled()
          ? 'Call SendUserMessage at checkpoints to mark where things stand.'
          : 'The user will see any text you output.'
        : 'The user will see any text you output.'
    /* eslint-enable @typescript-eslint/no-require-imports */
    const proactivePrompt = `\n# Proactive Mode\n\nYou are in proactive mode. Take initiative — explore, act, and make progress without waiting for instructions.\n\nStart by briefly greeting the user.\n\nYou will receive periodic <tick> prompts. These are check-ins. Do whatever seems most useful, or call Sleep if there's nothing to do. ${briefVisibility}`
    appendSystemPrompt = appendSystemPrompt
      ? `${appendSystemPrompt}\n\n${proactivePrompt}`
      : proactivePrompt
  }

  if (feature('KAIROS') && kairosEnabled && assistantModule) {
    const assistantAddendum = assistantModule.getAssistantSystemPromptAddendum()
    appendSystemPrompt = appendSystemPrompt
      ? `${appendSystemPrompt}\n\n${assistantAddendum}`
      : assistantAddendum
  }

  // Ink root is only needed for interactive sessions
  let root!: Root
  let getFpsMetrics!: () => FpsMetrics | undefined
  let stats!: StatsStore

  let remoteControl = parsed.remoteControl

  // Show setup screens after commands are loaded
  if (!isNonInteractiveSession) {
    const ctx = getRenderContext(false)
    getFpsMetrics = ctx.getFpsMetrics
    stats = ctx.stats
    if (process.env.USER_TYPE === 'ant') {
      installAsciicastRecorder()
    }

    const { createRoot } = await import('@anthropic/ink')
    root = await createRoot(ctx.renderOptions)

    logEvent('tengu_timer', {
      event:
        'startup' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      durationMs: Math.round(process.uptime() * 1000),
    })

    logForDebugging('[STARTUP] Running showSetupScreens()...')
    const setupScreensStart = Date.now()
    const onboardingShown = await showSetupScreens(
      root,
      permissionMode,
      allowDangerouslySkipPermissions,
      commands,
      enableClaudeInChrome,
      devChannels,
    )
    logForDebugging(
      `[STARTUP] showSetupScreens() completed in ${Date.now() - setupScreensStart}ms`,
    )

    // Resolve --remote-control / --rc entitlement gate
    if (feature('BRIDGE_MODE') && remoteControlOption !== undefined) {
      const { getBridgeDisabledReason } = await import(
        '../../bridge/bridgeEnabled.js'
      )
      const disabledReason = await getBridgeDisabledReason()
      remoteControl = disabledReason === null
      if (disabledReason) {
        process.stderr.write(
          chalk.yellow(`${disabledReason}\n--rc flag ignored.\n`),
        )
      }
    }

    // Check for pending agent memory snapshot updates
    if (
      feature('AGENT_MEMORY_SNAPSHOT') &&
      mainThreadAgentDefinition &&
      isCustomAgent(mainThreadAgentDefinition) &&
      mainThreadAgentDefinition.memory &&
      mainThreadAgentDefinition.pendingSnapshotUpdate
    ) {
      const agentDef = mainThreadAgentDefinition
      const choice = await launchSnapshotUpdateDialog(root, {
        agentType: agentDef.agentType,
        scope: agentDef.memory!,
        snapshotTimestamp: agentDef.pendingSnapshotUpdate!.snapshotTimestamp,
      })
      if (choice === 'merge') {
        const { buildMergePrompt } = await import(
          '../../components/agents/SnapshotUpdateDialog.js'
        )
        const mergePrompt = buildMergePrompt(
          agentDef.agentType,
          agentDef.memory!,
        )
        inputPrompt = inputPrompt
          ? `${mergePrompt}\n\n${inputPrompt}`
          : mergePrompt
      }
      agentDef.pendingSnapshotUpdate = undefined
    }

    // Skip executing /login if we just completed onboarding for it
    let mutablePrompt = prompt
    if (onboardingShown && mutablePrompt?.trim().toLowerCase() === '/login') {
      mutablePrompt = ''
    }

    if (onboardingShown) {
      void refreshRemoteManagedSettings()
      void refreshPolicyLimits()
      resetUserCache()
      refreshGrowthBookAfterAuthChange()
      void import('../../bridge/trustedDevice.js').then(m => {
        m.clearTrustedDeviceToken()
        return m.enrollTrustedDevice()
      })
    }

    // Validate org match
    const orgValidation = await validateForceLoginOrg()
    if (!orgValidation.valid) {
      await exitWithError(
        root,
        (orgValidation as { valid: false; message: string }).message,
      )
    }
  }

  // If gracefulShutdown was initiated, skip further initialization
  if (process.exitCode !== undefined) {
    logForDebugging(
      'Graceful shutdown initiated, skipping further initialization',
    )
    return {
      inputPrompt,
      tools,
      jsonSchema,
      commands,
      agentDefinitions,
      cliAgents,
      mainThreadAgentDefinition,
      agentSetting,
      effectiveModel,
      userSpecifiedFallbackModel,
      initialMainLoopModel,
      resolvedInitialModel,
      advisorModel,
      currentCwd,
      effectiveReplayUserMessages,
      thinkingEnabled: false,
      thinkingConfig: { type: 'disabled' },
      systemPrompt,
      appendSystemPrompt,
      setupTrigger: null,
      sessionNameArg,
      regularMcpConfigs: {},
      sdkMcpConfigs: {},
      dynamicMcpConfig,
      mcpClients: [],
      mcpTools: [],
      mcpCommands: [],
      hooksPromise: null,
      hookMessages: [],
      root,
      getFpsMetrics,
      stats,
      remoteControl,
      devChannels,
      initOnlyExited: true,
    }
  }

  // Initialize LSP manager AFTER trust is established
  initializeLspServerManager()

  // Show settings validation errors after trust is established
  if (!isNonInteractiveSession) {
    const { errors } = getSettingsWithErrors()
    const nonMcpErrors = errors.filter(e => !e.mcpErrorMetadata)
    if (nonMcpErrors.length > 0) {
      await launchInvalidSettingsDialog(root, {
        settingsErrors: nonMcpErrors,
        onExit: () => gracefulShutdownSync(1),
      })
    }
  }

  // Check quota status, fast mode, passes eligibility, and bootstrap data
  const bgRefreshThrottleMs = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_cicada_nap_ms',
    0,
  )
  const lastPrefetched = getGlobalConfig().startupPrefetchedAt ?? 0
  const skipStartupPrefetches =
    isBareMode() ||
    (bgRefreshThrottleMs > 0 &&
      Date.now() - lastPrefetched < bgRefreshThrottleMs)

  if (!skipStartupPrefetches) {
    const lastPrefetchedInfo =
      lastPrefetched > 0
        ? ` last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago`
        : ''
    logForDebugging(
      `Starting background startup prefetches${lastPrefetchedInfo}`,
    )

    checkQuotaStatus().catch(error => logError(error))

    void fetchBootstrapData()

    void prefetchPassesEligibility()
    if (
      !getFeatureValue_CACHED_MAY_BE_STALE('tengu_miraculo_the_bard', false)
    ) {
      void prefetchFastModeStatus()
    } else {
      resolveFastModeStatusFromCache()
    }
    if (bgRefreshThrottleMs > 0) {
      saveGlobalConfig(current => ({
        ...current,
        startupPrefetchedAt: Date.now(),
      }))
    }
  } else {
    logForDebugging(
      `Skipping startup prefetches, last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago`,
    )
    resolveFastModeStatusFromCache()
  }

  if (!isNonInteractiveSession) {
    void refreshExampleCommands()
  }

  // Resolve MCP configs
  const { servers: existingMcpConfigs } = await mcpConfigPromise
  logForDebugging(
    `[STARTUP] MCP configs resolved in ${mcpConfigResolvedMs}ms (awaited at +${Date.now() - mcpConfigStart}ms)`,
  )
  const allMcpConfigs = {
    ...existingMcpConfigs,
    ...dynamicMcpConfig,
  }

  // Separate SDK configs from regular MCP configs
  const sdkMcpConfigs: Record<string, McpSdkServerConfig> = {}
  const regularMcpConfigs: Record<string, ScopedMcpServerConfig> = {}

  for (const [name, config] of Object.entries(allMcpConfigs)) {
    const typedConfig = config as ScopedMcpServerConfig | McpSdkServerConfig
    if (typedConfig.type === 'sdk') {
      sdkMcpConfigs[name] = typedConfig as McpSdkServerConfig
    } else {
      regularMcpConfigs[name] = typedConfig as ScopedMcpServerConfig
    }
  }

  profileCheckpoint('action_mcp_configs_loaded')

  // Prefetch MCP resources
  const localMcpPromise = isNonInteractiveSession
    ? Promise.resolve({ clients: [], tools: [], commands: [] })
    : prefetchAllMcpResources(regularMcpConfigs)
  const claudeaiMcpPromise = isNonInteractiveSession
    ? Promise.resolve({ clients: [], tools: [], commands: [] })
    : claudeaiConfigPromise.then(configs =>
        Object.keys(configs).length > 0
          ? prefetchAllMcpResources(configs)
          : { clients: [], tools: [], commands: [] },
      )
  const mcpPromise = Promise.all([localMcpPromise, claudeaiMcpPromise]).then(
    ([local, claudeai]) => ({
      clients: [...local.clients, ...claudeai.clients],
      tools: uniqBy([...local.tools, ...claudeai.tools], 'name'),
      commands: uniqBy([...local.commands, ...claudeai.commands], 'name'),
    }),
  )

  // Start hooks early
  const hooksPromise =
    initOnly ||
    initFlag ||
    maintenance ||
    isNonInteractiveSession ||
    options.continue ||
    options.resume
      ? null
      : processSessionStartHooks('startup', {
          agentType: mainThreadAgentDefinition?.agentType,
          model: resolvedInitialModel,
        })

  const hookMessages: HookResultMessage[] = []
  mcpPromise.catch(() => {})

  const mcpClients: Awaited<typeof mcpPromise>['clients'] = []
  const mcpTools: Awaited<typeof mcpPromise>['tools'] = []
  const mcpCommands: Awaited<typeof mcpPromise>['commands'] = []

  let thinkingEnabled = shouldEnableThinkingByDefault()
  let thinkingConfig: ThinkingConfig =
    thinkingEnabled !== false ? { type: 'adaptive' } : { type: 'disabled' }

  if (options.thinking === 'adaptive' || options.thinking === 'enabled') {
    thinkingEnabled = true
    thinkingConfig = { type: 'adaptive' }
  } else if (options.thinking === 'disabled') {
    thinkingEnabled = false
    thinkingConfig = { type: 'disabled' }
  } else {
    const maxThinkingTokens = process.env.MAX_THINKING_TOKENS
      ? parseInt(process.env.MAX_THINKING_TOKENS, 10)
      : options.maxThinkingTokens
    if (maxThinkingTokens !== undefined) {
      if (maxThinkingTokens > 0) {
        thinkingEnabled = true
        thinkingConfig = {
          type: 'enabled',
          budgetTokens: maxThinkingTokens,
        }
      } else if (maxThinkingTokens === 0) {
        thinkingEnabled = false
        thinkingConfig = { type: 'disabled' }
      }
    }
  }

  logForDiagnosticsNoPII('info', 'started', {
    version: MACRO.VERSION,
    is_native_binary: isInBundledMode(),
  })

  registerCleanup(async () => {
    logForDiagnosticsNoPII('info', 'exited')
  })

  void logTenguInit({
    hasInitialPrompt: Boolean(prompt),
    hasStdin: Boolean(inputPrompt),
    verbose: parsed.verbose ?? false,
    debug: parsed.debug,
    debugToStderr: parsed.debugToStderr,
    print: parsed.print ?? false,
    outputFormat: outputFormat ?? 'text',
    inputFormat: inputFormat ?? 'text',
    numAllowedTools: allowedTools.length,
    numDisallowedTools: parsed.disallowedTools.length,
    mcpClientCount: Object.keys(allMcpConfigs).length,
    worktreeEnabled,
    skipWebFetchPreflight: getInitialSettings().skipWebFetchPreflight,
    githubActionInputs: process.env.GITHUB_ACTION_INPUTS,
    dangerouslySkipPermissionsPassed:
      parsed.dangerouslySkipPermissions ?? false,
    permissionMode,
    modeIsBypass: permissionMode === 'bypassPermissions',
    allowDangerouslySkipPermissionsPassed: allowDangerouslySkipPermissions,
    systemPromptFlag: systemPrompt
      ? options.systemPromptFile
        ? 'file'
        : 'flag'
      : undefined,
    appendSystemPromptFlag: appendSystemPrompt
      ? options.appendSystemPromptFile
        ? 'file'
        : 'flag'
      : undefined,
    thinkingConfig,
    assistantActivationPath:
      feature('KAIROS') && kairosEnabled
        ? assistantModule?.getAssistantActivationPath()
        : undefined,
    coordinatorModeModule,
  })

  // Log context metrics once at initialization
  void logContextMetrics(regularMcpConfigs, toolPermissionContext)

  void logPermissionContextForAnts(null, 'initialization')

  logManagedSettings()

  // Register PID file for concurrent-session detection
  void registerSession().then(registered => {
    if (!registered) return
    if (sessionNameArg) {
      void updateSessionName(sessionNameArg)
    }
    void countConcurrentSessions().then(count => {
      if (count >= 2) {
        logEvent('tengu_concurrent_sessions', {
          num_sessions: count,
        })
      }
    })
  })

  // Initialize versioned plugins system
  if (isBareMode()) {
    // skip — no-op
  } else if (isNonInteractiveSession) {
    await initializeVersionedPlugins()
    profileCheckpoint('action_after_plugins_init')
    void cleanupOrphanedPluginVersionsInBackground().then(() =>
      getGlobExclusionsForPluginCache(),
    )
  } else {
    void initializeVersionedPlugins().then(async () => {
      profileCheckpoint('action_after_plugins_init')
      await cleanupOrphanedPluginVersionsInBackground()
      void getGlobExclusionsForPluginCache()
    })
  }

  const setupTrigger =
    initOnly || initFlag ? 'init' : maintenance ? 'maintenance' : null
  if (initOnly) {
    applyConfigEnvironmentVariables()
    await processSetupHooks('init', { forceSyncExecution: true })
    await processSessionStartHooks('startup', {
      forceSyncExecution: true,
    })
    gracefulShutdownSync(0)
    return {
      inputPrompt,
      tools,
      jsonSchema,
      commands,
      agentDefinitions,
      cliAgents,
      mainThreadAgentDefinition,
      agentSetting,
      effectiveModel,
      userSpecifiedFallbackModel,
      initialMainLoopModel,
      resolvedInitialModel,
      advisorModel,
      currentCwd,
      effectiveReplayUserMessages,
      thinkingEnabled,
      thinkingConfig,
      systemPrompt,
      appendSystemPrompt,
      setupTrigger,
      sessionNameArg,
      regularMcpConfigs,
      sdkMcpConfigs,
      dynamicMcpConfig,
      mcpClients,
      mcpTools,
      mcpCommands,
      hooksPromise,
      hookMessages,
      root,
      getFpsMetrics,
      stats,
      remoteControl,
      devChannels,
      initOnlyExited: true,
    }
  }

  return {
    inputPrompt,
    tools,
    jsonSchema,
    commands,
    agentDefinitions,
    cliAgents,
    mainThreadAgentDefinition,
    agentSetting,
    effectiveModel,
    userSpecifiedFallbackModel,
    initialMainLoopModel,
    resolvedInitialModel,
    advisorModel,
    currentCwd,
    effectiveReplayUserMessages,
    thinkingEnabled,
    thinkingConfig,
    systemPrompt,
    appendSystemPrompt,
    setupTrigger,
    sessionNameArg,
    regularMcpConfigs,
    sdkMcpConfigs,
    dynamicMcpConfig,
    mcpClients,
    mcpTools,
    mcpCommands,
    hooksPromise,
    hookMessages,
    root,
    getFpsMetrics,
    stats,
    remoteControl,
    devChannels,
    initOnlyExited: false,
  }
}
