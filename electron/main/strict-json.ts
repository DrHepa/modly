export type StrictJsonParseLimits = Readonly<{
  maxBytes: number
  maxDepth: number
  maxProperties: number
  maxArrayLength: number
}>

export class StrictJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StrictJsonError'
  }
}

function assertLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StrictJsonError(`${label} must be a positive safe integer`)
  }
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39
}

function isHexDigit(code: number): boolean {
  return isDigit(code)
    || (code >= 0x41 && code <= 0x46)
    || (code >= 0x61 && code <= 0x66)
}

function hexDigitValue(code: number): number {
  if (isDigit(code)) return code - 0x30
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10
  return code - 0x61 + 10
}

/**
 * Parses canonical JSON while rejecting duplicate object keys before JSON.parse
 * can collapse them. Object-key equality is evaluated after JSON string escape
 * decoding, so escaped aliases such as `file` and `fi\u006ce` collide.
 */
export function parseStrictJson(text: string, limits: StrictJsonParseLimits): unknown {
  if (typeof text !== 'string') throw new StrictJsonError('JSON input must be text')
  assertLimit(limits.maxBytes, 'JSON byte limit')
  assertLimit(limits.maxDepth, 'JSON depth limit')
  assertLimit(limits.maxProperties, 'JSON property limit')
  assertLimit(limits.maxArrayLength, 'JSON array limit')
  if (Buffer.byteLength(text, 'utf8') < 1 || Buffer.byteLength(text, 'utf8') > limits.maxBytes) {
    throw new StrictJsonError('JSON input is empty or too large')
  }

  let index = 0
  let properties = 0

  const fail = (message: string): never => {
    throw new StrictJsonError(message)
  }
  const skipWhitespace = (): void => {
    while (index < text.length) {
      const code = text.charCodeAt(index)
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break
      index += 1
    }
  }
  const parseString = (decode: boolean): string => {
    if (text.charCodeAt(index) !== 0x22) return fail('JSON object keys and strings must be quoted')
    let decoded = ''
    index += 1
    while (index < text.length) {
      const code = text.charCodeAt(index)
      if (code === 0x22) {
        index += 1
        return decoded
      }
      if (code <= 0x1f) return fail('JSON strings cannot contain unescaped control characters')
      if (code !== 0x5c) {
        if (decode) decoded += text[index]
        index += 1
        continue
      }
      index += 1
      if (index >= text.length) return fail('JSON string escape is incomplete')
      const escape = text.charCodeAt(index)
      if (escape === 0x75) {
        let value = 0
        for (let offset = 1; offset <= 4; offset += 1) {
          const digit = text.charCodeAt(index + offset)
          if (!isHexDigit(digit)) return fail('JSON unicode escape is invalid')
          value = (value * 16) + hexDigitValue(digit)
        }
        if (decode) decoded += String.fromCharCode(value)
        index += 5
        continue
      }
      if (![0x22, 0x2f, 0x5c, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(escape)) {
        return fail('JSON string escape is invalid')
      }
      if (decode) {
        decoded += escape === 0x62 ? '\b'
          : escape === 0x66 ? '\f'
            : escape === 0x6e ? '\n'
              : escape === 0x72 ? '\r'
                : escape === 0x74 ? '\t'
                  : String.fromCharCode(escape)
      }
      index += 1
    }
    return fail('JSON string is unterminated')
  }
  const parseNumber = (): void => {
    if (text.charCodeAt(index) === 0x2d) index += 1
    if (text.charCodeAt(index) === 0x30) {
      index += 1
      if (isDigit(text.charCodeAt(index))) return fail('JSON number has a leading zero')
    } else {
      if (!isDigit(text.charCodeAt(index)) || text.charCodeAt(index) === 0x30) {
        return fail('JSON number is invalid')
      }
      while (isDigit(text.charCodeAt(index))) index += 1
    }
    if (text.charCodeAt(index) === 0x2e) {
      index += 1
      if (!isDigit(text.charCodeAt(index))) return fail('JSON number fraction is incomplete')
      while (isDigit(text.charCodeAt(index))) index += 1
    }
    const exponent = text.charCodeAt(index)
    if (exponent === 0x45 || exponent === 0x65) {
      index += 1
      const sign = text.charCodeAt(index)
      if (sign === 0x2b || sign === 0x2d) index += 1
      if (!isDigit(text.charCodeAt(index))) return fail('JSON number exponent is incomplete')
      while (isDigit(text.charCodeAt(index))) index += 1
    }
  }

  const parseValue = (depth: number): void => {
    skipWhitespace()
    const code = text.charCodeAt(index)
    if (code === 0x7b) {
      if (depth >= limits.maxDepth) return fail('JSON nesting is too deep')
      index += 1
      skipWhitespace()
      if (text.charCodeAt(index) === 0x7d) {
        index += 1
        return
      }
      const keys = new Set<string>()
      while (index < text.length) {
        const key = parseString(true)
        if (keys.has(key)) return fail('JSON object contains a duplicate key')
        keys.add(key)
        properties += 1
        if (properties > limits.maxProperties) return fail('JSON document has too many properties')
        skipWhitespace()
        if (text.charCodeAt(index) !== 0x3a) return fail('JSON object property is missing a colon')
        index += 1
        parseValue(depth + 1)
        skipWhitespace()
        const delimiter = text.charCodeAt(index)
        if (delimiter === 0x7d) {
          index += 1
          return
        }
        if (delimiter !== 0x2c) return fail('JSON object property delimiter is invalid')
        index += 1
        skipWhitespace()
      }
      return fail('JSON object is unterminated')
    }
    if (code === 0x5b) {
      if (depth >= limits.maxDepth) return fail('JSON nesting is too deep')
      index += 1
      skipWhitespace()
      if (text.charCodeAt(index) === 0x5d) {
        index += 1
        return
      }
      let length = 0
      while (index < text.length) {
        length += 1
        if (length > limits.maxArrayLength) return fail('JSON array is too large')
        parseValue(depth + 1)
        skipWhitespace()
        const delimiter = text.charCodeAt(index)
        if (delimiter === 0x5d) {
          index += 1
          return
        }
        if (delimiter !== 0x2c) return fail('JSON array delimiter is invalid')
        index += 1
      }
      return fail('JSON array is unterminated')
    }
    if (code === 0x22) {
      parseString(false)
      return
    }
    if (code === 0x2d || isDigit(code)) {
      parseNumber()
      return
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, index)) {
        index += literal.length
        return
      }
    }
    return fail('JSON value is invalid')
  }

  parseValue(0)
  skipWhitespace()
  if (index !== text.length) fail('JSON contains trailing data')
  try {
    return JSON.parse(text) as unknown
  } catch {
    return fail('JSON input is invalid')
  }
}
