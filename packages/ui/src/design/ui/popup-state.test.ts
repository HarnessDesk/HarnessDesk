import { expect, test } from 'vitest'
import { menusOpen, registerMenu } from './popup-state'
test('one closing flyout cannot unblock cards while its parent is open', () => {
  const parent = registerMenu(Symbol('parent'))
  const child = registerMenu(Symbol('child'))
  expect(menusOpen()).toBe(true)
  child()
  expect(menusOpen()).toBe(true)
  parent()
  expect(menusOpen()).toBe(false)
})
test('cleanup is idempotent', () => {
  const close = registerMenu(Symbol('one'))
  close(); close()
  expect(menusOpen()).toBe(false)
})
