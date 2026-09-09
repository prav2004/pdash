# =============================================================
#  Adds the ONE DNS record Firebase needs, straight into Netlify.
#  You do NOT type your password. You paste a Netlify "token"
#  (a revocable key) when asked - it stays hidden and local.
# =============================================================

$sec = Read-Host "Paste your Netlify personal access token, then press Enter (input is hidden)" -AsSecureString
$token = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
$headers = @{ Authorization = "Bearer $token" }

Write-Host ""
Write-Host "Looking up your domain in Netlify..."
try {
    $zones = Invoke-RestMethod -Uri "https://api.netlify.com/api/v1/dns_zones" -Headers $headers -Method Get
} catch {
    Write-Host "ERROR: Could not connect to Netlify. Is the token correct? Details:" -ForegroundColor Red
    Write-Host $_.Exception.Message
    exit 1
}

$zone = $zones | Where-Object { $_.name -eq "pickrpicks.app" } | Select-Object -First 1
if (-not $zone) {
    Write-Host "Could not find 'pickrpicks.app' in this Netlify account." -ForegroundColor Red
    Write-Host "Domains this token can see:"
    $zones | ForEach-Object { Write-Host "  - $($_.name)" }
    exit 1
}
Write-Host "Found your domain: $($zone.name)"

# Avoid creating a duplicate
$records  = Invoke-RestMethod -Uri "https://api.netlify.com/api/v1/dns_zones/$($zone.id)/dns_records" -Headers $headers -Method Get
$existing = $records | Where-Object { $_.type -eq "TXT" -and $_.value -eq "hosting-site=pickrdashbaord" }
if ($existing) {
    Write-Host "The record is already there - nothing to add. You're good!" -ForegroundColor Green
    exit 0
}

$body = @{ type = "TXT"; hostname = "pickrpicks.app"; value = "hosting-site=pickrdashbaord"; ttl = 3600 } | ConvertTo-Json
try {
    Invoke-RestMethod -Uri "https://api.netlify.com/api/v1/dns_zones/$($zone.id)/dns_records" -Headers $headers -Method Post -Body $body -ContentType "application/json" | Out-Null
    Write-Host ""
    Write-Host "SUCCESS! Added the TXT record (hosting-site=pickrdashbaord) to pickrpicks.app." -ForegroundColor Green
    Write-Host "Now tell the assistant 'check' and it will finish the launch."
} catch {
    Write-Host "Could not add the record. Details:" -ForegroundColor Red
    Write-Host $_.Exception.Message
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
    exit 1
}
