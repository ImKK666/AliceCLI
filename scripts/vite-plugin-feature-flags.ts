import type { Plugin } from 'rollup'
import { DEFAULT_BUILD_FEATURES } from './defines.ts'

/**
 * Collect enabled feature flags from defaults + env vars.
 */
export function getEnabledFeatures(): Set<string> {
  const envFeatures = Object.keys(process.env)
    .filter(k => k.startsWith('FEATURE_'))
    .map(k => k.replace('FEATURE_', ''))
  return new Set([...DEFAULT_BUILD_FEATURES, ...envFeatures])
}

// Regex to match feature('FLAG_NAME') calls with string literal arguments
const FEATURE_CALL_RE = /feature\s*\(\s*['"]([\w]+)['"]\s*\)/g

/**
 * Vite/Rollup plugin that replaces `feature('X')` calls with boolean literals
 * at the transform stage, BEFORE the bundler resolves imports.
 *
 * This approach is necessary because some feature-gated code blocks contain
 * require() calls to files that don't exist (e.g. hunter.js inside
 * feature('REVIEW_ARTIFACT')). The bundler must see these as dead code
 * (`if (false) { ... }`) before attempting import resolution.
 *
 * Also resolves `import { feature } from 'bun:bundle'` as a virtual module
 * to prevent "module not found" errors.
 */
export default function featureFlagsPlugin(): Plugin {
  const features = getEnabledFeatures()

  const virtualModuleId = 'bun:bundle'
  const resolvedVirtualModuleId = '\0' + virtualModuleId

  return {
    name: 'feature-flags',

    // Resolve bun:bundle as a virtual module (prevents "module not found")
    resolveId(id) {
      if (id === virtualModuleId) {
        return resolvedVirtualModuleId
      }
    },

    // Provide a stub export for bun:bundle (unused at runtime after transform)
    load(id) {
      if (id === resolvedVirtualModuleId) {
        return 'export function feature(name) { return false; }'
      }
    },

    transform(code, id) {
      if (id.includes('node_modules')) return null

      let matchCount = 0
      const transformed = code.replace(FEATURE_CALL_RE, (match, flagName) => {
        matchCount++
        return features.has(flagName) ? 'true' : 'false'
      })

      if (matchCount === 0) return null
      return { code: transformed, map: null }
    },
  }
}
