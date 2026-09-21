import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { generateClient, generatedPath, loadContract } from './lib/openapi-contract.mjs'

const contract = loadContract()
const source = generateClient(contract)
mkdirSync(dirname(generatedPath), { recursive: true })
writeFileSync(generatedPath, source, 'utf8')
console.log(
  `Generated ${generatedPath} from openapi/openapi.yaml (sha256:${contract.sha256.slice(0, 12)}…)`,
)
