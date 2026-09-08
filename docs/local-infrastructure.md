# Local infrastructure

Implements [T3](https://app.notion.com/p/c745d7fe772c460d926db52f68d2cfd4) through the side-effect-free `opencloudbox/infrastructure` entry point.

`parseProjectConfig` validates schemaVersion 1 TOML with provider, sandbox, sandbox.resources, network, lifecycle, source and optional non-secret env settings. Resource units are cpuMillicores, memoryBytes and diskBytes. Unknown/deprecated fields fail with paths and typo suggestions. Migration refuses credential material. `resolveConfigurationValue` selects CLI, environment, project, then default; invalid environment input fails without echoing its value.

| Host | Config | State | Cache |
| --- | --- | --- | --- |
| Windows | APPDATA/OpenCloudBox | LOCALAPPDATA/OpenCloudBox | state/Cache |
| Linux/WSL | XDG_CONFIG_HOME/ocbox | XDG_STATE_HOME/ocbox | XDG_CACHE_HOME/ocbox |
| macOS | ~/Library/Application Support/OpenCloudBox | same as config | ~/Library/Caches/OpenCloudBox |

Absent or relative XDG roots use ~/.config, ~/.local/state and ~/.cache. Windows uses home/AppData fallbacks. WSL state on /mnt/<drive> disables the protected credential fallback.

`LocalStateStore` persists activeSessionId, Session/provider mappings and content-free manifest baselines. It validates IDs before constructing paths, serializes mutations, fsyncs temporary files and atomically renames. Directory fsync runs where supported. Invalid state is quarantined without echoing content. Stale-owner inspection/removal is serialized to prevent concurrent reapers removing a new owner's lock. If recovery itself crashes, its .lock.recovery guard deliberately blocks further recovery: stop all CLI processes using that directory, inspect the abandoned lock, then remove the guard. Windows delete-pending sharing failures become bounded contention.

Hosted OAuth uses the OS-store port and never silently downgrades after an available adapter fails. The fallback uses Unix 0700/0600 or verified current-user Windows ACLs. Permissions are verified before writing credential bytes; links are rejected and temporary material is removed on failure. Provider keys remain environment-only. Human/JSON/JSONL envelopes use recursive redaction, TTY progress and NO_COLOR; telemetry has an additional flat allowlist excluding source/environment metadata.

AC1/2: config, migration and precedence tests. AC3: Windows/macOS/WSL/XDG path fixtures. AC4/5: atomic round-trip, quarantine, cancellation, contention, stale-owner and concurrent-reaper tests. AC6: protected-file cleanup, OS-adapter failure and real native Windows ACL round-trip with quoted paths. AC7/8: output goldens, redirected progress, no-color and telemetry exclusion.

Native Windows is exercised locally. Unix modes run only on Unix; native macOS and broader multi-process CLI checks remain integration acceptance work. These tests do not establish real-provider or hosted-auth readiness.
