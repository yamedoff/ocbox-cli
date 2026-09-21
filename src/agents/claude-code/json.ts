import { createHash } from 'node:crypto'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function cloneJson<Value extends JsonValue>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}

export function deepEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if (left === null || right === null) return false
  if (typeof left !== typeof right) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    if (leftKeys.length !== rightKeys.length) return false
    if (leftKeys.some((key, index) => key !== rightKeys[index])) return false
    return leftKeys.every((key) => deepEqual(left[key], right[key]))
  }
  return false
}

export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const parts: string[] = []
  for (const key of Object.keys(value).sort()) {
    const child = value[key]
    if (child === undefined) continue
    parts.push(`${JSON.stringify(key)}:${stableStringify(child)}`)
  }
  return `{${parts.join(',')}}`
}

export function hashJson(value: JsonValue): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

export function hashBytes(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function decodeSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~')
}

export function parseJsonPointer(pointer: string): string[] {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) throw new TypeError('JSON pointer must start with "/"')
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => decodeSegment(segment))
}

export function getAtPointer(root: JsonValue, pointer: string): JsonValue | undefined {
  let current: JsonValue | undefined = root
  for (const segment of parseJsonPointer(pointer)) {
    if (current === undefined || current === null || typeof current !== 'object') return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) return undefined
      current = current[index]
    } else {
      current = current[segment]
    }
  }
  return current
}
