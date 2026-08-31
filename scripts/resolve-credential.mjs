// Shared credential resolution for the dev scripts, in priority order:
// 1. $MOONSHOTAI_CN_API_KEY (or $MOONSHOT_API_KEY) from the environment;
// 2. the DSH credentials store at ~/.dsh/.credentials.yaml (parsed with a
//    regex so these scripts have no dependencies).
// The key is never printed.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The default credential reference, matching the plugin's `apiKeyEnv` default. */
export const DEFAULT_API_KEY_ENV = 'MOONSHOTAI_CN_API_KEY'

/**
 * Resolve a Kimi API key for the dev scripts.
 * @returns {string} the resolved key.
 * @throws when no key can be found, with setup guidance.
 */
export function resolveApiKey() {
  for (const name of [DEFAULT_API_KEY_ENV, 'MOONSHOT_API_KEY']) {
    const value = process.env[name]
    if (typeof value === 'string' && value.length > 0) return value
  }
  try {
    const yaml = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const match = /MOONSHOTAI_CN_API_KEY:\s*"?([^\s"}]+)"?/.exec(yaml)
    if (match?.[1] !== undefined && match[1].length > 0) return match[1]
  } catch {
    // fall through to the guidance error below
  }
  throw new Error(
    'No Kimi API key found. Export MOONSHOTAI_CN_API_KEY, or configure a Moonshot '
    + 'provider on the DSH Models page so the credentials store holds one.',
  )
}
