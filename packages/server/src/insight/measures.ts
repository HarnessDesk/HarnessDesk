import type { Measure } from '@harnessdesk/protocol'

/**
 * Adds only known non-negative quantities.  A partial total is a floor, while
 * a rate-derived total remains an estimate even when every source was read.
 */
export function sumMeasures(parts: readonly Measure[]): Measure {
  if (parts.length === 0) return { value: null, quality: 'unknown' }
  const known = parts.filter((part) => part.value !== null)
  if (known.length === 0) return { value: null, quality: 'unknown' }
  if (known.some((part) => !Number.isFinite(part.value!) || part.value! < 0)) {
    throw new Error('Usage contains an invalid number. Refresh its source.')
  }
  const value = known.reduce((sum, part) => sum + part.value!, 0)
  if (!Number.isFinite(value)) throw new Error('Usage is too large to total safely.')
  const quality = known.some((part) => part.quality === 'estimate')
    ? 'estimate'
    : known.length !== parts.length || known.some((part) => part.quality !== 'exact')
      ? 'floor'
      : 'exact'
  return { value, quality }
}
