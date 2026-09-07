/**
 * Interactive session path, extracted from main.tsx.
 *
 * Contains: model config logging, notification queue building,
 * initialState construction, session uploader setup,
 * and 6 REPL launch branches (continue, direct-connect, ssh, assistant, resume, fresh).
 */

import { feature } from 'bun:bundle'
import chalk from 'chalk'
import { resolve } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  getOriginalCwd,
  setDirectConnectServerUrl,
  setIsRemoteMode,
  setKairosActive,
  setOriginalCwd,
  setUserMsgOptIn,
  switchSession,
  setCwdState,
  getUserMsgOptIn,
} from '../bootstrap/state.js'
import { filterCommandsForRemoteMode } from '../commands.js'
import { getRemoteSessionUrl } from '../constants/product.js'
import { addToHistory } from '../history.js'
import { launchRepl } from '../replLauncher.js'
import {
  exitWithError,
  exitWithMessage,
  renderAndRun,
} from '../interactiveHelpers.js'
import {
  launchAssistantInstallWizard,
  launchAssistantSessionChooser,
  launchResumeChooser,
  launchTeleportRepoMismatchDialog,
  launchTeleportResumeWrapper,
} from '../dialogLaunchers.js'
import { createRemoteSessionConfig } from '../remote/RemoteSessionManager.js'
import {
  createDirectConnectSession,
  DirectConnectError,
} from '../server/createDirectConnectSession.js'
import {
  isPolicyAllowed,
  waitForPolicyLimitsToLoad,
} from '../services/policyLimits/index.js'
import { shouldEnablePromptSuggestion } from '../services/PromptSuggestion/promptSuggestion.js'
import {
  type AppState,
  IDLE_SPECULATION_STATE,
} from '../state/AppStateStore.js'
import { asSessionId } from '../types/ids.js'
import type { Message as MessageType } from '../types/message.js'
import { count, uniq } from '../utils/array.js'
import { getSubscriptionType } from '../utils/auth.js'
import { createEmptyAttributionState } from 'src/utils/commitAttribution.js'
import {
  getGlobalConfig,
  getRemoteControlAtStartup,
  saveGlobalConfig,
} from '../utils/config.js'
import { buildDeepLinkBanner } from '../utils/deepLink/banner.js'
import { parseEffortValue, getInitialEffortSetting } from '../utils/effort.js'
import {
  errorMessage,
  isENOENT,
  TeleportOperationError,
  toError,
} from 'src/utils/errors.js'
import { getInitialFastModeSetting } from '../utils/fastMode.js'
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js'
import { isAdvisorEnabled } from '../utils/advisor.js'
import { getBranch } from '../utils/git.js'
import { getWorktreePaths } from '../utils/getWorktreePaths.js'
import { getCwd } from 'src/utils/cwd.js'
import { logError } from '../utils/log.js'
import { createSystemMessage, createUserMessage } from '../utils/messages.js'
import { getModelDeprecationWarning } from '../utils/model/deprecation.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import {
  filterExistingPaths,
  getKnownPathsForRepo,
} from '../utils/githubRepoPathMapping.js'
import {
  gracefulShutdown,
  gracefulShutdownSync,
} from 'src/utils/gracefulShutdown.js'
import { logForDebugging } from 'src/utils/debug.js'
import { plural } from 'src/utils/stringUtils.js'
import { setCwd } from 'src/utils/Shell.js'
import {
  type ProcessedResume,
  processResumedConversation,
} from 'src/utils/sessionRestore.js'
import { loadConversationForResume } from '../utils/conversationRecovery.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { fetchSession, prepareApiRequest } from '../utils/teleport/api.js'
import {
  checkOutTeleportedSessionBranch,
  processMessagesForTeleportResume,
  teleportToRemoteWithErrorHandling,
  validateGitState,
  validateSessionRepository,
} from '../utils/teleport.js'
import { setTeleportedSessionInfo } from '../bootstrap/state.js'
import { validateUuid } from '../utils/uuid.js'
import {
  getSessionIdFromLog,
  loadTranscriptFromFile,
  saveMode,
  searchSessionsByCustomTitle,
} from '../utils/sessionStorage.js'
import { computeInitialTeamContext } from '../utils/swarm/reconnection.js'
import { profileCheckpoint } from '../utils/startupProfiler.js'
import type { AgentColorName } from '@alice-cli/builtin-tools/tools/AgentTool/agentColorManager.js'
import { isCustomAgent } from '@alice-cli/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { LogOption } from '../types/logs.js'
import {
  logStartupTelemetry,
  logSessionTelemetry,
  maybeActivateProactive,
  maybeActivateBrief,
} from './mainHelpers.js'
import type { ActionContext } from './actionContext.js'

// Lazy require to avoid circular dependency: teammate.ts -> AppState.tsx -> ... -> main.tsx
/* eslint-disable @typescript-eslint/no-require-imports */
const getTeammateUtils = () =>
  require('../utils/teammate.js') as typeof import('../utils/teammate.js')
/* eslint-enable @typescript-eslint/no-require-imports */

export async function launchInteractiveSession(
  ctx: ActionContext,
): Promise<void> {
  const {
    options,
    debug,
    debugToStderr,
    ide,
    verbose,
    resolvedInitialModel,
    permissionModeNotification,
    overlyBroadBashPermissions,
    toolPermissionContext,
    initialMainLoopModel,
    kairosEnabled,
    assistantTeamContext,
    inputPrompt,
    mcpTools,
    mcpClients,
    mcpCommands,
    commands,
    agentDefinitions,
    cliAgents,
    currentCwd,
    disableSlashCommands,
    dynamicMcpConfig,
    strictMcpConfig,
    systemPrompt,
    appendSystemPrompt,
    taskListId,
    thinkingConfig,
    thinkingEnabled,
    effectiveModel,
    advisorModel,
    agentSetting,
    hooksPromise,
    hookMessages,
    remoteControl,
    remoteControlName,
    fileDownloadPromise,
    coordinatorModeModule,
    _pendingConnect,
    _pendingSSH,
    _pendingAssistantChat,
    teleport,
    remote,
    root,
    getFpsMetrics,
    stats,
    agentCli,
  } = ctx
  // mainThreadAgentDefinition is mutable in resume paths
  let { mainThreadAgentDefinition } = ctx

  // root, getFpsMetrics, stats are guaranteed to be set for interactive sessions
  const interactiveRoot = root!
  const interactiveGetFpsMetrics = getFpsMetrics!
  const interactiveStats = stats!

  // Log model config at startup
  logEvent('tengu_startup_manual_model_config', {
    cli_flag:
      options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    env_var: process.env
      .ANTHROPIC_MODEL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    settings_file: (getInitialSettings() || {})
      .model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    subscriptionType:
      getSubscriptionType() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    agent:
      agentSetting as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  // Get deprecation warning for the initial model (resolvedInitialModel computed earlier for hooks parallelization)
  const deprecationWarning = getModelDeprecationWarning(resolvedInitialModel)

  // Build initial notification queue
  const initialNotifications: Array<{
    key: string
    text: string
    color?: 'warning'
    priority: 'high'
  }> = []
  if (permissionModeNotification) {
    initialNotifications.push({
      key: 'permission-mode-notification',
      text: permissionModeNotification,
      priority: 'high',
    })
  }
  if (deprecationWarning) {
    initialNotifications.push({
      key: 'model-deprecation-warning',
      text: deprecationWarning,
      color: 'warning',
      priority: 'high',
    })
  }
  if (overlyBroadBashPermissions.length > 0) {
    const displayList = uniq(overlyBroadBashPermissions.map(p => p.ruleDisplay))
    const displays = displayList.join(', ')
    const sources = uniq(
      overlyBroadBashPermissions.map(p => p.sourceDisplay),
    ).join(', ')
    const n = displayList.length
    initialNotifications.push({
      key: 'overly-broad-bash-notification',
      text: `${displays} allow ${plural(n, 'rule')} from ${sources} ${plural(n, 'was', 'were')} ignored — not available for Ants, please use auto-mode instead`,
      color: 'warning',
      priority: 'high',
    })
  }

  const teammateUtils = getTeammateUtils()
  const effectiveToolPermissionContext = {
    ...toolPermissionContext,
    mode:
      isAgentSwarmsEnabled() && teammateUtils?.isPlanModeRequired?.()
        ? ('plan' as const)
        : toolPermissionContext.mode,
  }
  // All startup opt-in paths (--tools, --brief, defaultView) have fired
  // above; initialIsBriefOnly just reads the resulting state.
  const initialIsBriefOnly =
    feature('KAIROS') || feature('KAIROS_BRIEF') ? getUserMsgOptIn() : false
  const fullRemoteControl =
    remoteControl || getRemoteControlAtStartup() || kairosEnabled
  let ccrMirrorEnabled = false
  if (feature('CCR_MIRROR') && !fullRemoteControl) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isCcrMirrorEnabled } =
      require('../bridge/bridgeEnabled.js') as typeof import('../bridge/bridgeEnabled.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    ccrMirrorEnabled = isCcrMirrorEnabled()
  }

  const initialState: AppState = {
    settings: getInitialSettings(),
    tasks: {},
    agentNameRegistry: new Map(),
    verbose: verbose ?? getGlobalConfig().verbose ?? false,
    mainLoopModel: initialMainLoopModel,
    mainLoopModelForSession: null,
    isBriefOnly: initialIsBriefOnly,
    expandedView: getGlobalConfig().showSpinnerTree
      ? 'teammates'
      : getGlobalConfig().showExpandedTodos
        ? 'tasks'
        : 'none',
    showTeammateMessagePreview: isAgentSwarmsEnabled() ? false : undefined,
    selectedIPAgentIndex: -1,
    selectedBgAgentIndex: -1,
    coordinatorTaskIndex: -1,
    viewSelectionMode: 'none',
    footerSelection: null,
    toolPermissionContext: effectiveToolPermissionContext,
    agent: mainThreadAgentDefinition?.agentType,
    agentDefinitions,
    mcp: {
      clients: [],
      tools: [],
      commands: [],
      resources: {},
      pluginReconnectKey: 0,
    },
    plugins: {
      enabled: [],
      disabled: [],
      commands: [],
      errors: [],
      installationStatus: {
        marketplaces: [],
        plugins: [],
      },
      needsRefresh: false,
    },
    statusLineText: undefined,
    kairosEnabled,
    remoteSessionUrl: undefined,
    remoteConnectionStatus: 'connecting',
    remoteBackgroundTaskCount: 0,
    replBridgeEnabled: fullRemoteControl || ccrMirrorEnabled,
    replBridgeExplicit: remoteControl,
    replBridgeOutboundOnly: ccrMirrorEnabled,
    replBridgeConnected: false,
    replBridgeSessionActive: false,
    replBridgeReconnecting: false,
    replBridgeConnectUrl: undefined,
    replBridgeSessionUrl: undefined,
    replBridgeEnvironmentId: undefined,
    replBridgeSessionId: undefined,
    replBridgeError: undefined,
    replBridgeInitialName: remoteControlName,
    showRemoteCallout: false,
    notifications: {
      current: null,
      queue: initialNotifications,
    },
    elicitation: {
      queue: [],
    },
    todos: {},
    remoteAgentTaskSuggestions: [],
    fileHistory: {
      snapshots: [],
      trackedFiles: new Set(),
      snapshotSequence: 0,
    },
    attribution: createEmptyAttributionState(),
    thinkingEnabled,
    promptSuggestionEnabled: shouldEnablePromptSuggestion(),
    sessionHooks: new Map(),
    inbox: {
      messages: [],
    },
    promptSuggestion: {
      text: null,
      promptId: null,
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: null,
    },
    speculation: IDLE_SPECULATION_STATE,
    speculationSessionTimeSavedMs: 0,
    skillImprovement: {
      suggestion: null,
    },
    workerSandboxPermissions: {
      queue: [],
      selectedIndex: 0,
    },
    pendingWorkerRequest: null,
    pendingSandboxRequest: null,
    authVersion: 0,
    initialMessage: inputPrompt
      ? {
          message: createUserMessage({
            content: String(inputPrompt),
          }),
        }
      : null,
    effortValue: parseEffortValue(options.effort) ?? getInitialEffortSetting(),
    activeOverlays: new Set<string>(),
    fastMode: getInitialFastModeSetting(resolvedInitialModel),
    ...(isAdvisorEnabled() && advisorModel && { advisorModel }),
    // Compute teamContext synchronously to avoid useEffect setState during render.
    // KAIROS: assistantTeamContext takes precedence — set earlier in the
    // KAIROS block so Agent(name: "foo") can spawn in-process teammates
    // without TeamCreate. computeInitialTeamContext() is for tmux-spawned
    // teammates reading their own identity, not the assistant-mode leader.
    teamContext: (feature('KAIROS')
      ? (assistantTeamContext ?? computeInitialTeamContext())
      : computeInitialTeamContext()) as AppState['teamContext'],
  }

  // Add CLI initial prompt to history
  if (inputPrompt) {
    addToHistory(String(inputPrompt))
  }

  const initialTools = mcpTools

  // Increment numStartups synchronously — first-render readers like
  // shouldShowEffortCallout (via useState initializer) need the updated
  // value before setImmediate fires. Defer only telemetry.
  saveGlobalConfig(current => ({
    ...current,
    numStartups: (current.numStartups ?? 0) + 1,
  }))
  setImmediate(() => {
    void logStartupTelemetry()
    logSessionTelemetry()
  })

  // Set up per-turn session environment data uploader (ant-only build).
  // Default-enabled for all ant users when working in an Anthropic-owned
  // repo. Captures git/filesystem state (NOT transcripts) at each turn so
  // environments can be recreated at any user message index. Gating:
  //   - Build-time: this import is stubbed in external builds.
  //   - Runtime: uploader checks github.com/anthropics/* remote + gcloud auth.
  //   - Safety: CLAUDE_CODE_DISABLE_SESSION_DATA_UPLOAD=1 bypasses (tests set this).
  // Import is dynamic + async to avoid adding startup latency.
  const sessionUploaderPromise =
    process.env.USER_TYPE === 'ant'
      ? import('../utils/sessionDataUploader.js')
      : null

  // Defer session uploader resolution to the onTurnComplete callback to avoid
  // adding a new top-level await in main.tsx (performance-critical path).
  // The per-turn auth logic in sessionDataUploader.ts handles unauthenticated
  // state gracefully (re-checks each turn, so auth recovery mid-session works).
  const uploaderReady = sessionUploaderPromise
    ? sessionUploaderPromise
        .then(mod => mod.createSessionTurnUploader())
        .catch(() => null)
    : null

  const sessionConfig = {
    debug: debug || debugToStderr,
    commands: [...commands, ...mcpCommands],
    initialTools,
    mcpClients,
    autoConnectIdeFlag: ide,
    mainThreadAgentDefinition,
    disableSlashCommands,
    dynamicMcpConfig,
    strictMcpConfig,
    systemPrompt,
    appendSystemPrompt,
    taskListId,
    thinkingConfig,
    ...(uploaderReady && {
      onTurnComplete: (messages: MessageType[]) => {
        void uploaderReady.then(uploader =>
          (uploader as ((msgs: MessageType[]) => void) | null)?.(messages),
        )
      },
    }),
  }

  // Shared context for processResumedConversation calls
  const resumeContext = {
    modeApi: coordinatorModeModule,
    mainThreadAgentDefinition,
    agentDefinitions,
    currentCwd,
    cliAgents,
    initialState,
  }

  if (options.continue) {
    // Continue the most recent conversation directly
    let resumeSucceeded = false
    try {
      const resumeStart = performance.now()

      // Clear stale caches before resuming to ensure fresh file/skill discovery
      const { clearSessionCaches } = await import('../commands/clear/caches.js')
      clearSessionCaches()

      const result = await loadConversationForResume(
        undefined /* sessionId */,
        undefined /* sourceFile */,
      )
      if (!result) {
        logEvent('tengu_continue', {
          success: false,
        })
        return await exitWithError(
          interactiveRoot,
          'No conversation found to continue',
        )
      }

      const loaded = await processResumedConversation(
        result,
        {
          forkSession: !!options.forkSession,
          includeAttribution: true,
          transcriptPath: result.fullPath,
        },
        resumeContext,
      )

      if (loaded.restoredAgentDef) {
        mainThreadAgentDefinition = loaded.restoredAgentDef
      }

      maybeActivateProactive(options)
      maybeActivateBrief(options)

      logEvent('tengu_continue', {
        success: true,
        resume_duration_ms: Math.round(performance.now() - resumeStart),
      })
      resumeSucceeded = true

      await launchRepl(
        interactiveRoot,
        {
          getFpsMetrics: interactiveGetFpsMetrics,
          stats: interactiveStats,
          initialState: loaded.initialState,
        },
        {
          ...sessionConfig,
          mainThreadAgentDefinition:
            loaded.restoredAgentDef ?? mainThreadAgentDefinition,
          initialMessages: loaded.messages,
          initialFileHistorySnapshots: loaded.fileHistorySnapshots,
          initialContentReplacements: loaded.contentReplacements,
          initialAgentName: loaded.agentName,
          initialAgentColor: loaded.agentColor,
        },
        renderAndRun,
      )
    } catch (error) {
      if (!resumeSucceeded) {
        logEvent('tengu_continue', {
          success: false,
        })
      }
      logError(error)
      process.exit(1)
    }
  } else if (feature('DIRECT_CONNECT') && _pendingConnect?.url) {
    // `claude connect <url>` — full interactive TUI connected to a remote server
    let directConnectConfig
    try {
      const session = await createDirectConnectSession({
        serverUrl: _pendingConnect.url,
        authToken: _pendingConnect.authToken,
        cwd: getOriginalCwd(),
        dangerouslySkipPermissions: _pendingConnect.dangerouslySkipPermissions,
      })
      if (session.workDir) {
        setOriginalCwd(session.workDir)
        setCwdState(session.workDir)
      }
      setDirectConnectServerUrl(_pendingConnect.url)
      directConnectConfig = session.config
    } catch (err) {
      return await exitWithError(
        interactiveRoot,
        err instanceof DirectConnectError ? err.message : String(err),
        () => gracefulShutdown(1),
      )
    }

    const connectInfoMessage = createSystemMessage(
      `Connected to server at ${_pendingConnect.url}\nSession: ${directConnectConfig.sessionId}`,
      'info',
    )

    await launchRepl(
      interactiveRoot,
      {
        getFpsMetrics: interactiveGetFpsMetrics,
        stats: interactiveStats,
        initialState,
      },
      {
        debug: debug || debugToStderr,
        commands,
        initialTools: [],
        initialMessages: [connectInfoMessage],
        mcpClients: [],
        autoConnectIdeFlag: ide,
        mainThreadAgentDefinition,
        disableSlashCommands,
        directConnectConfig,
        thinkingConfig,
      },
      renderAndRun,
    )
    return
  } else if (feature('SSH_REMOTE') && _pendingSSH?.host) {
    // `claude ssh <host> [dir]` — probe remote, deploy binary if needed,
    // spawn ssh with unix-socket -R forward to a local auth proxy, hand
    // the REPL an SSHSession. Tools run remotely, UI renders locally.
    // `--local` skips probe/deploy/ssh and spawns the current binary
    // directly with the same env — e2e test of the proxy/auth plumbing.
    const { createSSHSession, createLocalSSHSession, SSHSessionError } =
      await import('../ssh/createSSHSession.js')
    let sshSession: import('../ssh/createSSHSession.js').SSHSession | undefined
    try {
      if (_pendingSSH.local) {
        process.stderr.write('Starting local ssh-proxy test session...\n')
        sshSession = await createLocalSSHSession({
          cwd: _pendingSSH.cwd,
          permissionMode: _pendingSSH.permissionMode,
          dangerouslySkipPermissions: _pendingSSH.dangerouslySkipPermissions,
        })
      } else {
        process.stderr.write(`Connecting to ${_pendingSSH.host}…\n`)
        // In-place progress: \r + EL0 (erase to end of line). Final \n on
        // success so the next message lands on a fresh line. No-op when
        // stderr isn't a TTY (piped/redirected) — \r would just emit noise.
        const isTTY = process.stderr.isTTY
        let hadProgress = false
        sshSession = await createSSHSession(
          {
            host: _pendingSSH.host,
            cwd: _pendingSSH.cwd,
            localVersion: MACRO.VERSION,
            permissionMode: _pendingSSH.permissionMode,
            dangerouslySkipPermissions: _pendingSSH.dangerouslySkipPermissions,
            extraCliArgs: _pendingSSH.extraCliArgs,
            remoteBin: _pendingSSH.remoteBin,
          },
          isTTY
            ? {
                onProgress: (msg: string) => {
                  hadProgress = true
                  process.stderr.write(`\r  ${msg}\x1b[K`)
                },
              }
            : {},
        )
        if (hadProgress) process.stderr.write('\n')
      }
      setOriginalCwd(sshSession.remoteCwd)
      setCwdState(sshSession.remoteCwd)
      setDirectConnectServerUrl(_pendingSSH.local ? 'local' : _pendingSSH.host)
    } catch (err) {
      return await exitWithError(
        interactiveRoot,
        err instanceof SSHSessionError ? err.message : String(err),
        () => gracefulShutdown(1),
      )
    }

    const sshInfoMessage = createSystemMessage(
      _pendingSSH.local
        ? `Local ssh-proxy test session\ncwd: ${sshSession.remoteCwd}\nAuth: unix socket → local proxy`
        : `SSH session to ${_pendingSSH.host}\nRemote cwd: ${sshSession.remoteCwd}\nAuth: unix socket -R → local proxy`,
      'info',
    )

    await launchRepl(
      interactiveRoot,
      {
        getFpsMetrics: interactiveGetFpsMetrics,
        stats: interactiveStats,
        initialState,
      },
      {
        debug: debug || debugToStderr,
        commands,
        initialTools: [],
        initialMessages: [sshInfoMessage],
        mcpClients: [],
        autoConnectIdeFlag: ide,
        mainThreadAgentDefinition,
        disableSlashCommands,
        sshSession,
        thinkingConfig,
      },
      renderAndRun,
    )
    return
  } else if (
    feature('KAIROS') &&
    _pendingAssistantChat &&
    (_pendingAssistantChat.sessionId || _pendingAssistantChat.discover)
  ) {
    // `claude assistant [sessionId]` — REPL as a pure viewer client
    // of a remote assistant session. The agentic loop runs remotely; this
    // process streams live events and POSTs messages. History is lazy-
    // loaded by useAssistantHistory on scroll-up (no blocking fetch here).
    const { discoverAssistantSessions } = await import(
      '../assistant/sessionDiscovery.js'
    )

    let targetSessionId = _pendingAssistantChat.sessionId

    // Discovery flow — list bridge environments, filter sessions
    if (!targetSessionId) {
      let sessions
      try {
        sessions = await discoverAssistantSessions()
      } catch (e) {
        return await exitWithError(
          interactiveRoot,
          `Failed to discover sessions: ${e instanceof Error ? e.message : e}`,
          () => gracefulShutdown(1),
        )
      }
      if (sessions.length === 0) {
        let installedDir: string | null
        try {
          installedDir = await launchAssistantInstallWizard(interactiveRoot)
        } catch (e) {
          return await exitWithError(
            interactiveRoot,
            `Assistant installation failed: ${e instanceof Error ? e.message : e}`,
            () => gracefulShutdown(1),
          )
        }
        if (installedDir === null) {
          await gracefulShutdown(0)
          process.exit(0)
        }
        // The daemon needs a few seconds to spin up its worker and
        // establish a bridge session before discovery will find it.
        return await exitWithMessage(
          interactiveRoot,
          `Assistant installed in ${installedDir}. The daemon is starting up — run \`claude assistant\` again in a few seconds to connect.`,
          {
            exitCode: 0,
            beforeExit: () => gracefulShutdown(0),
          },
        )
      }
      if (sessions.length === 1) {
        targetSessionId = sessions[0]!.id
      } else {
        const picked = await launchAssistantSessionChooser(interactiveRoot, {
          sessions,
        })
        if (!picked) {
          await gracefulShutdown(0)
          process.exit(0)
        }
        targetSessionId = picked
      }
    }

    // Auth — call prepareApiRequest() once for orgUUID, but use a
    // getAccessToken closure for the token so reconnects get fresh tokens.
    const { checkAndRefreshOAuthTokenIfNeeded, getClaudeAIOAuthTokens } =
      await import('../utils/auth.js')
    await checkAndRefreshOAuthTokenIfNeeded()
    let apiCreds
    try {
      apiCreds = await prepareApiRequest()
    } catch (e) {
      return await exitWithError(
        interactiveRoot,
        `Error: ${e instanceof Error ? e.message : 'Failed to authenticate'}`,
        () => gracefulShutdown(1),
      )
    }
    const getAccessToken = (): string =>
      getClaudeAIOAuthTokens()?.accessToken ?? apiCreds.accessToken

    // Brief mode activation: setKairosActive(true) satisfies BOTH opt-in
    // and entitlement for isBriefEnabled() (BriefTool.ts:124-132).
    setKairosActive(true)
    setUserMsgOptIn(true)
    setIsRemoteMode(true)

    const remoteSessionConfig = createRemoteSessionConfig(
      targetSessionId,
      getAccessToken,
      apiCreds.orgUUID,
      /* hasInitialPrompt */ false,
      /* viewerOnly */ true,
    )

    const infoMessage = createSystemMessage(
      `Attached to assistant session ${targetSessionId.slice(0, 8)}…`,
      'info',
    )

    const assistantInitialState: AppState = {
      ...initialState,
      isBriefOnly: true,
      kairosEnabled: false,
      replBridgeEnabled: false,
    }

    const remoteCommands = filterCommandsForRemoteMode(commands)
    await launchRepl(
      interactiveRoot,
      {
        getFpsMetrics: interactiveGetFpsMetrics,
        stats: interactiveStats,
        initialState: assistantInitialState,
      },
      {
        debug: debug || debugToStderr,
        commands: remoteCommands,
        initialTools: [],
        initialMessages: [infoMessage],
        mcpClients: [],
        autoConnectIdeFlag: ide,
        mainThreadAgentDefinition,
        disableSlashCommands,
        remoteSessionConfig,
        thinkingConfig,
      },
      renderAndRun,
    )
    return
  } else if (options.resume || options.fromPr || teleport || remote !== null) {
    // Handle resume flow - from file (ant-only), session ID, or interactive selector

    // Clear stale caches before resuming to ensure fresh file/skill discovery
    const { clearSessionCaches } = await import('../commands/clear/caches.js')
    clearSessionCaches()

    let messages: MessageType[] | null = null
    let processedResume: ProcessedResume | undefined

    let maybeSessionId = validateUuid(options.resume)
    let searchTerm: string | undefined
    // Store full LogOption when found by custom title (for cross-worktree resume)
    let matchedLog: LogOption | null = null
    // PR filter for --from-pr flag
    let filterByPr: boolean | number | string | undefined

    // Handle --from-pr flag
    if (options.fromPr) {
      if (options.fromPr === true) {
        // Show all sessions with linked PRs
        filterByPr = true
      } else if (typeof options.fromPr === 'string') {
        // Could be a PR number or URL
        filterByPr = options.fromPr
      }
    }

    // If resume value is not a UUID, try exact match by custom title first
    if (
      options.resume &&
      typeof options.resume === 'string' &&
      !maybeSessionId
    ) {
      const trimmedValue = options.resume.trim()
      if (trimmedValue) {
        const matches = await searchSessionsByCustomTitle(trimmedValue, {
          exact: true,
        })

        if (matches.length === 1) {
          // Exact match found - store full LogOption for cross-worktree resume
          matchedLog = matches[0]!
          maybeSessionId = getSessionIdFromLog(matchedLog) ?? null
        } else {
          // No match or multiple matches - use as search term for picker
          searchTerm = trimmedValue
        }
      }
    }

    // --remote and --teleport both create/resume Claude Code Web (CCR) sessions.
    // Remote Control (--rc) is a separate feature gated in initReplBridge.ts.
    if (remote !== null || teleport) {
      await waitForPolicyLimitsToLoad()
      if (!isPolicyAllowed('allow_remote_sessions')) {
        return await exitWithError(
          interactiveRoot,
          "Error: Remote sessions are disabled by your organization's policy.",
          () => gracefulShutdown(1),
        )
      }
    }

    if (remote !== null) {
      // Create remote session (optionally with initial prompt)
      const hasInitialPrompt = remote.length > 0

      // Check if TUI mode is enabled - description is only optional in TUI mode
      const isRemoteTuiEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_remote_backend',
        false,
      )
      if (!isRemoteTuiEnabled && !hasInitialPrompt) {
        return await exitWithError(
          interactiveRoot,
          'Error: --remote requires a description.\nUsage: claude --remote "your task description"',
          () => gracefulShutdown(1),
        )
      }

      logEvent('tengu_remote_create_session', {
        has_initial_prompt: String(
          hasInitialPrompt,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      // Pass current branch so CCR clones the repo at the right revision
      const currentBranch = await getBranch()
      const createdSession = await teleportToRemoteWithErrorHandling(
        interactiveRoot,
        hasInitialPrompt ? remote : null,
        new AbortController().signal,
        currentBranch || undefined,
      )
      if (!createdSession) {
        logEvent('tengu_remote_create_session_error', {
          error:
            'unable_to_create_session' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return await exitWithError(
          interactiveRoot,
          'Error: Unable to create remote session',
          () => gracefulShutdown(1),
        )
      }
      logEvent('tengu_remote_create_session_success', {
        session_id:
          createdSession.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      // Check if new remote TUI mode is enabled via feature gate
      if (!isRemoteTuiEnabled) {
        // Original behavior: print session info and exit
        process.stdout.write(
          `Created remote session: ${createdSession.title}\n`,
        )
        process.stdout.write(
          `View: ${getRemoteSessionUrl(createdSession.id)}?m=0\n`,
        )
        process.stdout.write(
          `Resume with: claude --teleport ${createdSession.id}\n`,
        )
        await gracefulShutdown(0)
        process.exit(0)
      }

      // New behavior: start local TUI with CCR engine
      // Mark that we're in remote mode for command visibility
      setIsRemoteMode(true)
      switchSession(asSessionId(createdSession.id))

      // Get OAuth credentials for remote session
      let apiCreds: { accessToken: string; orgUUID: string }
      try {
        apiCreds = await prepareApiRequest()
      } catch (error) {
        logError(toError(error))
        return await exitWithError(
          interactiveRoot,
          `Error: ${errorMessage(error) || 'Failed to authenticate'}`,
          () => gracefulShutdown(1),
        )
      }

      // Create remote session config for the REPL
      const { getClaudeAIOAuthTokens: getTokensForRemote } = await import(
        '../utils/auth.js'
      )
      const getAccessTokenForRemote = (): string =>
        getTokensForRemote()?.accessToken ?? apiCreds.accessToken
      const remoteSessionConfig = createRemoteSessionConfig(
        createdSession.id,
        getAccessTokenForRemote,
        apiCreds.orgUUID,
        hasInitialPrompt,
      )

      // Add remote session info as initial system message
      const remoteSessionUrl = `${getRemoteSessionUrl(createdSession.id)}?m=0`
      const remoteInfoMessage = createSystemMessage(
        `/remote-control is active. Code in CLI or at ${remoteSessionUrl}`,
        'info',
      )

      // Create initial user message from the prompt if provided (CCR echoes it back but we ignore that)
      const initialUserMessage = hasInitialPrompt
        ? createUserMessage({ content: remote })
        : null

      // Set remote session URL in app state for footer indicator
      const remoteInitialState = {
        ...initialState,
        remoteSessionUrl,
      }

      // Pre-filter commands to only include remote-safe ones.
      // CCR's init response may further refine the list (via handleRemoteInit in REPL).
      const remoteCommands = filterCommandsForRemoteMode(commands)
      await launchRepl(
        interactiveRoot,
        {
          getFpsMetrics: interactiveGetFpsMetrics,
          stats: interactiveStats,
          initialState: remoteInitialState,
        },
        {
          debug: debug || debugToStderr,
          commands: remoteCommands,
          initialTools: [],
          initialMessages: initialUserMessage
            ? [remoteInfoMessage, initialUserMessage]
            : [remoteInfoMessage],
          mcpClients: [],
          autoConnectIdeFlag: ide,
          mainThreadAgentDefinition,
          disableSlashCommands,
          remoteSessionConfig,
          thinkingConfig,
        },
        renderAndRun,
      )
      return
    } else if (teleport) {
      if (teleport === true || teleport === '') {
        // Interactive mode: show task selector and handle resume
        logEvent('tengu_teleport_interactive_mode', {})
        logForDebugging(
          'selectAndResumeTeleportTask: Starting teleport flow...',
        )
        const teleportResult =
          await launchTeleportResumeWrapper(interactiveRoot)
        if (!teleportResult) {
          // User cancelled or error occurred
          await gracefulShutdown(0)
          process.exit(0)
        }
        const { branchError } = await checkOutTeleportedSessionBranch(
          teleportResult.branch,
        )
        messages = processMessagesForTeleportResume(
          teleportResult.log,
          branchError,
        )
      } else if (typeof teleport === 'string') {
        logEvent('tengu_teleport_resume_session', {
          mode: 'direct' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        try {
          // First, fetch session and validate repository before checking git state
          const sessionData = await fetchSession(teleport)
          const repoValidation = await validateSessionRepository(sessionData)

          // Handle repo mismatch or not in repo cases
          if (
            repoValidation.status === 'mismatch' ||
            repoValidation.status === 'not_in_repo'
          ) {
            const sessionRepo = repoValidation.sessionRepo
            if (sessionRepo) {
              // Check for known paths
              const knownPaths = getKnownPathsForRepo(sessionRepo)
              const existingPaths = await filterExistingPaths(knownPaths)

              if (existingPaths.length > 0) {
                // Show directory switch dialog
                const selectedPath = await launchTeleportRepoMismatchDialog(
                  interactiveRoot,
                  {
                    targetRepo: sessionRepo,
                    initialPaths: existingPaths,
                  },
                )

                if (selectedPath) {
                  // Change to the selected directory
                  process.chdir(selectedPath)
                  setCwd(selectedPath)
                  setOriginalCwd(selectedPath)
                } else {
                  // User cancelled
                  await gracefulShutdown(0)
                }
              } else {
                // No known paths - show original error
                throw new TeleportOperationError(
                  `You must run claude --teleport ${teleport} from a checkout of ${sessionRepo}.`,
                  chalk.red(
                    `You must run claude --teleport ${teleport} from a checkout of ${chalk.bold(sessionRepo)}.\n`,
                  ),
                )
              }
            }
          } else if (repoValidation.status === 'error') {
            throw new TeleportOperationError(
              repoValidation.errorMessage || 'Failed to validate session',
              chalk.red(
                `Error: ${repoValidation.errorMessage || 'Failed to validate session'}\n`,
              ),
            )
          }

          await validateGitState()

          // Use progress UI for teleport
          const { teleportWithProgress } = await import(
            '../components/TeleportProgress.js'
          )
          const result = await teleportWithProgress(interactiveRoot, teleport)
          // Track teleported session for reliability logging
          setTeleportedSessionInfo({ sessionId: teleport })
          messages = result.messages
        } catch (error) {
          if (error instanceof TeleportOperationError) {
            process.stderr.write(error.formattedMessage + '\n')
          } else {
            logError(error)
            process.stderr.write(chalk.red(`Error: ${errorMessage(error)}\n`))
          }
          await gracefulShutdown(1)
        }
      }
    }
    if (process.env.USER_TYPE === 'ant') {
      if (
        options.resume &&
        typeof options.resume === 'string' &&
        !maybeSessionId
      ) {
        const resolvedPath = resolve(options.resume)
        try {
          const resumeStart = performance.now()
          let logOption
          try {
            // Attempt to load as a transcript file; ENOENT falls through to session-ID handling
            logOption = await loadTranscriptFromFile(resolvedPath)
          } catch (error) {
            if (!isENOENT(error)) throw error
            // ENOENT: not a file path — fall through to session-ID handling
          }
          if (logOption) {
            const result = await loadConversationForResume(
              logOption,
              undefined /* sourceFile */,
            )
            if (result) {
              processedResume = await processResumedConversation(
                result,
                {
                  forkSession: !!options.forkSession,
                  transcriptPath: result.fullPath,
                },
                resumeContext,
              )
              if (processedResume.restoredAgentDef) {
                mainThreadAgentDefinition = processedResume.restoredAgentDef
              }
              logEvent('tengu_session_resumed', {
                entrypoint:
                  'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                success: true,
                resume_duration_ms: Math.round(performance.now() - resumeStart),
              })
            } else {
              logEvent('tengu_session_resumed', {
                entrypoint:
                  'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                success: false,
              })
            }
          }
        } catch (error) {
          logEvent('tengu_session_resumed', {
            entrypoint:
              'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            success: false,
          })
          logError(error)
          await exitWithError(
            interactiveRoot,
            `Unable to load transcript from file: ${options.resume}`,
            () => gracefulShutdown(1),
          )
        }
      }
    }

    // If not loaded as a file, try as session ID
    if (maybeSessionId) {
      // Resume specific session by ID
      const sessionId = maybeSessionId
      try {
        const resumeStart = performance.now()
        // Use matchedLog if available (for cross-worktree resume by custom title)
        // Otherwise fall back to sessionId string (for direct UUID resume)
        const result = await loadConversationForResume(
          matchedLog ?? sessionId,
          undefined,
        )

        if (!result) {
          logEvent('tengu_session_resumed', {
            entrypoint:
              'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            success: false,
          })
          return await exitWithError(
            interactiveRoot,
            `No conversation found with session ID: ${sessionId}`,
          )
        }

        const fullPath = matchedLog?.fullPath ?? result.fullPath
        processedResume = await processResumedConversation(
          result,
          {
            forkSession: !!options.forkSession,
            sessionIdOverride: sessionId,
            transcriptPath: fullPath,
          },
          resumeContext,
        )

        if (processedResume.restoredAgentDef) {
          mainThreadAgentDefinition = processedResume.restoredAgentDef
        }
        logEvent('tengu_session_resumed', {
          entrypoint:
            'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          success: true,
          resume_duration_ms: Math.round(performance.now() - resumeStart),
        })
      } catch (error) {
        logEvent('tengu_session_resumed', {
          entrypoint:
            'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          success: false,
        })
        logError(error)
        await exitWithError(
          interactiveRoot,
          `Failed to resume session ${sessionId}`,
        )
      }
    }

    // Await file downloads before rendering REPL (files must be available)
    if (fileDownloadPromise) {
      try {
        const results = await fileDownloadPromise
        const failedCount = count(results, r => !r.success)
        if (failedCount > 0) {
          process.stderr.write(
            chalk.yellow(
              `Warning: ${failedCount}/${results.length} file(s) failed to download.\n`,
            ),
          )
        }
      } catch (error) {
        return await exitWithError(
          interactiveRoot,
          `Error downloading files: ${errorMessage(error)}`,
        )
      }
    }

    // If we have a processed resume or teleport messages, render the REPL
    const resumeData =
      processedResume ??
      (Array.isArray(messages)
        ? {
            messages,
            fileHistorySnapshots: undefined,
            agentName: undefined,
            agentColor: undefined as AgentColorName | undefined,
            restoredAgentDef: mainThreadAgentDefinition,
            initialState,
            contentReplacements: undefined,
          }
        : undefined)
    if (resumeData) {
      maybeActivateProactive(options)
      maybeActivateBrief(options)

      await launchRepl(
        interactiveRoot,
        {
          getFpsMetrics: interactiveGetFpsMetrics,
          stats: interactiveStats,
          initialState: resumeData.initialState,
        },
        {
          ...sessionConfig,
          mainThreadAgentDefinition:
            resumeData.restoredAgentDef ?? mainThreadAgentDefinition,
          initialMessages: resumeData.messages,
          initialFileHistorySnapshots: resumeData.fileHistorySnapshots,
          initialContentReplacements: resumeData.contentReplacements,
          initialAgentName: resumeData.agentName,
          initialAgentColor: resumeData.agentColor,
        },
        renderAndRun,
      )
    } else {
      // Show interactive selector (includes same-repo worktrees)
      // Note: ResumeConversation loads logs internally to ensure proper GC after selection
      await launchResumeChooser(
        interactiveRoot,
        {
          getFpsMetrics: interactiveGetFpsMetrics,
          stats: interactiveStats,
          initialState,
        },
        getWorktreePaths(getOriginalCwd()),
        {
          ...sessionConfig,
          initialSearchQuery: searchTerm,
          forkSession: options.forkSession,
          filterByPr,
        },
      )
    }
  } else {
    // Pass unresolved hooks promise to REPL so it can render immediately
    // instead of blocking ~500ms waiting for SessionStart hooks to finish.
    // REPL will inject hook messages when they resolve and await them before
    // the first API call so the model always sees hook context.
    const pendingHookMessages =
      hooksPromise && hookMessages.length === 0 ? hooksPromise : undefined

    profileCheckpoint('action_after_hooks')
    maybeActivateProactive(options)
    maybeActivateBrief(options)
    // Persist the current mode for fresh sessions so future resumes know what mode was used
    if (feature('COORDINATOR_MODE')) {
      saveMode(
        coordinatorModeModule?.isCoordinatorMode() ? 'coordinator' : 'normal',
      )
    }

    // If launched via a deep link, show a provenance banner so the user
    // knows the session originated externally. Linux xdg-open and
    // browsers with "always allow" set dispatch the link with no OS-level
    // confirmation, so this is the only signal the user gets that the
    // prompt — and the working directory / CLAUDE.md it implies — came
    // from an external source rather than something they typed.
    let deepLinkBanner: ReturnType<typeof createSystemMessage> | null = null
    if (feature('LODESTONE')) {
      if (options.deepLinkOrigin) {
        logEvent('tengu_deep_link_opened', {
          has_prefill: Boolean(options.prefill),
          has_repo: Boolean(options.deepLinkRepo),
        })
        deepLinkBanner = createSystemMessage(
          buildDeepLinkBanner({
            cwd: getCwd(),
            prefillLength: options.prefill?.length,
            repo: options.deepLinkRepo,
            lastFetch:
              options.deepLinkLastFetch !== undefined
                ? new Date(options.deepLinkLastFetch)
                : undefined,
          }),
          'warning',
        )
      } else if (options.prefill) {
        deepLinkBanner = createSystemMessage(
          'Launched with a pre-filled prompt — review it before pressing Enter.',
          'warning',
        )
      }
    }
    const initialMessages = deepLinkBanner
      ? [deepLinkBanner, ...hookMessages]
      : hookMessages.length > 0
        ? hookMessages
        : undefined

    await launchRepl(
      interactiveRoot,
      {
        getFpsMetrics: interactiveGetFpsMetrics,
        stats: interactiveStats,
        initialState,
      },
      {
        ...sessionConfig,
        initialMessages,
        pendingHookMessages,
      },
      renderAndRun,
    )
  }
}
