/**
 * One scene, from staging to frames to putting things back.
 *
 * Staged once and photographed once per theme, because both themes photograph
 * the same staged state. Whatever the scene changed is put back afterwards
 * whether or not it got its frames: a scene that bent an agent's history and
 * then failed on its frame would otherwise leave the desk bent for the next
 * take. And when both fail, the scene's own failure is the one reported, not
 * the failure to tidy up after it.
 *
 * Kept apart from `shoot.mjs` so a test can run it: that driver runs the app
 * as it is imported.
 *
 * @param {{ leaveOverlay?: boolean, run: () => Promise<unknown>, finish?: () => unknown }} scene
 * @param {{ leaveOverlay: () => Promise<unknown>, themes: readonly string[], photograph: (theme: string) => Promise<unknown> }} around
 */
export const runScene = async (scene, { leaveOverlay, themes, photograph }) => {
  try {
    if (scene.leaveOverlay) await leaveOverlay()
    await scene.run()
    for (const theme of themes) await photograph(theme)
  } catch (error) {
    try {
      await scene.finish?.()
    } catch {
      /* Not reported: it would hide why the scene failed. */
    }
    throw error
  }
  await scene.finish?.()
}
