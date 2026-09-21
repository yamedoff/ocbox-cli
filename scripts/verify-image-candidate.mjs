import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const ROOT = new URL('../', import.meta.url)
const IMAGE = new URL('../images/ocbox-base/', import.meta.url)
const REQUIRED_TOOLS = [
  'bash',
  'build-essential',
  'ca-certificates',
  'curl',
  'git',
  'gzip',
  'jq',
  'openssh-client',
  'patch',
  'python3',
  'ripgrep',
  'tar',
  'tini',
  'xz-utils',
]
const BASE_DIGEST = 'sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa'
const INDEX_DIGEST = 'sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e'

function assert(condition, message) {
  if (!condition) throw new Error(`Image candidate verification failed: ${message}`)
}

async function source(name) {
  return readFile(new URL(name, IMAGE), 'utf8')
}

function workflowStep(workflow, name, nextName) {
  const start = workflow.indexOf(name)
  assert(start !== -1, `workflow step ${name}`)
  const end =
    nextName === undefined ? workflow.length : workflow.indexOf(nextName, start + name.length)
  assert(end !== -1, `workflow step ${nextName}`)
  return workflow.slice(start, end)
}

async function walk(directory) {
  const paths = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...(await walk(path)))
    else paths.push(path)
  }
  return paths
}

export function verifyImageSources({
  manifest,
  schema,
  dockerfile,
  entrypoint,
  readiness,
  launcher,
  workflow,
}) {
  assert(schema.$id.endsWith('base-image-manifest-v1.json'), 'manifest schema id')
  assert(manifest.schemaVersion === 1, 'manifest version')
  assert(manifest.base.platformDigest === BASE_DIGEST, 'base platform digest')
  assert(manifest.base.indexDigest === INDEX_DIGEST, 'base index digest')
  assert(manifest.image.platform === 'linux/amd64', 'effective platform')
  assert(/^[0-9a-f]{40}$/.test(manifest.base.sourceCommit), 'base source commit')
  assert(manifest.runtime.uid === 10001 && manifest.runtime.gid === 10001, 'runtime identity')
  assert(
    manifest.runtime.home === '/home/ocbox' && manifest.runtime.workspace === '/workspace',
    'runtime paths',
  )
  assert(manifest.toolchain.node === '24.20.0', 'Node pin')
  assert(manifest.toolchain.corepack === '0.36.0', 'Corepack pin')
  assert(manifest.toolchain.pnpm === '11.24.0', 'pnpm pin')
  assert(
    JSON.stringify(manifest.guaranteedTools) === JSON.stringify(REQUIRED_TOOLS),
    'guaranteed tool set',
  )
  assert(manifest.release.stable === false && manifest.release.benchmarkRuns === 0, 'stable gate')
  assert(manifest.release.providerPublicationVerified === false, 'provider publication gate')
  assert(manifest.release.fiveRunBenchmarksVerified === false, 'benchmark gate')

  assert(dockerfile.includes(`node:24-bookworm-slim@${BASE_DIGEST}`), 'Dockerfile base digest')
  assert(dockerfile.includes('FROM --platform=linux/amd64'), 'Dockerfile architecture')
  assert(dockerfile.includes('USER 10001:10001'), 'Dockerfile non-root user')
  assert(
    dockerfile.includes(`org.opencontainers.image.base.digest="${BASE_DIGEST}"`),
    'OCI base digest label',
  )
  assert(
    dockerfile.includes('ENTRYPOINT ["/usr/bin/tini", "--", "/opt/ocbox/bin/entrypoint.sh"]'),
    'tini init entrypoint',
  )
  assert(
    dockerfile.includes('dist/execution-helper.js /opt/ocbox/bin/ocbox-exec-helper.js'),
    'fixed helper path',
  )
  assert(
    dockerfile.includes('COPY --chown=ocbox:ocbox dist /opt/ocbox/cli/dist') &&
      dockerfile.includes('package.json /opt/ocbox/cli/package.json') &&
      dockerfile.includes('images/ocbox-base/ocbox /opt/ocbox/bin/'),
    'compiled CLI install',
  )
  assert(
    launcher.includes('node /opt/ocbox/cli/dist/index.js') && launcher.includes('exec '),
    'compiled CLI launcher',
  )
  assert(
    dockerfile.includes('npm install --global --ignore-scripts --force'),
    'verified archive install',
  )
  assert(!/\b(?:sudo|docker\.sock)\b/.test(dockerfile), 'forbidden runtime facility in Dockerfile')
  assert(
    entrypoint.includes('umask 027') && entrypoint.includes('exec "$@"'),
    'entrypoint semantics',
  )
  assert(
    readiness.includes('--protocol-version') &&
      readiness.includes('registry.npmjs.org') &&
      readiness.includes('ocbox --version') &&
      readiness.includes('mktemp -d /workspace'),
    'readiness coverage',
  )
  assert(
    manifest.capabilities.structuredArgv === true &&
      manifest.capabilities.bashShell === true &&
      manifest.capabilities.tty === false &&
      manifest.capabilities.preview === false &&
      manifest.capabilities.database === false &&
      manifest.capabilities.dockerSocket === false &&
      manifest.capabilities.sudo === false,
    'runtime capability gate',
  )
  assert(
    schema.properties.capabilities.additionalProperties === false &&
      schema.properties.capabilities.properties.structuredArgv.const === true &&
      schema.properties.capabilities.properties.sudo.const === false &&
      schema.properties.capabilities.properties.dockerSocket.const === false,
    'capability schema gate',
  )
  assert(
    workflow.includes('docker/setup-buildx-action@d7f5e7f509e45cec5c76c4d5afdd7de93d0b3df5'),
    'isolated Buildx builder pin',
  )
  const loadableStep = workflowStep(
    workflow,
    'Build loadable runtime candidate',
    'Export attested OCI candidate',
  )
  const ociStep = workflowStep(
    workflow,
    'Export attested OCI candidate',
    'Run readiness and image policy checks',
  )
  assert(loadableStep.includes('--load'), 'classic load output')
  assert(loadableStep.includes('--provenance=false'), 'classic load must disable provenance')
  assert(
    !loadableStep.includes('--provenance=mode=max'),
    'classic load must not claim attestations',
  )
  assert(ociStep.includes('--provenance=mode=max'), 'OCI output must enable provenance')
  assert(ociStep.includes('--output type=oci,dest=artifacts/ocbox-base.oci.tar'), 'OCI output file')
  assert(!ociStep.includes('--provenance=false'), 'OCI output must not disable provenance')
  assert(dockerfile.includes('ARG SOURCE_DATE_EPOCH='), 'reproducible build epoch default')
  assert(
    workflow.includes('SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct)'),
    'reproducible build epoch source',
  )
  assert(
    loadableStep.includes('--build-arg SOURCE_DATE_EPOCH=') &&
      ociStep.includes('--build-arg SOURCE_DATE_EPOCH='),
    'reproducible build epoch is pinned on both outputs',
  )
  assert(
    workflow.includes('subject-path: artifacts/ocbox-base.oci.tar') &&
      !workflow.includes('subject-path: artifacts/ocbox-base.tar'),
    'attestation subject is the OCI archive',
  )
  assert(
    workflow.includes(`jq -e '."buildx.build.provenance"'`),
    'provenance metadata fails closed',
  )
  const actionReferences = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)]
  assert(actionReferences.length >= 7, 'supply-chain action coverage')
  for (const match of actionReferences) {
    assert(/^[0-9a-f]{40}$/.test(match[1] ?? ''), 'workflow action is not pinned to a commit')
  }
  for (const required of [
    'spdx-json',
    'provenance',
    'vuln,secret',
    'cosign sign-blob',
    'schedule:',
  ]) {
    assert(workflow.includes(required), `workflow is missing ${required}`)
  }
}

export async function loadImageSources() {
  return {
    manifest: JSON.parse(await source('manifest.json')),
    schema: JSON.parse(await source('manifest.schema.json')),
    dockerfile: await source('Dockerfile'),
    entrypoint: await source('entrypoint.sh'),
    readiness: await source('readiness.sh'),
    launcher: await source('ocbox'),
    workflow: await readFile(new URL('../.github/workflows/image.yml', import.meta.url), 'utf8'),
  }
}

export async function verifyStaticCandidate() {
  verifyImageSources(await loadImageSources())

  const files = await walk(fileURLToPath(IMAGE))
  const credentialPattern =
    /(?:AKIA[A-Z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/
  for (const path of files) {
    const contents = await readFile(path, 'utf8')
    assert(!credentialPattern.test(contents), `credential-shaped material in ${path}`)
  }
}

export function verifyRegistryDigests() {
  const reference = `node:24-bookworm-slim@${INDEX_DIGEST}`
  const inspection = spawnSync('docker', ['buildx', 'imagetools', 'inspect', reference], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
    timeout: 60_000,
  })
  assert(inspection.status === 0, 'registry inspection command')
  assert(inspection.stdout.includes(`Digest:    ${INDEX_DIGEST}`), 'registry index digest')
  assert(inspection.stdout.includes(`sha256:${BASE_DIGEST.slice(7)}`), 'registry amd64 digest')
  assert(inspection.stdout.includes('Platform:    linux/amd64'), 'registry amd64 platform')
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await verifyStaticCandidate()
    if (process.argv.includes('--registry')) verifyRegistryDigests()
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, verified: true, registry: process.argv.includes('--registry') })}\n`,
    )
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Image candidate verification failed'}\n`,
    )
    process.exitCode = 1
  }
}
