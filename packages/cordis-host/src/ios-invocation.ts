import { AsyncLocalStorage } from 'node:async_hooks'
const invocations = new AsyncLocalStorage<string>()
export const currentIosInvocation = (): string => {
  const value = invocations.getStore()
  if (!value) throw new Error('Simulator control requires a live host invocation.')
  return value
}
export const withIosInvocation = <T>(invocation: string | undefined, run: () => T): T => invocation === undefined ? run() : invocations.run(invocation, run)
