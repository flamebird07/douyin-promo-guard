
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot
$promptPath = Join-Path $PSScriptRoot 'PROMPT.md'
$prompt = Get-Content -LiteralPath $promptPath -Raw -Encoding UTF8
codex exec -m gpt-5.6-sol -s read-only --skip-git-repo-check $prompt 1> (Join-Path $PSScriptRoot 'codex-out.txt') 2> (Join-Path $PSScriptRoot 'codex-err.txt')
$code = $LASTEXITCODE
Set-Content -LiteralPath (Join-Path $PSScriptRoot 'codex-exit.txt') -Value ("EXIT=" + $code) -Encoding ascii
exit $code
