// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * Hooks are user-defined shell commands that can be executed at various points
 * in Claude Code's lifecycle.
 *
 * This barrel re-exports from the domain modules in hooks/.
 */
export * from './hooks/types.js'
export * from './hooks/engine.js'
export * from './hooks/matching.js'
export * from './hooks/replContext.js'
export * from './hooks/outsideRepl.js'
export * from './hooks/dispatchers.js'
