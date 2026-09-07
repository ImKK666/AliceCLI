import type { Command } from '@commander-js/extra-typings'

type RegisterHelpers = {
  createSortedHelpConfig: () => { sortSubcommands: true; sortOptions: true }
}

export function register(program: Command, _helpers: RegisterHelpers): void {
  program
    .command('server')
    .description('Start a Alice CLI session server')
    .option('--port <number>', 'HTTP port', '0')
    .option('--host <string>', 'Bind address', '0.0.0.0')
    .option('--auth-token <token>', 'Bearer token for auth')
    .option('--unix <path>', 'Listen on a unix domain socket')
    .option(
      '--workspace <dir>',
      'Default working directory for sessions that do not specify cwd',
    )
    .option(
      '--idle-timeout <ms>',
      'Idle timeout for detached sessions in ms (0 = never expire)',
      '600000',
    )
    .option(
      '--max-sessions <n>',
      'Maximum concurrent sessions (0 = unlimited)',
      '32',
    )
    .action(
      async (opts: {
        port: string
        host: string
        authToken?: string
        unix?: string
        workspace?: string
        idleTimeout: string
        maxSessions: string
      }) => {
        const { randomBytes } = await import('crypto')
        const { startServer } = await import('../../server/server.js')
        const { SessionManager } = await import(
          '../../server/sessionManager.js'
        )
        const { DangerousBackend } = await import(
          '../../server/backends/dangerousBackend.js'
        )
        const { printBanner } = await import('../../server/serverBanner.js')
        const { createServerLogger } = await import('../../server/serverLog.js')
        const { writeServerLock, removeServerLock, probeRunningServer } =
          await import('../../server/lockfile.js')

        const existing = await probeRunningServer()
        if (existing) {
          process.stderr.write(
            `A claude server is already running (pid ${existing.pid}) at ${existing.httpUrl}\n`,
          )
          process.exit(1)
        }

        const authToken =
          opts.authToken ?? `sk-ant-cc-${randomBytes(16).toString('base64url')}`

        const config = {
          port: parseInt(opts.port, 10),
          host: opts.host,
          authToken,
          unix: opts.unix,
          workspace: opts.workspace,
          idleTimeoutMs: parseInt(opts.idleTimeout, 10),
          maxSessions: parseInt(opts.maxSessions, 10),
        }

        const backend = new DangerousBackend()
        const sessionManager = new SessionManager(backend, {
          idleTimeoutMs: config.idleTimeoutMs,
          maxSessions: config.maxSessions,
        })
        const logger = createServerLogger()

        const server = startServer(config, sessionManager, logger)
        const actualPort = server.port ?? config.port
        printBanner(config, authToken, actualPort)

        await writeServerLock({
          pid: process.pid,
          port: actualPort,
          host: config.host,
          httpUrl: config.unix
            ? `unix:${config.unix}`
            : `http://${config.host}:${actualPort}`,
          startedAt: Date.now(),
        })

        let shuttingDown = false
        const shutdown = async () => {
          if (shuttingDown) return
          shuttingDown = true
          // Stop accepting new connections before tearing down sessions.
          server.stop(true)
          await sessionManager.destroyAll()
          await removeServerLock()
          process.exit(0)
        }
        process.once('SIGINT', () => void shutdown())
        process.once('SIGTERM', () => void shutdown())
      },
    )
}
