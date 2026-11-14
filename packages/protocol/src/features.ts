/** Host-owned optional services; launch flags are defaults only. */
export type DeskFeature = 'lead' | 'mobile'
export interface DeskFeatureProblem {
  readonly kind: 'preferences' | 'transition'
  readonly message: string
  readonly feature?: DeskFeature
}
/** Flags are the last acknowledged choices. A problem fences service admission until explicit repair. */
export interface DeskFeatureState {
  readonly lead: boolean
  readonly mobile: boolean
  readonly problem?: DeskFeatureProblem
}
