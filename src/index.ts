import { execute } from '@oclif/core'

// oclif owns argument parsing and the built-in help/version surface. Product
// commands will be registered in later milestones.
await execute({
  development: false,
  dir: import.meta.url,
})
