import type { Command } from '@commander-js/extra-typings'

type RegisterHelpers = {
  createSortedHelpConfig: () => { sortSubcommands: true; sortOptions: true }
}

export function register(program: Command, helpers: RegisterHelpers): void {
  const auth = program
    .command('auth')
    .description('Manage authentication')
    .configureHelp(helpers.createSortedHelpConfig())

  auth
    .command('login')
    .description('Sign in to your Anthropic account')
    .option('--email <email>', 'Pre-populate email address on the login page')
    .option('--sso', 'Force SSO login flow')
    .option(
      '--console',
      'Use Anthropic Console (API usage billing) instead of Claude subscription',
    )
    .option('--claudeai', 'Use Claude subscription (default)')
    .action(
      async ({
        email,
        sso,
        console: useConsole,
        claudeai,
      }: {
        email?: string
        sso?: boolean
        console?: boolean
        claudeai?: boolean
      }) => {
        const { authLogin } = await import('./../../cli/handlers/auth.js')
        await authLogin({ email, sso, console: useConsole, claudeai })
      },
    )

  auth
    .command('status')
    .description('Show authentication status')
    .option('--json', 'Output as JSON (default)')
    .option('--text', 'Output as human-readable text')
    .action(async (opts: { json?: boolean; text?: boolean }) => {
      const { authStatus } = await import('./../../cli/handlers/auth.js')
      await authStatus(opts)
    })

  auth
    .command('logout')
    .description('Log out from your Anthropic account')
    .action(async () => {
      const { authLogout } = await import('./../../cli/handlers/auth.js')
      await authLogout()
    })
}
