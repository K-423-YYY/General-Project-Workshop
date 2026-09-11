# harness command wrapper (PowerShell) - real logic lives in _log.mjs
$log = Join-Path $PSScriptRoot '_log.mjs'
& node $log --tool python3 -- @args
exit $LASTEXITCODE
