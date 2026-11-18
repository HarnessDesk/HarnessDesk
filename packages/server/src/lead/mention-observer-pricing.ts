/** Rates are USD microdollars per million tokens. This plain value is captured
 * with each reservation so later configuration changes cannot reprice it. */
export interface MentionPriceSchedule {
  readonly model: string
  readonly version: string
  readonly promptThreshold: number
  readonly low: MentionRates
  readonly high: MentionRates
}

interface MentionRates {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite5m: number
  readonly cacheWrite1h: number
}

export interface MentionReportedUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly cacheWrite5mTokens?: number
  readonly cacheWrite1hTokens?: number
}

// Anthropic Haiku 5.5 overview, verified 2026-11-18:
// https://platform.claude.com/docs/en/models/haiku-5-5/overview
const HAIKU: MentionPriceSchedule = Object.freeze({
  model: 'claude-haiku-5-5', version: '2026-11-18', promptThreshold: 100_000,
  low: Object.freeze({ input: 100_000, output: 500_000, cacheRead: 10_000, cacheWrite5m: 125_000, cacheWrite1h: 200_000 }),
  high: Object.freeze({ input: 500_000, output: 2_500_000, cacheRead: 50_000, cacheWrite5m: 625_000, cacheWrite1h: 1_000_000 }),
})

export function mentionPriceSchedule(model: string): MentionPriceSchedule | null {
  return model === HAIKU.model ? HAIKU : null
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const validRates = (rates: MentionRates): boolean => !!rates && [rates.input, rates.output, rates.cacheRead, rates.cacheWrite5m, rates.cacheWrite1h].every(count)
const validSchedule = (schedule: MentionPriceSchedule): boolean => !!schedule && typeof schedule.model === 'string' && schedule.model.length > 0 && typeof schedule.version === 'string' && schedule.version.length > 0 && count(schedule.promptThreshold) && validRates(schedule.low) && validRates(schedule.high)

function roundedCost(terms: readonly (readonly [number, number])[]): number | null {
  const numerator = terms.reduce((sum, [tokens, rate]) => sum + BigInt(tokens) * BigInt(rate), 0n)
  const result = (numerator + 999_999n) / 1_000_000n
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null
}

/** Conservative admission accounting for the bounded request, not a guarantee
 * about provider invoices outside the reported token and pricing contract. */
export function quoteMentionHold(schedule: MentionPriceSchedule, inputUpper: number, maxOutput: number): number | null {
  if (!validSchedule(schedule) || !count(inputUpper) || !count(maxOutput)) return null
  const tiers = [schedule.low, schedule.high]
  const inputRate = Math.max(...tiers.flatMap(r => [r.input, r.cacheRead, r.cacheWrite5m, r.cacheWrite1h]))
  const outputRate = Math.max(...tiers.map(r => r.output))
  return roundedCost([[inputUpper, inputRate], [maxOutput, outputRate]])
}

export function priceMentionUsage(schedule: MentionPriceSchedule, usage: MentionReportedUsage): number | null {
  if (!validSchedule(schedule) || !usage || ![usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].every(count)) return null
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheWrite5mTokens, cacheWrite1hTokens } = usage
  if ((cacheWrite5mTokens !== undefined && !count(cacheWrite5mTokens)) || (cacheWrite1hTokens !== undefined && !count(cacheWrite1hTokens))) return null
  if (cacheWriteTokens > 0 && (cacheWrite5mTokens === undefined || cacheWrite1hTokens === undefined)) return null
  const write5m = cacheWrite5mTokens ?? 0, write1h = cacheWrite1hTokens ?? 0
  const writes = BigInt(write5m) + BigInt(write1h)
  if (writes !== BigInt(cacheWriteTokens)) return null
  const prompt = BigInt(inputTokens) + BigInt(cacheReadTokens) + BigInt(cacheWriteTokens)
  if (prompt > BigInt(Number.MAX_SAFE_INTEGER)) return null
  const rates = prompt > BigInt(schedule.promptThreshold) ? schedule.high : schedule.low
  return roundedCost([[inputTokens, rates.input], [outputTokens, rates.output], [cacheReadTokens, rates.cacheRead], [write5m, rates.cacheWrite5m], [write1h, rates.cacheWrite1h]])
}
