/** The views approved for live embedding. Later scenes join this registry. */
export const SCENES = {
  dashboard: { width: 960, height: 600 },
  'dashboard-spend': { width: 672, height: 432 },
  'dashboard-limits': { width: 672, height: 432 },
  'dashboard-activity': { width: 672, height: 432 },
} as const

export type SceneName = keyof typeof SCENES
export const isSceneName = (value: string): value is SceneName => Object.hasOwn(SCENES, value)
