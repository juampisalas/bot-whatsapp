export type Command = 'run' | 'list-conversations'

// Mapa en lugar de lista para que el guard y el mensaje de error salgan de la misma fuente.
const COMANDOS: Record<Command, true> = {
  run: true,
  'list-conversations': true,
}

function esComando(valor: string): valor is Command {
  return Object.hasOwn(COMANDOS, valor)
}

/**
 * Sin subcomando corre la captura. Cualquier token que no sea un comando
 * conocido falla: si cayera en el camino por defecto, un `lst-conversations`
 * con un dedazo arrancaría el bot en modo captura sin decir nada.
 */
export function parseCommand(argv: readonly string[]): Command {
  const [subcomando] = argv
  if (subcomando === undefined) return 'run'
  if (esComando(subcomando)) return subcomando

  const validos = Object.keys(COMANDOS).join(', ')
  throw new Error(`Subcomando desconocido: ${subcomando}. Comandos válidos: ${validos}`)
}
