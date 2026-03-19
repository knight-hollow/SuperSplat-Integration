# SuperSplat VPCC Decoder Integration

## Overview

This project extends `supersplat` with a local VPCC decode workflow so that a user can:

1. Open the SuperSplat web UI in a browser.
2. Upload a `.bin` or `.v3c` VPCC bitstream.
3. Let a local Node.js service call the VPCC decoder executable.
4. Convert the decoded output into `.ply`.
5. Automatically load the reconstructed point cloud into SuperSplat.

This integration is intended for local Windows development and testing, where the browser frontend and the decoder service both run on the same machine.

## Directory Structure

- `src/file-handler.ts`
  Frontend import pipeline, including VPCC upload and reconstructed PLY import.
- `src/ui/menu.ts`
  Adds the `Import VPCC...` menu item.
- `src/ui/scene-panel.ts`
  Adds a VPCC import button in the scene panel header.
- `local-server/vpcc-server.cjs`
  Local HTTP service used to receive uploads, run the decoder, and expose decoded PLY files.
- `local-server/vpcc-config.cjs`
  Configuration for decoder path, port, working directory, output directory, and upload size limit.

## Basic Principle

The integrated workflow is:

```text
Browser upload (.bin/.v3c)
-> local Node.js HTTP service
-> PccAppDecoder.exe
-> reconstructed .ply file
-> SuperSplat asset loader
-> point cloud displayed in browser
```

The frontend does not decode VPCC by itself. The decoder remains a native executable in `GS4-vpcc/mpeg-pcc-tmc2/bin/Release/PccAppDecoder.exe`.

The browser uploads the bitstream to the local service. The local service writes the file to a temporary job directory, executes the decoder, then returns a URL for the reconstructed `.ply`. SuperSplat reuses its existing PLY loading pipeline to display the point cloud.

## Why This Architecture

This design was chosen for four reasons:

1. `supersplat` already knows how to load `.ply`, so the safest integration path is to decode to PLY and reuse the existing loader.
2. Running the native decoder in a local service is much simpler than compiling the VPCC decoder to WebAssembly.
3. The browser cannot directly execute local native binaries for security reasons.
4. This separation keeps the decoder logic isolated and easier to debug.

## Requirements

### Runtime

- Windows
- Node.js 18 or later
- npm

### Decoder

Make sure the VPCC decoder has already been built:

```text
GS4-vpcc/mpeg-pcc-tmc2/bin/Release/PccAppDecoder.exe
```

If the decoder path is different on your machine, set the `VPCC_DECODER_PATH` environment variable before starting the service.

## Installation

Open a terminal in:

```text
D:\Users\Student\Desktop\Haining\supersplat
```

Install dependencies:

```bash
npm install
```

## Start The System

Use the combined development command:

```bash
npm run develop:vpcc
```

This starts three processes:

1. Rollup watcher for the frontend.
2. Static web server for the built `dist` directory.
3. Local VPCC decode service on `http://127.0.0.1:3001`.

The browser URL may not always be `http://localhost:3000`. Check the terminal output for the actual frontend URL, for example:

```text
INFO  Accepting connections at http://localhost:50924
```

Open that URL in your browser.

## How To Use

There are two ways to import VPCC bitstreams:

### Option 1: Dedicated VPCC Menu

Use:

```text
File -> Import VPCC...
```

Then choose a single `.bin` or `.v3c` file.

### Option 2: Normal Import

Use:

```text
File -> Import...
```

If the selected file is a single `.bin` or `.v3c`, the frontend automatically routes it through the VPCC decode service.

### What Happens Next

1. The browser uploads the selected bitstream to `POST /api/vpcc/decode`.
2. The local service stores the file under `.vpcc-jobs/<jobId>/input/`.
3. The service runs `PccAppDecoder.exe`.
4. The decoded `.ply` is written under `.vpcc-jobs/<jobId>/decoded/`.
5. The service returns a URL to that PLY file.
6. SuperSplat loads it through the existing PLY import path.

## Local Service API

### Health Check

```text
GET /api/vpcc/health
```

Returns whether the service is alive and whether the decoder executable exists.

### Decode Endpoint

```text
POST /api/vpcc/decode?filename=<original_filename>
Content-Type: application/octet-stream
Body: raw .bin or .v3c bytes
```

Returns JSON similar to:

```json
{
  "jobId": "example-job-id",
  "inputFilename": "frame_0000.bin",
  "decoderExitCode": 1,
  "logUrl": "http://127.0.0.1:3001/api/vpcc/log/example-job-id",
  "files": [
    {
      "name": "frame_0000.decoded.ply",
      "url": "http://127.0.0.1:3001/api/vpcc/result/example-job-id/frame_0000.decoded.ply"
    }
  ],
  "firstFile": {
    "name": "frame_0000.decoded.ply",
    "url": "http://127.0.0.1:3001/api/vpcc/result/example-job-id/frame_0000.decoded.ply"
  }
}
```

### Result File

```text
GET /api/vpcc/result/<jobId>/<filename>
```

Streams the decoded PLY file back to the frontend.

### Decoder Log

```text
GET /api/vpcc/log/<jobId>
```

Returns the decoder stdout/stderr log as plain text.

## Configuration

The local service can be configured with environment variables:

- `VPCC_SERVER_HOST`
  Host to bind the local service. Default: `127.0.0.1`
- `VPCC_SERVER_PORT`
  Service port. Default: `3001`
- `VPCC_PUBLIC_ORIGIN`
  Public base URL returned to the frontend. Optional.
- `VPCC_MAX_UPLOAD_BYTES`
  Maximum upload size. Default: `1073741824`
- `VPCC_JOBS_DIR`
  Temporary job directory. Default: `supersplat/.vpcc-jobs`
- `VPCC_DECODER_PATH`
  Full path to `PccAppDecoder.exe`
- `VPCC_DECODER_CWD`
  Working directory for the decoder process

## Important Implementation Notes

### Decoder Exit Code

In testing, `PccAppDecoder.exe` sometimes returned a non-zero exit code even when a valid `.ply` file had been produced.

Because of that, the service does not rely only on the process exit code. If a real decoded PLY file exists, the decode is treated as successful.

### Output File Naming

Some decoder runs may leave both a template-like output name and an actual generated PLY file. The service filters outputs and prefers concrete PLY files for frontend import.

### Temporary Files

Decoded results are stored under:

```text
supersplat/.vpcc-jobs/
```

Each request gets its own job directory.

## Deployment Notes

This setup is designed for local deployment rather than public internet deployment.

If you want to deploy this more permanently on a workstation:

1. Build the VPCC decoder once.
2. Keep the `GS4-vpcc` and `supersplat` directories on the same machine.
3. Set environment variables if the decoder path or port changes.
4. Start `npm run develop:vpcc` for development, or run the frontend and VPCC service separately for a more controlled setup.

For a more production-style deployment, you would usually:

1. Build the frontend with `npm run build`.
2. Serve `dist/` using a standard static file server.
3. Run `node local-server/vpcc-server.cjs` as a separate background service.
4. Point the frontend to the service using `VPCC_API_ORIGIN`.

## Known Limitations

- The current version is primarily designed for single uploaded `.bin` or `.v3c` files.
- The frontend currently imports the first reconstructed PLY returned by the service.
- Multi-frame VPCC outputs are not yet promoted into a full animated sequence workflow.
- Temporary decoded files are kept in `.vpcc-jobs` until manually cleaned.
- This integration assumes a local trusted environment and does not include authentication.

## Troubleshooting

### `Import VPCC...` Is Not Visible

- Make sure you opened the actual dev server URL shown in the terminal.
- Hard refresh the page after rebuilding.
- You can still use normal `Import...` with a single `.bin` or `.v3c`.

### Decoder Not Found

Check:

```text
GS4-vpcc/mpeg-pcc-tmc2/bin/Release/PccAppDecoder.exe
```

Or set:

```bash
set VPCC_DECODER_PATH=your_full_decoder_path
```

before starting the service.

### Decode Fails

Check:

- `GET /api/vpcc/health`
- The decoder log returned by `/api/vpcc/log/<jobId>`
- Whether the bitstream file is valid
- Whether the decoder build matches the bitstream format

## Suggested Next Improvements

- Add a clearer progress UI for upload and decode.
- Support automatic multi-frame sequence import.
- Add cleanup of old `.vpcc-jobs` directories.
- Add a visible settings UI for decoder path and service endpoint.
