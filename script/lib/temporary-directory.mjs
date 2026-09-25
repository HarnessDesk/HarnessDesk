import { rmSync } from 'node:fs'

const TRANSIENT = new Set(['EBUSY', 'ENOTEMPTY'])

/** Remove a validated temporary directory without failing completed work on a late helper write. */
export const removeTemporaryDirectory = (
  directory,
  { remove = rmSync, warn = (message) => process.stderr.write(`${message}\n`) } = {},
) => {
  try {
    remove(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 })
    return true
  } catch (error) {
    if (!TRANSIENT.has(error?.code)) throw error
    warn('warning: a temporary native-test directory remained busy after cleanup retries')
    return false
  }
}
