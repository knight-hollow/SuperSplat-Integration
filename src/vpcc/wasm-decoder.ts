import type { VpccImportFile } from './types';

type VpccWasmModule = {
    HEAPU8: Uint8Array;
    _malloc: (size: number) => number;
    _free: (ptr: number) => void;
    ccall: (name: string, returnType: string | null, argTypes: string[], args: unknown[]) => any;
    FS?: {
        mkdirTree: (path: string) => void;
        writeFile: (path: string, data: Uint8Array) => void;
        readFile: (path: string) => Uint8Array;
        unlink: (path: string) => void;
    };
};

type VpccWasmFactory = (moduleOverrides?: Record<string, unknown>) => Promise<VpccWasmModule>;

const wasmModuleUrl = () => new URL('/static/lib/vpcc/pcc-app-decoder-wasm.js', window.location.href).href;

let modulePromise: Promise<VpccWasmModule> | null = null;

const loadModule = async () => {
    if (!modulePromise) {
        modulePromise = (async () => {
            const importedModule = await import(wasmModuleUrl());
            const factory = (importedModule.default || importedModule) as VpccWasmFactory;
            const verboseConsole = (window as any).VPCC_WASM_VERBOSE_CONSOLE === true;
            return await factory(
                verboseConsole ? {} : {
                    // Suppress Emscripten printf/emscripten_log output by default.
                    // This can noticeably reduce overhead during heavy decoding.
                    print: (_text: unknown) => {},
                    printErr: (_text: unknown) => {}
                }
            );
        })();
    }
    return await modulePromise;
};

const decodeVpccWithWasm = async (file: File): Promise<VpccImportFile> => {
    const tTotalStart = performance.now();

    const tModuleStart = performance.now();
    const module = await loadModule();
    const tModuleEnd = performance.now();

    const inputName = file.name.replace(/[^\w.\-]+/g, '_');
    const baseName = inputName.replace(/\.[^.]+$/, '') || 'decoded';
    const outputName = `${baseName}.decoded.ply`;

    let ok = false;
    let errorMessage: string | null = null;
    let inputReadMs = 0;
    let decodeMs = 0;
    let fsIoMs = 0;
    let inputPtr = 0;

    try {
        const tInputReadStart = performance.now();
        const inputBytes = new Uint8Array(await file.arrayBuffer());
        inputReadMs = performance.now() - tInputReadStart;

        const hasFs = !!module.FS;
        let outputArrayBuffer: ArrayBuffer;

        if (hasFs && module.FS) {
            // Fast path: write/read directly in Emscripten FS to avoid
            // heap copy + C++ temp file buffering in vpcc_decode_buffer.
            const fs = module.FS;
            const inPath = `/tmp/vpcc/${inputName}`;
            const outPath = `/tmp/vpcc/${outputName}`;
            const tFsStart = performance.now();
            try {
                fs.mkdirTree('/tmp/vpcc');
                try { fs.unlink(inPath); } catch (_err) {}
                try { fs.unlink(outPath); } catch (_err) {}
                fs.writeFile(inPath, inputBytes);
            } finally {
                fsIoMs += performance.now() - tFsStart;
            }

            const tDecodeStart = performance.now();
            const decodeResult = module.ccall('vpcc_decode_file', 'number', ['string', 'string'], [inPath, outPath]);
            decodeMs = performance.now() - tDecodeStart;
            if (decodeResult !== 0) {
                const decoderError = module.ccall('vpcc_get_last_error', 'string', [], []) as string;
                throw new Error(decoderError || `VPCC WASM decoder failed with code ${decodeResult}`);
            }

            const tFsReadStart = performance.now();
            const outputBytes = fs.readFile(outPath);
            fsIoMs += performance.now() - tFsReadStart;
            outputArrayBuffer = outputBytes.buffer.slice(outputBytes.byteOffset, outputBytes.byteOffset + outputBytes.byteLength);
        } else {
            // Compatibility fallback for older artifacts that don't export FS.
            const tHeapWriteStart = performance.now();
            inputPtr = module._malloc(inputBytes.byteLength);
            module.HEAPU8.set(inputBytes, inputPtr);
            fsIoMs = performance.now() - tHeapWriteStart;

            const tDecodeStart = performance.now();
            const decodeResult = module.ccall('vpcc_decode_buffer', 'number', ['number', 'number'], [inputPtr, inputBytes.byteLength]);
            decodeMs = performance.now() - tDecodeStart;
            if (decodeResult !== 0) {
                const decoderError = module.ccall('vpcc_get_last_error', 'string', [], []) as string;
                throw new Error(decoderError || `VPCC WASM decoder failed with code ${decodeResult}`);
            }

            const outputSize = module.ccall('vpcc_get_output_size', 'number', [], []) as number;
            const outputPtr = module.ccall('vpcc_get_output_buffer', 'number', [], []) as number;
            if (outputSize <= 0 || outputPtr === 0) {
                throw new Error('VPCC WASM decoder returned an empty output buffer');
            }
            const outputBytes = module.HEAPU8.slice(outputPtr, outputPtr + outputSize);
            outputArrayBuffer = outputBytes.buffer.slice(outputBytes.byteOffset, outputBytes.byteOffset + outputBytes.byteLength);
        }

        ok = true;
        return {
            filename: outputName,
            contents: new File([outputArrayBuffer], outputName, {
                type: 'application/octet-stream'
            })
        };
    } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        throw error;
    } finally {
        const tCleanupStart = performance.now();
        if (inputPtr !== 0) { module._free(inputPtr); }
        module.ccall('vpcc_clear_output_buffer', null, [], []);

        const tCleanupEnd = performance.now();
        if (!ok && errorMessage === null) {
            errorMessage = 'VPCC WASM decode failed (unknown error)';
        }

        const enableTimingLog = (window as any).VPCC_WASM_TIMING === true;
        if (enableTimingLog) {
            const tTotalEnd = performance.now();
            console.log('[VPCC TIMING][WASM]', {
                file: file.name,
                ok,
                error: errorMessage,
                totalMs: tTotalEnd - tTotalStart,
                moduleLoadMs: tModuleEnd - tModuleStart,
                inputReadMs,
                decodeMs,
                fsIoMs,
                cleanupMs: tCleanupEnd - tCleanupStart
            });
        }
    }
};

export { decodeVpccWithWasm };
