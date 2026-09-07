/**
 * Phase 2: setupPermissionsAndMcp
 *
 * From initialPermissionModeFromCLI through format validation checks.
 * Handles permission mode, MCP config parsing, tool permission context,
 * and format validation. Extracted from main.tsx .action() handler.
 */

import { feature } from 'bun:bundle'
import chalk from 'chalk'
import mapValues from 'lodash-es/mapValues.js'
import { resolve } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  type ChannelEntry,
  getIsNonInteractiveSession,
  setAdditionalDirectoriesForClaudeMd,
  setAllowedChannels,
  setChromeFlagOverride,
  setSessionBypassPermissionsMode,
  setUserMsgOptIn,
} from '../../bootstrap/state.js'
import {
  CLAUDE_IN_CHROME_SKILL_HINT,
  CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER,
} from '../../utils/claudeInChrome/prompt.js'
import {
  setupClaudeInChrome,
  shouldAutoEnableClaudeInChrome,
  shouldEnableClaudeInChrome,
} from '../../utils/claudeInChrome/setup.js'
import {
  CLAUDE_IN_CHROME_MCP_SERVER_NAME,
  isClaudeInChromeMCPServer,
} from 'src/utils/claudeInChrome/common.js'
import { isBareMode, isEnvTruthy } from '../../utils/envUtils.js'
import { getPlatform } from '../../utils/platform.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from '../../utils/log.js'
import { errorMessage } from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'
import { plural } from 'src/utils/stringUtils.js'
import { writeToStderr } from 'src/utils/process.js'
import type {
  McpServerConfig,
  McpSdkServerConfig,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import {
  areMcpConfigsAllowedWithEnterpriseMcpConfig,
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getClaudeCodeMcpConfigs,
  parseMcpConfig,
  parseMcpConfigFromFilePath,
} from 'src/services/mcp/config.js'
import { fetchClaudeAIMcpConfigsIfEligible } from 'src/services/mcp/claudeai.js'
import {
  initializeToolPermissionContext,
  initialPermissionModeFromCLI,
  isDefaultPermissionModeAuto,
  parseToolListFromCLI,
  removeDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
} from '../../utils/permissions/permissionSetup.js'
import type { DangerousPermissionInfo } from '../../utils/permissions/permissionSetup.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionMode } from '../../types/permissions.js'
import type { ValidationError } from '../../utils/settings/validation.js'
import type { ParsedOptions } from './parseOptions.js'

/**
 * Result of setupPermissionsAndMcp
 */
export type PermissionsAndMcpResult = {
  permissionMode: PermissionMode
  permissionModeNotification: string | undefined
  toolPermissionContext: ToolPermissionContext
  overlyBroadBashPermissions: DangerousPermissionInfo[]
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig>
  strictMcpConfig: boolean
  claudeaiConfigPromise: Promise<Record<string, ScopedMcpServerConfig>>
  mcpConfigPromise: Promise<{ servers: Record<string, ScopedMcpServerConfig> }>
  mcpConfigStart: number
  mcpConfigResolvedMs: number | undefined
  enableClaudeInChrome: boolean
  devChannels: ChannelEntry[] | undefined
  channelEntries: ChannelEntry[]
  // Updated prompt values (may have been modified by chrome/channel setup)
  allowedTools: string[]
  appendSystemPrompt: string | undefined
  remoteControlOption: string | true | undefined
}

export async function setupPermissionsAndMcp(
  parsed: ParsedOptions,
): Promise<PermissionsAndMcpResult> {
  const {
    permissionModeCli,
    dangerouslySkipPermissions,
    allowDangerouslySkipPermissions,
    allowedTools,
    disallowedTools,
    baseTools,
    mcpConfig,
    addDir,
    sdkUrl,
    isNonInteractiveSession,
    effectiveIncludePartialMessages,
    autoModeStateModule,
    options,
  } = parsed
  let { outputFormat, inputFormat, appendSystemPrompt } = parsed
  // allowedTools is an array that may be mutated (chrome tools pushed)
  const effectiveAllowedTools = [...allowedTools]

  const { mode: permissionMode, notification: permissionModeNotification } =
    initialPermissionModeFromCLI({
      permissionModeCli,
      dangerouslySkipPermissions,
    })

  // Store session bypass permissions mode for trust dialog check
  setSessionBypassPermissionsMode(permissionMode === 'bypassPermissions')
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (
      (options as { enableAutoMode?: boolean }).enableAutoMode ||
      permissionModeCli === 'auto' ||
      permissionMode === 'auto' ||
      (!permissionModeCli && isDefaultPermissionModeAuto())
    ) {
      autoModeStateModule?.setAutoModeFlagCli(true)
    }
  }

  // Parse the MCP config files/strings if provided
  let dynamicMcpConfig: Record<string, ScopedMcpServerConfig> = {
    // Built-in MCP servers (default disabled, user enables via /mcp)
    'mcp-chrome': {
      type: 'http',
      url: 'http://127.0.0.1:12306/mcp',
      scope: 'dynamic',
      headers: {
        Authorization: 'Bearer my-static-token',
      },
    },
  }

  if (mcpConfig && mcpConfig.length > 0) {
    const processedConfigs = mcpConfig
      .map((config: string) => config.trim())
      .filter((config: string) => config.length > 0)

    let allConfigs: Record<string, McpServerConfig> = {}
    const allErrors: ValidationError[] = []

    for (const configItem of processedConfigs) {
      let configs: Record<string, McpServerConfig> | null = null
      let errors: ValidationError[] = []

      const parsedJson = safeParseJSON(configItem)
      if (parsedJson) {
        const result = parseMcpConfig({
          configObject: parsedJson,
          filePath: 'command line',
          expandVars: true,
          scope: 'dynamic',
        })
        if (result.config) {
          configs = result.config.mcpServers
        } else {
          errors = result.errors
        }
      } else {
        const configPath = resolve(configItem)
        const result = parseMcpConfigFromFilePath({
          filePath: configPath,
          expandVars: true,
          scope: 'dynamic',
        })
        if (result.config) {
          configs = result.config.mcpServers
        } else {
          errors = result.errors
        }
      }

      if (errors.length > 0) {
        allErrors.push(...errors)
      } else if (configs) {
        allConfigs = { ...allConfigs, ...configs }
      }
    }

    if (allErrors.length > 0) {
      const formattedErrors = allErrors
        .map(err => `${err.path ? err.path + ': ' : ''}${err.message}`)
        .join('\n')
      logForDebugging(
        `--mcp-config validation failed (${allErrors.length} errors): ${formattedErrors}`,
        {
          level: 'error',
        },
      )
      process.stderr.write(
        `Error: Invalid MCP configuration:\n${formattedErrors}\n`,
      )
      process.exit(1)
    }

    if (Object.keys(allConfigs).length > 0) {
      const nonSdkConfigNames = Object.entries(allConfigs)
        .filter(([, config]) => config.type !== 'sdk')
        .map(([name]) => name)

      let reservedNameError: string | null = null
      if (nonSdkConfigNames.some(isClaudeInChromeMCPServer)) {
        reservedNameError = `Invalid MCP configuration: "${CLAUDE_IN_CHROME_MCP_SERVER_NAME}" is a reserved MCP name.`
      } else if (feature('CHICAGO_MCP')) {
        const { isComputerUseMCPServer, COMPUTER_USE_MCP_SERVER_NAME } =
          await import('src/utils/computerUse/common.js')
        if (nonSdkConfigNames.some(isComputerUseMCPServer)) {
          reservedNameError = `Invalid MCP configuration: "${COMPUTER_USE_MCP_SERVER_NAME}" is a reserved MCP name.`
        }
      }
      if (reservedNameError) {
        process.stderr.write(`Error: ${reservedNameError}\n`)
        process.exit(1)
      }

      const scopedConfigs = mapValues(allConfigs, config => ({
        ...config,
        scope: 'dynamic' as const,
      }))

      const { allowed, blocked } = filterMcpServersByPolicy(scopedConfigs)
      if (blocked.length > 0) {
        process.stderr.write(
          `Warning: MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`,
        )
      }
      dynamicMcpConfig = {
        ...dynamicMcpConfig,
        ...(allowed as Record<string, ScopedMcpServerConfig>),
      }
    }
  }

  // Extract Claude in Chrome option and enforce claude.ai subscriber check
  const chromeOpts = options as { chrome?: boolean }
  setChromeFlagOverride(chromeOpts.chrome)
  const enableClaudeInChrome =
    shouldEnableClaudeInChrome(chromeOpts.chrome) &&
    (process.env.USER_TYPE === 'ant' || isClaudeAISubscriber())
  const autoEnableClaudeInChrome =
    !enableClaudeInChrome && shouldAutoEnableClaudeInChrome()

  if (enableClaudeInChrome) {
    const platform = getPlatform()
    try {
      logEvent('tengu_claude_in_chrome_setup', {
        platform:
          platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      const {
        mcpConfig: chromeMcpConfig,
        allowedTools: chromeMcpTools,
        systemPrompt: chromeSystemPrompt,
      } = setupClaudeInChrome()
      dynamicMcpConfig = {
        ...dynamicMcpConfig,
        ...chromeMcpConfig,
      }
      effectiveAllowedTools.push(...chromeMcpTools)
      if (chromeSystemPrompt) {
        appendSystemPrompt = appendSystemPrompt
          ? `${chromeSystemPrompt}\n\n${appendSystemPrompt}`
          : chromeSystemPrompt
      }
    } catch (error) {
      logEvent('tengu_claude_in_chrome_setup_failed', {
        platform:
          platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logForDebugging(`[Claude in Chrome] Error: ${error}`)
      logError(error)
      console.error(`Error: Failed to run with Claude in Chrome.`)
      process.exit(1)
    }
  } else if (autoEnableClaudeInChrome) {
    try {
      const { mcpConfig: chromeMcpConfig } = setupClaudeInChrome()
      dynamicMcpConfig = {
        ...dynamicMcpConfig,
        ...chromeMcpConfig,
      }

      const hint =
        feature('WEB_BROWSER_TOOL') &&
        typeof Bun !== 'undefined' &&
        'WebView' in Bun
          ? CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER
          : CLAUDE_IN_CHROME_SKILL_HINT
      appendSystemPrompt = appendSystemPrompt
        ? `${appendSystemPrompt}\n\n${hint}`
        : hint
    } catch (error) {
      logForDebugging(`[Claude in Chrome] Error (auto-enable): ${error}`)
    }
  }

  // Extract strict MCP config flag
  const strictMcpConfig = options.strictMcpConfig || false

  // Check if enterprise MCP configuration exists
  if (doesEnterpriseMcpConfigExist()) {
    if (strictMcpConfig) {
      process.stderr.write(
        chalk.red(
          'You cannot use --strict-mcp-config when an enterprise MCP config is present',
        ),
      )
      process.exit(1)
    }

    if (
      dynamicMcpConfig &&
      !areMcpConfigsAllowedWithEnterpriseMcpConfig(dynamicMcpConfig)
    ) {
      process.stderr.write(
        chalk.red(
          'You cannot dynamically configure MCP servers when an enterprise MCP config is present',
        ),
      )
      process.exit(1)
    }
  }

  // chicago MCP
  if (
    feature('CHICAGO_MCP') &&
    getPlatform() !== 'unknown' &&
    !getIsNonInteractiveSession()
  ) {
    try {
      const { getChicagoEnabled } = await import(
        'src/utils/computerUse/gates.js'
      )
      if (getChicagoEnabled()) {
        const { setupComputerUseMCP } = await import(
          'src/utils/computerUse/setup.js'
        )
        const { mcpConfig: cuMcpConfig, allowedTools: cuTools } =
          setupComputerUseMCP()
        dynamicMcpConfig = {
          ...dynamicMcpConfig,
          ...cuMcpConfig,
        }
        effectiveAllowedTools.push(...cuTools)
      }
    } catch (error) {
      logForDebugging(`[Computer Use MCP] Setup failed: ${errorMessage(error)}`)
    }
  }

  // Store additional directories for CLAUDE.md loading
  setAdditionalDirectoriesForClaudeMd(addDir)

  // Channel server allowlist from --channels flag
  let devChannels: ChannelEntry[] | undefined
  const parseChannelEntries = (raw: string[], flag: string): ChannelEntry[] => {
    const entries: ChannelEntry[] = []
    const bad: string[] = []
    for (const c of raw) {
      if (c.startsWith('plugin:')) {
        const rest = c.slice(7)
        const at = rest.indexOf('@')
        if (at <= 0 || at === rest.length - 1) {
          bad.push(c)
        } else {
          entries.push({
            kind: 'plugin',
            name: rest.slice(0, at),
            marketplace: rest.slice(at + 1),
          })
        }
      } else if (c.startsWith('server:') && c.length > 7) {
        entries.push({ kind: 'server', name: c.slice(7) })
      } else {
        bad.push(c)
      }
    }
    if (bad.length > 0) {
      process.stderr.write(
        chalk.red(
          `${flag} entries must be tagged: ${bad.join(', ')}\n` +
            `  plugin:<name>@<marketplace>  — plugin-provided channel (allowlist enforced)\n` +
            `  server:<name>                — manually configured MCP server\n`,
        ),
      )
      process.exit(1)
    }
    return entries
  }

  const channelOpts = options as {
    channels?: string[]
    dangerouslyLoadDevelopmentChannels?: string[]
  }
  const rawChannels = channelOpts.channels
  const rawDev = channelOpts.dangerouslyLoadDevelopmentChannels
  let channelEntries: ChannelEntry[] = []
  if (rawChannels && rawChannels.length > 0) {
    channelEntries = parseChannelEntries(rawChannels, '--channels')
    setAllowedChannels(channelEntries)
  }
  if (!isNonInteractiveSession) {
    if (rawDev && rawDev.length > 0) {
      devChannels = parseChannelEntries(
        rawDev,
        '--dangerously-load-development-channels',
      )
    }
  }
  if (channelEntries.length > 0 || (devChannels?.length ?? 0) > 0) {
    const joinPluginIds = (entries: ChannelEntry[]) => {
      const ids = entries.flatMap(e =>
        e.kind === 'plugin' ? [`${e.name}@${e.marketplace}`] : [],
      )
      return ids.length > 0
        ? (ids
            .sort()
            .join(
              ',',
            ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
        : undefined
    }
    logEvent('tengu_mcp_channel_flags', {
      channels_count: channelEntries.length,
      dev_count: devChannels?.length ?? 0,
      plugins: joinPluginIds(channelEntries),
      dev_plugins: joinPluginIds(devChannels ?? []),
    })
  }

  // SDK opt-in for SendUserMessage via --tools
  if ((feature('KAIROS') || feature('KAIROS_BRIEF')) && baseTools.length > 0) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { BRIEF_TOOL_NAME, LEGACY_BRIEF_TOOL_NAME } =
      require('@alice-cli/builtin-tools/tools/BriefTool/prompt.js') as typeof import('@alice-cli/builtin-tools/tools/BriefTool/prompt.js')
    const { isBriefEntitled } =
      require('@alice-cli/builtin-tools/tools/BriefTool/BriefTool.js') as typeof import('@alice-cli/builtin-tools/tools/BriefTool/BriefTool.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const toolsParsed = parseToolListFromCLI(baseTools)
    if (
      (toolsParsed.includes(BRIEF_TOOL_NAME) ||
        toolsParsed.includes(LEGACY_BRIEF_TOOL_NAME)) &&
      isBriefEntitled()
    ) {
      setUserMsgOptIn(true)
    }
  }

  // Initialize tool permission context
  const initResult = await initializeToolPermissionContext({
    allowedToolsCli: effectiveAllowedTools,
    disallowedToolsCli: disallowedTools,
    baseToolsCli: baseTools,
    permissionMode,
    allowDangerouslySkipPermissions,
    addDirs: addDir,
  })
  let toolPermissionContext = initResult.toolPermissionContext
  const { warnings, dangerousPermissions, overlyBroadBashPermissions } =
    initResult

  // Handle overly broad shell allow rules for ant users
  if (
    process.env.USER_TYPE === 'ant' &&
    overlyBroadBashPermissions.length > 0
  ) {
    for (const permission of overlyBroadBashPermissions) {
      logForDebugging(
        `Ignoring overly broad shell permission ${permission.ruleDisplay} from ${permission.sourceDisplay}`,
      )
    }
    toolPermissionContext = removeDangerousPermissions(
      toolPermissionContext,
      overlyBroadBashPermissions,
    )
  }

  if (feature('TRANSCRIPT_CLASSIFIER') && dangerousPermissions.length > 0) {
    toolPermissionContext = stripDangerousPermissionsForAutoMode(
      toolPermissionContext,
    )
  }

  // Print any warnings from initialization
  warnings.forEach(warning => {
    console.error(warning)
  })

  // claude.ai config fetch
  const claudeaiConfigPromise: Promise<Record<string, ScopedMcpServerConfig>> =
    isNonInteractiveSession &&
    !strictMcpConfig &&
    !doesEnterpriseMcpConfigExist() &&
    !isBareMode()
      ? fetchClaudeAIMcpConfigsIfEligible().then(configs => {
          const { allowed, blocked } = filterMcpServersByPolicy(configs)
          if (blocked.length > 0) {
            process.stderr.write(
              `Warning: claude.ai MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`,
            )
          }
          return allowed
        })
      : Promise.resolve({})

  // Kick off MCP config loading early
  logForDebugging('[STARTUP] Loading MCP configs...')
  const mcpConfigStart = Date.now()
  let mcpConfigResolvedMs: number | undefined
  const mcpConfigPromise = (
    strictMcpConfig || isBareMode()
      ? Promise.resolve({
          servers: {} as Record<string, ScopedMcpServerConfig>,
        })
      : getClaudeCodeMcpConfigs(dynamicMcpConfig)
  ).then(result => {
    mcpConfigResolvedMs = Date.now() - mcpConfigStart
    return result
  })

  // Format validation
  if (inputFormat && inputFormat !== 'text' && inputFormat !== 'stream-json') {
    console.error(`Error: Invalid input format "${inputFormat}".`)
    process.exit(1)
  }
  if (inputFormat === 'stream-json' && outputFormat !== 'stream-json') {
    console.error(
      `Error: --input-format=stream-json requires output-format=stream-json.`,
    )
    process.exit(1)
  }

  // Validate sdkUrl is only used with appropriate formats
  if (sdkUrl) {
    if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
      console.error(
        `Error: --sdk-url requires both --input-format=stream-json and --output-format=stream-json.`,
      )
      process.exit(1)
    }
  }

  // Validate replayUserMessages is only used with stream-json formats
  if (options.replayUserMessages) {
    if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
      console.error(
        `Error: --replay-user-messages requires both --input-format=stream-json and --output-format=stream-json.`,
      )
      process.exit(1)
    }
  }

  // Validate includePartialMessages is only used with print mode and stream-json output
  if (effectiveIncludePartialMessages) {
    if (!isNonInteractiveSession || outputFormat !== 'stream-json') {
      writeToStderr(
        `Error: --include-partial-messages requires --print and --output-format=stream-json.`,
      )
      process.exit(1)
    }
  }

  // Validate --no-session-persistence is only used with print mode
  if (options.sessionPersistence === false && !isNonInteractiveSession) {
    writeToStderr(
      `Error: --no-session-persistence can only be used with --print mode.`,
    )
    process.exit(1)
  }

  return {
    permissionMode,
    permissionModeNotification,
    toolPermissionContext,
    overlyBroadBashPermissions,
    dynamicMcpConfig,
    strictMcpConfig,
    claudeaiConfigPromise,
    mcpConfigPromise,
    mcpConfigStart,
    mcpConfigResolvedMs,
    enableClaudeInChrome,
    devChannels,
    channelEntries,
    allowedTools: effectiveAllowedTools,
    appendSystemPrompt,
    remoteControlOption: parsed.remoteControlOption,
  }
}
