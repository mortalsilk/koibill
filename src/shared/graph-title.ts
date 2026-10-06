import type { GraphSource } from './types'
import { getAIProvider } from './ai-providers'

const MAX_TITLE_LENGTH = 80
const MAX_PHRASE_WORDS = 7

const stopWordsByLanguage = [
  new Set('a an and are as at be been being but by can could did do does doing for from had has have having he her hers him his how i if in into is it its may might more most must my no nor not of on or our ours she should so some than that the their theirs them then there these they this those through to too under up very was we were what when where which while who why will with would you your yours'.split(' ')),
  new Set('a al algo algunas algunos ante antes como con contra cual cuando de del desde donde durante e el ella ellas ellos en entre era es esa ese eso esta estaba estas este esto fue ha hasta hay la las lo los más me mi muy nada ni no nos o para pero por porque que se sin sobre su sus también te tiene todo un una uno y ya'.split(' ')),
  new Set('à au aux avec ce ces dans de des du elle en est et eux il ils je la le les leur lui mais me même mon ne nos notre nous on ou par pas pour que qui sa se ses son sur ta te tes toi ton tu un une vos votre vous'.split(' ')),
  new Set('aber als am an auch auf aus bei bin bis bist da dadurch daher darum das dass dein deine dem den der des die dies diese doch dort du durch ein eine einem einen einer eines er es für hat hier ich im in ist ja kann kein mit muss nach nicht noch nun ob oder sein seine selbst sich sie sind so über um und uns unser vom von vor war was weg weil weiter welche wenn werde werden wie wieder will wir wo zu zum zur'.split(' ')),
  new Set('a ao aos aquela aquelas aquele aqueles as até com como da das de dela delas dele deles depois do dos e ela elas ele eles em entre era essa essas esse esses esta estas este estes eu foi há isso isto já mais mas me mesmo meu minha muito na nas não no nos nós o os ou para pela pelas pelo pelos por porque que se sem ser seu sua suas também te tem um uma você vocês'.split(' ')),
  new Set('a ad al alla allo anche che chi ci con da dal dalla delle dello di e è era essere gli ha hai hanno ho i il in io la le lei lo ma mi ne nei nel nella no non noi o per più quale quando questa questo se sei si sia sono su sul sulla tra tu un una uno vi voi'.split(' ')),
]

interface WordToken {
  text: string
  normalized: string
  start: number
  end: number
}

interface Phrase {
  words: WordToken[]
  index: number
}

interface ScoredPhrase extends Phrase {
  score: number
  title: string
}

export function generateGraphNodeTitle(source: Pick<GraphSource, 'kind' | 'excerpt' | 'pageNumber' | 'title' | 'provider'>): string {
  const extracted = extractKeywordTitle(source.excerpt)
  if (extracted) return extracted
  if (source.kind === 'web' && source.title?.trim()) return truncateTitle(cleanText(source.title)) || 'Web insight'
  if (source.kind === 'pdf') return `Idea from page ${source.pageNumber}`
  if (source.kind === 'chatgpt') return 'ChatGPT insight'
  return source.kind === 'ai' ? `${getAIProvider(source.provider ?? 'chatgpt').name} insight` : 'Web insight'
}

export function extractKeywordTitle(input: string): string | null {
  const text = cleanText(input)
  if (!text) return null
  const words = tokenize(text)
  if (!words.length) return null
  const stopWords = detectStopWords(words)
  const phrases = candidatePhrases(text, words, stopWords)
  const meaningful = words.filter((word) => !stopWords.has(word.normalized) && hasLetterOrNumber(word.text))
  if (!meaningful.length) return null

  const frequency = new Map<string, number>()
  const degree = new Map<string, number>()
  for (const phrase of phrases) {
    const contribution = Math.max(0, phrase.words.length - 1)
    for (const word of phrase.words) {
      frequency.set(word.normalized, (frequency.get(word.normalized) ?? 0) + 1)
      degree.set(word.normalized, (degree.get(word.normalized) ?? 0) + contribution)
    }
  }

  const wordScore = new Map<string, number>()
  for (const [word, count] of frequency) {
    const standardRake = ((degree.get(word) ?? 0) + count) / count
    wordScore.set(word, standardRake + Math.log2(count + 1) * 0.35)
  }

  const scored = phraseWindows(text, phrases).map<ScoredPhrase>((phrase) => {
    const title = titleFromWords(text, phrase.words)
    const total = phrase.words.reduce((sum, word) => sum + (wordScore.get(word.normalized) ?? 1), 0)
    const lengthPreference = phrase.words.length === 1 ? .55 : 1 + Math.min(phrase.words.length, 4) * .08
    const positionPreference = 1 + .12 * (1 - phrase.words[0].start / Math.max(1, text.length))
    const capitalizationPreference = 1 + .05 * (phrase.words.filter((word) => /^\p{Lu}/u.test(word.text)).length / phrase.words.length)
    const keywordDensity = phrase.words.filter((word) => (frequency.get(word.normalized) ?? 0) > 1).length / phrase.words.length
    return { ...phrase, title, score: total / Math.sqrt(phrase.words.length) * lengthPreference * positionPreference * capitalizationPreference * (1 + keywordDensity * .08) }
  }).filter((phrase) => phrase.title.length > 0 && phrase.title.length <= MAX_TITLE_LENGTH)

  scored.sort((left, right) => right.score - left.score || left.index - right.index || (left.title < right.title ? -1 : left.title > right.title ? 1 : 0))
  if (scored[0]) return scored[0].title
  return fallbackFromWords(text, meaningful)
}

export function cleanText(input: string): string {
  return input
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/\S+|www\.\S+/giu, ' ')
    .replace(/\[(?:\d+(?:\s*[,;]\s*\d+)*)\]/gu, ' ')
    .replace(/(^|\s)[#>*_~`=-]+(?=\s|$)/gu, ' ')
    .replace(/[*_~`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/gu, '')
    .trim()
}

function tokenize(text: string): WordToken[] {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('und', { granularity: 'word' })
    return [...segmenter.segment(text)].flatMap((segment) => segment.isWordLike
      ? [{ text: segment.segment, normalized: normalizeWord(segment.segment), start: segment.index, end: segment.index + segment.segment.length }]
      : [])
  }
  const tokens: WordToken[] = []
  const pattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    tokens.push({ text: match[0], normalized: normalizeWord(match[0]), start, end: start + match[0].length })
  }
  return tokens
}

function detectStopWords(words: WordToken[]): Set<string> {
  let selected = stopWordsByLanguage[0]
  let bestHits = -1
  for (const stopWords of stopWordsByLanguage) {
    const hits = words.reduce((count, word) => count + Number(stopWords.has(word.normalized)), 0)
    if (hits > bestHits) { selected = stopWords; bestHits = hits }
  }
  return selected
}

function candidatePhrases(text: string, words: WordToken[], stopWords: Set<string>): Phrase[] {
  const phrases: Phrase[] = []
  let current: WordToken[] = []
  let phraseIndex = 0
  let previousEnd = 0
  const flush = (): void => {
    if (current.length) phrases.push({ words: current, index: phraseIndex++ })
    current = []
  }
  for (const word of words) {
    const separator = text.slice(previousEnd, word.start)
    if (/[.!?;,;:\n\r()[\]{}]/u.test(separator)) flush()
    if (stopWords.has(word.normalized)) flush()
    else if (hasLetterOrNumber(word.text)) current.push(word)
    previousEnd = word.end
  }
  flush()
  return phrases
}

function phraseWindows(text: string, phrases: Phrase[]): Phrase[] {
  const windows: Phrase[] = []
  for (const phrase of phrases) {
    if (phrase.words.length <= MAX_PHRASE_WORDS) {
      windows.push(phrase)
      continue
    }
    for (let start = 0; start < phrase.words.length; start += 1) {
      const words = phrase.words.slice(start, start + MAX_PHRASE_WORDS)
      if (words.length < 2) break
      if (titleFromWords(text, words).length <= MAX_TITLE_LENGTH) windows.push({ words, index: phrase.index * 10_000 + start })
    }
  }
  return windows
}

function titleFromWords(text: string, words: WordToken[]): string {
  if (!words.length) return ''
  return text.slice(words[0].start, words.at(-1)!.end).replace(/\s+/gu, ' ').trim().replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
}

function fallbackFromWords(text: string, words: WordToken[]): string | null {
  for (let length = Math.min(MAX_PHRASE_WORDS, words.length); length > 0; length -= 1) {
    const title = titleFromWords(text, words.slice(0, length))
    if (title && title.length <= MAX_TITLE_LENGTH) return title
  }
  return null
}

function truncateTitle(value: string): string {
  if (value.length <= MAX_TITLE_LENGTH) return value
  const shortened = value.slice(0, MAX_TITLE_LENGTH + 1).replace(/\s+\S*$/u, '').trim()
  return shortened || value.slice(0, MAX_TITLE_LENGTH).trim()
}

function normalizeWord(word: string): string {
  return word.normalize('NFKC').toLowerCase()
}

function hasLetterOrNumber(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value)
}
