export interface GroupableRunStep {
  readonly step: string
  readonly state: string
  readonly signature: string
}

/** Only adjacent, completed visits of one step with the same recorded result fold. */
export const groupRunSteps = <T extends GroupableRunStep>(rows: readonly T[]): readonly (readonly T[])[] => {
  const groups: T[][] = []
  for (const row of rows) {
    const last = groups.at(-1)
    const before = last?.at(-1)
    if (row.state === 'done' && before?.state === 'done' && row.step === before.step && row.signature === before.signature) last!.push(row)
    else groups.push([row])
  }
  return groups
}
