import { laneEnvironmentOf } from '@harnessdesk/protocol'

const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export const environmentSupported = (meta: unknown): boolean =>
  object(object(meta).harnessdesk).sessionEnvironment === true

export function environmentMeta(
  meta: Record<string, unknown>,
  environment: Readonly<Record<string, string>>,
  supported: boolean,
): Record<string, unknown> {
  if (!supported) {
    throw new Error(
      'This runtime cannot pass a lane environment to a session. ' +
        'Choose a runtime with lane support, or turn isolation off.',
    )
  }
  return {
    ...meta,
    harnessdesk: { ...object(meta.harnessdesk), environment: laneEnvironmentOf(environment) },
  }
}

export function acknowledgeEnvironment(
  meta: unknown,
  requested: Readonly<Record<string, string>>,
): void {
  let received: Readonly<Record<string, string>>
  try {
    received = laneEnvironmentOf(object(object(meta).harnessdesk).environment)
  } catch {
    throw new Error(
      'This runtime did not acknowledge the lane environment. ' +
        'Choose a runtime with lane support, or turn isolation off.',
    )
  }
  const expected = laneEnvironmentOf(requested)
  if (Object.keys(expected).some((key) => expected[key] !== received[key])) {
    throw new Error(
      'This runtime did not acknowledge the lane environment. ' +
        'Choose a runtime with lane support, or turn isolation off.',
    )
  }
}
