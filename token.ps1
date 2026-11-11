param(
    [switch]$Check,
    [switch]$ForceRefresh,
    [string]$CredentialName = 'kimi-code',
    [string]$OAuthHost = 'https://auth.kimi.com',
    [string]$ApiBase = 'https://api.kimi.com/coding/v1'
)

# Local Codex auth helper. Tokens go only to the calling process's stdout.
# -Check prints non-secret status instead. No credentials are embedded here.
# OAuth protocol: MoonshotAI/kimi-code/packages/oauth/src/{constants,oauth,storage}.ts
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($CredentialName -notmatch '^kimi-code(?:-env-[0-9a-f]{16})?$') { throw 'Invalid Kimi credential name.' }
if ($OAuthHost -notin @('https://auth.kimi.com', 'https://auth.kimi.ai')) { throw 'Invalid Kimi OAuth host.' }
if ($ApiBase -notin @('https://api.kimi.com/coding/v1', 'https://api.kimi.ai/coding/v1')) { throw 'Invalid Kimi API base.' }
$kimiRoot = if ($env:KIMI_CODE_HOME) { $env:KIMI_CODE_HOME } else { Join-Path $env:USERPROFILE '.kimi-code' }
$tokenFile = Join-Path (Join-Path $kimiRoot 'credentials') ($CredentialName + '.json')
$tokenMutex = New-Object Threading.Mutex($false, ('Local\CodexKimiAccountRefresh-' + $CredentialName))
$locked = $false
$tempFile = $null
$stage = 'read'

function Read-KimiToken {
    $value = Get-Content -LiteralPath $tokenFile -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($value.access_token)) {
        throw 'No Kimi CLI login found. Run kimi login first.'
    }
    return $value
}

try {
    try { $locked = $tokenMutex.WaitOne(30000) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Kimi credential refresh is busy. Retry shortly.' }
    $token = Read-KimiToken
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    if ($ForceRefresh -or [double]$token.expires_at -le ($now + 300)) {
        if ([string]::IsNullOrWhiteSpace($token.refresh_token)) {
            throw 'Kimi login has expired. Run kimi login again.'
        }
        $beforeRefresh = [string]$token.refresh_token
        $stage = 'refresh'
        try {
            $newToken = Invoke-RestMethod -Method Post `
                -Uri ($OAuthHost + '/api/oauth/token') `
                -ContentType 'application/x-www-form-urlencoded' `
                -Body @{
                    client_id = '17e5f671-d194-4dfb-9706-5516cb48c098'
                    grant_type = 'refresh_token'
                    refresh_token = $beforeRefresh
                } -TimeoutSec 20
        } catch {
            # A running Kimi CLI may have rotated the shared credential.
            $latest = Read-KimiToken
            if ($latest.refresh_token -ne $beforeRefresh -and
                [double]$latest.expires_at -gt ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 60)) {
                $token = $latest
                $newToken = $null
            } else {
                throw 'Kimi token refresh failed. Open Kimi CLI to check your login and network.'
            }
        }
        if ($null -ne $newToken) {
            $stage = 'save'
            if ([string]::IsNullOrWhiteSpace($newToken.access_token) -or
                [string]::IsNullOrWhiteSpace($newToken.refresh_token) -or
                [double]$newToken.expires_in -le 0) {
                throw 'Kimi returned an invalid refresh response; credentials were not overwritten.'
            }
            $latest = Read-KimiToken
            if ($latest.refresh_token -ne $beforeRefresh) {
                # Preserve another process's newer login/refresh.
                $token = $latest
            } else {
                $token = [pscustomobject]@{
                    access_token = $newToken.access_token
                    refresh_token = $newToken.refresh_token
                    expires_at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + [double]$newToken.expires_in
                    scope = $newToken.scope
                    token_type = $newToken.token_type
                    expires_in = $newToken.expires_in
                }
                $tempFile = $tokenFile + '.tmp.' + [Guid]::NewGuid().ToString('N')
                [IO.File]::WriteAllText($tempFile, ($token | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
                # Replace preserves the destination file's Windows ACL.
                [IO.File]::Replace($tempFile, $tokenFile, [NullString]::Value)
                $tempFile = $null
            }
        }
    }
    if ([double]$token.expires_at -le [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) {
        throw 'Kimi login is expired. Open Kimi CLI to refresh it.'
    }
    if ($Check) {
        $stage = 'verify'
        $models = Invoke-RestMethod -Uri ($ApiBase + '/models') `
            -Headers @{ Authorization = ('Bearer ' + $token.access_token) } -TimeoutSec 20
        @{ ok = $true; models = @($models.data.id); expires_at = $token.expires_at } | ConvertTo-Json -Compress
    } else {
        [Console]::Out.Write([string]$token.access_token)
    }
} catch {
    # Avoid echoing HTTP bodies, headers, or token-bearing exception objects.
    [Console]::Error.WriteLine('Kimi account adapter failed. Check Kimi CLI login/network; credentials were not printed.')
    if ($Check) { [Console]::Error.WriteLine('Stage: ' + $stage + '; error type: ' + $_.Exception.GetType().Name + '; line: ' + $_.InvocationInfo.ScriptLineNumber) }
    if ($Check -and $stage -eq 'save') { [Console]::Error.WriteLine($_.Exception.Message) }
    exit 1
} finally {
    if ($null -ne $tempFile -and [IO.File]::Exists($tempFile)) { [IO.File]::Delete($tempFile) }
    if ($locked) { $tokenMutex.ReleaseMutex() }
    $tokenMutex.Dispose()
}
