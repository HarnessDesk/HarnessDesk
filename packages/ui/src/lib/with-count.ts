/** A group counts its members only while there is something to count. */
export const withCount = (label: string, count: number): string => count > 0 ? `${label} · ${count}` : label
