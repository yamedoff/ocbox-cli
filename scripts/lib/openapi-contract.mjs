import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseYaml } from './openapi-yaml.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = join(here, '..', '..')
export const artifactPath = join(repositoryRoot, 'openapi', 'openapi.yaml')
export const provenancePath = join(repositoryRoot, 'openapi', 'PROVENANCE.json')
export const generatedPath = join(repositoryRoot, 'src', 'api', 'generated', 'client.ts')

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete']

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Reads and SHA-256 verifies the pinned artifact against its provenance. */
export function loadContract() {
  const bytes = readFileSync(artifactPath)
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== provenance.sha256) {
    throw new Error(
      `Pinned OpenAPI checksum drift: expected ${provenance.sha256}, computed ${sha256} for openapi/openapi.yaml`,
    )
  }
  if (bytes.length !== provenance.bytes) {
    throw new Error(
      `Pinned OpenAPI size drift: expected ${provenance.bytes} bytes, computed ${bytes.length}`,
    )
  }
  const document = parseYaml(bytes.toString('utf8'))
  if (!isRecord(document)) throw new TypeError('OpenAPI document must be a mapping')
  return { document, provenance, sha256, source: bytes.toString('utf8') }
}

function refName(ref) {
  const segments = ref.split('/')
  return segments[segments.length - 1] ?? 'Unknown'
}

function literal(value) {
  return JSON.stringify(value)
}

function resolveNode(document, node) {
  if (isRecord(node) && typeof node.$ref === 'string') {
    const segments = node.$ref.replace(/^#\//, '').split('/')
    let current = document
    for (const segment of segments) {
      const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~')
      if (!isRecord(current)) return undefined
      current = current[decoded]
    }
    return current
  }
  return node
}

function emitType(schema) {
  if (!isRecord(schema)) return 'unknown'
  if (typeof schema.$ref === 'string') return refName(schema.$ref)
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((item) => emitType(item)).join(' | ')
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((item) => emitType(item)).join(' | ')
  if (Array.isArray(schema.allOf)) return schema.allOf.map((item) => emitType(item)).join(' & ')

  const declared = schema.type
  const typeList = Array.isArray(declared) ? declared : declared === undefined ? [] : [declared]
  const parts = typeList.map((single) => {
    switch (single) {
      case 'array':
        return `readonly ${emitType(schema.items)}[]`
      case 'boolean':
        return 'boolean'
      case 'integer':
      case 'number':
        return 'number'
      case 'null':
        return 'null'
      case 'object':
        return isRecord(schema.properties)
          ? emitObjectLiteral(schema)
          : isRecord(schema.additionalProperties)
            ? `Record<string, ${emitType(schema.additionalProperties)}>`
            : 'Record<string, unknown>'
      case 'string':
        return Array.isArray(schema.enum)
          ? schema.enum.map((value) => literal(value)).join(' | ')
          : 'string'
      default:
        return 'unknown'
    }
  })
  if (parts.length > 0) return parts.join(' | ')
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => literal(value)).join(' | ')
  if (isRecord(schema.properties)) return emitObjectLiteral(schema)
  if (isRecord(schema.additionalProperties))
    return `Record<string, ${emitType(schema.additionalProperties)}>`
  return 'unknown'
}

function emitObjectLiteral(schema) {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const members = Object.entries(properties).map(([key, value]) => {
    const optional = required.has(key) ? '' : '?'
    return `readonly ${propertyName(key)}${optional}: ${emitType(value)}`
  })
  if (members.length === 0) return 'Record<string, unknown>'
  return `{ ${members.join('; ')} }`
}

function propertyName(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : literal(key)
}

function emitNamedSchema(name, schema) {
  if (isRecord(schema) && (schema.type === 'object' || isRecord(schema.properties))) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    const members = Object.entries(properties).map(([key, value]) => {
      const optional = required.has(key) ? '' : '?'
      return `  readonly ${propertyName(key)}${optional}: ${emitType(value)}`
    })
    if (members.length === 0) return `export type ${name} = Record<string, unknown>`
    return `export interface ${name} {\n${members.join('\n')}\n}`
  }
  return `export type ${name} = ${emitType(schema)}`
}

function resolveParameters(document, pathItem, operation) {
  const raw = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ]
  return raw.map((parameter) => resolveNode(document, parameter)).filter(isRecord)
}

function parameterType(parameter) {
  const schema = isRecord(parameter.schema) ? parameter.schema : {}
  return schema.type === 'integer' || schema.type === 'number' ? 'number' : 'string'
}

function pathParameterNames(path) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])
}

function requestBodySchema(document, operation) {
  const requestBody = resolveNode(document, operation.requestBody)
  if (!isRecord(requestBody) || !isRecord(requestBody.content)) return null
  const json = requestBody.content['application/json']
  if (!isRecord(json)) return null
  return json.schema ?? null
}

function responseSchema(operation) {
  const responses = isRecord(operation.responses) ? operation.responses : {}
  for (const status of ['200', '201', '202', '204']) {
    const response = responses[status]
    if (!isRecord(response)) continue
    if (!isRecord(response.content)) return null
    const json = response.content['application/json']
    return isRecord(json) ? (json.schema ?? null) : null
  }
  return null
}

/** Builds the route model used for deterministic client generation. */
export function buildRoutes(document) {
  const routes = []
  const paths = isRecord(document.paths) ? document.paths : {}
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method]
      if (!isRecord(operation) || typeof operation.operationId !== 'string') continue
      const parameters = resolveParameters(document, pathItem, operation)
      const bodySchema = requestBodySchema(document, operation)
      const requestBody = resolveNode(document, operation.requestBody)
      routes.push({
        bodyRequired: isRecord(requestBody) && requestBody.required === true,
        bodySchema,
        idempotencyRequired: method !== 'get' && operation['x-idempotency'] !== 'none',
        method,
        operationId: operation.operationId,
        path,
        pathParameters: pathParameterNames(path).map((name) => {
          const parameter = parameters.find(
            (candidate) => candidate.in === 'path' && candidate.name === name,
          )
          return { name, type: parameter === undefined ? 'string' : parameterType(parameter) }
        }),
        queryParameters: parameters
          .filter((parameter) => parameter.in === 'query')
          .map((parameter) => ({ name: parameter.name, type: parameterType(parameter) })),
        responseSchema: responseSchema(operation),
      })
    }
  }
  return routes
}

function argFields(route) {
  const fields = []
  if (route.pathParameters.length > 0) {
    const members = route.pathParameters.map(
      (parameter) => `readonly ${propertyName(parameter.name)}: ${parameter.type}`,
    )
    fields.push(`readonly path: { ${members.join('; ')} }`)
  }
  if (route.queryParameters.length > 0) {
    const members = route.queryParameters.map(
      (parameter) => `readonly ${propertyName(parameter.name)}?: ${parameter.type}`,
    )
    fields.push(`readonly query?: { ${members.join('; ')} }`)
  }
  if (route.bodySchema !== null) {
    const optional = route.bodyRequired ? '' : '?'
    fields.push(`readonly body${optional}: ${emitType(route.bodySchema)}`)
  }
  if (route.idempotencyRequired) fields.push('readonly idempotencyKey: string')
  fields.push('readonly signal?: AbortSignal')
  return fields
}

function renderArgumentList(route) {
  const fields = argFields(route)
  const hasRequired = fields.some((field) => !field.includes('?:'))
  const optional = hasRequired ? '' : '?'
  return `args${optional}: { ${fields.join('; ')} }`
}

function outputType(route) {
  if (route.responseSchema === null) return 'unknown'
  return `${emitType(route.responseSchema)} | ErrorEnvelope`
}

function renderOperation(route) {
  const args = renderArgumentList(route)
  const lines = []
  lines.push(`    async ${route.operationId}(${args}): Promise<ApiResult<${outputType(route)}>> {`)
  const renderedPath = route.path.replace(
    /\{([^}]+)\}/g,
    (_match, name) => `\${encodeURIComponent(String(args.path.${propertyName(name)}))}`,
  )
  lines.push(`      const url = new URL(\`\${normalizedBase}/v1${renderedPath}\`)`)
  if (route.queryParameters.length > 0) {
    lines.push('      if (args?.query !== undefined) {')
    for (const parameter of route.queryParameters) {
      lines.push(
        `        if (args.query.${propertyName(parameter.name)} !== undefined) url.searchParams.set(${literal(parameter.name)}, String(args.query.${propertyName(parameter.name)}))`,
      )
    }
    lines.push('      }')
  }
  lines.push('      const headers: Record<string, string> = { ...defaultHeaders }')
  if (route.bodySchema !== null) {
    lines.push("      if (args?.body !== undefined) headers['content-type'] = 'application/json'")
  }
  if (route.idempotencyRequired) {
    lines.push("      headers['idempotency-key'] = args.idempotencyKey")
  }
  lines.push('      const response = await transport.fetch(url, {')
  lines.push(`        method: ${literal(route.method.toUpperCase())},`)
  lines.push('        headers,')
  if (route.bodySchema !== null) {
    lines.push('        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),')
  }
  lines.push('        ...(args?.signal === undefined ? {} : { signal: args.signal }),')
  lines.push('      })')
  lines.push('      const text = await response.text()')
  lines.push('      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)')
  lines.push('      return {')
  lines.push(`        body: parsed as ${outputType(route)},`)
  lines.push("        requestId: response.headers.get('x-request-id'),")
  lines.push("        replay: response.headers.get('idempotency-replayed') === 'true',")
  lines.push('        status: response.status,')
  lines.push('      }')
  lines.push('    },')
  return lines
}

/** Deterministically emits the public TypeScript client from the pinned contract. */
export function generateClient({ document, provenance, sha256 }) {
  const lines = []
  lines.push('/**')
  lines.push(' * Generated from openapi/openapi.yaml. DO NOT EDIT BY HAND.')
  lines.push(' *')
  lines.push(` * Pinned source commit: ${provenance.sourceCommit}`)
  lines.push(` * Pinned source SHA-256: ${sha256}`)
  lines.push(' * Regenerate with: pnpm run api:generate')
  lines.push(' *')
  lines.push(' * This file depends only on the standard Web Fetch surface provided by the')
  lines.push(' * Node runtime. It never imports private implementation or domain code.')
  lines.push(' */')
  lines.push('')
  lines.push(`export const OPENAPI_SOURCE_COMMIT = ${literal(provenance.sourceCommit)} as const`)
  lines.push(`export const OPENAPI_CHECKSUM = ${literal(`sha256:${sha256}`)} as const`)
  lines.push('')
  lines.push('export interface ApiTransport {')
  lines.push('  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>')
  lines.push('}')
  lines.push('')
  lines.push('export interface ReadRequestOptions {')
  lines.push('  readonly signal?: AbortSignal')
  lines.push('}')
  lines.push('')
  lines.push('export interface MutatingRequestOptions {')
  lines.push('  readonly idempotencyKey: string')
  lines.push('  readonly signal?: AbortSignal')
  lines.push('}')
  lines.push('')
  lines.push('export interface ApiResult<ResponseType> {')
  lines.push('  readonly status: number')
  lines.push('  readonly body: ResponseType')
  lines.push('  readonly requestId: string | null')
  lines.push('  readonly replay: boolean')
  lines.push('}')
  lines.push('')

  const schemas = isRecord(document.components) ? document.components.schemas : null
  if (isRecord(schemas)) {
    const names = Object.keys(schemas).filter((name) => name !== 'ErrorEnvelope')
    for (const name of names) {
      if (!isRecord(schemas[name])) continue
      lines.push(emitNamedSchema(name, schemas[name]))
      lines.push('')
    }
    if (isRecord(schemas.ErrorEnvelope)) {
      lines.push(emitNamedSchema('ErrorEnvelope', schemas.ErrorEnvelope))
      lines.push('')
    }
  }

  const routes = buildRoutes(document)
  lines.push('export interface OpenCloudBoxClient {')
  for (const route of routes) {
    lines.push(
      `  ${route.operationId}(${renderArgumentList(route)}): Promise<ApiResult<${outputType(route)}>>`,
    )
  }
  lines.push('}')
  lines.push('')
  lines.push('export interface ClientOptions {')
  lines.push('  readonly transport?: ApiTransport')
  lines.push('  readonly headers?: Readonly<Record<string, string>>')
  lines.push('}')
  lines.push('')
  lines.push(
    'export function createClient(baseUrl: string, options: ClientOptions = {}): OpenCloudBoxClient {',
  )
  lines.push('  const transport = options.transport ?? (globalThis as unknown as ApiTransport)')
  lines.push('  const defaultHeaders = options.headers ?? {}')
  lines.push("  const normalizedBase = baseUrl.replace(/\\/v1\\/?$/, '').replace(/\\/$/, '')")
  lines.push('  return {')
  for (const route of routes) {
    lines.push(...renderOperation(route))
  }
  lines.push('  }')
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}
