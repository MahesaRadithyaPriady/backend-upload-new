#!/usr/bin/env pwsh
# Reset Daily Limit Script for Popular Encode Job (Windows)
# Run: .\utils\reset-daily-limit.ps1

$ErrorActionPreference = "Stop"

Write-Host "=" * 60 -ForegroundColor Cyan
Write-Host "Reset Daily Limit - Popular Encode Job" -ForegroundColor Cyan
Write-Host "=" * 60 -ForegroundColor Cyan

$dateKey = (Get-Date).ToString("yyyy-MM-dd")
Write-Host "Date: $dateKey" -ForegroundColor Gray
Write-Host ""

try {
    # Run the Node.js script
    node $PSScriptRoot\reset-daily-limit.js
} catch {
    Write-Host "❌ Error: $_" -ForegroundColor Red
    exit 1
}
