#!/usr/bin/env bun
/**
 * Compile Alice CLI into a standalone binary.
 *
 * Pipeline:
 *   1. Bun.build() → single JS file (no splitting, with feature flags)
 *   2. bun build --compile → standalone executable
 *
 * Usage:
 *   bun run scripts/compile.ts                    # default output: alice
 *   bun run scripts/compile.ts --outfile=my-cli   # custom output name
 */
import { statSync, rmSync, mkdirSync } from 'fs'
import { cp } from 'fs/promises'
import { join, dirname, resolve } from 'path'
import { getMacroDefines, DEFAULT_BUILD_FEATURES } from './defines.ts'

const TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-windows-x64',
] as const

const targetArg = process.argv
  .find(a => a.startsWith('--target='))
  ?.split('=')[1]
const allTargets = process.argv.includes('--all')
const outfile =
  process.argv.find(a => a.startsWith('--outfile='))?.split('=')[1] ?? 'alice'
const binDir = 'bin'

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

mkdirSync(binDir, { recursive: true })

async function compileForTarget(target?: string): Promise<void> {
  const isWindows = target?.includes('windows')
  const suffix = isWindows ? '.exe' : ''
  const platformSuffix = target ? `-${target.replace('bun-', '')}` : ''
  const outputName = join(binDir, `${outfile}${platformSuffix}${suffix}`)

  const args = [
    'bun',
    'build',
    '--compile',
    `--outfile=${outputName}`,
    entryPath,
  ]
  if (target) {
    args.splice(3, 0, `--target=${target}`)
  }

  console.log(
    `[2/3] Compiling: ${outputName}${target ? ` (${target})` : ''}...`,
  )
  const proc = Bun.spawnSync(args, { stdio: ['inherit', 'inherit', 'inherit'] })

  if (proc.exitCode !== 0) {
    console.error(`Compilation failed for ${target ?? 'native'}`)
    process.exit(1)
  }

  // Copy vendor files alongside the binary
  const outDir = dirname(resolve(outputName))
  const vendorRipgrep = join(outDir, 'vendor', 'ripgrep')
  await cp('src/utils/vendor/ripgrep', vendorRipgrep, { recursive: true })

  const size = statSync(outputName).size
  const sizeMB = Math.round(size / 1024 / 1024)
  console.log(`  → ${outputName} (${sizeMB} MB)`)
}

if (allTargets) {
  console.log(`[2/3] Cross-compiling for ${TARGETS.length} platforms...`)
  for (const target of TARGETS) {
    await compileForTarget(target)
  }
} else if (targetArg) {
  if (!TARGETS.includes(targetArg as (typeof TARGETS)[number])) {
    console.error(`Unknown target: ${targetArg}`)
    console.error(`Available: ${TARGETS.join(', ')}`)
    process.exit(1)
  }
  await compileForTarget(targetArg)
} else {
  await compileForTarget()
}

// Step 3: Copy vendor files (already done per-target above)
console.log('[3/3] Vendor files copied.')

rmSync(compileOutdir, { recursive: true, force: true })

const nativeBin = join(binDir, outfile)
if (!allTargets && !targetArg) {
  console.log(
    `\n  Standalone binary: ${nativeBin} (${Math.round(statSync(nativeBin).size / 1024 / 1024)} MB)`,
  )
  console.log(`  Run: ./${nativeBin} --version`)
} else {
  console.log('\n  All binaries compiled successfully.')
  console.log(`  Output: ${binDir}/`)
  if (allTargets) {
    for (const t of TARGETS) {
      const isWin = t.includes('windows')
      const name = `${outfile}-${t.replace('bun-', '')}${isWin ? '.exe' : ''}`
      console.log(`    ${binDir}/${name}`)
    }
  } else {
    const isWin = targetArg?.includes('windows')
    const name = `${outfile}-${targetArg!.replace('bun-', '')}${isWin ? '.exe' : ''}`
    console.log(`    ${binDir}/${name}`)
  }
}
