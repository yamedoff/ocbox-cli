/**
 * Coding-agent adapter kernels. CLI command shells live under src/commands.
 *
 * Export policy: the codex kernel is star-exported as the historical top-level
 * surface, while claude-code is namespace-only (`claudeCode`) because both
 * kernels export `ADAPTER_ID`, `buildHookCommand`, `isOwnedHookCommand`, and
 * other same-named helpers with different wire values. Star-exporting both
 * would make those names ambiguous (and silently resolve to one adapter), so
 * new adapters must follow the claude-code pattern: namespace-only here, with
 * an explicit `* as <name>Adapter` alias. The `codexAdapter` alias mirrors the
 * star export for call sites that want the adapter made explicit.
 */
export * from './codex/index.js'
export * as claudeCode from './claude-code/index.js'
export * as codexAdapter from './codex/index.js'
