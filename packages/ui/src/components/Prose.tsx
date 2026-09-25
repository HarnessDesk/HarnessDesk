import { codeSpans } from '../lib/health'
import { CodeText } from '../design'

/**
 * Host or agent text, with what it wrote between backticks set as code.
 *
 * The strings that reach a settings row or a sign-in card are written for a
 * log and a terminal as well as for this window, so a command or a variable
 * arrives in Markdown's backticks; drawn literally, they are the one place
 * the backticks mean nothing. Nothing else in the string is interpreted.
 */
export const Prose = ({ text }: { text: string }) => (
  <>
    {codeSpans(text).map((span, index) =>
      span.code ? (
        <CodeText as="code" key={index}>
          {span.text}
        </CodeText>
      ) : (
        <span key={index}>{span.text}</span>
      ),
    )}
  </>
)
