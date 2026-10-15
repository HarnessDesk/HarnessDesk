// Vendored from lucide-animated (`rotate-ccw`); ./index.ts says what changed.

import { MotionGlyph, type GlyphProps } from './glyph'

export const RotateCcwGlyph = ({ controls, ...props }: GlyphProps) => (
  <MotionGlyph
    name="rotate-ccw"
    animate={controls}
    transition={{ type: 'spring', stiffness: 250, damping: 25 }}
    variants={{
      normal: { rotate: '0deg' },
      animate: { rotate: '-50deg' },
    }}
    {...props}
  >
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </MotionGlyph>
)
