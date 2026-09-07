#!/usr/bin/env bun
/**
 * Post-build processing for Vite build output.
 *
 * 1. Copy native addon files
 * 2. Generate executable entry point (Bun only)
 */
import { writeFile, cp } from 'node:fs/promises'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'

const outdir = 'dist'

async function postBuild() {
  // Step 1: Copy native addon files
  const audioCaptureDir = join(outdir, 'vendor', 'audio-capture')
  await cp('vendor/audio-capture', audioCaptureDir, {
    recursive: true,
  } as never)
  console.log(`Copied vendor/audio-capture/ → ${audioCaptureDir}/`)

  const ripgrepDir = join(outdir, 'vendor', 'ripgrep')
  await cp('src/utils/vendor/ripgrep', ripgrepDir, { recursive: true } as never)
  console.log(`Copied src/utils/vendor/ripgrep/ → ${ripgrepDir}/`)

  // Step 2: Generate executable entry point (Bun only)
  const cliBun = join(outdir, 'cli-bun.js')
  await writeFile(cliBun, '#!/usr/bin/env bun\nimport "./cli.js"\n')
  chmodSync(cliBun, 0o755)

  console.log(
    'Post-build complete: copied vendor assets, generated entry point',
  )
}

postBuild().catch(err => {
  console.error('Post-build failed:', err)
  process.exit(1)
})
