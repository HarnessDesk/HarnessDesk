import { execFile } from 'node:child_process'

/**
 * The one discipline every device engine shares: `execFile` (never a
 * shell), a mandatory timeout, and stderr folded into the failure — a hung
 * or chatty device binary must never hang or garble an agent's turn.
 */

export interface DeviceRun {
  readonly stdout: string
  readonly stderr: string
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export const isPng = (buffer: Buffer): boolean =>
  buffer.length >= PNG_MAGIC.length && buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)

export const runDevice = (
  binary: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly what: string },
): Promise<DeviceRun> =>
  new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      { timeout: options.timeoutMs ?? 20_000, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.toString().trim().split('\n').slice(-2).join(' · ')
          reject(new Error(`${options.what} failed: ${detail || error.message}`))
        } else {
          resolve({ stdout: stdout.toString(), stderr: stderr.toString() })
        }
      },
    )
  })

/** The same, but the stdout is binary (a screenshot) and becomes a data URL. */
export const runDeviceForPng = (
  binary: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly what: string },
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      { timeout: options.timeoutMs ?? 20_000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr ?? '').toString().trim().split('\n').slice(-2).join(' · ')
          reject(new Error(`${options.what} failed: ${detail || error.message}`))
        } else if (stdout.length === 0) {
          reject(new Error(`${options.what} produced no image.`))
        } else if (!isPng(stdout)) {
          reject(new Error(`${options.what} produced non-PNG output.`))
        } else {
          resolve(`data:image/png;base64,${stdout.toString('base64')}`)
        }
      },
    )
  })
