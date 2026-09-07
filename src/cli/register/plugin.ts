import type { Command } from '@commander-js/extra-typings'
import { Option } from '@commander-js/extra-typings'
import {
  VALID_INSTALLABLE_SCOPES,
  VALID_UPDATE_SCOPES,
} from '../../services/plugins/pluginCliCommands.js'

type RegisterHelpers = {
  createSortedHelpConfig: () => { sortSubcommands: true; sortOptions: true }
}

export function register(program: Command, helpers: RegisterHelpers): void {
  // Hidden flag on all plugin/marketplace subcommands to target cowork_plugins.
  const coworkOption = () =>
    new Option('--cowork', 'Use cowork_plugins directory').hideHelp()

  // Plugin validate command
  const pluginCmd = program
    .command('plugin')
    .alias('plugins')
    .description('Manage Alice CLI plugins')
    .configureHelp(helpers.createSortedHelpConfig())

  pluginCmd
    .command('validate <path>')
    .description('Validate a plugin or marketplace manifest')
    .addOption(coworkOption())
    .action(async (manifestPath: string, options: { cowork?: boolean }) => {
      const { pluginValidateHandler } = await import(
        './../../cli/handlers/plugins.js'
      )
      await pluginValidateHandler(manifestPath, options)
    })

  // Plugin list command
  pluginCmd
    .command('list')
    .description('List installed plugins')
    .option('--json', 'Output as JSON')
    .option(
      '--available',
      'Include available plugins from marketplaces (requires --json)',
    )
    .addOption(coworkOption())
    .action(
      async (options: {
        json?: boolean
        available?: boolean
        cowork?: boolean
      }) => {
        const { pluginListHandler } = await import(
          './../../cli/handlers/plugins.js'
        )
        await pluginListHandler(options)
      },
    )

  // Marketplace subcommands
  const marketplaceCmd = pluginCmd
    .command('marketplace')
    .description('Manage Alice CLI marketplaces')
    .configureHelp(helpers.createSortedHelpConfig())

  marketplaceCmd
    .command('add <source>')
    .description('Add a marketplace from a URL, path, or GitHub repo')
    .addOption(coworkOption())
    .option(
      '--sparse <paths...>',
      'Limit checkout to specific directories via git sparse-checkout (for monorepos). Example: --sparse .claude-plugin plugins',
    )
    .option(
      '--scope <scope>',
      'Where to declare the marketplace: user (default), project, or local',
    )
    .action(
      async (
        source: string,
        options: {
          cowork?: boolean
          sparse?: string[]
          scope?: string
        },
      ) => {
        const { marketplaceAddHandler } = await import(
          './../../cli/handlers/plugins.js'
        )
        await marketplaceAddHandler(source, options)
      },
    )

  marketplaceCmd
    .command('list')
    .description('List all configured marketplaces')
    .option('--json', 'Output as JSON')
    .addOption(coworkOption())
    .action(async (options: { json?: boolean; cowork?: boolean }) => {
      const { marketplaceListHandler } = await import(
        './../../cli/handlers/plugins.js'
      )
      await marketplaceListHandler(options)
    })

  marketplaceCmd
    .command('remove <name>')
    .alias('rm')
    .description('Remove a configured marketplace')
    .addOption(coworkOption())
    .action(async (name: string, options: { cowork?: boolean }) => {
      const { marketplaceRemoveHandler } = await import(
        './../../cli/handlers/plugins.js'
      )
      await marketplaceRemoveHandler(name, options)
    })

  marketplaceCmd
    .command('update [name]')
    .description(
      'Update marketplace(s) from their source - updates all if no name specified',
    )
    .addOption(coworkOption())
    .action(async (name: string | undefined, options: { cowork?: boolean }) => {
      const { marketplaceUpdateHandler } = await import(
        './../../cli/handlers/plugins.js'
      )
      await marketplaceUpdateHandler(name, options)
    })

  // Plugin install command
  pluginCmd
    .command('install <plugin>')
    .alias('i')
    .description(
      'Install a plugin from available marketplaces (use plugin@marketplace for specific marketplace)',
    )
    .option(
      '-s, --scope <scope>',
      'Installation scope: user, project, or local',
      'user',
    )
    .addOption(coworkOption())
    .action(
      async (plugin: string, options: { scope?: string; cowork?: boolean }) => {
        const { pluginInstallHandler } = await import(
          './../../cli/handlers/plugins.js'
        )
        await pluginInstallHandler(plugin, options)
      },
    )

  // Plugin uninstall command
  pluginCmd
    .command('uninstall <plugin>')
    .alias('remove')
    .alias('rm')
    .description('Uninstall an installed plugin')
    .option(
      '-s, --scope <scope>',
      'Uninstall from scope: user, project, or local',
      'user',
    )
    .option(
      '--keep-data',
      "Preserve the plugin's persistent data directory (~/.claude/plugins/data/{id}/)",
    )
    .addOption(coworkOption())
    .action(
      async (
        plugin: string,
        options: {
          scope?: string
          cowork?: boolean
          keepData?: boolean
        },
      ) => {
        const { pluginUninstallHandler } = await import(
          './../../cli/handlers/plugins.js'
        )
        await pluginUninstallHandler(plugin, options)
      },
    )

  // Plugin enable command
  pluginCmd
    .command('enable <plugin>')
    .description('Enable a disabled plugin')
    .option(
      '-s, --scope <scope>',
      `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`,
    )
    .addOption(coworkOption())
    .action(
      async (plugin: string, options: { scope?: string; cowork?: boolean }) => {
        const { pluginEnableHandler } = await import(
          './../../cli/handlers/plugins.js'
        )
        await pluginEnableHandler(plugin, options)
      },
    )

  // Plugin disable command
  pluginCmd
    .command('disable [plugin]')
    .description('Disable an enabled plugin')
    .option('-a, --all', 'Disable all enabled plugins')
    .option(
      '-s, --scope <scope>',
      `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`,
    )
    .addOption(coworkOption())
    .action(
      async (
        plugin: string | undefined,
        options: { scope?: string; cowork?: boolean; all?: boolean },
      ) => {
        const { pluginDisableHandler } = await import(
          './../../cli/handlers/plugins.js'
        )
        await pluginDisableHandler(plugin, options)
      },
    )

  // Plugin update command
  pluginCmd
    .command('update <plugin>')
    .description(
      'Update a plugin to the latest version (restart required to apply)',
    )
    .option(
      '-s, --scope <scope>',
      `Installation scope: ${VALID_UPDATE_SCOPES.join(', ')} (default: user)`,
    )
    .addOption(coworkOption())
    .action(
      async (plugin: string, options: { scope?: string; cowork?: boolean }) => {
        const { pluginUpdateHandler } = await import(
          './../../cli/handlers/plugins.js'
        )
        await pluginUpdateHandler(plugin, options)
      },
    )
}
