export type Command = 'run' | 'list-conversations'

// Map instead of a list so the type guard and the error message share one source.
const COMMANDS: Record<Command, true> = {
  run: true,
  'list-conversations': true,
}

function isCommand(value: string): value is Command {
  return Object.hasOwn(COMMANDS, value)
}

/**
 * With no subcommand, run capture. Any unknown token fails: falling through to the
 * default would let a typo like `lst-conversations` start the bot in capture mode
 * with no warning.
 */
export function parseCommand(argv: readonly string[]): Command {
  const [subcommand] = argv
  if (subcommand === undefined) return 'run'
  if (isCommand(subcommand)) return subcommand

  const valid = Object.keys(COMMANDS).join(', ')
  throw new Error(`Unknown subcommand: ${subcommand}. Valid commands: ${valid}`)
}
