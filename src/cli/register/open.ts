import type { Command } from '@commander-js/extra-typings'
import {
  getOriginalCwd,
  setCwdState,
  setDirectConnectServerUrl,
  setOriginalCwd,
} from 'src/bootstrap/state.js'
import {
  createDirectConnectSession,
  DirectConnectError,
} from '../../server/createDirectConnectSession.js'

type PendingConnect = {
  url: string | undefined
  authToken: string | undefined
  dangerouslySkipPermissions: boolean
}

type RegisterHelpers = {
  createSortedHelpConfig: () => { sortSubcommands: true; sortOptions: true }
  getPendingConnect: () => PendingConnect | undefined
}

export function register(program: Command, helpers: RegisterHelpers): void {
  // claude connect — subcommand only handles -p (headless) mode.
  // Interactive mode (without -p) is handled by early argv rewriting in main()
  // which redirects to the main command with full TUI support.
  program
    .command('open <cc-url>')
    .description('Connect to a Claude Code server (internal — use cc:// URLs)')
    .option('-p, --print [prompt]', 'Print mode (headless)')
    .option(
      '--output-format <format>',
      'Output format: text, json, stream-json',
      'text',
    )
    .action(
      async (
        ccUrl: string,
        opts: {
          print?: string | true
          outputFormat?: string
        },
      ) => {
        const { parseConnectUrl } = await import(
          '../../server/parseConnectUrl.js'
        )
        const { serverUrl, authToken } = parseConnectUrl(ccUrl)
        const _pendingConnect = helpers.getPendingConnect()

        let connectConfig
        try {
          const session = await createDirectConnectSession({
            serverUrl,
            authToken,
            cwd: getOriginalCwd(),
            dangerouslySkipPermissions:
              _pendingConnect?.dangerouslySkipPermissions,
          })
          if (session.workDir) {
            setOriginalCwd(session.workDir)
            setCwdState(session.workDir)
          }
          setDirectConnectServerUrl(serverUrl)
          connectConfig = session.config
        } catch (err) {
          console.error(
            err instanceof DirectConnectError ? err.message : String(err),
          )
          process.exit(1)
        }

        const { runConnectHeadless } = await import(
          '../../server/connectHeadless.js'
        )

        const prompt = typeof opts.print === 'string' ? opts.print : ''
        const interactive = opts.print === true
        await runConnectHeadless(
          connectConfig,
          prompt,
          opts.outputFormat,
          interactive,
        )
      },
    )
}
