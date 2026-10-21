import { expect, it } from 'vitest'

import { projectNeedsOpening } from './workspace-recovery'

it.each([
  '/work/storefront is outside every folder and repository opened here. Open it first.',
  '/work/storefront is outside every open workspace. Open its folder first to read from it.',
  'The project checkout changed. Open the project folder again, then preview again.',
  'The project checkout changed. Open the project folder again, then try again.',
])('offers project recovery for the host instruction: %s', text => {
  expect(projectNeedsOpening(text)).toBe(true)
})

it.each([
  'The project checkout changed.',
  'Open the project folder again, then try again.',
  'The project checkout changed. The runtime is unavailable.',
  'The project checkout changed. Open the project folder again, then run the command.',
  'Choose a project folder, then try again.',
])('does not infer project recovery from an unrelated or incomplete refusal: %s', text => {
  expect(projectNeedsOpening(text)).toBe(false)
})
