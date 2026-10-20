import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`Flow example pauses and resumes the real ring paint and relay in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' })
    await page.goto(`/preview.html?flows-page&theme=${theme}`)
    await page.getByRole('checkbox', { name: 'Open Write and review', exact: true }).click()
    const example = page.locator('[data-slot="flow-example"]')
    // Step once so both the current card and a declared transition have motion.
    await example.getByRole('button', { name: 'Next', exact: true }).click()
    const ring = example.locator('[data-slot="flow-ring"]')
    const baton = example.locator('[data-slot="flow-baton"]')
    await expect(ring).toHaveCount(1)
    await expect(baton).toHaveCount(1)
    const states = () => example.evaluate(root => ({
      ring: getComputedStyle(root.querySelector('[data-slot="flow-ring"]')!, '::before').animationPlayState,
      relay: getComputedStyle(root.querySelector('[data-slot="flow-baton"]')!).animationPlayState,
    }))
    await expect.poll(states).toEqual({ ring: 'paused', relay: 'paused' })
    await example.getByRole('button', { name: 'Play', exact: true }).click()
    await expect.poll(states).toEqual({ ring: 'running', relay: 'running' })
    await example.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect.poll(states).toEqual({ ring: 'paused', relay: 'paused' })
    const held = await example.evaluate(async root => {
      const animations = root.getAnimations({ subtree: true })
      await Promise.all(animations.map(animation => animation.ready))
      const before = animations.map(animation => animation.currentTime)
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
      return { count: animations.length, states: animations.map(animation => animation.playState),
        before, after: animations.map(animation => animation.currentTime) }
    })
    expect(held.count).toBe(2)
    expect(held.states).toEqual(['paused', 'paused'])
    expect(held.after).toEqual(held.before)
    await example.getByRole('button', { name: 'Play', exact: true }).click()
    await expect.poll(states).toEqual({ ring: 'running', relay: 'running' })
    await example.getByRole('button', { name: 'Pause', exact: true }).click()

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(example.getByRole('button', { name: 'Play', exact: true })).toBeDisabled()
    await expect(example).toContainText('Use Next with reduced motion.')
    expect(await example.evaluate(root => ({
      ring: getComputedStyle(root.querySelector('[data-slot="flow-ring"]')!, '::before').animationName,
      relay: getComputedStyle(root.querySelector('[data-slot="flow-baton"]')!).animationName,
      active: root.getAnimations({ subtree: true }).length,
    }))).toEqual({ ring: 'none', relay: 'none', active: 0 })
    await example.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(example).toHaveAttribute('data-playing', 'false')
    await expect(example).toContainText('Use Next with reduced motion.')
  })
}
