param(
    [string]$Tmc2Root = "..\GS4-vpcc\mpeg-pcc-tmc2",
    [string]$BuildDir = "..\GS4-vpcc\mpeg-pcc-tmc2\build-wasm",
    [string]$OutputDir = ".\static\lib\vpcc",
    [string]$EmSdkEnv = ""
)

$ErrorActionPreference = "Stop"

if ($EmSdkEnv -and (Test-Path $EmSdkEnv)) {
    Write-Host "Importing Emscripten environment from $EmSdkEnv"
    . $EmSdkEnv | Out-Null
}

function Resolve-CMakeExecutable {
    $cmakeCommand = Get-Command cmake -ErrorAction SilentlyContinue
    if ($cmakeCommand) {
        return $cmakeCommand.Source
    }

    $candidatePaths = @(
        (Join-Path $env:APPDATA "Python\Python313\Scripts\cmake.exe"),
        (Join-Path $env:APPDATA "Python\Python314\Scripts\cmake.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\Scripts\cmake.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python314\Scripts\cmake.exe")
    )

    foreach ($candidate in $candidatePaths) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    throw "cmake was not found. Install cmake and ensure it is on PATH, or install it with 'python -m pip install --user cmake'."
}

function Get-UserToolDirectories {
    return @(
        (Join-Path $env:APPDATA "Python\Python313\Scripts"),
        (Join-Path $env:APPDATA "Python\Python314\Scripts"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\Scripts"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python314\Scripts")
    ) | Where-Object { Test-Path $_ }
}

function Invoke-CMake {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    $cmakeExe = Resolve-CMakeExecutable
    & $cmakeExe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "cmake command failed with exit code $LASTEXITCODE"
    }
}

if (-not (Get-Command emcmake -ErrorAction SilentlyContinue)) {
    throw "emcmake was not found. Install Emscripten and ensure emcmake/emcc are on PATH, or pass -EmSdkEnv path\to\emsdk_env.ps1."
}

$cmakeExe = Resolve-CMakeExecutable
$toolDirs = @((Split-Path $cmakeExe -Parent)) + (Get-UserToolDirectories)
$uniqueToolDirs = $toolDirs | Select-Object -Unique
$env:PATH = ($uniqueToolDirs -join ';') + ";$env:PATH"

$tmc2RootPath = Resolve-Path $Tmc2Root
$buildPath = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $BuildDir))
$outputPath = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputDir))

New-Item -ItemType Directory -Force -Path $buildPath | Out-Null
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null

$configureArgs = @(
    "cmake",
    "-S", $tmc2RootPath,
    "-B", $buildPath,
    "-G", "Ninja",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_CXX_FLAGS_RELEASE=-O3 -DNDEBUG -msimd128",
    "-DCMAKE_C_FLAGS_RELEASE=-O3 -DNDEBUG -msimd128",
    "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
    "-DBUILD_BROWSER_VPCC_WASM=ON",
    "-DBUILD_TMC2_NATIVE_APPS=OFF",
    "-DBUILD_TMC2_ENCODER_COMPONENTS=OFF",
    "-DENABLE_TBB=OFF",
    "-DBITSTREAM_TRACE=OFF",
    "-DCONFORMANCE_TRACE=OFF",
    "-DCODEC_TRACE=OFF",
    "-DSEI_TRACE=OFF",
    "-DUSE_JMAPP_VIDEO_CODEC=OFF",
    "-DUSE_HMAPP_VIDEO_CODEC=OFF",
    "-DUSE_SHMAPP_VIDEO_CODEC=OFF",
    "-DUSE_HDRTOOLS=OFF",
    "-DUSE_HMLIB_VIDEO_CODEC=ON"
)

Write-Host "Configuring VPCC WASM build..."
& emcmake @configureArgs

Write-Host "Building VPCC WASM bridge..."
Invoke-CMake --build $buildPath --target PccAppDecoderWasm

$jsArtifact = Join-Path $tmc2RootPath "bin\pcc-app-decoder-wasm.js"
$wasmArtifact = Join-Path $tmc2RootPath "bin\pcc-app-decoder-wasm.wasm"

if (-not (Test-Path $jsArtifact)) {
    throw "Expected JS artifact was not found at $jsArtifact"
}
if (-not (Test-Path $wasmArtifact)) {
    throw "Expected WASM artifact was not found at $wasmArtifact"
}

Copy-Item $jsArtifact (Join-Path $outputPath "pcc-app-decoder-wasm.js") -Force
Copy-Item $wasmArtifact (Join-Path $outputPath "pcc-app-decoder-wasm.wasm") -Force

Write-Host "VPCC WASM artifacts copied to $outputPath"
