# ============================================================
# Test luồng nạp thẻ cào TheSieuRe trên PRODUCTION
# Chạy:  powershell -ExecutionPolicy Bypass -File backend/test/card-deposit-test.ps1
#
# CẢNH BÁO QUAN TRỌNG #1: PowerShell làm MẤT double quotes khi truyền
# JSON qua tham số -d "...". Body sẽ thành {email:...} -> JSON.parse fail
# -> 400 "Internal Server Error". LUÔN ghi body ra file tạm rồi dùng
# --data-binary "@file".
#
# CẢNH BÁO #2: dùng THẺ GIẢ để test chỉ xác nhận được "API gọi tới
# TheSieuRe + error handling". Muốn xác nhận credit wallet + webhook,
# PHẢI dùng thẻ cào THẬT (mệnh giá nhỏ nhất, ví dụ 10k/20k).
# ============================================================

param(
    [string]$Email = "tranminhkhaiyy07@gmail.com",
    [string]$Password = "trankhai339",
    [string]$ApiBase = "https://nexusvotex-api.onrender.com/api",
    [string]$CardType = "VIETTEL",
    [string]$Pin = "",
    [string]$Serial = "",
    [int]$Amount = 10000
)

$ErrorActionPreference = "Stop"
$tmp = Join-Path $env:TEMP "nexusvotex_body.json"
$UA = "User-Agent: node-fetch/2.6.0"

function Send-Json($Method, $Url, $Obj) {
    Set-Content -LiteralPath $tmp -Value ($Obj | ConvertTo-Json -Compress) -Encoding UTF8 -NoNewline
    curl.exe -s -w "`n[HTTP %{http_code}]" -X $Method $Url -H "Content-Type: application/json" -H $UA --data-binary "@$tmp"
}

Write-Output "===== 1. LOGIN ====="
$raw = curl.exe -s -X POST "$ApiBase/auth/login" -H "Content-Type: application/json" -H $UA --data-binary "@$(Set-Content -LiteralPath $tmp -Value ('{"email":"' + $Email + '","password":"' + $Password + '"}') -Encoding UTF8 -NoNewline; $tmp)"
$login = $raw | ConvertFrom-Json
if (-not $login.success) { Write-Output "LOGIN FAILED: $raw"; exit 1 }
$token = $login.data.token
Write-Output "Login OK - user: $($login.data.user.email) role: $($login.data.user.role)"
Write-Output "Token: $($token.Substring(0,30))..."

Write-Output "`n===== 2. BALANCE TRUOC ====="
$raw = curl.exe -s "$ApiBase/wallet/" -H "Authorization: Bearer $token" -H $UA
$before = ($raw | ConvertFrom-Json).data.balance
Write-Output "Balance: $before"

Write-Output "`n===== 3. SUBMIT CARD (${CardType} ${Amount}đ) ====="
if (-not $Pin -or -not $Serial) {
    Write-Output "KHONG co the thuc: chi test phan error-handling (provider tu choi)."
    $Pin = "12345678901234"
    $Serial = "12345678901234"
}
$resp = Send-Json "POST" "$ApiBase/wallet/deposit/card" @{ card_type = $CardType; pin = $Pin; serial = $Serial; amount = $Amount }
Write-Output $resp

$code = ($resp -split "\|")[-1]
if ($code -ne "200") {
    Write-Output "`nCard bi tu choi (thuong la the gia/da dung). Voi the THUC thanh cong HTTP 200."
    Write-Output "Xem payment record trong Supabase table 'payments' (method=thesieure)."
    exit 0
}

$paymentCode = (($resp -split "\|")[0] | ConvertFrom-Json).data.payment_code
Write-Output "Payment code: $paymentCode"

Write-Output "`n===== 4. POLL WALLET 60s (cho webhook credit) ====="
$deadline = (Get-Date).AddSeconds(60)
$newBalance = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $raw = curl.exe -s "$ApiBase/wallet/" -H "Authorization: Bearer $token" -H $UA
    $b = ($raw | ConvertFrom-Json).data.balance
    if ($b -ne $before) { $newBalance = $b; break }
}
if ($null -eq $newBalance) {
    Write-Output "Chua thay doi balance trong 60s. Kiem tra webhook TheSieuRe da tro toi:"
    Write-Output "  POST $ApiBase/webhook/thesieure"
} else {
    Write-Output "BALANCE THAY DOI: $before -> $newBalance (credit +$($newBalance - $before))"
}

Write-Output "`n===== 5. KET TRA SUPABASE (payments + wallet_transactions) ====="
Write-Output "Table 'payments'  : WHERE payment_code = '$paymentCode'"
Write-Output "Table 'wallet_transactions' : WHERE user_id = login user, type=deposit, ref_id=payment id"
Write-Output "Confirm trinh duyet admin: user -> vi -> lich su nap, notification 'Nap tien thanh cong'."
