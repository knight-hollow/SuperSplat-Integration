# Browser VPCC WASM Integration

## Purpose

This document explains how browser-side VPCC decoding was integrated into `supersplat`, why the final architecture was chosen, how the original `GS4-vpcc` project was trimmed into a WebAssembly-friendly decode target, and what each new or modified file is responsible for.

The end goal is:

- user selects a `.bin` or `.v3c` file in the browser
- the browser loads a VPCC decoder compiled to WebAssembly
- the decoder reconstructs a `.ply` file in memory
- `supersplat` imports that `.ply` through its existing import pipeline

## How The Overall Architecture Was Chosen

### Starting point

At the beginning there were two independent codebases:

- `GS4-vpcc`, which can decode VPCC bitstreams using the TMC2 decoder stack
- `supersplat`, which already knows how to import and render Gaussian splat data, including PLY-based data paths

The first architectural question was not "how to rewrite everything in the browser", but rather:

- which part of the pipeline should stay unchanged
- which part must move from native execution to browser execution

### Key architectural decision

The chosen design was:

- keep `supersplat`'s existing PLY import pipeline
- only replace the VPCC decode stage

That means the browser-side path is:

```text
.bin / .v3c
-> browser File object
-> VPCC WASM bridge
-> Emscripten virtual file system
-> vpcc_decode_file(inputPath, outputPath)
-> reconstructed .ply in virtual FS
-> browser reads .ply bytes
-> existing SuperSplat PLY import path
```

This was chosen because it minimizes risk:

- no need to rewrite `supersplat`'s renderer
- no need to teach `supersplat` a brand new internal VPCC data format
- the browser decoder can focus on one job only: bitstream to PLY

### Why not decode directly into SuperSplat internal structures

That option would have required:

- understanding and recreating `supersplat`'s internal asset structures
- writing a browser-side conversion layer for all Gaussian attributes
- changing more rendering-side code

Using `.ply` as the handoff format was simpler and more robust because:

- `GS4-vpcc` already knows how to reconstruct PLY
- `supersplat` already knows how to load PLY
- the integration boundary stays clean

### Why a dedicated WASM wrapper target was created

The native `PccAppDecoder` executable is built as a command-line application. That is not a good direct match for browser use.

The browser needs:

- a small exported ABI
- stable input/output function signatures
- no command-line parsing layer

So a separate wrapper target was introduced:

- `PccAppDecoderWasm`

Its job is to expose only:

- `vpcc_decode_file(inputPath, outputPath)`
- `vpcc_get_last_error()`

This keeps the browser boundary small and easy to call from TypeScript.

## Implementation Steps

## 1. Define The Browser Decode Pipeline

The first practical step was to define the exact runtime pipeline:

1. user imports `.bin` or `.v3c` from the normal `Import` entry
2. frontend recognizes the extension as VPCC
3. frontend loads the Emscripten-generated module
4. uploaded bytes are written into the Emscripten virtual file system
5. exported C function is called
6. decoder writes a `.ply` into the virtual file system
7. frontend reads the `.ply` back into a browser `File`
8. `supersplat` imports that file as if it were any other PLY

This pipeline became the contract between the VPCC side and the `supersplat` side.

## 2. Trim The TMC2 Build To A Minimal Browser-Oriented Target

The original TMC2 project contains:

- native applications
- encoder components
- optional external codecs
- threading features and tooling that are not useful for the browser build

To avoid compiling unnecessary or incompatible parts, `GS4-vpcc/mpeg-pcc-tmc2/CMakeLists.txt` was modified to add browser-oriented switches:

- `BUILD_BROWSER_VPCC_WASM`
- `BUILD_TMC2_NATIVE_APPS`
- `BUILD_TMC2_ENCODER_COMPONENTS`

These switches made it possible to:

- keep decoder libraries
- skip native command-line apps
- skip encoder-only pieces
- skip components that do not help browser-side decoding

This build trimming is the reason the project could be turned into a manageable WebAssembly target instead of trying to compile the entire native tree unchanged.

## 3. Create A Dedicated WASM Decoder Target

A new target directory was added:

- `GS4-vpcc/mpeg-pcc-tmc2/source/app/PccAppDecoderWasm/`

This target was introduced specifically for browser use. Its CMake file:

- includes only the headers needed by the wrapper
- links only the required decode-side libraries
- sets Emscripten output options
- exports a small browser-callable ABI

This is where the native code is turned into a module that the browser can actually load.

## 4. Implement The C++ WASM Bridge

The file:

- `GS4-vpcc/mpeg-pcc-tmc2/source/app/PccAppDecoderWasm/PccAppDecoderWasm.cpp`

implements the wrapper around the VPCC decode libraries.

Its main responsibilities are:

- validate input and output paths
- set up `PCCDecoderParameters`
- initialize the VPCC bitstream
- read and decode V3C units through `PCCBitstreamReader`
- call `PCCDecoder`
- reconstruct output point clouds
- write the result as `.ply`
- capture the last error message for JavaScript

The exported functions are:

- `vpcc_decode_file`
- `vpcc_get_last_error`

This wrapper is the core of browser-side direct decode. Without it, the browser would have no simple way to call into the native VPCC library stack.

## 5. Configure Emscripten Output For Browser Use

The WASM target CMake file was configured with browser-specific link options, including:

- `WASM=1`
- `EXPORT_ES6=1`
- `MODULARIZE=1`
- `ENVIRONMENT=web,worker,node`
- `FILESYSTEM=1`
- `ALLOW_MEMORY_GROWTH=1`
- exported runtime methods for `ccall` and `FS`

These options are important because:

- the browser needs an importable JS module
- the decoder expects file paths, so the Emscripten virtual file system must exist
- VPCC decode is memory-intensive, so fixed tiny heaps are not sufficient

Later debugging also required larger memory limits and exception support for the decoder path.

## 6. Fix TMC2 Source And Build Issues Exposed By Emscripten

After the browser target existed, compilation still failed in several places. Those issues had to be resolved before browser-side decode could even start.

Key fixes included:

- updating `dependencies/CMakeLists.txt` so browser builds do not incorrectly pull the wrong native parser dependency
- fixing narrowing conversion issues in `PCCPointSet.cpp`
- adding missing includes in `PccAppDecoderWasm.cpp`
- enabling C++ exceptions for the browser-targeted build when needed

These changes were not optional polish. They were required to make the native decoder code compile under Emscripten's Clang toolchain.

## 7. Add An Offline Windows Build Script

The file:

- `supersplat/build-vpcc-wasm.ps1`

was created as the Windows entry point for building the VPCC decoder to WASM.

It does the following:

1. optionally imports the Emscripten environment from `emsdk_env.ps1`
2. locates `cmake`
3. adds user Python scripts directories to `PATH` so `cmake` and `ninja` can be found
4. configures an Emscripten build for `mpeg-pcc-tmc2`
5. builds the `PccAppDecoderWasm` target
6. copies the generated `.js` and `.wasm` artifacts into `supersplat/static/lib/vpcc`

This script is important because the browser-side decode path is only usable after these artifacts exist.

## 8. Build A TypeScript WASM Bridge In SuperSplat

On the frontend side, these files were added:

- `src/vpcc/types.ts`
- `src/vpcc/wasm-decoder.ts`

The main work happens in `src/vpcc/wasm-decoder.ts`.

That file is responsible for:

- dynamically importing `pcc-app-decoder-wasm.js`
- creating and reusing the WASM module instance
- creating input/output directories in the Emscripten virtual file system
- writing the uploaded bitstream into `FS`
- calling `vpcc_decode_file`
- reading back the reconstructed `.ply`
- wrapping the output bytes into a browser `File`

This bridge is what lets normal browser code call the C++ decoder without any server in between.

## 9. Integrate VPCC Files Into The Existing Import Flow

The main import routing was updated in:

- `src/file-handler.ts`

The important changes were:

- `.bin` and `.v3c` were added to the supported import extensions
- VPCC files are detected inside the normal `Import` path
- `decodeVpccFile(file)` now performs VPCC decode before handing off to the normal model import path
- the result from `decodeVpccWithWasm()` is reintroduced as a regular importable PLY file

This means the user no longer needs a special import concept for VPCC. The ordinary `Import` entry is enough.

## 10. Keep Optional Local Fallback As A Separate Capability

The browser-side direct decode became the default path. A separate helper was still kept in:

- `src/vpcc/local-service-decoder.ts`

Its purpose is no longer to define the main architecture. Instead, it acts as an optional escape hatch for debugging or native-assisted workflows.

Current behavior:

- default path is browser-side WASM decode
- local fallback is only used if `window.VPCC_ENABLE_LOCAL_FALLBACK === true`

That preserves flexibility without making server-side decoding the default design.

## 11. Remove Redundant UI And Keep One Unified Import Entry

Originally there were two visible import entries:

- regular `Import`
- separate `Import VPCC`

After VPCC support was fully integrated into the common import flow, the separate VPCC UI became redundant.

So the following cleanup was made:

- remove `Import VPCC...` from `src/ui/menu.ts`
- remove the extra VPCC button from `src/ui/scene-panel.ts`
- remove the now-unused `scene.importVpcc` event path from `src/file-handler.ts`

This keeps the UX simpler:

- one `Import` entry
- multiple supported formats behind it

## 12. Debug And Stabilize Browser-Side Runtime Issues

Getting the module to compile was only half the job. The runtime path also had to be stabilized.

Several runtime issues were encountered and fixed:

### Logger and MD5 path crashes

An early `memory access out of bounds` happened in logger/MD5-related code paths rather than in the actual reconstruction logic.

To stabilize the browser path:

- explicit logger initialization was removed from the WASM wrapper
- the wrapper stopped calling `bitstream.computeMD5()`

### Trace macros causing crashes

Trace-heavy code paths were unnecessary for the browser build and unstable under WASM, so the build script now configures:

- `BITSTREAM_TRACE=OFF`
- `CONFORMANCE_TRACE=OFF`
- `CODEC_TRACE=OFF`
- `SEI_TRACE=OFF`

### Exception handling in decoder backends

Some codec/backend paths required exceptions to be enabled under Emscripten so the decoder would not abort unexpectedly. Browser-targeted build settings were adjusted accordingly.

These fixes are why the decoder progressed from "compiles" to "can actually reconstruct a PLY in WASM".

## Runtime Path Today

When a user imports a `.bin` or `.v3c` file through the normal `Import` action:

1. `src/file-handler.ts` recognizes the file as VPCC
2. `decodeVpccFile(file)` starts the decode flow
3. `src/vpcc/wasm-decoder.ts` loads the WASM module
4. the file is written to Emscripten FS
5. `vpcc_decode_file` is called
6. the decoder writes a `.ply` into the virtual FS
7. JavaScript reads the `.ply` bytes back
8. the output is wrapped as a browser `File`
9. `importSplatModel()` loads it through the existing PLY path

## How The Build Target Was Trimmed

The browser build intentionally avoids as much native-only functionality as possible.

Current browser build settings from `build-vpcc-wasm.ps1` are:

- `BUILD_BROWSER_VPCC_WASM=ON`
- `BUILD_TMC2_NATIVE_APPS=OFF`
- `BUILD_TMC2_ENCODER_COMPONENTS=OFF`
- `ENABLE_TBB=OFF`
- `BITSTREAM_TRACE=OFF`
- `CONFORMANCE_TRACE=OFF`
- `CODEC_TRACE=OFF`
- `SEI_TRACE=OFF`
- `USE_JMAPP_VIDEO_CODEC=OFF`
- `USE_HMAPP_VIDEO_CODEC=OFF`
- `USE_SHMAPP_VIDEO_CODEC=OFF`
- `USE_HDRTOOLS=OFF`
- `USE_HMLIB_VIDEO_CODEC=ON`

The logic behind these settings is:

- disable native CLI apps because the browser only needs a callable library wrapper
- disable encoder components because browser-side direct decode only needs decoder-side functionality
- disable optional tooling and threading pieces that do not help the browser path
- disable trace-heavy code that adds instability and noise in WASM
- keep only the codec/decode path needed by the selected VPCC decode stack

## New And Modified Files And Their Roles

### VPCC / TMC2 side

#### `../GS4-vpcc/mpeg-pcc-tmc2/CMakeLists.txt`

Modified.

Role:

- introduces browser-oriented build switches
- allows the decoder tree to be built without the full native app set
- enables browser-specific compile behavior such as exception support when needed

#### `../GS4-vpcc/mpeg-pcc-tmc2/dependencies/CMakeLists.txt`

Modified.

Role:

- fixes dependency selection so the browser build does not incorrectly include the wrong parser-related path

#### `../GS4-vpcc/mpeg-pcc-tmc2/source/app/PccAppDecoderWasm/CMakeLists.txt`

Created.

Role:

- defines the dedicated WASM decoder target
- links the minimal set of libraries needed for browser-side decode
- configures Emscripten exports and runtime capabilities

#### `../GS4-vpcc/mpeg-pcc-tmc2/source/app/PccAppDecoderWasm/PccAppDecoderWasm.cpp`

Created.

Role:

- exposes `vpcc_decode_file` and `vpcc_get_last_error`
- maps browser-side input/output paths to native decoder calls
- converts VPCC library decode flow into a compact C ABI

#### `../GS4-vpcc/mpeg-pcc-tmc2/source/lib/PccLibCommon/source/PCCPointSet.cpp`

Modified.

Role:

- fixes compile issues that surfaced under Emscripten/Clang

### SuperSplat side

#### `build-vpcc-wasm.ps1`

Created and iteratively updated.

Role:

- provides the practical offline build entry for the VPCC WASM artifacts
- hides Windows toolchain setup complexity behind one command

#### `package.json`

Modified.

Role:

- adds scripts for building and running the VPCC WASM integration

#### `src/vpcc/types.ts`

Created.

Role:

- defines the import result shape used between VPCC decode helpers and the main file handler

#### `src/vpcc/wasm-decoder.ts`

Created.

Role:

- loads the Emscripten module
- manages virtual file system I/O
- invokes the exported decode function
- returns the reconstructed `.ply` to the browser import pipeline

#### `src/vpcc/local-service-decoder.ts`

Created.

Role:

- contains the optional local-service decode path
- no longer defines the default architecture, but remains available as an explicit fallback path

#### `src/file-handler.ts`

Modified.

Role:

- recognizes `.bin` and `.v3c` in the normal import flow
- routes VPCC files into the browser-side decode path
- feeds the decoded PLY back into the standard model import path
- now supports one unified `Import` entry instead of a separate `Import VPCC`

#### `src/ui/menu.ts`

Modified.

Role:

- removes the duplicate `Import VPCC...` menu item after VPCC became part of the normal import flow

#### `src/ui/scene-panel.ts`

Modified.

Role:

- removes the extra VPCC import button from the scene panel
- keeps the UI aligned with the single-entry import design

#### `static/lib/vpcc/README.md`

Created.

Role:

- explains where the generated browser artifacts belong and how they are produced

#### `static/lib/vpcc/pcc-app-decoder-wasm.js`

Initially created as a stub, later replaced by the real build artifact.

Role:

- serves as the browser-loadable JS glue file generated by Emscripten

#### `static/lib/vpcc/pcc-app-decoder-wasm.wasm`

Generated artifact.

Role:

- contains the compiled VPCC decoder logic executed by the browser

## Build Requirements

To build the VPCC decoder to WebAssembly, the machine needs:

- Emscripten
- CMake
- Ninja
- the TMC2 dependency tree already present inside `GS4-vpcc`

## Standalone Repository Layout

If your goal is to let other computers clone one repository and reproduce the current browser-side VPCC functionality quickly, the easiest packaging strategy is:

- keep only the `supersplat` folder as the GitHub repository
- keep the prebuilt VPCC browser artifacts inside `static/lib/vpcc`
- do not require other users to rebuild TMC2 unless they explicitly want to modify the decoder

In other words, for runtime use on another machine:

- `GS4-vpcc/mpeg-pcc-tmc2` is not required
- `supersplat/static/lib/vpcc/pcc-app-decoder-wasm.js` is required
- `supersplat/static/lib/vpcc/pcc-app-decoder-wasm.wasm` is required

### What still works if TMC2 is removed

If you delete the TMC2 source tree and keep only the current `supersplat` folder, the following still works:

- browser-side VPCC import
- `.bin` / `.v3c` import through the normal `Import` menu
- WebAssembly decode using the committed artifacts

What will no longer work without TMC2:

- rebuilding `pcc-app-decoder-wasm.js`
- rebuilding `pcc-app-decoder-wasm.wasm`
- running the optional native local fallback if its decoder executable is not present

## Files To Upload To GitHub

For a practical, easy-to-reproduce repository, include:

### Required runtime files

- all normal `supersplat` source files
- `src/file-handler.ts`
- `src/vpcc/types.ts`
- `src/vpcc/wasm-decoder.ts`
- `src/vpcc/local-service-decoder.ts`
- `src/ui/menu.ts`
- `src/ui/scene-panel.ts`
- `static/lib/vpcc/pcc-app-decoder-wasm.js`
- `static/lib/vpcc/pcc-app-decoder-wasm.wasm`
- `static/lib/vpcc/README.md`
- `README-VPCC-WASM.md`

### Optional development files

Keep these if you want other developers to be able to rebuild the decoder later:

- `build-vpcc-wasm.ps1`
- local fallback server files under `local-server/`

These are useful even in a standalone `supersplat` repository, but they are not required just to run the already-built browser decode path.

### Files that should not be uploaded

Do not upload:

- `node_modules/`
- `dist/`
- `.vpcc-jobs/`
- local caches or IDE folders
- the full `GS4-vpcc/mpeg-pcc-tmc2` tree unless you explicitly want the repository to support decoder rebuilds from source

## Quick Reproduction On Another Computer

If the repository already contains the prebuilt VPCC artifacts, another machine only needs Node.js.

### Steps

1. Clone the repository.
2. Open a terminal inside the `supersplat` folder.
3. Install dependencies:

```bash
npm install
```

4. Start the browser-side VPCC build of the frontend:

```bash
npm run develop:vpcc:wasm
```

5. Open the local URL shown in the terminal.
6. Use the normal `Import` action and select a `.bin` or `.v3c` file.

This is the fastest way to reproduce the current feature on another computer.

## Rebuild On Another Computer

If another developer wants to regenerate the WASM decoder from source instead of using the committed artifacts, they must additionally obtain:

- the `GS4-vpcc/mpeg-pcc-tmc2` source tree
- Emscripten
- CMake
- Ninja

Then they can run:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-vpcc-wasm.ps1 -EmSdkEnv "<path-to-emsdk_env.ps1>"
```

This is optional for consumers of the repository, but important for maintainers.

## Windows Setup Example

One working setup on Windows is:

```powershell
cd D:\Users\Student\Desktop\Haining
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
.\emsdk install latest
.\emsdk activate latest
python -m pip install --user cmake ninja
```

Then build from:

```powershell
cd D:\Users\Student\Desktop\Haining\supersplat
powershell -ExecutionPolicy Bypass -File .\build-vpcc-wasm.ps1 -EmSdkEnv "D:\Users\Student\Desktop\Haining\emsdk\emsdk_env.ps1"
```

After a successful build, these files should exist:

```text
supersplat/static/lib/vpcc/pcc-app-decoder-wasm.js
supersplat/static/lib/vpcc/pcc-app-decoder-wasm.wasm
```

## Development Commands

### WASM-first frontend

```bash
npm run develop:vpcc:wasm
```

Starts the frontend only and uses browser-side direct decode as the default path.

### Frontend plus optional local fallback service

```bash
npm run develop:vpcc
```

Starts:

- frontend watch
- static web server
- optional local VPCC decode service

## Optional Fallback Control

Browser-side WASM decode is the default design.

If you explicitly want to allow the local fallback path during debugging, set:

```js
window.VPCC_ENABLE_LOCAL_FALLBACK = true;
```

before importing a VPCC bitstream.

## Current Limitations

- VPCC browser-side decode still runs synchronously from the page's point of view, so large files can take a long time and keep the UI busy
- the wrapper currently assumes a single output PLY path
- multi-frame VPCC sequences are not yet promoted into the full timeline flow
- large decoded PLY files can be expensive to parse after decode completes

## What Has Been Verified

- the browser-targeted VPCC WASM artifacts can be built locally
- the TypeScript bridge compiles and passes linting
- `.bin` / `.v3c` files are routed through the normal `Import` flow
- the duplicate `Import VPCC` UI was removed
- the WASM decoder path can reconstruct a PLY output from the test bitstream after the browser-oriented fixes
