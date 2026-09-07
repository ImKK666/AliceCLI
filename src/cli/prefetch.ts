import { getSystemContext, getUserContext } from '../context.js'
import { isEnvTruthy, isBareMode } from '../utils/envUtils.js'
import {
  prefetchAwsCredentialsAndBedRockInfoIfSafe,
  prefetchGcpCredentialsIfSafe,
} from '../utils/auth.js'
import { checkHasTrustDialogAccepted } from '../utils/config.js'
import { countFilesRoundedRg } from '../utils/ripgrep.js'
import { getCwd } from '../utils/cwd.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { initializeAnalyticsGates } from 'src/services/analytics/sink.js'
import { getRelevantTips } from 'src/services/tips/tipRegistry.js'
import { initUser } from '../utils/user.js'
import { refreshModelCapabilities } from '../utils/model/modelCapabilities.js'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import { skillChangeDetector } from '../utils/skills/skillChangeDetector.js'

function prefetchSystemContextIfSafe(): void {
  const isNonInteractiveSession = getIsNonInteractiveSession()

  if (isNonInteractiveSession) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_non_interactive')
    void getSystemContext()
    return
  }

  const hasTrust = checkHasTrustDialogAccepted()
  if (hasTrust) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_has_trust')
    void getSystemContext()
  } else {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_skipped_no_trust')
  }
}

export function startDeferredPrefetches(): void {
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER) ||
    isBareMode()
  ) {
    return
  }

  void initUser()
  void getUserContext()
  prefetchSystemContextIfSafe()
  void getRelevantTips()
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) &&
    !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)
  ) {
    void prefetchAwsCredentialsAndBedRockInfoIfSafe()
  }
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) &&
    !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)
  ) {
    void prefetchGcpCredentialsIfSafe()
  }
  void countFilesRoundedRg(getCwd(), AbortSignal.timeout(3000), [])

  void initializeAnalyticsGates()

  void refreshModelCapabilities()

  void settingsChangeDetector.initialize()
  if (!isBareMode()) {
    void skillChangeDetector.initialize()
  }

  if (process.env.USER_TYPE === 'ant') {
    void import('../utils/eventLoopStallDetector.js').then(m =>
      m.startEventLoopStallDetector(),
    )
  }
}
