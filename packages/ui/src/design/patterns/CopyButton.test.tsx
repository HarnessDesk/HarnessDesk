import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, afterEach, expect, test, vi } from 'vitest'

import { CopyButton } from '../index'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)
const writeText = vi.fn<(text: string) => Promise<void>>()
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

afterEach(async () => {
  writeText.mockReset()
  await act(() => root.render(null))
})

afterAll(async () => {
  await act(() => root.unmount())
  host.remove()
})

const press = async () => {
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button')!.click()
    await Promise.resolve()
  })
}

test('copies the text and says so, to the row that shows it as well', async () => {
  writeText.mockResolvedValue()
  const onCopiedChange = vi.fn()
  await act(() => root.render(<CopyButton text="pnpm verify" label="Copy this command" onCopiedChange={onCopiedChange} />))
  expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Copy this command')

  await press()
  expect(writeText).toHaveBeenCalledWith('pnpm verify')
  expect(onCopiedChange).toHaveBeenLastCalledWith(true)
})

test('hands a failed write back rather than swallowing it', async () => {
  writeText.mockRejectedValue(new Error('denied'))
  const onError = vi.fn()
  const onCopiedChange = vi.fn()
  await act(() => root.render(<CopyButton text="pnpm verify" label="Copy this command" onError={onError} onCopiedChange={onCopiedChange} />))

  await press()
  await act(async () => { await Promise.resolve() })
  expect(onError).toHaveBeenCalledTimes(1)
  expect(onCopiedChange).not.toHaveBeenCalled()
})
