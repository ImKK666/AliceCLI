import { Readable, Writable } from 'stream'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  Trace,
} from 'vscode-jsonrpc/node.js'
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
} from 'vscode-languageserver-protocol'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
/**
 * LSP client interface.
 */
export type LSPClient = {
  readonly capabilities: ServerCapabilities | undefined
  readonly isInitialized: boolean
  start: (
    command: string,
    args: string[],
    options?: {
      env?: Record<string, string>
      cwd?: string
    },
  ) => Promise<void>
  initialize: (params: InitializeParams) => Promise<InitializeResult>
  sendRequest: <TResult>(method: string, params: unknown) => Promise<TResult>
  sendNotification: (method: string, params: unknown) => Promise<void>
  onNotification: (method: string, handler: (params: unknown) => void) => void
  onRequest: <TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ) => void
  stop: () => Promise<void>
}

/**
 * Create an LSP client wrapper using vscode-jsonrpc.
 * Manages communication with an LSP server process via stdio.
 *
 * @param onCrash - Called when the server process exits unexpectedly (non-zero
 *   exit code during operation, not during intentional stop). Allows the owner
 *   to propagate crash state so the server can be restarted on next use.
 */
export function createLSPClient(
  serverName: string,
  onCrash?: (error: Error) => void,
): LSPClient {
  // State variables in closure
  let process: ReturnType<typeof Bun.spawn> | undefined
  let stdinAdapter: Writable | undefined
  let connection: MessageConnection | undefined
  let capabilities: ServerCapabilities | undefined
  let isInitialized = false
  let startFailed = false
  let startError: Error | undefined
  let isStopping = false // Track intentional shutdown to avoid spurious error logging
  // Queue handlers registered before connection ready (lazy initialization support)
  const pendingHandlers: Array<{
    method: string
    handler: (params: unknown) => void
  }> = []
  const pendingRequestHandlers: Array<{
    method: string
    handler: (params: unknown) => unknown | Promise<unknown>
  }> = []

  function checkStartFailed(): void {
    if (startFailed) {
      throw startError || new Error(`LSP server ${serverName} failed to start`)
    }
  }

  return {
    get capabilities(): ServerCapabilities | undefined {
      return capabilities
    },

    get isInitialized(): boolean {
      return isInitialized
    },

    async start(
      command: string,
      args: string[],
      options?: {
        env?: Record<string, string>
        cwd?: string
      },
    ): Promise<void> {
      try {
        // 1. Spawn LSP server process (Bun.spawn throws synchronously on ENOENT)
        process = Bun.spawn([command, ...args], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...subprocessEnv(), ...options?.env },
          cwd: options?.cwd,
        })

        // Adapt Bun streams to Node.js streams for vscode-jsonrpc
        const nodeStdout = Readable.fromWeb(process.stdout as never)
        const procStdin = process.stdin as {
          write(data: unknown): void
          end(): void
        }
        stdinAdapter = new Writable({
          write(chunk, _enc, cb) {
            try {
              procStdin.write(chunk)
              cb()
            } catch (e) {
              cb(e as Error)
            }
          },
          final(cb) {
            try {
              procStdin.end()
              cb()
            } catch (e) {
              cb(e as Error)
            }
          },
        })

        // Capture stderr for server diagnostics
        ;(async () => {
          try {
            const reader = (
              process!.stderr as ReadableStream<Uint8Array>
            ).getReader()
            const decoder = new TextDecoder()
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              const output = decoder.decode(value, { stream: true }).trim()
              if (output)
                logForDebugging(`[LSP SERVER ${serverName}] ${output}`)
            }
          } catch {
            /* stream closed */
          }
        })()

        // Handle process exit (crash detection)
        process.exited
          .then(code => {
            if (code !== 0 && code !== null && !isStopping) {
              isInitialized = false
              startFailed = false
              startError = undefined
              const crashError = new Error(
                `LSP server ${serverName} crashed with exit code ${code}`,
              )
              logError(crashError)
              onCrash?.(crashError)
            }
          })
          .catch(error => {
            if (!isStopping) {
              startFailed = true
              startError = error as Error
              logError(
                new Error(
                  `LSP server ${serverName} failed: ${(error as Error).message}`,
                ),
              )
            }
          })

        // 2. Create JSON-RPC connection
        const reader = new StreamMessageReader(nodeStdout)
        const writer = new StreamMessageWriter(stdinAdapter)
        connection = createMessageConnection(reader, writer)

        // 2.5. Register error/close handlers BEFORE listen() to catch all errors
        // This prevents unhandled promise rejections when the server crashes or closes unexpectedly
        connection.onError(([error, _message, _code]) => {
          // Only log if not intentionally stopping (avoid spurious errors during shutdown)
          if (!isStopping) {
            startFailed = true
            startError = error
            logError(
              new Error(
                `LSP server ${serverName} connection error: ${error.message}`,
              ),
            )
          }
        })

        connection.onClose(() => {
          // Only treat as error if not intentionally stopping
          if (!isStopping) {
            isInitialized = false
            // Don't set startFailed here - the connection may close after graceful shutdown
            logForDebugging(`LSP server ${serverName} connection closed`)
          }
        })

        // 3. Start listening for messages
        connection.listen()

        // 3.5. Enable protocol tracing for debugging
        // Note: trace() sends a $/setTrace notification which can fail if the server
        // process has already exited. We catch and log the error rather than letting
        // it become an unhandled promise rejection.
        connection
          .trace(Trace.Verbose, {
            log: (message: string) => {
              logForDebugging(`[LSP PROTOCOL ${serverName}] ${message}`)
            },
          })
          .catch((error: Error) => {
            logForDebugging(
              `Failed to enable tracing for ${serverName}: ${error.message}`,
            )
          })

        // 4. Apply any queued notification handlers
        for (const { method, handler } of pendingHandlers) {
          connection.onNotification(method, handler)
          logForDebugging(
            `Applied queued notification handler for ${serverName}.${method}`,
          )
        }
        pendingHandlers.length = 0 // Clear the queue

        // 5. Apply any queued request handlers
        for (const { method, handler } of pendingRequestHandlers) {
          connection.onRequest(method, handler)
          logForDebugging(
            `Applied queued request handler for ${serverName}.${method}`,
          )
        }
        pendingRequestHandlers.length = 0 // Clear the queue

        logForDebugging(`LSP client started for ${serverName}`)
      } catch (error) {
        const err = error as Error
        logError(
          new Error(`LSP server ${serverName} failed to start: ${err.message}`),
        )
        throw error
      }
    },

    async initialize(params: InitializeParams): Promise<InitializeResult> {
      if (!connection) {
        throw new Error('LSP client not started')
      }

      checkStartFailed()

      try {
        const result: InitializeResult = await connection.sendRequest(
          'initialize',
          params,
        )

        capabilities = result.capabilities

        // Send initialized notification
        await connection.sendNotification('initialized', {})

        isInitialized = true
        logForDebugging(`LSP server ${serverName} initialized`)

        return result
      } catch (error) {
        const err = error as Error
        logError(
          new Error(
            `LSP server ${serverName} initialize failed: ${err.message}`,
          ),
        )
        throw error
      }
    },

    async sendRequest<TResult>(
      method: string,
      params: unknown,
    ): Promise<TResult> {
      if (!connection) {
        throw new Error('LSP client not started')
      }

      checkStartFailed()

      if (!isInitialized) {
        throw new Error('LSP server not initialized')
      }

      try {
        return await connection.sendRequest(method, params)
      } catch (error) {
        const err = error as Error
        logError(
          new Error(
            `LSP server ${serverName} request ${method} failed: ${err.message}`,
          ),
        )
        throw error
      }
    },

    async sendNotification(method: string, params: unknown): Promise<void> {
      if (!connection) {
        throw new Error('LSP client not started')
      }

      checkStartFailed()

      try {
        await connection.sendNotification(method, params)
      } catch (error) {
        const err = error as Error
        logError(
          new Error(
            `LSP server ${serverName} notification ${method} failed: ${err.message}`,
          ),
        )
        // Don't re-throw for notifications - they're fire-and-forget
        logForDebugging(`Notification ${method} failed but continuing`)
      }
    },

    onNotification(method: string, handler: (params: unknown) => void): void {
      if (!connection) {
        // Queue handler for application when connection is ready (lazy initialization)
        pendingHandlers.push({ method, handler })
        logForDebugging(
          `Queued notification handler for ${serverName}.${method} (connection not ready)`,
        )
        return
      }

      checkStartFailed()

      connection.onNotification(method, handler)
    },

    onRequest<TParams, TResult>(
      method: string,
      handler: (params: TParams) => TResult | Promise<TResult>,
    ): void {
      if (!connection) {
        // Queue handler for application when connection is ready (lazy initialization)
        pendingRequestHandlers.push({
          method,
          handler: handler as (params: unknown) => unknown | Promise<unknown>,
        })
        logForDebugging(
          `Queued request handler for ${serverName}.${method} (connection not ready)`,
        )
        return
      }

      checkStartFailed()

      connection.onRequest(method, handler)
    },

    async stop(): Promise<void> {
      let shutdownError: Error | undefined

      // Mark as stopping to prevent error handlers from logging spurious errors
      isStopping = true

      try {
        if (connection) {
          // Try to send shutdown request and exit notification
          await connection.sendRequest('shutdown', {})
          await connection.sendNotification('exit', {})
        }
      } catch (error) {
        const err = error as Error
        logError(
          new Error(`LSP server ${serverName} stop failed: ${err.message}`),
        )
        shutdownError = err
        // Continue to cleanup despite shutdown failure
      } finally {
        // Always cleanup resources, even if shutdown/exit failed
        if (connection) {
          try {
            connection.dispose()
          } catch (error) {
            // Log but don't throw - disposal errors are less critical
            logForDebugging(
              `Connection disposal failed for ${serverName}: ${errorMessage(error)}`,
            )
          }
          connection = undefined
        }

        if (stdinAdapter) {
          stdinAdapter.destroy()
          stdinAdapter = undefined
        }

        if (process) {
          try {
            process.kill()
          } catch (error) {
            logForDebugging(
              `Process kill failed for ${serverName} (may already be dead): ${errorMessage(error)}`,
            )
          }
          process = undefined
        }

        isInitialized = false
        capabilities = undefined
        isStopping = false // Reset for potential restart
        // Don't reset startFailed - preserve error state for diagnostics
        // startFailed and startError remain as-is
        if (shutdownError) {
          startFailed = true
          startError = shutdownError
        }

        logForDebugging(`LSP client stopped for ${serverName}`)
      }

      // Re-throw shutdown error after cleanup is complete
      if (shutdownError) {
        throw shutdownError
      }
    },
  }
}
