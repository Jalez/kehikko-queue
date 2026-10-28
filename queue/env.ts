/**
 * What of a caller's environment a run gets. The command runs as the caller would have run it —
 * the same PATH, the same tool versions — less anything that looks like a secret, which is held in
 * this process's memory only for as long as the run is queued or running, and never logged or
 * written down. A caller that needs one passes its name explicitly (`--keep-env NAME`).
 */

/** A name that looks like a secret. */
export const SECRET = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE|API_?KEY|ACCESS_?KEY|_KEY$|^KEY$|AUTH|COOKIE|SESSION_?KEY)/i

/** This module's own plumbing, which is not the caller's: a run never sees where Kehikot keeps things. */
const PLUMBING = /^(KEHIKOT_|KEHIKKO_|PORT$)/

export const ENV_MOST = 1000
export const ENV_VALUE_MOST = 32 * 1024
export const ENV_BYTES_MOST = 512 * 1024

/**
 * The environment a run is given: strings only, no secret-looking names unless kept, bounded. Null
 * when what was given is not an environment at all or is too large, with a sentence.
 */
export function runEnv(given: unknown, keep: readonly string[] = [], plumbing = false): { env: Record<string, string>; dropped: string[] } | { why: string } {
  if (!given || typeof given !== 'object' || Array.isArray(given)) return { why: 'The environment is an object of names and values.' }
  const env: Record<string, string> = {}
  const dropped: string[] = []
  let bytes = 0
  const entries = Object.entries(given as Record<string, unknown>)
  if (entries.length > ENV_MOST) return { why: `The environment has more than ${ENV_MOST} variables.` }
  for (const [name, value] of entries) {
    if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.length > ENV_VALUE_MOST) continue
    if (plumbing && PLUMBING.test(name)) continue
    if (SECRET.test(name) && !keep.includes(name)) {
      dropped.push(name)
      continue
    }
    bytes += name.length + value.length
    if (bytes > ENV_BYTES_MOST) return { why: 'The environment is larger than this queue takes.' }
    env[name] = value
  }
  return { env, dropped }
}
