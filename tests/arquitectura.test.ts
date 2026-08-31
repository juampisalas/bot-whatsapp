import { join } from 'node:path'
import { expect, test } from 'bun:test'

/**
 * La invariante central del diseño: baileys entra solamente por el adaptador. Lo que
 * capture, store y domain necesiten del canal les llega por el puerto `MessagingProvider`
 * o por los tipos de dominio, nunca por la librería.
 *
 * Sin este chequeo la regla era un ítem de checklist manual: un import de baileys en
 * `capture/` pasa el typecheck y el resto de la suite sin que nadie se entere.
 */
const CAPAS_SIN_BAILEYS = ['capture', 'store', 'domain']

/**
 * Busca el import y no la palabra: un comentario que nombra baileys para explicar de dónde
 * viene un dato no rompe la regla. Cubre las tres formas —`from 'baileys'`,
 * `import('baileys')` y `require('baileys')`— y los submódulos.
 */
const IMPORTA_BAILEYS = /(?:from|import|require)\s*\(?\s*['"]baileys(?:\/[^'"]*)?['"]/

/**
 * El SDK de AI (`ai`) vive en el agente, no en la captura. Misma idea que baileys: un
 * import accidental en `capture/` pasaría typecheck y el resto de la suite sin avisar.
 */
const IMPORTA_AI = /(?:from|import|require)\s*\(?\s*['"]ai(?:\/[^'"]*)?['"]/

const raizDeFuentes = join(import.meta.dir, '..', 'src')

// El glob recursivo hace que un subdirectorio nuevo quede cubierto sin tocar este test.
function fuentesDe(capa: string): string[] {
  return [...new Bun.Glob('**/*.ts').scanSync({ cwd: join(raizDeFuentes, capa) })]
}

test.each(CAPAS_SIN_BAILEYS)('src/%s no importa baileys', async (capa) => {
  const archivos = fuentesDe(capa)
  // Un glob que no encuentra nada pasaría el test sin haber mirado una sola línea.
  expect(archivos.length).toBeGreaterThan(0)

  const infractores: string[] = []
  for (const archivo of archivos) {
    const contenido = await Bun.file(join(raizDeFuentes, capa, archivo)).text()
    if (IMPORTA_BAILEYS.test(contenido)) infractores.push(`src/${capa}/${archivo}`)
  }

  expect(infractores).toEqual([])
})

test('src/capture no importa ai', async () => {
  const archivos = fuentesDe('capture')
  expect(archivos.length).toBeGreaterThan(0)

  const infractores: string[] = []
  for (const archivo of archivos) {
    const contenido = await Bun.file(join(raizDeFuentes, 'capture', archivo)).text()
    if (IMPORTA_AI.test(contenido)) infractores.push(`src/capture/${archivo}`)
  }

  expect(infractores).toEqual([])
})
