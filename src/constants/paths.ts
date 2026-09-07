import { join } from 'path'

export const CONFIG_DIR_NAME = '.alice'
export const LEGACY_CONFIG_DIR_NAME = '.claude'
export const CONFIG_FILE_NAME = 'ALICE.md'
export const LEGACY_CONFIG_FILE_NAME = 'CLAUDE.md'
export const CONFIG_JSON_NAME = '.alice.json'
export const LEGACY_CONFIG_JSON_NAME = '.claude.json'

export function getConfigDir(root: string): string {
  return join(root, CONFIG_DIR_NAME)
}

export function getLegacyConfigDir(root: string): string {
  return join(root, LEGACY_CONFIG_DIR_NAME)
}
