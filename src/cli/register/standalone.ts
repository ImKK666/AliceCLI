import { feature } from 'bun:bundle'
import type { Command } from '@commander-js/extra-typings'
import { getAutoModeEnabledStateIfCached } from 'src/utils/permissions/permissionSetup.js'
import { getBaseRenderOptions } from '../../utils/renderOptions.js'

type RegisterHelpers = {
  createSortedHelpConfig: () => { sortSubcommands: true; sortOptions: true }
}

export function register(program: Command, _helpers: RegisterHelpers): void {
  // Setup token command
  program
    .command('setup-token')
    .description(
      'Set up a long-lived authentication token (requires Claude subscription)',
    )
    .action(async () => {
      const [{ setupTokenHandler }, { createRoot }] = await Promise.all([
        import('./../../cli/handlers/util.js'),
        import('@anthropic/ink'),
      ])
      const root = await createRoot(getBaseRenderOptions(false))
      await setupTokenHandler(root)
    })

  // Agents command - list configured agents
  program
    .command('agents')
    .description('List configured agents')
    .option(
      '--setting-sources <sources>',
      'Comma-separated list of setting sources to load (user, project, local).',
    )
    .action(async () => {
      const { agentsHandler } = await import('./../../cli/handlers/agents.js')
      await agentsHandler()
      process.exit(0)
    })

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // Skip when tengu_auto_mode_config.enabled === 'disabled' (circuit breaker).
    // Reads from disk cache — GrowthBook isn't initialized at registration time.
    if (getAutoModeEnabledStateIfCached() !== 'disabled') {
      const autoModeCmd = program
        .command('auto-mode')
        .description('Inspect auto mode classifier configuration')

      autoModeCmd
        .command('defaults')
        .description(
          'Print the default auto mode environment, allow, and deny rules as JSON',
        )
        .action(async () => {
          const { autoModeDefaultsHandler } = await import(
            './../../cli/handlers/autoMode.js'
          )
          autoModeDefaultsHandler()
          process.exit(0)
        })

      autoModeCmd
        .command('config')
        .description(
          'Print the effective auto mode config as JSON: your settings where set, defaults otherwise',
        )
        .action(async () => {
          const { autoModeConfigHandler } = await import(
            './../../cli/handlers/autoMode.js'
          )
          autoModeConfigHandler()
          process.exit(0)
        })

      autoModeCmd
        .command('critique')
        .description('Get AI feedback on your custom auto mode rules')
        .option('--model <model>', 'Override which model is used')
        .action(async options => {
          const { autoModeCritiqueHandler } = await import(
            './../../cli/handlers/autoMode.js'
          )
          await autoModeCritiqueHandler(options)
          process.exit()
        })
    }
  }

  // claude autonomy — CLI subcommands mirroring /autonomy slash command
  {
    const autonomyCmd = program
      .command('autonomy')
      .description('Inspect and manage automatic autonomy runs and flows')

    autonomyCmd
      .command('status')
      .description(
        'Print autonomy run, flow, team, pipe, and remote-control status',
      )
      .option(
        '--deep',
        'Include teams, pipes, daemon, and remote-control sections',
      )
      .action(async (options: { deep?: boolean }) => {
        const { autonomyStatusHandler } = await import(
          './../../cli/handlers/autonomy.js'
        )
        await autonomyStatusHandler(options)
        process.exit(0)
      })

    autonomyCmd
      .command('runs [limit]')
      .description('List recent autonomy runs')
      .action(async (limit?: string) => {
        const { autonomyRunsHandler } = await import(
          './../../cli/handlers/autonomy.js'
        )
        await autonomyRunsHandler(limit)
        process.exit(0)
      })

    autonomyCmd
      .command('flows [limit]')
      .description('List recent autonomy flows')
      .action(async (limit?: string) => {
        const { autonomyFlowsHandler } = await import(
          './../../cli/handlers/autonomy.js'
        )
        await autonomyFlowsHandler(limit)
        process.exit(0)
      })

    const flowCmd = autonomyCmd
      .command('flow <flowId>')
      .description('Inspect a single autonomy flow')
      .action(async (flowId: string) => {
        const { autonomyFlowHandler } = await import(
          './../../cli/handlers/autonomy.js'
        )
        await autonomyFlowHandler(flowId)
        process.exit(0)
      })

    flowCmd
      .command('cancel <flowId>')
      .description('Cancel a queued, waiting, or running autonomy flow')
      .action(async (flowId: string) => {
        const { autonomyFlowCancelHandler } = await import(
          './../../cli/handlers/autonomy.js'
        )
        await autonomyFlowCancelHandler(flowId)
        process.exit(0)
      })

    flowCmd
      .command('resume <flowId>')
      .description('Resume a waiting autonomy flow')
      .action(async (flowId: string) => {
        const { autonomyFlowResumeHandler } = await import(
          './../../cli/handlers/autonomy.js'
        )
        await autonomyFlowResumeHandler(flowId)
        process.exit(0)
      })
  }

  // Remote Control command — connect local environment to claude.ai/code.
  // The actual command is intercepted by the fast-path in cli.tsx before
  // Commander.js runs, so this registration exists only for help output.
  // Always hidden: isBridgeEnabled() at this point (before enableConfigs)
  // would throw inside isClaudeAISubscriber -> getGlobalConfig and return
  // false via the try/catch — but not before paying ~65ms of side effects
  // (25ms settings Zod parse + 40ms sync `security` keychain subprocess).
  // The dynamic visibility never worked; the command was always hidden.
  if (feature('BRIDGE_MODE')) {
    program
      .command('remote-control', { hidden: true })
      .alias('rc')
      .description(
        'Connect your local environment for remote-control sessions via claude.ai/code',
      )
      .action(async () => {
        // Unreachable — cli.tsx fast-path handles this command before main.tsx loads.
        // If somehow reached, delegate to bridgeMain.
        const { bridgeMain } = await import('../../bridge/bridgeMain.js')
        await bridgeMain(process.argv.slice(3))
      })
  }

  if (feature('KAIROS')) {
    program
      .command('assistant [sessionId]')
      .description(
        'Attach the REPL as a client to a running bridge session. Discovers sessions via API if no sessionId given.',
      )
      .action(() => {
        // Argv rewriting above should have consumed `assistant [id]`
        // before commander runs. Reaching here means a root flag came first
        // (e.g. `--debug assistant`) and the position-0 predicate
        // didn't match. Print usage like the ssh stub does.
        process.stderr.write(
          'Usage: claude assistant [sessionId]\n\n' +
            'Attach the REPL as a viewer client to a running bridge session.\n' +
            'Omit sessionId to discover and pick from available sessions.\n',
        )
        process.exit(1)
      })
  }

  // Doctor command - check installation health
  program
    .command('doctor')
    .description(
      'Check the health of your Claude Code auto-updater. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.',
    )
    .action(async () => {
      const [{ doctorHandler }, { createRoot }] = await Promise.all([
        import('./../../cli/handlers/util.js'),
        import('@anthropic/ink'),
      ])
      const root = await createRoot(getBaseRenderOptions(false))
      await doctorHandler(root)
    })

  // claude install
  program
    .command('install [target]')
    .description(
      'Install Claude Code native build. Use [target] to specify version (stable, latest, or specific version)',
    )
    .option('--force', 'Force installation even if already installed')
    .action(
      async (target: string | undefined, options: { force?: boolean }) => {
        const { installHandler } = await import('./../../cli/handlers/util.js')
        await installHandler(target, options)
      },
    )

  // claude update — update ccb to the latest version via npm or bun
  program
    .command('update')
    .description('Update alice-cli to the latest version')
    .action(async () => {
      const { updateCCB } = await import('./../../cli/updateCCB.js')
      await updateCCB()
    })
}
