const MIN_LETTER_COUNT = 40

const SPANISH_WORDS = [
  'que',
  'de',
  'la',
  'el',
  'en',
  'y',
  'a',
  'los',
  'las',
  'por',
  'con',
  'para',
  'pero',
  'como',
  'hola',
  'gracias',
  'también',
  'tambien',
  'está',
  'esta',
  'estoy',
  'buenos',
  'días',
  'dias',
  'ahora',
  'después',
  'despues',
  'mañana',
  'manana',
  'ayer',
  'hoy',
  'sí',
  'si',
  'no',
  'muy',
  'bien',
  'vos',
  'che',
]

const ENGLISH_WORDS = [
  'the',
  'and',
  'you',
  'that',
  'have',
  'for',
  'not',
  'with',
  'this',
  'but',
  'from',
  'they',
  'what',
  'there',
  'about',
  'would',
  'could',
  'hello',
  'thanks',
  'thank',
  'today',
  'tomorrow',
  'yesterday',
  'please',
  'sorry',
  'yeah',
  'okay',
]

function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, ' ')
}

function countWordHits(text: string, words: readonly string[]): number {
  let hits = 0
  for (const word of words) {
    const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    const matches = text.match(pattern)
    if (matches) hits += matches.length
  }
  return hits
}

function countSpanishAccentHits(text: string): number {
  const matches = text.match(/[áéíóúñ¿¡]/gi)
  return matches?.length ?? 0
}

/**
 * Lightweight es/en prior from message texts in the enrichment window.
 * Returns ISO codes Whisper understands, or null when signal is too weak.
 */
export function inferChatLanguagePrior(texts: readonly string[]): string | null {
  const corpus = texts
    .map((text) => stripUrls(text.trim()))
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  const letters = corpus.replace(/[^a-záéíóúñü]/gi, '')
  if (letters.length < MIN_LETTER_COUNT) return null

  const spanishScore = countWordHits(corpus, SPANISH_WORDS) + countSpanishAccentHits(corpus) * 2
  const englishScore = countWordHits(corpus, ENGLISH_WORDS)
  if (spanishScore === 0 && englishScore === 0) return null
  if (spanishScore >= englishScore * 1.2) return 'es'
  if (englishScore >= spanishScore * 1.2) return 'en'
  return null
}
