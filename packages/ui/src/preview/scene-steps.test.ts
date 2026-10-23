import { afterEach, expect, it, vi } from 'vitest'

import { runSceneSteps } from './scene-steps'

afterEach(() => {
  document.body.replaceChildren()
  delete document.documentElement.dataset.sceneSteps
  delete document.documentElement.dataset.sceneStepsMissed
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('abandons the first scene replay when StrictMode remounts its effect', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16))
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100))
  document.body.innerHTML = '<div id="root"></div>'
  const button = document.createElement('button')
  button.id = 'rail'
  button.setAttribute('aria-pressed', 'false')
  setTimeout(() => document.querySelector('#root')!.append(button), 1000)
  const click = vi.fn(() => button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true')))
  button.addEventListener('click', click)
  const controller = new AbortController()
  const steps = [{ click: '#rail[aria-pressed="false"]', unless: '#rail[aria-pressed="true"]' }]
  const first = runSceneSteps(steps, controller.signal)
  controller.abort()
  const second = runSceneSteps(steps, new AbortController().signal)
  await vi.runAllTimersAsync()
  await Promise.all([first, second])
  expect(click).toHaveBeenCalledTimes(1)
  expect(button.getAttribute('aria-pressed')).toBe('true')
  expect(document.documentElement.dataset.sceneSteps).toBe('done')
})
