/** The position-only fixture starts at identity before its measured centering pass. */
export const shapeViewportReady = ({ scale, x, y }: { scale: number; x: number; y: number }): boolean => scale >= 0.8 && (x !== 0 || y !== 0)
