import { feature } from 'bun:bundle'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { migrateBypassPermissionsAcceptedToSettings } from './migrateBypassPermissionsAcceptedToSettings.js'
import { migrateEnableAllProjectMcpServersToSettings } from './migrateEnableAllProjectMcpServersToSettings.js'
import { resetProToOpusDefault } from './resetProToOpusDefault.js'
import { migrateSonnet1mToSonnet45 } from './migrateSonnet1mToSonnet45.js'
import { migrateLegacyOpusToCurrent } from './migrateLegacyOpusToCurrent.js'
import { migrateSonnet45ToSonnet46 } from './migrateSonnet45ToSonnet46.js'
import { migrateOpusToOpus1m } from './migrateOpusToOpus1m.js'
import { migrateReplBridgeEnabledToRemoteControlAtStartup } from './migrateReplBridgeEnabledToRemoteControlAtStartup.js'
import { resetAutoModeOptInForDefaultOffer } from './resetAutoModeOptInForDefaultOffer.js'
import { migrateFennecToOpus } from './migrateFennecToOpus.js'
import { migrateChangelogFromConfig } from '../utils/releaseNotes.js'

const CURRENT_MIGRATION_VERSION = 11

export function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateBypassPermissionsAcceptedToSettings()
    migrateEnableAllProjectMcpServersToSettings()
    resetProToOpusDefault()
    migrateSonnet1mToSonnet45()
    migrateLegacyOpusToCurrent()
    migrateSonnet45ToSonnet46()
    migrateOpusToOpus1m()
    migrateReplBridgeEnabledToRemoteControlAtStartup()
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      resetAutoModeOptInForDefaultOffer()
    }
    if (process.env.USER_TYPE === 'ant') {
      migrateFennecToOpus()
    }
    saveGlobalConfig(prev =>
      prev.migrationVersion === CURRENT_MIGRATION_VERSION
        ? prev
        : { ...prev, migrationVersion: CURRENT_MIGRATION_VERSION },
    )
  }
  migrateChangelogFromConfig().catch(() => {})
}
