import { readFileSync } from 'fs'
import { join } from 'path'
import { findGitRoot } from '../utils/git.js'

/**
 * `claude up` — run the "# claude up" section from the nearest ALICE.md (or CLAUDE.md).
 *
 * Walks up from CWD looking for ALICE.md files (falling back to CLAUDE.md),
 * extracts the section under the `# claude up` heading, and executes it as a shell script.
 *
 * ANT-only command (USER_TYPE === "ant").
 */
export async function up(): Promise<void> {
  const cwd = process.cwd()
  const gitRoot = findGitRoot(cwd)
  const searchDirs = gitRoot ? [gitRoot, cwd] : [cwd]

  let upSection: string | null = null

  for (const dir of searchDirs) {
    // Try ALICE.md first, then fall back to CLAUDE.md
    for (const filename of ['ALICE.md', 'CLAUDE.md']) {
      const mdPath = join(dir, filename)
      try {
        const content = readFileSync(mdPath, 'utf-8')
        upSection = extractUpSection(content)
        if (upSection) {
          console.log(`Found "# claude up" in ${mdPath}`)
          break
        }
      } catch {
        // File not found — continue searching
      }
    }
    if (upSection) break
  }

  if (!upSection) {
    console.log(
      'No "# claude up" section found in ALICE.md.\n' +
        'Add a section like:\n\n' +
        '  # claude up\n' +
        '  ```bash\n' +
        '  npm install\n' +
        '  npm run build\n' +
        '  ```',
    )
    return
  }

  console.log('Running:\n')
  console.log(upSection)
  console.log()

  const result = Bun.spawnSync(['bash', '-c', upSection], {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  })

  if (result.exitCode !== 0) {
    console.error(`\nclaude up failed with exit code ${result.exitCode}`)
    process.exitCode = result.exitCode ?? 1
  } else {
    console.log('\nclaude up completed successfully.')
  }
}

/**
 * Extract the content under "# claude up" heading from markdown.
 * Returns the text between `# claude up` and the next `#` heading (or EOF).
 * Strips fenced code block markers if present.
 */
function extractUpSection(markdown: string): string | null {
  const lines = markdown.split('\n')
  let inSection = false
  const sectionLines: string[] = []

  for (const line of lines) {
    if (/^#\s+claude\s+up\b/i.test(line)) {
      inSection = true
      continue
    }
    if (inSection && /^#\s/.test(line)) {
      break
    }
    if (inSection) {
      sectionLines.push(line)
    }
  }

  if (sectionLines.length === 0) return null

  // Strip fenced code block markers
  let text = sectionLines.join('\n').trim()
  text = text.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '')

  return text.trim() || null
}
