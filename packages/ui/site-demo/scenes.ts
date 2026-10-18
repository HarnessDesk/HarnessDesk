/** The views approved for live embedding. Later scenes join this registry. */
export const SCENES = {
  dashboard: { width: 960, height: 600 },
  'dashboard-spend': { width: 672, height: 432 },
  'dashboard-limits': { width: 672, height: 432 },
  'dashboard-activity': { width: 672, height: 432 },
  // The tour: one App window per destination, at the tour's 800 × 500.
  'tour-teams': { width: 800, height: 500 },
  'tour-run': { width: 800, height: 500 },
  'tour-flows': { width: 800, height: 500 },
  'tour-library': { width: 800, height: 500 },
  'tour-runtimes': { width: 800, height: 500 },
  'tour-chats': { width: 800, height: 500 },
  // The hero: the README's race, Side by side on two Browsers.
  'hero-race': { width: 1200, height: 750 },
} as const

export type SceneName = keyof typeof SCENES
export const isDashboardScene = (name: SceneName): name is 'dashboard' | 'dashboard-spend' | 'dashboard-limits' | 'dashboard-activity' => name.startsWith('dashboard')
export const isSceneName = (value: string): value is SceneName => Object.hasOwn(SCENES, value)
