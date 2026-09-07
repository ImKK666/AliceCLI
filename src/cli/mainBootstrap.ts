import chalk from 'chalk'
import { readFileSync } from 'fs'
import { SHOW_CURSOR } from '@anthropic/ink'
import { profileCheckpoint } from '../utils/startupProfiler.js'
import { eagerParseCliFlag } from '../utils/cliArgs.js'
import { errorMessage, isENOENT } from '../utils/errors.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { getFsImplementation, safeResolvePath } from '../utils/fsOperations.js'
import { safeParseJSON } from '../utils/json.js'
import { writeFileSync_DEPRECATED } from '../utils/slowOperations.js'
import { logError } from '../utils/log.js'
import { generateTempFilePath } from '../utils/tempfile.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import { parseSettingSourcesFlag } from '../utils/settings/constants.js'
import {
  setAllowedSettingSources,
  setFlagSettingsPath,
} from '../bootstrap/state.js'

function loadSettingsFromFlag(settingsFile: string): void {
  try {
    const trimmedSettings = settingsFile.trim()
    const looksLikeJson =
      trimmedSettings.startsWith('{') && trimmedSettings.endsWith('}')

    let settingsPath: string

    if (looksLikeJson) {
      const parsedJson = safeParseJSON(trimmedSettings)
      if (!parsedJson) {
        process.stderr.write(
          chalk.red('Error: Invalid JSON provided to --settings\n'),
        )
        process.exit(1)
      }

      settingsPath = generateTempFilePath('claude-settings', '.json', {
        contentHash: trimmedSettings,
      })
      writeFileSync_DEPRECATED(settingsPath, trimmedSettings, 'utf8')
    } else {
      const { resolvedPath: resolvedSettingsPath } = safeResolvePath(
        getFsImplementation(),
        settingsFile,
      )
      try {
        readFileSync(resolvedSettingsPath, 'utf8')
      } catch (e) {
        if (isENOENT(e)) {
          process.stderr.write(
            chalk.red(
              `Error: Settings file not found: ${resolvedSettingsPath}\n`,
            ),
          )
          process.exit(1)
        }
        throw e
      }
      settingsPath = resolvedSettingsPath
    }

    setFlagSettingsPath(settingsPath)
    resetSettingsCache()
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
    }
    process.stderr.write(
      chalk.red(`Error processing settings: ${errorMessage(error)}\n`),
    )
    process.exit(1)
  }
}

function loadSettingSourcesFromFlag(settingSourcesArg: string): void {
  try {
    const sources = parseSettingSourcesFlag(settingSourcesArg)
    setAllowedSettingSources(sources)
    resetSettingsCache()
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
    }
    process.stderr.write(
      chalk.red(`Error processing --setting-sources: ${errorMessage(error)}\n`),
    )
    process.exit(1)
  }
}

export function eagerLoadSettings(): void {
  profileCheckpoint('eagerLoadSettings_start')
  const settingsFile = eagerParseCliFlag('--settings')
  if (settingsFile) {
    loadSettingsFromFlag(settingsFile)
  }

  const settingSourcesArg = eagerParseCliFlag('--setting-sources')
  if (settingSourcesArg !== undefined) {
    loadSettingSourcesFromFlag(settingSourcesArg)
  }
  profileCheckpoint('eagerLoadSettings_end')
}

export function initializeEntrypoint(isNonInteractive: boolean): void {
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    return
  }

  const cliArgs = process.argv.slice(2)

  const mcpIndex = cliArgs.indexOf('mcp')
  if (mcpIndex !== -1 && cliArgs[mcpIndex + 1] === 'serve') {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'mcp'
    return
  }

  if (isEnvTruthy(process.env.CLAUDE_CODE_ACTION)) {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-code-github-action'
    return
  }

  process.env.CLAUDE_CODE_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli'
}

export function resetCursor(): void {
  const terminal = process.stderr.isTTY
    ? process.stderr
    : process.stdout.isTTY
      ? process.stdout
      : undefined
  terminal?.write(SHOW_CURSOR)
}
