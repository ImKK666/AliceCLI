import { feature } from 'bun:bundle'
import { relative } from 'path'
import { isAnalyticsDisabled } from 'src/services/analytics/config.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getCwd } from 'src/utils/cwd.js'
import {
  getInitialMainLoopModel,
  getSdkBetas,
  setUserMsgOptIn,
} from '../bootstrap/state.js'
import { getContextWindowForModel } from '../utils/context.js'
import {
  hasNodeOption,
  isBareMode,
  isEnvTruthy,
  isInProtectedNamespace,
} from '../utils/envUtils.js'
import { findGitRoot, getIsGit, getWorktreeCount } from '../utils/git.js'
import { getGhAuthStatus } from '../utils/github/ghAuthStatus.js'
import { logError } from '../utils/log.js'
import {
  getDefaultMainLoopModel,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import { isAutoUpdaterDisabled } from '../utils/config.js'
import { getManagedPluginNames } from '../utils/plugins/managedPlugins.js'
import { getPluginSeedDirs } from '../utils/plugins/pluginDirectories.js'
import { loadAllPluginsCacheOnly } from '../utils/plugins/pluginLoader.js'
import { SandboxManager } from '../utils/sandbox/sandbox-adapter.js'
import {
  getInitialSettings,
  getManagedSettingsKeysForLogging,
  getSettingsForSource,
} from '../utils/settings/settings.js'
import {
  logPluginLoadErrors,
  logPluginsEnabledForSession,
} from '../utils/telemetry/pluginTelemetry.js'
import { logSkillsLoaded } from '../utils/telemetry/skillLoadedEvent.js'
import type { ThinkingConfig } from '../utils/thinking.js'

/**
 * Log managed settings keys to Statsig for analytics.
 * This is called after init() completes to ensure settings are loaded
 * and environment variables are applied before model resolution.
 */
export function logManagedSettings(): void {
  try {
    const policySettings = getSettingsForSource('policySettings')
    if (policySettings) {
      const allKeys = getManagedSettingsKeysForLogging(policySettings)
      logEvent('tengu_managed_settings_loaded', {
        keyCount: allKeys.length,
        keys: allKeys.join(
          ',',
        ) as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  } catch {
    // Silently ignore errors - this is just for analytics
  }
}

/**
 * Per-session skill/plugin telemetry. Called from both the interactive path
 * and the headless -p path (before runHeadless) -- both go through
 * main.tsx but branch before the interactive startup path, so it needs two
 * call sites here rather than one here + one in QueryEngine.
 */
export function logSessionTelemetry(): void {
  const model = parseUserSpecifiedModel(
    getInitialMainLoopModel() ?? getDefaultMainLoopModel(),
  )
  void logSkillsLoaded(getCwd(), getContextWindowForModel(model, getSdkBetas()))
  void loadAllPluginsCacheOnly()
    .then(({ enabled, errors }) => {
      const managedNames = getManagedPluginNames()
      logPluginsEnabledForSession(enabled, managedNames, getPluginSeedDirs())
      logPluginLoadErrors(errors, managedNames)
    })
    .catch(err => logError(err))
}

export function getCertEnvVarTelemetry(): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  if (process.env.NODE_EXTRA_CA_CERTS) {
    result.has_node_extra_ca_certs = true
  }
  if (process.env.CLAUDE_CODE_CLIENT_CERT) {
    result.has_client_cert = true
  }
  if (hasNodeOption('--use-system-ca')) {
    result.has_use_system_ca = true
  }
  if (hasNodeOption('--use-openssl-ca')) {
    result.has_use_openssl_ca = true
  }
  return result
}

export async function logStartupTelemetry(): Promise<void> {
  if (isAnalyticsDisabled()) return
  const [isGit, worktreeCount, ghAuthStatus] = await Promise.all([
    getIsGit(),
    getWorktreeCount(),
    getGhAuthStatus(),
  ])

  logEvent('tengu_startup_telemetry', {
    is_git: isGit,
    worktree_count: worktreeCount,
    gh_auth_status:
      ghAuthStatus as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    sandbox_enabled: SandboxManager.isSandboxingEnabled(),
    are_unsandboxed_commands_allowed:
      SandboxManager.areUnsandboxedCommandsAllowed(),
    is_auto_bash_allowed_if_sandbox_enabled:
      SandboxManager.isAutoAllowBashIfSandboxedEnabled(),
    auto_updater_disabled: isAutoUpdaterDisabled(),
    prefers_reduced_motion: getInitialSettings().prefersReducedMotion ?? false,
    ...getCertEnvVarTelemetry(),
  })
}

export async function logTenguInit({
  hasInitialPrompt,
  hasStdin,
  verbose,
  debug,
  debugToStderr,
  print,
  outputFormat,
  inputFormat,
  numAllowedTools,
  numDisallowedTools,
  mcpClientCount,
  worktreeEnabled,
  skipWebFetchPreflight,
  githubActionInputs,
  dangerouslySkipPermissionsPassed,
  permissionMode,
  modeIsBypass,
  allowDangerouslySkipPermissionsPassed,
  systemPromptFlag,
  appendSystemPromptFlag,
  thinkingConfig,
  assistantActivationPath,
  coordinatorModeModule,
}: {
  hasInitialPrompt: boolean
  hasStdin: boolean
  verbose: boolean
  debug: boolean
  debugToStderr: boolean
  print: boolean
  outputFormat: string
  inputFormat: string
  numAllowedTools: number
  numDisallowedTools: number
  mcpClientCount: number
  worktreeEnabled: boolean
  skipWebFetchPreflight: boolean | undefined
  githubActionInputs: string | undefined
  dangerouslySkipPermissionsPassed: boolean
  permissionMode: string
  modeIsBypass: boolean
  allowDangerouslySkipPermissionsPassed: boolean
  systemPromptFlag: 'file' | 'flag' | undefined
  appendSystemPromptFlag: 'file' | 'flag' | undefined
  thinkingConfig: ThinkingConfig
  assistantActivationPath: string | undefined
  coordinatorModeModule: { isCoordinatorMode(): boolean } | null
}): Promise<void> {
  try {
    logEvent('tengu_init', {
      entrypoint:
        'claude' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      hasInitialPrompt,
      hasStdin,
      verbose,
      debug,
      debugToStderr,
      print,
      outputFormat:
        outputFormat as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      inputFormat:
        inputFormat as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      numAllowedTools,
      numDisallowedTools,
      mcpClientCount,
      worktree: worktreeEnabled,
      skipWebFetchPreflight,
      ...(githubActionInputs && {
        githubActionInputs:
          githubActionInputs as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      dangerouslySkipPermissionsPassed,
      permissionMode:
        permissionMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      modeIsBypass,
      inProtectedNamespace: isInProtectedNamespace(),
      allowDangerouslySkipPermissionsPassed,
      thinkingType:
        thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(thinkingConfig.type === 'enabled' && {
        thinkingBudgetTokens: thinkingConfig.budgetTokens,
      }),
      ...(systemPromptFlag && {
        systemPromptFlag:
          systemPromptFlag as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(appendSystemPromptFlag && {
        appendSystemPromptFlag:
          appendSystemPromptFlag as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      is_simple: isBareMode() || undefined,
      is_coordinator:
        feature('COORDINATOR_MODE') &&
        coordinatorModeModule?.isCoordinatorMode()
          ? true
          : undefined,
      ...(assistantActivationPath && {
        assistantActivationPath:
          assistantActivationPath as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      autoUpdatesChannel: (getInitialSettings().autoUpdatesChannel ??
        'latest') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(process.env.USER_TYPE === 'ant'
        ? (() => {
            const cwd = getCwd()
            const gitRoot = findGitRoot(cwd)
            const rp = gitRoot ? relative(gitRoot, cwd) || '.' : undefined
            return rp
              ? {
                  relativeProjectPath:
                    rp as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                }
              : {}
          })()
        : {}),
    })
  } catch (error) {
    logError(error)
  }
}

export function maybeActivateProactive(options: unknown): void {
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    ((options as { proactive?: boolean }).proactive ||
      isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE))
  ) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const proactiveModule = require('../proactive/index.js')
    if (!proactiveModule.isProactiveActive()) {
      proactiveModule.activateProactive('command')
    }
  }
}

export function maybeActivateBrief(options: unknown): void {
  if (!(feature('KAIROS') || feature('KAIROS_BRIEF'))) return
  const briefFlag = (options as { brief?: boolean }).brief
  const briefEnv = isEnvTruthy(process.env.CLAUDE_CODE_BRIEF)
  if (!briefFlag && !briefEnv) return
  // --brief / CLAUDE_CODE_BRIEF are explicit opt-ins: check entitlement,
  // then set userMsgOptIn to activate the tool + prompt section. The env
  // var also grants entitlement (isBriefEntitled() reads it), so setting
  // CLAUDE_CODE_BRIEF=1 alone force-enables for dev/testing -- no GB gate
  // needed. initialIsBriefOnly reads getUserMsgOptIn() directly.
  // Conditional require: static import would leak the tool name string
  // into external builds via BriefTool.ts -> prompt.ts.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { isBriefEntitled } =
    require('@alice-cli/builtin-tools/tools/BriefTool/BriefTool.js') as typeof import('@alice-cli/builtin-tools/tools/BriefTool/BriefTool.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const entitled = isBriefEntitled()
  if (entitled) {
    setUserMsgOptIn(true)
  }
  // Fire unconditionally once intent is seen: enabled=false captures the
  // "user tried but was gated" failure mode in Datadog.
  logEvent('tengu_brief_mode_enabled', {
    enabled: entitled,
    gated: !entitled,
    source: (briefEnv
      ? 'env'
      : 'flag') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

export type TeammateOptions = {
  agentId?: string
  agentName?: string
  teamName?: string
  agentColor?: string
  planModeRequired?: boolean
  parentSessionId?: string
  teammateMode?: 'auto' | 'tmux' | 'in-process'
  agentType?: string
}

export function extractTeammateOptions(options: unknown): TeammateOptions {
  if (typeof options !== 'object' || options === null) {
    return {}
  }
  const opts = options as Record<string, unknown>
  const teammateMode = opts.teammateMode
  return {
    agentId: typeof opts.agentId === 'string' ? opts.agentId : undefined,
    agentName: typeof opts.agentName === 'string' ? opts.agentName : undefined,
    teamName: typeof opts.teamName === 'string' ? opts.teamName : undefined,
    agentColor:
      typeof opts.agentColor === 'string' ? opts.agentColor : undefined,
    planModeRequired:
      typeof opts.planModeRequired === 'boolean'
        ? opts.planModeRequired
        : undefined,
    parentSessionId:
      typeof opts.parentSessionId === 'string'
        ? opts.parentSessionId
        : undefined,
    teammateMode:
      teammateMode === 'auto' ||
      teammateMode === 'tmux' ||
      teammateMode === 'in-process'
        ? teammateMode
        : undefined,
    agentType: typeof opts.agentType === 'string' ? opts.agentType : undefined,
  }
}
