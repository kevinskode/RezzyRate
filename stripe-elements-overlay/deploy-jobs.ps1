# Rezzy Rate: one-time setup for "Jobs that match your resume"
# Run from PowerShell:  cd stripe-elements-overlay ; .\deploy-jobs.ps1
# (If Windows blocks the script, run first:  Set-ExecutionPolicy -Scope Process Bypass)

$ErrorActionPreference = "Continue"
$Region = "us-east-2"
$Api    = "https://gyw1n7b24m.execute-api.us-east-2.amazonaws.com/Prod"
Set-Location $PSScriptRoot

Write-Host "`n== Rezzy Rate jobs setup ==" -ForegroundColor Cyan

# 1) Tools
foreach ($tool in @("aws", "sam")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Write-Host "Missing '$tool'. Install it, then re-run this script:" -ForegroundColor Red
    if ($tool -eq "aws") { Write-Host "  https://aws.amazon.com/cli/" } else { Write-Host "  https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html" }
    exit 1
  }
}
$who = $null
try { $who = aws sts get-caller-identity --query Account --output text 2>$null } catch {}
if ($LASTEXITCODE -ne 0 -or -not $who) { Write-Host "AWS CLI isn't signed in. Run 'aws configure' (or 'aws sso login') and try again." -ForegroundColor Red; exit 1 }
Write-Host "AWS account: $who"

# 2) Adzuna keys -> SSM (skipped if already saved)
$haveKeys = $true
try { aws ssm get-parameter --name /rezzy/adzuna/app_key --region $Region --query Parameter.Name --output text *> $null } catch { $haveKeys = $false }
if ($LASTEXITCODE -ne 0) { $haveKeys = $false }

if ($haveKeys) {
  $ans = Read-Host "Adzuna keys are already saved in AWS. Replace them? (y/N)"
  if ($ans -match '^[yY]') { $haveKeys = $false }
}
if (-not $haveKeys) {
  Write-Host "Get these free at https://developer.adzuna.com (Dashboard > API access details)."
  $appId  = Read-Host "Adzuna app_id"
  $secKey = Read-Host "Adzuna app_key" -AsSecureString
  $appKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secKey))
  aws ssm put-parameter --name /rezzy/adzuna/app_id  --type String       --value $appId  --overwrite --region $Region | Out-Null
  aws ssm put-parameter --name /rezzy/adzuna/app_key --type SecureString --value $appKey --overwrite --region $Region | Out-Null
  $appKey = $null
  if ($LASTEXITCODE -ne 0) { Write-Host "Couldn't save the keys to AWS (see error above)." -ForegroundColor Red; exit 1 }
  Write-Host "Saved Adzuna keys to AWS Parameter Store." -ForegroundColor Green
}

# 3) Build + deploy the backend
Write-Host "`nBuilding..." -ForegroundColor Cyan
sam build
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed (see above)." -ForegroundColor Red; exit 1 }
Write-Host "`nDeploying (review the change set, then type y)..." -ForegroundColor Cyan
sam deploy
if ($LASTEXITCODE -ne 0) { Write-Host "Deploy failed or was cancelled (see above)." -ForegroundColor Red; exit 1 }

# 4) Smoke test
Write-Host "`nTesting the jobs endpoint..." -ForegroundColor Cyan
Start-Sleep -Seconds 5
try {
  $r = Invoke-RestMethod "$Api/jobs?q=Data%20Analyst&skills=SQL,Python&where=Detroit%2C%20MI&limit=5"
  Write-Host ("Success: {0} live jobs returned. Job search is live on rezzyrate.com." -f $r.jobs.Count) -ForegroundColor Green
} catch {
  Write-Host "The endpoint returned an error: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "Copy this whole window and send it to Claude."
}
