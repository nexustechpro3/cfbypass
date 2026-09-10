import axios from 'axios'

const EXHAUSTED_TTL_MS = 60 * 1000

interface KeyEntry {
  key: string
  exhaustedUntil: number
}

let keys: KeyEntry[] = []
let cursor = 0

function loadKeys(): void {
  const raw = process.env.GEMINI_KEYS ?? ''
  keys = raw
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)
    .map(key => ({ key, exhaustedUntil: 0 }))
  if (keys.length) {
    console.log(`[AIPool] Loaded ${keys.length} Gemini key(s)`)
  }
}

loadKeys()

export function nextKey(): string | null {
  const now = Date.now()
  for (let i = 0; i < keys.length; i++) {
    const idx = (cursor + i) % keys.length
    if (keys[idx].exhaustedUntil <= now) {
      cursor = (idx + 1) % keys.length
      return keys[idx].key
    }
  }
  return null
}

function markExhausted(key: string): void {
  const entry = keys.find(k => k.key === key)
  if (entry) entry.exhaustedUntil = Date.now() + EXHAUSTED_TTL_MS
}

export async function solveWithGemini(imageBase64: string, prompt: string): Promise<string> {
  const key = nextKey()
  if (!key) throw new Error('No Gemini API keys available')

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-vision:generateContent?key=${key}`

  try {
    const response = await axios.post(
      url,
      {
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: imageBase64,
                },
              },
            ],
          },
        ],
      },
      { timeout: 15000 }
    )

    const text: string =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    return text
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status
      if (status === 429 || status === 403) {
        markExhausted(key)
      }
    }
    throw err
  }
}
