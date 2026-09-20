import { laneEnvironmentOf } from '@harnessdesk/protocol'

const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export function environmentIn(meta: unknown): Readonly<Record<string, string>> | undefined {
  const ours = object(object(meta).harnessdesk)
  return Object.hasOwn(ours, 'environment') ? laneEnvironmentOf(ours.environment) : undefined
}

export function childEnvironment(
  base: NodeJS.ProcessEnv,
  environment?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  return { ...base, ...(environment === undefined ? {} : laneEnvironmentOf(environment)) }
}

export function environmentAck<T extends object>(
  response: T,
  environment: Readonly<Record<string, string>> | undefined,
): T & { _meta?: Record<string, unknown> } {
  if (!environment) return response
  const meta = object((response as { _meta?: unknown })._meta)
  return {
    ...response,
    _meta: {
      ...meta,
      harnessdesk: { ...object(meta.harnessdesk), environment: laneEnvironmentOf(environment) },
    },
  }
}
