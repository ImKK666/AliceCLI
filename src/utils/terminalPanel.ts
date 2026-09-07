/**
 * Built-in terminal panel toggled with Meta+J.
 *
 * Uses tmux for shell persistence: a separate tmux server with a per-instance
 * socket (e.g., "claude-panel-a1b2c3d4") holds the shell session. Each Claude
 * Code instance gets its own isolated terminal panel that persists within the
 * session but is destroyed when the instance exits.
 *
 * Meta+J is bound to detach-client inside tmux, so pressing it returns to
 * Alice CLI while the shell keeps running. Next toggle re-attaches to the
 * same session.
 *
 * When tmux is not available, falls back to a non-persistent shell via spawnSync.
 *
 * Uses the same suspend-Ink pattern as the external editor (promptEditor.ts).
 */

import { getSessionId } from '../bootstrap/state.js'
import { instances } from '@anthropic/ink'
import { registerCleanup } from './cleanupRegistry.js'
import { pwd } from './cwd.js'
import { logForDebugging } from './debug.js'

const TMUX_SESSION = 'panel'

/**
 * Get the tmux socket name for the terminal panel.
 * Uses a unique socket per Alice CLI instance (based on session ID)
 * so that each instance has its own isolated terminal panel.
 */
export function getTerminalPanelSocket(): string {
  // Use first 8 chars of session UUID for uniqueness while keeping name short
  const sessionId = getSessionId()
  return `claude-panel-${sessionId.slice(0, 8)}`
}

let instance: TerminalPanel | undefined

/**
 * Return the singleton TerminalPanel, creating it lazily on first use.
 */
export function getTerminalPanel(): TerminalPanel {
  if (!instance) {
    instance = new TerminalPanel()
  }
  return instance
}

class TerminalPanel {
  private hasTmux: boolean | undefined
  private cleanupRegistered = false

  // ── public API ────────────────────────────────────────────────────

  toggle(): void {
    this.showShell()
  }

  // ── tmux helpers ──────────────────────────────────────────────────

  private checkTmux(): boolean {
    if (this.hasTmux !== undefined) return this.hasTmux
    const result = Bun.spawnSync(['tmux', '-V'])
    this.hasTmux = result.exitCode === 0
    if (!this.hasTmux) {
      logForDebugging(
        'Terminal panel: tmux not found, falling back to non-persistent shell',
      )
    }
    return this.hasTmux
  }

  private hasSession(): boolean {
    const result = Bun.spawnSync([
      'tmux',
      '-L',
      getTerminalPanelSocket(),
      'has-session',
      '-t',
      TMUX_SESSION,
    ])
    return result.exitCode === 0
  }

  private createSession(): boolean {
    const shell = process.env.SHELL || '/bin/bash'
    const cwd = pwd()
    const socket = getTerminalPanelSocket()

    const result = Bun.spawnSync([
      'tmux',
      '-L',
      socket,
      'new-session',
      '-d',
      '-s',
      TMUX_SESSION,
      '-c',
      cwd,
      shell,
      '-l',
    ])

    if (result.exitCode !== 0) {
      logForDebugging(
        `Terminal panel: failed to create tmux session: ${result.stderr.toString()}`,
      )
      return false
    }

    // Bind Meta+J (toggles back to Alice CLI from inside the terminal)
    // and configure the status bar hint. Chained with ';' to collapse
    // multiple spawnSync calls into 1.
    // biome-ignore format: one tmux command per line
    Bun.spawnSync([
      'tmux',
      '-L', socket,
      'bind-key', '-n', 'M-j', 'detach-client', ';',
      'set-option', '-g', 'status-style', 'bg=default', ';',
      'set-option', '-g', 'status-left', '', ';',
      'set-option', '-g', 'status-right', ' Alt+J to return to Claude ', ';',
      'set-option', '-g', 'status-right-style', 'fg=brightblack',
    ])

    if (!this.cleanupRegistered) {
      this.cleanupRegistered = true
      registerCleanup(async () => {
        // Fire-and-forget async spawn — spawnSync here would block the event
        // loop and serialize the entire cleanup Promise.all in gracefulShutdown.
        // try/catch swallows ENOENT if tmux disappears between session
        // creation and cleanup — prevents spurious uncaughtException noise.
        try {
          Bun.spawn(['tmux', '-L', socket, 'kill-server'], {
            stdout: 'ignore',
            stderr: 'ignore',
            stdin: 'ignore',
          })
        } catch {
          // Swallow errors (e.g., ENOENT if tmux disappeared)
        }
      })
    }

    return true
  }

  private attachSession(): void {
    Bun.spawnSync({
      cmd: [
        'tmux',
        '-L',
        getTerminalPanelSocket(),
        'attach-session',
        '-t',
        TMUX_SESSION,
      ],
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    })
  }

  // ── show shell ────────────────────────────────────────────────────

  private showShell(): void {
    const inkInstance = instances.get(process.stdout)
    if (!inkInstance) {
      logForDebugging('Terminal panel: no Ink instance found, aborting')
      return
    }

    inkInstance.enterAlternateScreen()
    try {
      if (this.checkTmux() && this.ensureSession()) {
        this.attachSession()
      } else {
        this.runShellDirect()
      }
    } finally {
      inkInstance.exitAlternateScreen()
    }
  }

  // ── helpers ───────────────────────────────────────────────────────

  /** Ensure a tmux session exists, creating one if needed. */
  private ensureSession(): boolean {
    if (this.hasSession()) return true
    return this.createSession()
  }

  /** Fallback when tmux is not available — runs a non-persistent shell. */
  private runShellDirect(): void {
    const shell = process.env.SHELL || '/bin/bash'
    const cwd = pwd()
    Bun.spawnSync({
      cmd: [shell, '-i', '-l'],
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
      cwd,
      env: process.env,
    })
  }
}
