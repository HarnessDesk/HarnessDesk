// Vendored from lucide-animated (`chevron-down`); ./index.ts says what changed.

import { motion, type Transition } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const DEFAULT_TRANSITION: Transition = {
  times: [0, 0.4, 1],
  duration: 0.5,
}

export const ChevronDownGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="chevron-down" {...props}>
    <motion.path
      animate={controls}
      d="m6 9 6 6 6-6"
      transition={DEFAULT_TRANSITION}
      variants={{
        normal: { y: 0 },
        animate: { y: [0, 2, 0] },
      }}
    />
  </Glyph>
)
