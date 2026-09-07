#!/usr/bin/env bun
/**
 * Compile Claude Code into a standalone binary.
 *
 * Pipeline:
 *   1. Vite build → dist/cli.js + dist/chunks/ (code-split ESM)
 *   2. Patch top-level await in entry → .catch() (bun --compile limitation)
 *   3. bun build --compile --bytecode → single executable
 *
 * Usage:
 *   bun run scripts/compile.ts                    # default output: claude-code-bin
 *   bun run scripts/compile.ts --outfile=my-cli   # custom output name
 */
import { execSync } from 'child_process'
import { statSync, chmodSync } from 'fs'
import { readFile, writeFile, rm } from 'fs/promises'
import { join } from 'path'

const outfile =
  process.argv.find(a => a.startsWith('--outfile='))?.split('=')[1] ??
  'claude-code-bin'

// Step 1: Vite build (code-split ESM output)
console.log('[1/3] Building with Vite (code splitting)...')
execSync('bun run build:vite', { stdio: 'inherit' })

// Step 2: Patch top-level await in entry file
// bun build --compile does not support top-level await (ESM module semantics).
// Vite's entry cli.js ends with `await m();export{};` — replace with .catch().
console.log('[2/3] Patching top-level await for --compile compatibility...')
const entryPath = join('dist', 'cli.js')
let entry = await readFile(entryPath, 'utf-8')
const TLA_PATTERN = /await\s+(\w+)\(\s*\)\s*;?\s*(export\s*\{[^}]*\}\s*;?\s*)$/
if (TLA_PATTERN.test(entry)) {
  entry = entry.replace(
    TLA_PATTERN,
    '$1().catch(e=>{console.error(e);process.exit(1)});$2',
  )
  await writeFile(entryPath, entry)
  console.log('  Patched: await m() → m().catch(...)')
} else {
  console.warn(
    '  Warning: top-level await pattern not found — entry may already be patched',
  )
}

// Step 3: Compile to standalone binary
console.log(`[3/3] Compiling to standalone binary: ${outfile}...`)
execSync(`bun build --compile --bytecode --outfile=${outfile} ${entryPath}`, {
  stdio: 'inherit',
  timeout: 300_000,
})

const size = statSync(outfile).size
const sizeMB = Math.round(size / 1024 / 1024)
console.log(`\n  Standalone binary: ./${outfile} (${sizeMB} MB)`)
console.log(`  Run: ./${outfile} --version`)
