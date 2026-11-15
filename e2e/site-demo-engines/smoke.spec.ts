import { expect, test } from '@playwright/test'

test('reduced motion and the staged Run work in the built demo', async ({ page, baseURL }) => {
  const errors: string[] = []
  const external: string[] = []
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === baseURL) return route.continue()
    external.push(url.origin)
    return route.abort()
  })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/?view=flow&stage=write&theme=light')
  const demo = page.locator('[data-slot="site-run-demo"]')
  await expect(demo).toHaveAttribute('data-stage', 'write')
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)

  // Exercise the production stylesheet, including an instantaneous transition.
  const motion = await page.evaluate(() => {
    const node = document.createElement('div')
    node.style.cssText = 'width: 100px; transition: width 300ms ease'
    document.body.append(node)
    getComputedStyle(node).width
    node.style.width = '0px'
    const result = { width: node.getBoundingClientRect().width, duration: getComputedStyle(node).transitionDuration }
    node.remove()
    return result
  })
  expect(motion).toEqual({ width: 0, duration: '0s' })
  // Reduced motion stops automatic playback, while the real control still works.
  await page.waitForTimeout(3800)
  await expect(demo).toHaveAttribute('data-stage', 'write')
  await page.getByRole('button', { name: 'Next step', exact: true }).click()
  await expect(demo).toHaveAttribute('data-stage', 'check')
  expect(errors).toEqual([])
  expect(external).toEqual([])
})
