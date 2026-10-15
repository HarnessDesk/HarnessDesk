// Vendored from lucide-animated (`chevron-left`); ./index.ts says what changed.

import { motion, type Transition } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const DEFAULT_TRANSITION: Transition = {
  times: [0, 0.4, 1],
  duration: 0.5,
}

export const ChevronLeftGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="chevron-left" {...props}>
    <motion.path
      animate={controls}
      d="m15 18-6-6 6-6"
      transition={DEFAULT_TRANSITION}
      variants={{
        normal: { x: 0 },
        animate: { x: [0, -2, 0] },
      }}
    />
  </Glyph>
)
