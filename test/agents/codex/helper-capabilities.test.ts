import { describe, expect, it } from 'vitest'
import {
  COVERED_CAPABILITIES,
  CODEX_ADAPTER_NOTICE,
  UNCOVERED_CAPABILITIES,
  capabilityMatrix,
} from '../../../src/agents/codex/capabilities.js'

describe('codex capability matrix', () => {
  it('is exact and honest about uncovered surfaces', () => {
    const matrix = capabilityMatrix()
    expect(matrix.covered).toEqual([...COVERED_CAPABILITIES])
    expect(matrix.uncovered).toEqual([...UNCOVERED_CAPABILITIES])
    expect(matrix.covered.length).toBeGreaterThan(0)
    expect(matrix.uncovered.length).toBeGreaterThan(0)
    expect(matrix.notice).toBe(CODEX_ADAPTER_NOTICE)
    expect(matrix.notice).toMatch(/routing aid/)
    expect(matrix.notice).toMatch(/not host isolation/)
  })

  it('describes the covered Bash path with the pinned exec grammar', () => {
    expect(COVERED_CAPABILITIES.join(' ')).toMatch(/Bash/)
    expect(COVERED_CAPABILITIES.join(' ')).toMatch(/ocbox exec/)
  })
})
