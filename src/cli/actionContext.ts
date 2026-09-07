/**
 * ActionContext — captures all local variables computed in the .action() setup
 * code that the headless and interactive session paths need.
 *
 * Extracted from main.tsx Phase B Step 1.
 */

import type { Root } from '@anthropic/ink'
import type { AgentDefinitionsResult } from '@alice-cli/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { AgentColorName } from '@alice-cli/builtin-tools/tools/AgentTool/agentColorManager.js'
import type { DownloadResult } from '../services/api/filesApi.js'
import type {
  MCPServerConnection,
  McpSdkServerConfig,
  ScopedMcpServerConfig,
} from '../services/mcp/types.js'
import type { AppState } from '../state/AppStateStore.js'
import type {
  ToolInputJSONSchema,
  Tool,
  Tools,
  ToolPermissionContext,
} from '../Tool.js'
import type { Command } from '../types/command.js'
import type { HookResultMessage } from '../types/message.js'
import type { Message as MessageType } from '../types/message.js'
import type { StatsStore } from '../context/stats.js'
import type { FpsMetrics } from '../utils/fpsTracker.js'
import type { ThinkingConfig } from '../utils/thinking.js'
import type { DangerousPermissionInfo } from '../utils/permissions/permissionSetup.js'
import type { ChannelEntry } from '../bootstrap/state.js'
import type { TeammateOptions } from './mainHelpers.js'

// Re-export types used in PendingConnect/PendingSSH/PendingAssistantChat
export type PendingConnect = {
  url: string | undefined
  authToken: string | undefined
  dangerouslySkipPermissions: boolean
}

export type PendingAssistantChat = { sessionId?: string; discover: boolean }

export type PendingSSH = {
  host: string | undefined
  cwd: string | undefined
  permissionMode: string | undefined
  dangerouslySkipPermissions: boolean
  /** --local: spawn the child CLI directly, skip ssh/probe/deploy. e2e test mode. */
  local: boolean
  /** Extra CLI args to forward to the remote CLI on initial spawn (--resume, -c). */
  extraCliArgs: string[]
  remoteBin: string | undefined
}

/**
 * The full options object from Commander. Typed as a broad record since the
 * actual type is inferred from the option chain and accessed via type
 * assertions throughout the codebase.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ActionOptions = Record<string, any>

/**
 * Captures all local variables that flow from the .action() setup code
 * into the headless or interactive session paths.
 */
export type ActionContext = {
  // ── Options (raw or extracted) ───────────────────────────────────────
  options: ActionOptions
  prompt: string | undefined
  debug: boolean
  debugToStderr: boolean
  dangerouslySkipPermissions: boolean | undefined
  allowDangerouslySkipPermissions: boolean
  allowedTools: string[]
  disallowedTools: string[]
  betas: string[]
  ide: boolean
  sessionId: string | undefined
  verbose: boolean | undefined
  print: boolean | undefined
  outputFormat: string | undefined
  inputFormat: string | undefined
  disableSlashCommands: boolean
  strictMcpConfig: boolean
  agentCli: string | undefined
  agentSetting: string | undefined

  // ── Computed values ──────────────────────────────────────────────────
  isNonInteractiveSession: boolean
  inputPrompt: string | AsyncIterable<string>
  effectiveModel: string | undefined
  userSpecifiedFallbackModel: string | undefined
  effectiveReplayUserMessages: boolean
  effectiveIncludePartialMessages: boolean
  sdkUrl: string | undefined
  teleport: string | true | null
  remote: string | null
  remoteControl: boolean
  remoteControlName: string | undefined
  currentCwd: string
  taskListId: string | undefined
  setupTrigger: 'init' | 'maintenance' | null
  sessionNameArg: string | undefined

  // ── Thinking ─────────────────────────────────────────────────────────
  thinkingEnabled: boolean
  thinkingConfig: ThinkingConfig

  // ── Schema ───────────────────────────────────────────────────────────
  jsonSchema: ToolInputJSONSchema | undefined

  // ── Prompts ──────────────────────────────────────────────────────────
  systemPrompt: string | undefined
  appendSystemPrompt: string | undefined

  // ── Permissions ──────────────────────────────────────────────────────
  permissionMode: string
  permissionModeNotification: string | undefined
  toolPermissionContext: ToolPermissionContext
  overlyBroadBashPermissions: DangerousPermissionInfo[]

  // ── Tools ────────────────────────────────────────────────────────────
  tools: Tools

  // ── Commands and agents ──────────────────────────────────────────────
  commands: Command[]
  agentDefinitions: AgentDefinitionsResult
  cliAgents: AgentDefinitionsResult['activeAgents']
  mainThreadAgentDefinition:
    | AgentDefinitionsResult['activeAgents'][number]
    | undefined

  // ── Model ────────────────────────────────────────────────────────────
  initialMainLoopModel: string | null
  resolvedInitialModel: string
  advisorModel: string | undefined
  kairosEnabled: boolean
  assistantTeamContext:
    | Awaited<
        ReturnType<
          NonNullable<
            typeof import('../assistant/index.js')
          >['initializeAssistantTeam']
        >
      >
    | undefined

  // ── MCP ──────────────────────────────────────────────────────────────
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig>
  regularMcpConfigs: Record<string, ScopedMcpServerConfig>
  sdkMcpConfigs: Record<string, McpSdkServerConfig>
  claudeaiConfigPromise: Promise<Record<string, ScopedMcpServerConfig>>
  /** Already-connected MCP clients (empty arrays in practice — populated later) */
  mcpClients: MCPServerConnection[]
  mcpTools: Tool[]
  mcpCommands: Command[]

  // ── Hooks ────────────────────────────────────────────────────────────
  hooksPromise: Promise<HookResultMessage[]> | null
  hookMessages: HookResultMessage[]

  // ── UI (interactive only) ────────────────────────────────────────────
  root?: Root
  getFpsMetrics?: () => FpsMetrics | undefined
  stats?: StatsStore

  // ── File downloads ───────────────────────────────────────────────────
  fileDownloadPromise?: Promise<DownloadResult[]>

  // ── Teammate ─────────────────────────────────────────────────────────
  storedTeammateOpts?: TeammateOptions

  // ── Module-scope conditional requires ────────────────────────────────
  coordinatorModeModule:
    | typeof import('../coordinator/coordinatorMode.js')
    | null

  // ── Module-scope pendingXxx vars ─────────────────────────────────────
  _pendingConnect: PendingConnect | undefined
  _pendingSSH: PendingSSH | undefined
  _pendingAssistantChat: PendingAssistantChat | undefined
}
