const BIN_MARKER = 'b64' as const

interface EncodedBinary {
  $bin: typeof BIN_MARKER
  data: string
}

function isEncodedBinary(value: unknown): value is EncodedBinary {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.$bin === BIN_MARKER && typeof record.data === 'string'
}

function isBinary(value: unknown): value is Uint8Array | ArrayBuffer | Buffer {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return true
  if (value instanceof Uint8Array) return true
  if (value instanceof ArrayBuffer) return true
  return false
}

function toBase64(value: Uint8Array | ArrayBuffer | Buffer): string {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return value.toString('base64')
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString('base64')
  }
  return Buffer.from(value).toString('base64')
}

function encodeValue(value: unknown): unknown {
  if (isBinary(value)) {
    return { $bin: BIN_MARKER, data: toBase64(value) } satisfies EncodedBinary
  }
  if (Array.isArray(value)) {
    return value.map(encodeValue)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = encodeValue(child)
    }
    return out
  }
  return value
}

function decodeValue(value: unknown): unknown {
  if (isEncodedBinary(value)) {
    return new Uint8Array(Buffer.from(value.data, 'base64'))
  }
  // Already-decoded binaries (live Baileys payloads or a prior decodeRaw) must not be walked.
  if (isBinary(value)) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(decodeValue)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = decodeValue(child)
    }
    return out
  }
  return value
}

/**
 * Deep-clones `raw` and replaces binary leaves with `{ $bin: 'b64', data }`.
 * Leaves unmarked historical JSON alone; only new writes get the marker.
 */
export function encodeRaw(raw: unknown): unknown {
  return encodeValue(raw)
}

/**
 * Inverse of {@link encodeRaw}: restores `$bin` leaves to `Uint8Array`.
 * Values without the marker pass through unchanged. Safe to call on already-decoded
 * payloads (live Baileys `Uint8Array` leaves are left intact).
 */
export function decodeRaw(raw: unknown): unknown {
  return decodeValue(raw)
}
