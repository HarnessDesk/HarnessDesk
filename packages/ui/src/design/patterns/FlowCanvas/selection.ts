const sameIds = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every(id => right.includes(id))

export const selectionMatches = (
  actual: { nodes: readonly string[]; edges: readonly string[] },
  controlled: { nodes: readonly string[]; edges: readonly string[] },
) => sameIds(actual.nodes, controlled.nodes) && sameIds(actual.edges, controlled.edges)
