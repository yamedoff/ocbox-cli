import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

export type ProtectedPathKind = 'directory' | 'file'

/** Injectable ACL boundary so permission failure and verification are testable. */
export interface WindowsAclProtector {
  protectAndVerify(path: string, kind: ProtectedPathKind): Promise<boolean>
}

const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Protect-Path($targetPath, $targetKind) {
$item = if ($targetKind -eq 'directory') {
  [System.IO.DirectoryInfo]::new($targetPath)
} else {
  [System.IO.FileInfo]::new($targetPath)
}
if (-not $item.Exists) { return 35 }
if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return 34 }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
function Test-UserOnlyAcl($candidate) {
  if (-not $candidate.AreAccessRulesProtected) { return $false }
  if ($candidate.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { return $false }
  $fullControl = $false
  # Request raw SIDs; .Access resolves account names and can wait for an
  # unavailable domain controller while checking inherited ACLs.
  foreach ($entry in $candidate.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    $entrySid = $entry.IdentityReference
    if ($entrySid.Value -ne $sid.Value) { return $false }
    if ($entry.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { return $false }
    if (($entry.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and
        -not ($entry.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly)) { $fullControl = $true }
  }
  return $fullControl
}
# A protected object needs verification only; rewriting its ACL may require
# privileges that ordinary users intentionally do not hold.
# Use .NET Framework APIs directly. PowerShell cmdlets autoload Management and
# Security modules, which can stall on Windows runners before ACL work begins.
# These APIs preserve literal paths and do not require module discovery.
if (Test-UserOnlyAcl ($item.GetAccessControl())) { return 0 }
$acl = if ($targetKind -eq 'directory') {
  [System.Security.AccessControl.DirectorySecurity]::new()
} else {
  [System.Security.AccessControl.FileSecurity]::new()
}
$acl.SetAccessRuleProtection($true, $false)
$inheritance = if ($targetKind -eq 'directory') {
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.SetOwner($sid)
$acl.SetAccessRule($rule)
$item.SetAccessControl($acl)
$verified = $item.GetAccessControl()
if (-not (Test-UserOnlyAcl $verified)) { return 31 }
return 0
}
# Requests contain only a path kind and a base64 UTF-8 path. Never evaluate
# request data as PowerShell code. Return one numeric verification status.
while ($null -ne ($request = [Console]::ReadLine())) {
  try {
    $parts = $request.Split(':', 2)
    if ($parts.Length -ne 2 -or $parts[0] -notin @('file', 'directory')) {
      [Console]::WriteLine('35')
      continue
    }
    $target = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
    $result = Protect-Path $target $parts[0]
    [Console]::WriteLine([string]$result)
  } catch {
    [Console]::WriteLine('32')
  }
}
`

/** Windows implementation that discards all subprocess output and returns only verification status. */
export class PowerShellWindowsAclProtector implements WindowsAclProtector {
  readonly #executable: string
  #worker: ChildProcessWithoutNullStreams | undefined
  #idleTimer: NodeJS.Timeout | undefined
  #queue: Promise<unknown> = Promise.resolve()

  constructor(executable = 'powershell.exe') {
    this.#executable = executable
  }

  protectAndVerify(path: string, kind: ProtectedPathKind): Promise<boolean> {
    // Serialize requests so a response can only authorize its own path. Reuse
    // one process for the repeated ACL checks of a credential operation; each
    // request still reads and verifies the current filesystem permissions.
    const request = this.#queue.then(() => this.#request(path, kind))
    this.#queue = request.catch(() => undefined)
    return request
  }

  #request(path: string, kind: ProtectedPathKind): Promise<boolean> {
    return new Promise((resolve) => {
      const startedAt = Date.now()
      // Test-only phase diagnostics never include the target path or ACL data.
      const diagnostic = process.env['OCBOX_AUTH_DIAGNOSTICS'] === '1'
      if (diagnostic) process.stderr.write(`Windows ACL: starting ${kind}\n`)
      // Windows PowerShell must discover its own modules, even when the CLI was
      // launched from PowerShell 7, whose inherited module path is incompatible.
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'),
      )
      if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer)
      const child =
        this.#worker ??
        spawn(
          this.#executable,
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(ACL_SCRIPT, 'utf16le').toString('base64'),
          ],
          {
            stdio: 'pipe',
            windowsHide: true,
            env: environment,
          },
        )
      this.#worker = child
      child.stderr.resume() // Discard errors without revealing paths or ACL data.
      this.#setReferenced(child, true)
      let response = ''
      let settled = false
      const finish = (code: number | null, signal: string | null = null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.stdin.off('error', onError)
        child.off('error', onError)
        child.off('exit', onExit)
        if (diagnostic) {
          process.stderr.write(
            `Windows ACL: finished ${kind} in ${Date.now() - startedAt}ms (exit ${code}, signal ${signal})\n`,
          )
        }
        if (code === 0) {
          this.#setReferenced(child, false)
          // Idle workers do not keep the CLI alive. Terminate them promptly if
          // a longer-lived caller stops using credential storage.
          this.#idleTimer = setTimeout(() => this.#discard(child), 5_000)
          this.#idleTimer.unref()
        } else {
          this.#discard(child)
        }
        resolve(code === 0)
      }
      const onData = (chunk: Buffer) => {
        response += chunk.toString('utf8')
        if (response.length > 16) return finish(null)
        if (!response.includes('\n')) return
        const value = response.trim()
        finish(/^\d+$/.test(value) ? Number(value) : null)
      }
      const onError = () => finish(null)
      const onExit = (code: number | null, signal: string | null) =>
        finish(code === 0 ? null : code, signal)
      const timer = setTimeout(() => finish(null, 'SIGTERM'), 10_000)
      child.stdout.on('data', onData)
      child.stdin.once('error', onError)
      child.once('error', onError)
      child.once('exit', onExit)
      child.stdin.write(`${kind}:${Buffer.from(path, 'utf8').toString('base64')}\n`, (error) => {
        if (error !== null && error !== undefined) finish(null)
      })
    })
  }

  #discard(child: ChildProcessWithoutNullStreams): void {
    if (this.#worker === child) this.#worker = undefined
    // Ignore late broken-pipe errors after timeout/idle termination.
    child.on('error', () => undefined)
    child.stdin.on('error', () => undefined)
    child.kill()
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
  }

  #setReferenced(child: ChildProcessWithoutNullStreams, referenced: boolean): void {
    if (referenced) child.ref()
    else child.unref()
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      const pipe = stream as typeof stream & { ref?(): void; unref?(): void }
      if (referenced) pipe.ref?.()
      else pipe.unref?.()
    }
  }
}
