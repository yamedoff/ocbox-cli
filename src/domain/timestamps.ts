import { z } from 'zod'

const CANONICAL_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** A canonical UTC instant serialized exactly as JavaScript Date#toISOString. */
export const UtcTimestampSchema = z
  .string()
  .regex(CANONICAL_UTC_PATTERN, 'Expected canonical UTC timestamp with millisecond precision')
  .refine((value) => {
    const instant = new Date(value)
    return !Number.isNaN(instant.valueOf()) && instant.toISOString() === value
  }, 'Expected a real canonical UTC instant')
  .brand<'UtcTimestamp'>()

/** Unix epoch milliseconds for boundaries that must remain numeric. */
export const UnixEpochMillisecondsSchema = z
  .number()
  .int()
  .nonnegative()
  .safe()
  .brand<'UnixEpochMilliseconds'>()

/** Explicitly unit-bearing duration used by provider and execution contracts. */
export const DurationMillisecondsSchema = z
  .number()
  .int()
  .nonnegative()
  .safe()
  .brand<'DurationMilliseconds'>()

export type UtcTimestamp = z.infer<typeof UtcTimestampSchema>
export type UnixEpochMilliseconds = z.infer<typeof UnixEpochMillisecondsSchema>
export type DurationMilliseconds = z.infer<typeof DurationMillisecondsSchema>
