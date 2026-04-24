#!/usr/bin/env pwsh
# Popular Encode Progress Migration Script for Windows
# Run: .\utils\migrate-popular-encode.ps1

$ErrorActionPreference = "Stop"

Write-Host "=" * 60 -ForegroundColor Cyan
Write-Host "Popular Encode Progress Migration" -ForegroundColor Cyan
Write-Host "=" * 60 -ForegroundColor Cyan
Write-Host ""

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $projectRoot

Write-Host "Project Root: $projectRoot" -ForegroundColor Gray
Write-Host ""

try {
    # Step 1: Generate Prisma Client
    Write-Host "> Step 1: Generating Prisma Client..." -ForegroundColor Yellow
    npx prisma generate --config=prisma.config.ts
    Write-Host "  ✓ Prisma Client generated" -ForegroundColor Green
    Write-Host ""

    # Step 2: Push schema to database (quick sync)
    Write-Host "> Step 2: Pushing schema to database (db push)..." -ForegroundColor Yellow
    npx prisma db push --accept-data-loss --config=prisma.config.ts
    Write-Host "  ✓ Schema pushed to database" -ForegroundColor Green
    Write-Host ""

    Write-Host "=" * 60 -ForegroundColor Green
    Write-Host "✓ Migration completed successfully!" -ForegroundColor Green
    Write-Host "=" * 60 -ForegroundColor Green
    Write-Host ""
    Write-Host "Table 'popular_encode_progress' is now ready." -ForegroundColor White
    Write-Host "You can verify with: npm run db:studio" -ForegroundColor Gray

} catch {
    Write-Host ""
    Write-Host "=" * 60 -ForegroundColor Red
    Write-Host "✗ Migration failed" -ForegroundColor Red
    Write-host "=" * 60 -ForegroundColor Red
    Write-Host ""
    Write-Host "Error: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "Troubleshooting:" -ForegroundColor Yellow
    Write-Host "1. Ensure DATABASE_URL is set in .env"
    Write-Host "2. Ensure PostgreSQL is running"
    Write-Host "3. Check prisma/schema.prisma is valid"
    Write-Host ""
    Write-Host "Alternative quick fix:" -ForegroundColor Cyan
    Write-Host "  npx prisma db push --accept-data-loss --config=prisma.config.ts"
    exit 1
}
