import { appendFileSync, readFileSync } from 'node:fs'
export const recordInterrupt = file => appendFileSync(file, 'I', { mode: 0o600 })
export const interruptCount = file => {
  const data = readFileSync(file)
  if (data.length > 1000 || !data.every(byte => byte === 73)) throw new Error('invalid synthetic counter')
  return data.length
}
