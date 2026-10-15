// Vendored from lucide-animated (`plus`); ./index.ts says what changed.

import { MotionGlyph, type GlyphProps } from './glyph'

export const PlusGlyph = ({ controls, ...props }: GlyphProps) => (
  <MotionGlyph
    name="plus"
    animate={controls}
    transition={{ type: 'spring', stiffness: 100, damping: 15 }}
    variants={{
      normal: {
        rotate: 0,
      },
      animate: {
        rotate: 180,
      },
    }}
    {...props}
  >
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </MotionGlyph>
)
