#!/usr/bin/env bun
/**
 * Compile Claude Code into a standalone binary.
 *
 * Pipeline:
 *   1. Bun.build() → single JS file (no splitting, with feature flags)
 *   2. bun build --compile → standalone executable
 *
 * Usage:
 *   bun run scripts/compile.ts                    # default output: claude-code-bin
 *   bun run scripts/compile.ts --outfile=my-cli   # custom output name
 */
import { statSync, rmSync } from 'fs'
import { cp } from 'fs/promises'
import { join, dirname, resolve } from 'path'
import { getMacroDefines, DEFAULT_BUILD_FEATURES } from './defines.ts'

const outfile =
  process.argv.find(a => a.startsWith('--outfile='))?.split('=')[1] ??
  'claude-code-bin'

const compileOutdir = 'compile-out'

rmSync(compileOutdir, { recursive: true, force: true })

// Step 1: Bundle into single JS file
console.log('[1/3] Bundling with Bun.build() (single file)...')

const envFeatures = Object.keys(process.env)
  .filter(k => k.startsWith('FEATURE_'))
  .map(k => k.replace('FEATURE_', ''))
const features = [...new Set([...DEFAULT_BUILD_FEATURES, ...envFeatures])]

const result = await Bun.build({
  entrypoints: ['src/entrypoints/cli.tsx'],
  outdir: compileOutdir,
  target: 'bun',
  splitting: false,
  sourcemap: 'none',
  minify: true,
  define: {
    ...getMacroDefines(),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  features,
})

if (!result.success) {
  console.error('Bundle failed:')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

const entryPath = join(compileOutdir, 'cli.js')
console.log(`  Bundled → ${entryPath}`)

// Step 2: Compile to standalone binary
// Note: --bytecode is omitted because JSC bytecode compiler doesn't support
// some patterns in the bundled output. Source-mode compile still works well.
console.log(`[2/3] Compiling to standalone binary: ${outfile}...`)
const proc = Bun.spawnSync(
  ['bun', 'build', '--compile', `--outfile=${outfile}`, entryPath],
  { stdio: ['inherit', 'inherit', 'inherit'] },
)

if (proc.exitCode !== 0) {
  console.error('Compilation failed')
  process.exit(1)
}

// Step 3: Copy vendor files alongside the binary
console.log('[3/3] Copying vendor files...')
const outDir = dirname(resolve(outfile))
const vendorRipgrep = join(outDir, 'vendor', 'ripgrep')
await cp('src/utils/vendor/ripgrep', vendorRipgrep, { recursive: true })
console.log(`  Copied vendor/ripgrep/ → ${vendorRipgrep}/`)

rmSync(compileOutdir, { recursive: true, force: true })

const size = statSync(outfile).size
const sizeMB = Math.round(size / 1024 / 1024)
console.log(`\n  Standalone binary: ./${outfile} (${sizeMB} MB)`)
console.log(`  Run: ./${outfile} --version`)
