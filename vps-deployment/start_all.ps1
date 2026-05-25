Get-Process nginx -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process python -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

# nginx must be started from its own directory
Set-Location 'C:\nginx-1.26.3'
Start-Process -FilePath 'C:\nginx-1.26.3\nginx.exe' -WorkingDirectory 'C:\nginx-1.26.3' -WindowStyle Hidden

# Flask — use full python path so PATH doesn't matter
$py = (Get-Command python.exe).Source
Start-Process -FilePath $py -ArgumentList 'app.py' -WorkingDirectory 'C:\quantlab\backend' -WindowStyle Hidden -RedirectStandardOutput 'C:\quantlab\backend.log' -RedirectStandardError 'C:\quantlab\backend_err.log'

Start-Sleep -Seconds 10
Write-Host ('nginx: ' + (Get-Process nginx -ErrorAction SilentlyContinue | Measure-Object).Count)
Write-Host ('python: ' + (Get-Process python -ErrorAction SilentlyContinue | Measure-Object).Count)
if (Test-Path 'C:\quantlab\backend.log') { Get-Content 'C:\quantlab\backend.log' -Tail 30 }
if (Test-Path 'C:\quantlab\backend_err.log') {
    $err = Get-Content 'C:\quantlab\backend_err.log' -Raw
    if ($err.Trim()) { Write-Host '--- stderr ---'; Write-Host $err }
}
