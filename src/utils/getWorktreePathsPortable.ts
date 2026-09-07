/**
 * Portable worktree detection using Bun.spawn — no analytics,
 * no bootstrap deps, no execa. Used by listSessionsImpl.ts (SDK) and
 * anywhere that needs worktree paths without pulling in the CLI
 * dependency chain (execa → cross-spawn → which).
 */
export async function getWorktreePathsPortable(cwd: string): Promise<string[]> {
  try {
    const proc = Bun.spawn(['git', 'worktree', 'list', '--porcelain'], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    })
    const timer = setTimeout(() => proc.kill(), 5000)
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ])
    clearTimeout(timer)
    if (exitCode !== 0 || !stdout) return []
    return stdout
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).normalize('NFC'))
  } catch {
    return []
  }
}
