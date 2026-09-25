const KEYS = [
  'HARNESSDESK_GOAL_ID',
  'HARNESSDESK_LANE_ID',
  'HARNESSDESK_PORT_START',
  'HARNESSDESK_PORT_END',
  'HARNESSDESK_PORT_COUNT',
  'PORT',
] as const

export function laneEnvironmentOf(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The lane environment is incomplete.')
  }
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).length !== KEYS.length ||
    KEYS.some((key) => {
      const text = input[key]
      return (
        typeof text !== 'string' ||
        text.length === 0 ||
        /[\u0000-\u001f\u007f]/.test(text) ||
        text.length > (key === 'HARNESSDESK_GOAL_ID' ? 4_096 : 200)
      )
    })
  ) {
    throw new Error('The lane environment is incomplete.')
  }
  const start = Number(input.HARNESSDESK_PORT_START)
  const end = Number(input.HARNESSDESK_PORT_END)
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1_024 ||
    end > 65_535 ||
    end < start ||
    end - start + 1 > 1_000 ||
    input.HARNESSDESK_PORT_START !== String(start) ||
    input.HARNESSDESK_PORT_END !== String(end) ||
    input.HARNESSDESK_PORT_COUNT !== String(end - start + 1) ||
    input.PORT !== String(start)
  ) {
    throw new Error('The lane port block is invalid.')
  }
  return Object.freeze(Object.fromEntries(KEYS.map((key) => [key, input[key] as string])))
}
