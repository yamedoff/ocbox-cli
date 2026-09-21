/**
 * Minimal dependency-free YAML parser for the pinned OpenAPI artifact.
 *
 * The repository dependency policy forbids a general YAML runtime, so this
 * module implements only the YAML 1.2 core subset used by
 * `openapi/openapi.yaml`: block mappings, block sequences, flow sequences,
 * single/double-quoted and plain scalars, and comments. Anything outside that
 * subset fails loudly so the contract can never be silently misread.
 */
export class YamlParseError extends Error {
  constructor(message, line) {
    super(`OpenAPI YAML parse error on line ${line + 1}: ${message}`)
    this.name = 'YamlParseError'
    this.line = line
  }
}

function quoteStarts(text, index) {
  if (index === 0) return true
  const previous = text[index - 1]
  return [' ', ':', ',', '[', '{', '-'].includes(previous)
}

function stripInlineComment(text, line) {
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quote === '"') {
      if (character === '\\') index += 1
      else if (character === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (character === "'" && text[index + 1] === "'") index += 1
      else if (character === "'") quote = null
      continue
    }
    if ((character === '"' || character === "'") && quoteStarts(text, index)) {
      quote = character
      continue
    }
    if (character === '#' && (index === 0 || /\s/.test(text[index - 1] ?? ''))) {
      return text.slice(0, index)
    }
  }
  if (quote !== null) throw new YamlParseError('unterminated quoted scalar', line)
  return text
}

function tokenize(source) {
  const lines = []
  const physical = source.split(/\r?\n/)
  for (let index = 0; index < physical.length; index += 1) {
    const withoutComment = stripInlineComment(physical[index] ?? '', index)
    const trimmedEnd = withoutComment.replace(/\s+$/, '')
    if (trimmedEnd.trim().length === 0) continue
    const indentMatch = trimmedEnd.match(/^ */)
    const indent = indentMatch?.[0].length ?? 0
    if (trimmedEnd.slice(0, indent + 1).includes('\t')) {
      throw new YamlParseError('tabs are not supported for indentation', index)
    }
    lines.push({ indent, text: trimmedEnd.slice(indent) })
  }
  return lines
}

/** Returns `[key, value]` for a mapping entry, or null for a plain scalar. */
function splitKeyValue(text) {
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quote === '"') {
      if (character === '\\') index += 1
      else if (character === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (character === "'" && text[index + 1] === "'") index += 1
      else if (character === "'") quote = null
      continue
    }
    if ((character === '"' || character === "'") && quoteStarts(text, index)) {
      quote = character
      continue
    }
    if (character === ':') {
      const next = text[index + 1]
      if (next === undefined || next === ' ') {
        return [text.slice(0, index), text.slice(index + 1).replace(/^\s/, '')]
      }
    }
  }
  return null
}

function parseQuoted(text, line) {
  const quote = text[0]
  if (quote === '"') {
    if (!text.endsWith('"') || text.length < 2)
      throw new YamlParseError('unterminated double-quoted scalar', line)
    const body = text.slice(1, -1)
    return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, code) => {
      if (code.startsWith('u')) return String.fromCharCode(Number.parseInt(code.slice(1), 16))
      if (code === 'n') return '\n'
      if (code === 't') return '\t'
      if (code === 'r') return '\r'
      return code
    })
  }
  if (!text.endsWith("'") || text.length < 2)
    throw new YamlParseError('unterminated single-quoted scalar', line)
  return text.slice(1, -1).replace(/''/g, "'")
}

function parseScalar(text, line) {
  const value = text.trim()
  if (value.length === 0) return null
  if (value.startsWith('"') || value.startsWith("'")) return parseQuoted(value, line)
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return Number(value)
  return value
}

function skipWhitespace(text, start) {
  let index = start
  while (index < text.length && /\s/.test(text[index] ?? '')) index += 1
  return index
}

function parseFlowValue(text, start, line) {
  const index = skipWhitespace(text, start)
  const character = text[index]
  if (character === '[') return parseFlowSequence(text, index, line)
  if (character === '{') return parseFlowMapping(text, index, line)
  if (character === '"' || character === "'") {
    let end = index + 1
    while (end < text.length) {
      if (character === '"' && text[end] === '\\') {
        end += 2
        continue
      }
      if (text[end] === character) {
        if (character === "'" && text[end + 1] === "'") {
          end += 2
          continue
        }
        break
      }
      end += 1
    }
    if (end >= text.length) throw new YamlParseError('unterminated flow scalar', line)
    return { next: end + 1, value: parseQuoted(text.slice(index, end + 1), line) }
  }
  let end = index
  while (end < text.length && !',]}'.includes(text[end] ?? '')) end += 1
  return { next: end, value: parseScalar(text.slice(index, end), line) }
}

function parseFlowSequence(text, start, line) {
  let index = start + 1
  const items = []
  index = skipWhitespace(text, index)
  if (text[index] === ']') return { next: index + 1, value: items }
  for (;;) {
    const result = parseFlowValue(text, index, line)
    items.push(result.value)
    index = skipWhitespace(text, result.next)
    const separator = text[index]
    if (separator === ',') {
      index = skipWhitespace(text, index + 1)
      continue
    }
    if (separator === ']') return { next: index + 1, value: items }
    throw new YamlParseError('expected , or ] in flow sequence', line)
  }
}

function parseFlowMapping(text, start, line) {
  let index = start + 1
  const entries = {}
  index = skipWhitespace(text, index)
  if (text[index] === '}') return { next: index + 1, value: entries }
  for (;;) {
    const keyResult = parseFlowValue(text, index, line)
    if (typeof keyResult.value !== 'string')
      throw new YamlParseError('flow keys must be strings', line)
    index = skipWhitespace(text, keyResult.next)
    if (text[index] !== ':') throw new YamlParseError('expected : in flow mapping', line)
    const valueResult = parseFlowValue(text, index + 1, line)
    if (Object.hasOwn(entries, keyResult.value))
      throw new YamlParseError(`duplicate key "${keyResult.value}"`, line)
    entries[keyResult.value] = valueResult.value
    index = skipWhitespace(text, valueResult.next)
    const separator = text[index]
    if (separator === ',') {
      index = skipWhitespace(text, index + 1)
      continue
    }
    if (separator === '}') return { next: index + 1, value: entries }
    throw new YamlParseError('expected , or } in flow mapping', line)
  }
}

function parseInline(text, line) {
  const trimmed = text.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const result = parseFlowValue(trimmed, 0, line)
    if (skipWhitespace(trimmed, result.next) !== trimmed.length) {
      throw new YamlParseError('unexpected trailing flow content', line)
    }
    return result.value
  }
  return parseScalar(trimmed, line)
}

function isSequenceLine(line) {
  return line.text === '-' || line.text.startsWith('- ')
}

function parseBlock(lines, start, indent) {
  const first = lines[start]
  if (first === undefined) return { next: start, value: null }
  return isSequenceLine(first)
    ? parseSequence(lines, start, indent)
    : parseMapping(lines, start, indent)
}

function parseSequence(lines, start, indent) {
  const items = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined || line.indent !== indent || !isSequenceLine(line)) break
    const rest = line.text === '-' ? '' : line.text.slice(2)
    if (rest.trim().length === 0) {
      const child = lines[index + 1]
      if (
        child !== undefined &&
        child.indent > indent &&
        !isSequenceLine(child) &&
        (child.text.startsWith('[') ||
          child.text.startsWith('{') ||
          splitKeyValue(child.text) === null)
      ) {
        items.push(parseInline(child.text, index + 1))
        index += 2
      } else if (child !== undefined && child.indent > indent) {
        const parsed = parseBlock(lines, index + 1, child.indent)
        items.push(parsed.value)
        index = parsed.next
      } else {
        items.push(null)
        index += 1
      }
      continue
    }
    const pair = splitKeyValue(rest)
    if (pair !== null) {
      const mappingIndent = indent + (line.text.length - rest.length)
      const parsed = parseMapping(lines, index, mappingIndent, rest)
      items.push(parsed.value)
      index = parsed.next
      continue
    }
    items.push(parseInline(rest, index))
    index += 1
  }
  return { next: index, value: items }
}

function parseMapping(lines, start, indent, firstEntry) {
  const entries = {}
  let index = start
  let pending = firstEntry
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    if (pending === undefined && line.indent !== indent) break
    if (pending === undefined && isSequenceLine(line)) break
    const entryText = pending ?? line.text
    const pair = splitKeyValue(entryText)
    if (pair === null) throw new YamlParseError('expected "key: value"', index)
    const [rawKey, rawValue] = pair
    const key =
      rawKey.startsWith('"') || rawKey.startsWith("'") ? String(parseQuoted(rawKey, index)) : rawKey
    if (Object.hasOwn(entries, key)) throw new YamlParseError(`duplicate key "${key}"`, index)
    if (rawValue.length > 0) {
      entries[key] = parseInline(rawValue, index)
      index += 1
    } else {
      const child = lines[index + 1]
      if (
        child !== undefined &&
        child.indent > indent &&
        !isSequenceLine(child) &&
        (child.text.startsWith('[') ||
          child.text.startsWith('{') ||
          splitKeyValue(child.text) === null)
      ) {
        entries[key] = parseInline(child.text, index + 1)
        index += 2
      } else if (
        child !== undefined &&
        (child.indent > indent || (child.indent === indent && isSequenceLine(child)))
      ) {
        const parsed = parseBlock(lines, index + 1, child.indent)
        entries[key] = parsed.value
        index = parsed.next
      } else {
        entries[key] = null
        index += 1
      }
    }
    pending = undefined
  }
  return { next: index, value: entries }
}

/** Parses the supported YAML subset into plain JavaScript values. */
export function parseYaml(source) {
  const lines = tokenize(source)
  if (lines.length === 0) return null
  const first = lines[0]
  if (first === undefined) return null
  const parsed = parseBlock(lines, 0, first.indent)
  if (parsed.next !== lines.length)
    throw new YamlParseError('unexpected trailing content', parsed.next)
  return parsed.value
}
