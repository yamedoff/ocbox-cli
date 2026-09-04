import { z } from 'zod'

/** A sandbox path; never a host/local filesystem path. */
export const SandboxPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes('\0'), 'Sandbox paths cannot contain NUL bytes')
  .brand<'SandboxPath'>()

export type SandboxPath = z.infer<typeof SandboxPathSchema>
