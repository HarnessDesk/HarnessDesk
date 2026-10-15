// Vendored from lucide-animated (`rotate-cw`); ./index.ts says what changed.

import { MotionGlyph, type GlyphProps } from './glyph'

export const RotateCwGlyph = ({ controls, ...props }: GlyphProps) => (
  <MotionGlyph
    name="rotate-cw"
    animate={controls}
    transition={{ type: 'spring', stiffness: 250, damping: 25 }}
    variants={{
      normal: { rotate: '0deg' },
      animate: { rotate: '50deg' },
    }}
    {...props}
  >
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
  </MotionGlyph>
)
