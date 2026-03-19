# VPCC WASM Artifacts

This directory is intended to contain the browser-loadable VPCC decoder artifacts:

- `pcc-app-decoder-wasm.js`
- `pcc-app-decoder-wasm.wasm`

For a standalone `supersplat` repository that should run on another machine without rebuilding TMC2, these two files should be committed to the repository.

They are produced by running:

```powershell
npm run build:vpcc:wasm
```

from the `supersplat` directory after installing Emscripten.

The frontend loads these artifacts for browser-side VPCC decoding. If they are missing, browser-side decode will not work unless you rebuild them or explicitly enable and configure the optional local fallback path.
