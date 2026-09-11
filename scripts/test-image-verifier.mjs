import assert from 'node:assert/strict'
import { loadImageSources, verifyImageSources } from './verify-image-candidate.mjs'

// The static verifier must accept the committed candidate and fail closed on
// each reviewed invariant. These cases mutate a throwaway copy of the real
// sources so drift (for example, re-attaching provenance to the classic load
// path, dropping the CLI from the image, or weakening a capability) is caught.
const baseline = await loadImageSources()
verifyImageSources(baseline)

const cases = [
  [
    'classic load must disable provenance',
    (sources) => {
      sources.workflow = sources.workflow.replace('--provenance=false', '--provenance=mode=max')
    },
  ],
  [
    'classic load must not claim attestations',
    (sources) => {
      sources.workflow = sources.workflow.replace(
        '--provenance=false',
        '--provenance=mode=max --provenance=false',
      )
    },
  ],
  [
    'tini init entrypoint',
    (sources) => {
      sources.dockerfile = sources.dockerfile.replace(
        'ENTRYPOINT ["/usr/bin/tini"',
        'ENTRYPOINT ["/bin/sh"',
      )
    },
  ],
  [
    'compiled CLI install',
    (sources) => {
      sources.dockerfile = sources.dockerfile.replace('COPY --chown=ocbox:ocbox dist ', '')
    },
  ],
  [
    'compiled CLI launcher',
    (sources) => {
      sources.launcher = '#!/bin/bash\nexit 0\n'
    },
  ],
  [
    'fixed helper path',
    (sources) => {
      sources.dockerfile = sources.dockerfile.replace(
        'dist/execution-helper.js /opt/ocbox/bin/ocbox-exec-helper.js',
        'dist/execution-helper.js /opt/ocbox/bin/helper.js',
      )
    },
  ],
  [
    'OCI base digest label',
    (sources) => {
      sources.dockerfile = sources.dockerfile.replace(
        'org.opencontainers.image.base.digest',
        'org.opencontainers.image.base.note',
      )
    },
  ],
  [
    'runtime capability gate',
    (sources) => {
      sources.manifest.capabilities.sudo = true
    },
  ],
  [
    'capability schema gate',
    (sources) => {
      sources.schema.properties.capabilities.properties.sudo.const = true
    },
  ],
  [
    'readiness coverage',
    (sources) => {
      sources.readiness = sources.readiness.replace('mktemp -d /workspace', 'mktemp /workspace')
    },
  ],
  [
    'reproducible build epoch default',
    (sources) => {
      sources.dockerfile = sources.dockerfile.replace('ARG SOURCE_DATE_EPOCH=', 'ARG UNUSED=')
    },
  ],
  [
    'reproducible build epoch is pinned on both outputs',
    (sources) => {
      sources.workflow = sources.workflow.replaceAll(
        '--build-arg SOURCE_DATE_EPOCH=',
        '--build-arg UNUSED=',
      )
    },
  ],
  [
    'provenance metadata fails closed',
    (sources) => {
      sources.workflow = sources.workflow.replace(
        `jq -e '."buildx.build.provenance"'`,
        `jq '."buildx.build.provenance"'`,
      )
    },
  ],
  [
    'attestation subject is the OCI archive',
    (sources) => {
      sources.workflow = sources.workflow.replace(
        'subject-path: artifacts/ocbox-base.oci.tar',
        'subject-path: artifacts/ocbox-base.tar',
      )
    },
  ],
  [
    'workflow action is not pinned to a commit',
    (sources) => {
      sources.workflow = sources.workflow.replace(
        'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        'actions/checkout@v7',
      )
    },
  ],
]

for (const [expected, mutate] of cases) {
  const draft = structuredClone(baseline)
  mutate(draft)
  assert.throws(
    () => verifyImageSources(draft),
    (error) => {
      assert.ok(
        typeof error?.message === 'string' && error.message.includes(expected),
        `expected "${expected}", received "${error?.message}"`,
      )
      return true
    },
    `expected drift to fail closed: ${expected}`,
  )
}

process.stdout.write(`Image verifier fail-closed cases passed (${cases.length})\n`)
