<#
    Собирает архив, который уезжает на сервер.

        deploy\package.ps1

    Кладёт deploy\dist\obsidian-server-<дата>.zip. Внутрь попадает только то,
    что серверу действительно нужно: исходники, манифесты и пример конфига.
    Ни node_modules (там бинари под платформу сборщика), ни data/ (это чужая
    база), ни .env (там админский токен).
#>
param(
    [string]$OutDir = (Join-Path $PSScriptRoot "dist")
)

$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$server = Join-Path $root "obsidian-server"
if (-not (Test-Path (Join-Path $server "src\index.ts"))) {
    throw "Не найден obsidian-server рядом с deploy\"
}

# Со временем, а не только с датой: за день архив собирают не один раз, и
# затирать предыдущий, который уже уехал на сервер, нельзя.
$stamp = Get-Date -Format "yyyy-MM-dd-HHmm"
$staging = Join-Path ([System.IO.Path]::GetTempPath()) "obsidian-package-$([guid]::NewGuid())"
$archive = Join-Path $OutDir "obsidian-server-$stamp.zip"

New-Item -ItemType Directory -Path $staging -Force | Out-Null
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

# Исходники целиком: TypeScript выполняется Node напрямую, сборки нет.
Copy-Item -Recurse (Join-Path $server "src") (Join-Path $staging "src")

# tsconfig.json нужен для `npm run check` на копии разработчика; сам сервер его
# не читает — TypeScript выполняется Node напрямую, без компиляции.
foreach ($file in @("package.json", "package-lock.json", "tsconfig.json", ".npmrc", ".env.example", "README.md")) {
    Copy-Item (Join-Path $server $file) (Join-Path $staging $file)
}

# Тесты не грузим: на сервере им нечего делать, а поверхность они увеличивают.
# Инструкция по установке едет вместе с архивом.
Copy-Item (Join-Path $PSScriptRoot "README.md") (Join-Path $staging "DEPLOY.md")
Copy-Item -Recurse (Join-Path $PSScriptRoot "systemd") (Join-Path $staging "systemd")
Copy-Item -Recurse (Join-Path $PSScriptRoot "cloudflared") (Join-Path $staging "cloudflared")
Copy-Item -Recurse (Join-Path $PSScriptRoot "windows") (Join-Path $staging "windows")

# Страховка от глупой ошибки: секретов в архиве быть не должно.
$leaked = Get-ChildItem -Recurse -Force $staging |
    Where-Object { $_.Name -eq ".env" -or $_.Name -eq "node_modules" -or $_.Name -eq "data" }
if ($leaked) {
    Remove-Item -Recurse -Force $staging
    throw "В сборку попало лишнее: $($leaked.Name -join ', ')"
}

if (Test-Path $archive) { Remove-Item $archive }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $archive
Remove-Item -Recurse -Force $staging

$size = [math]::Round((Get-Item $archive).Length / 1KB)
Write-Host "Готово: $archive ($size КБ)"
Write-Host ""
Write-Host "На сервере:"
Write-Host "  npm ci --ignore-scripts --omit=optional --omit=dev"
Write-Host "  cp .env.example .env   # и поправить"
Write-Host "  node src/index.ts      # проверить, потом автозапуск — см. DEPLOY.md"
