import type { VpccImportFile } from './types';

type VpccWasmModule = {
    FS: {
        mkdir: (path: string) => void;
        writeFile: (path: string, data: Uint8Array) => void;
        readFile: (path: string) => Uint8Array;
        unlink: (path: string) => void;
        rmdir: (path: string) => void;
    };
    ccall: (name: string, returnType: string | null, argTypes: string[], args: unknown[]) => any;
};

type VpccWasmFactory = (moduleOverrides?: Record<string, unknown>) => Promise<VpccWasmModule>;

const wasmModuleUrl = () => new URL('/static/lib/vpcc/pcc-app-decoder-wasm.js', window.location.href).href;

let modulePromise: Promise<VpccWasmModule> | null = null;

const ensureDir = (FS: VpccWasmModule['FS'], path: string) => {
    try {
        FS.mkdir(path);
    } catch (error) {
        // ignore EEXIST from repeated decode calls
    }
};

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
    const { FS } = module;

    ensureDir(FS, '/vpcc');
    ensureDir(FS, '/vpcc/input');
    ensureDir(FS, '/vpcc/output');

    const inputName = file.name.replace(/[^\w.\-]+/g, '_');
    const baseName = inputName.replace(/\.[^.]+$/, '') || 'decoded';
    const outputName = `${baseName}.decoded.ply`;
    const inputPath = `/vpcc/input/${inputName}`;
    const outputPath = `/vpcc/output/${outputName}`;

    let ok = false;
    let errorMessage: string | null = null;
    let inputReadMs = 0;
    let fsWriteMs = 0;
    let decodeMs = 0;
    let fsReadMs = 0;

    try {
        const tInputReadStart = performance.now();
        const inputBytes = new Uint8Array(await file.arrayBuffer());
        inputReadMs = performance.now() - tInputReadStart;

        const tFsWriteStart = performance.now();
        FS.writeFile(inputPath, inputBytes);
        fsWriteMs = performance.now() - tFsWriteStart;

        const tDecodeStart = performance.now();
        const decodeResult = module.ccall('vpcc_decode_file', 'number', ['string', 'string'], [inputPath, outputPath]);
        decodeMs = performance.now() - tDecodeStart;
        if (decodeResult !== 0) {
            const decoderError = module.ccall('vpcc_get_last_error', 'string', [], []) as string;
            throw new Error(decoderError || `VPCC WASM decoder failed with code ${decodeResult}`);
        }

        const tFsReadStart = performance.now();
        const outputBytes = FS.readFile(outputPath);
        fsReadMs = performance.now() - tFsReadStart;
        const outputArrayBuffer = outputBytes.slice().buffer;

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
        try {
            FS.unlink(inputPath);
        } catch (error) {
            // ignore cleanup failures
        }
        try {
            FS.unlink(outputPath);
        } catch (error) {
            // ignore cleanup failures
        }

        const tCleanupEnd = performance.now();
        if (!ok && errorMessage === null) {
            errorMessage = 'VPCC WASM decode failed (unknown error)';
        }

        // Always emit timing info, even when decode fails, so you can compare scheme A/B.
        const tTotalEnd = performance.now();
        console.log('[VPCC TIMING][WASM]', {
            file: file.name,
            ok,
            error: errorMessage,
            totalMs: tTotalEnd - tTotalStart,
            moduleLoadMs: tModuleEnd - tModuleStart,
            inputReadMs,
            fsWriteMs,
            decodeMs,
            fsReadMs,
            cleanupMs: tCleanupEnd - tCleanupStart
        });
    }
};

export { decodeVpccWithWasm };
