import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import {
  generateClient,
  generatedPath,
  loadContract,
  repositoryRoot,
} from './lib/openapi-contract.mjs'

const contract = loadContract()
const expected = generateClient(contract)

let committed
try {
  committed = readFileSync(generatedPath, 'utf8')
} catch {
  console.error(`API contract drift: missing generated client ${generatedPath}`)
  process.exit(1)
}

if (committed !== expected) {
  console.error(
    `API contract drift: ${relative(repositoryRoot, generatedPath)} is not deterministic. Run \`pnpm run api:generate\` and commit the result.`,
  )
  process.exit(1)
}

if (!contract.provenance.generated.includes('src/api/generated/client.ts')) {
  console.error('API contract drift: PROVENANCE.json does not list the generated client')
  process.exit(1)
}

console.log(
  `API contract verified: commit ${contract.provenance.sourceCommit} sha256:${contract.sha256} matches the pinned generated client`,
)
