import { Context } from '@deepseek-ai/cordis'
import { IosService } from '../../src/ios.js'
import type { HostRuntime } from '../../src/runtime.js'

// A synthetic 1 × 1 PNG, including IHDR, compressed image data and IEND.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64')
export type { IosProbeResult as ProbeResult } from '../../src/ios-environment.js'

export const iosService = (dependencies: ConstructorParameters<typeof IosService>[2] = {}, denied = false): IosService => {
  const runtime = { owner: () => ({ gate: { assertIos() { if (denied) throw new Error('ios permission denied') } } }) }
  return new IosService(new Context(), runtime as unknown as HostRuntime, dependencies)
}
