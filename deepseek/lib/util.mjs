/** Small shared helpers for the agent-bridge DSH plugin. */

export function clip(value, max) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

export function asString(value) {
  return typeof value === 'string' ? value : undefined
}

export function asBoolean(value) {
  return typeof value === 'boolean' ? value : undefined
}

export function asNumber(value) {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/** Normalise a route prefix to '/name' (no trailing slash). */
export function normalizePrefix(value) {
  const raw = String(value ?? '/agent-bridge').trim() || '/agent-bridge'
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash
}

/** Extract plain text from DSH message content parts. */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part)
      continue
    }
    if (part === null || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    else if (part.type === 'input_text' && typeof part.text === 'string') parts.push(part.text)
    else if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n').trim()
}

export function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.replace(/[\\/]+$/, '').toLowerCase()
}

export function isoNow() {
  return new Date().toISOString()
}
