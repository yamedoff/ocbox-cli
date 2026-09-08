import { spawn } from 'node:child_process'

export type ProtectedPathKind = 'directory' | 'file'

/** Injectable ACL boundary so permission failure and verification are testable. */
export interface WindowsAclProtector {
  protectAndVerify(path: string, kind: ProtectedPathKind): Promise<boolean>
}

const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$targetPath = $env:OCBOX_ACL_TARGET_PATH
$targetKind = $env:OCBOX_ACL_TARGET_KIND
$item = Get-Item -LiteralPath $targetPath -Force
if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { exit 34 }
if (($targetKind -eq 'directory') -ne $item.PSIsContainer) { exit 35 }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
function Test-UserOnlyAcl($candidate) {
  if (-not $candidate.AreAccessRulesProtected) { return $false }
  if ($candidate.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { return $false }
  $fullControl = $false
  foreach ($entry in @($candidate.Access)) {
    $entrySid = $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])
    if ($entrySid.Value -ne $sid.Value) { return $false }
    if ($entry.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { return $false }
    if (($entry.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and
        -not ($entry.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly)) { $fullControl = $true }
  }
  return $fullControl
}
# A protected object needs verification only; rewriting its ACL may require
# privileges that ordinary users intentionally do not hold.
if (Test-UserOnlyAcl (Get-Acl -LiteralPath $targetPath)) { exit 0 }
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
Set-Acl -LiteralPath $targetPath -AclObject $acl
$verified = Get-Acl -LiteralPath $targetPath
if (-not (Test-UserOnlyAcl $verified)) { exit 31 }
`

/** Windows implementation that discards all subprocess output and returns only verification status. */
export class PowerShellWindowsAclProtector implements WindowsAclProtector {
  readonly #executable: string

  constructor(executable = 'powershell.exe') {
    this.#executable = executable
  }

  protectAndVerify(path: string, kind: ProtectedPathKind): Promise<boolean> {
    return new Promise((resolve) => {
      // Windows PowerShell must discover its own modules, even when the CLI was
      // launched from PowerShell 7, whose inherited module path is incompatible.
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'),
      )
      const child = spawn(
        this.#executable,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(ACL_SCRIPT, 'utf16le').toString('base64'),
        ],
        {
          stdio: 'ignore',
          windowsHide: true,
          // Pass paths as data; PowerShell -Command would parse trailing arguments as code.
          env: { ...environment, OCBOX_ACL_TARGET_PATH: path, OCBOX_ACL_TARGET_KIND: kind },
          timeout: 10_000,
        },
      )
      child.once('error', () => resolve(false))
      child.once('exit', (code) => resolve(code === 0))
    })
  }
}
