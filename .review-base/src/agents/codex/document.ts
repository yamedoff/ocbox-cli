import { createHash } from 'node:crypto'
import { z } from 'zod'

export type CodexJsonValue =
  | string
  | number
  | boolean
  | null
  | CodexJsonValue[]
  | { [key: string]: CodexJsonValue }

export const CodexJsonValueSchema: z.ZodType<CodexJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(CodexJsonValueSchema),
    z.record(z.string(), CodexJsonValueSchema),
  ]),
)

export type DocumentPath = readonly (string | number)[]

export type MutableDocument = { [key: string]: unknown }

export function isRecord(value: unknown): value is MutableDocument {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function getAtPath(root: unknown, path: DocumentPath): unknown {
  let current: unknown = root
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[segment]
    } else {
      if (!isRecord(current)) return undefined
      current = current[segment]
    }
  }
  return current
}

export function setAtPath(root: MutableDocument, path: DocumentPath, value: unknown): void {
  if (path.length === 0) throw new TypeError('A document path cannot be empty')
  let current: MutableDocument = root
  for (const [index, segment] of path.entries()) {
    const last = index === path.length - 1
    if (last) {
      current[String(segment)] = value
      return
    }
    const existing = current[String(segment)]
    if (!isRecord(existing)) {
      const created: MutableDocument = {}
      current[String(segment)] = created
      current = created
    } else {
      current = existing
    }
  }
}

export function deleteAtPath(root: MutableDocument, path: DocumentPath): boolean {
  if (path.length === 0) return false
  const parent = getAtPath(root, path.slice(0, -1))
  const key = path[path.length - 1]
  if (key === undefined) return false
  if (typeof key === 'number') {
    if (!Array.isArray(parent) || key < 0 || key >= parent.length) return false
    parent.splice(key, 1)
    return true
  }
  if (!isRecord(parent) || !Object.hasOwn(parent, key)) return false
  delete parent[key]
  return true
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isRecord(value)) {
    const sorted: { [key: string]: unknown } = {}
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key])
    return sorted
  }
  return value
}

export function canonicalJson(value: CodexJsonValue): string {
  return JSON.stringify(canonicalize(value))
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== typeof right) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
  }
  return false
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
