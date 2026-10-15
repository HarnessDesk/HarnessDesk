// Vendored from lucide-animated (`message-square`); ./index.ts says what changed.

import type { Variants } from 'motion/react'

import { MotionGlyph, type GlyphProps } from './glyph'

const ICON_VARIANTS: Variants = {
  normal: {
    scale: 1,
    rotate: 0,
  },
  animate: {
    scale: 1.05,
    rotate: [0, -7, 7, 0],
    transition: {
      rotate: {
        duration: 0.5,
        ease: 'easeInOut',
      },
      scale: {
        type: 'spring',
        stiffness: 400,
        damping: 10,
      },
    },
  },
}

export const MessageSquareGlyph = ({ controls, ...props }: GlyphProps) => (
  <MotionGlyph
    name="message-square"
    animate={controls}
    variants={ICON_VARIANTS}
    {...props}
  >
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </MotionGlyph>
)
