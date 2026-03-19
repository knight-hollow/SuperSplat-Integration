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
            return await factory();
        })();
    }
    return await modulePromise;
};

const decodeVpccWithWasm = async (file: File): Promise<VpccImportFile> => {
    const module = await loadModule();
    const { FS } = module;

    ensureDir(FS, '/vpcc');
    ensureDir(FS, '/vpcc/input');
    ensureDir(FS, '/vpcc/output');

    const inputName = file.name.replace(/[^\w.\-]+/g, '_');
    const outputName = `${inputName.replace(/\.[^.]+$/, '') || 'decoded'}.decoded.ply`;
    const inputPath = `/vpcc/input/${inputName}`;
    const outputPath = `/vpcc/output/${outputName}`;

    try {
        const inputBytes = new Uint8Array(await file.arrayBuffer());
        FS.writeFile(inputPath, inputBytes);

        const decodeResult = module.ccall('vpcc_decode_file', 'number', ['string', 'string'], [inputPath, outputPath]);
        if (decodeResult !== 0) {
            const decoderError = module.ccall('vpcc_get_last_error', 'string', [], []) as string;
            throw new Error(decoderError || `VPCC WASM decoder failed with code ${decodeResult}`);
        }

        const outputBytes = FS.readFile(outputPath);
        const outputArrayBuffer = outputBytes.slice().buffer;
        return {
            filename: outputName,
            contents: new File([outputArrayBuffer], outputName, {
                type: 'application/octet-stream'
            })
        };
    } finally {
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
    }
};

export { decodeVpccWithWasm };
