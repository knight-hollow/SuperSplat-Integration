/**
 * VPCC WASM 解码器对外入口。
 *
 * 行为：
 * - 默认通过 Web Worker 执行解码（主线程零阻塞，输入输出均 transferable）；
 *   `window.VPCC_WASM_NO_WORKER = true` 或 worker 创建失败时，自动回退到
 *   主线程内联路径（即原先的实现），行为完全兼容。
 * - 默认在 worker 内完成 PLY → 每属性 Float32Array 的去交织，主线程只做
 *   GSplatData 的轻量构造，彻底跳过 splat-transform。需要禁用直连路径
 *   （例如对比老路径或调试兼容性）时设置 `window.VPCC_WASM_DIRECT = false`。
 */

import { buildGSplatDataFromBundle, parseVpccDecodedPly, type VpccDecodedBundle } from './attribute-map';
import type { VpccImportFile } from './types';
import { createVpccWorkerUrl, type WorkerRequest, type WorkerResponse, type WorkerReadySignal, type WorkerOptions } from './wasm-decoder-worker';


type VpccWasmModule = {
    HEAPU8: Uint8Array;
    HEAPF32?: Float32Array;
    _malloc: (size: number) => number;
    _free: (ptr: number) => void;
    _vpcc_decode_file_direct?: unknown;
    _vpcc_get_splat_count?: unknown;
    _vpcc_get_property_ptr?: unknown;
    ccall: (name: string, returnType: string | null, argTypes: string[], args: unknown[]) => any;
    FS?: {
        mkdirTree: (path: string) => void;
        writeFile: (path: string, data: Uint8Array, opts?: { canOwn?: boolean }) => void;
        readFile: (path: string) => Uint8Array;
        unlink: (path: string) => void;
    };
};

type VpccWasmFactory = (moduleOverrides?: Record<string, unknown>) => Promise<VpccWasmModule>;

const wasmModuleUrl = () => new URL('/static/lib/vpcc/pcc-app-decoder-wasm.js', window.location.href).href;

const readOpts = (): WorkerOptions => ({
    verboseConsole: (window as any).VPCC_WASM_VERBOSE_CONSOLE === true,
    skipPreUnlink: (window as any).VPCC_WASM_SKIP_PREUNLINK === true,
    // 直连渲染默认开启，显式设置为 false 才回退到 splat-transform PLY 路径。
    directParse: (window as any).VPCC_WASM_DIRECT !== false
});

const isWorkerDisabled = () => (window as any).VPCC_WASM_NO_WORKER === true;

const timingEnabled = () => (window as any).VPCC_WASM_TIMING === true;

// ---------------------------------------------------------------------------
// Worker 客户端
// ---------------------------------------------------------------------------

type PendingEntry = {
    resolve: (reply: Extract<WorkerResponse, { ok: true }>) => void;
    reject: (err: Error) => void;
};

type WorkerClient = {
    ready: Promise<void>;
    post: (req: WorkerRequest, transfer: ArrayBuffer[]) => Promise<Extract<WorkerResponse, { ok: true }>>;
    dispose: () => void;
    healthy: boolean;
};

let workerClientPromise: Promise<WorkerClient | null> | null = null;

const tryCreateWorkerClient = (): Promise<WorkerClient | null> => {
    return new Promise((resolve) => {
        let worker: Worker;
        let blobUrl: string;
        try {
            blobUrl = createVpccWorkerUrl(wasmModuleUrl());
            worker = new Worker(blobUrl, { type: 'module' });
        } catch (err) {
            console.warn('[VPCC][worker] cannot create module worker, falling back to main-thread:', err);
            resolve(null);
            return;
        }

        const pending = new Map<number, PendingEntry>();
        let healthy = true;

        let resolveReady!: () => void;
        let rejectReady!: (err: Error) => void;
        const ready = new Promise<void>((res, rej) => {
            resolveReady = res;
            rejectReady = rej;
        });

        worker.onmessage = (ev) => {
            const data = ev.data as WorkerResponse | WorkerReadySignal;
            if ((data as WorkerReadySignal).__vpccWorkerReady) {
                resolveReady();
                return;
            }
            const reply = data as WorkerResponse;
            const entry = pending.get(reply.token);
            if (!entry) return;
            pending.delete(reply.token);
            if (reply.ok === true) {
                entry.resolve(reply);
                return;
            }
            entry.reject(new Error(reply.error));
        };

        worker.onerror = (ev) => {
            healthy = false;
            const err = new Error(`VPCC worker error: ${ev.message || 'unknown'}`);
            rejectReady(err);
            for (const entry of pending.values()) entry.reject(err);
            pending.clear();
        };

        worker.onmessageerror = () => {
            healthy = false;
            const err = new Error('VPCC worker message error (structured clone failed)');
            rejectReady(err);
            for (const entry of pending.values()) entry.reject(err);
            pending.clear();
        };

        let nextToken = 1;
        const post = (req: WorkerRequest, transfer: ArrayBuffer[]) => {
            req.token = nextToken++;
            return new Promise<Extract<WorkerResponse, { ok: true }>>((res, rej) => {
                pending.set(req.token, { resolve: res, reject: rej });
                try {
                    worker.postMessage(req, transfer);
                } catch (err: any) {
                    pending.delete(req.token);
                    rej(err instanceof Error ? err : new Error(String(err)));
                }
            });
        };

        const dispose = () => {
            try {
                worker.terminate();
            } catch (_e) {}
            try {
                URL.revokeObjectURL(blobUrl);
            } catch (_e) {}
            for (const entry of pending.values()) entry.reject(new Error('VPCC worker disposed'));
            pending.clear();
            healthy = false;
        };

        resolve({ ready,
            post,
            dispose,
            get healthy() {
                return healthy;
            } } as WorkerClient);
    });
};

const getWorkerClient = async (): Promise<WorkerClient | null> => {
    if (isWorkerDisabled()) return null;
    if (!workerClientPromise) {
        workerClientPromise = (async () => {
            const client = await tryCreateWorkerClient();
            if (!client) return null;
            try {
                await client.ready;
            } catch (err) {
                console.warn('[VPCC][worker] failed to become ready, falling back to main-thread:', err);
                client.dispose();
                return null;
            }
            return client;
        })();
    }
    const client = await workerClientPromise;
    if (client && !client.healthy) {
        // 以前的 worker 异常了，重置 promise，下一次重新拉起一个新的。
        workerClientPromise = null;
        return null;
    }
    return client;
};

// ---------------------------------------------------------------------------
// 主线程 fallback（保留原行为，供 worker 不可用时使用）
// ---------------------------------------------------------------------------

let modulePromise: Promise<VpccWasmModule> | null = null;

const loadModuleOnMainThread = async () => {
    if (!modulePromise) {
        modulePromise = (async () => {
            const importedModule = await import(wasmModuleUrl());
            const factory = (importedModule.default || importedModule) as VpccWasmFactory;
            const verboseConsole = (window as any).VPCC_WASM_VERBOSE_CONSOLE === true;
            return await factory(
                verboseConsole ? {} : {
                    print: (_text: unknown) => {},
                    printErr: (_text: unknown) => {}
                }
            );
        })();
    }
    return await modulePromise;
};

const decodeOnMainThread = async (file: File): Promise<VpccImportFile> => {
    const tTotalStart = performance.now();

    const tModuleStart = performance.now();
    const module = await loadModuleOnMainThread();
    const tModuleEnd = performance.now();

    const inputName = file.name.replace(/[^\w.\-]+/g, '_');
    const baseName = inputName.replace(/\.[^.]+$/, '') || 'decoded';
    const outputName = `${baseName}.decoded.ply`;

    let ok = false;
    let errorMessage: string | null = null;
    let inputReadMs = 0;
    let decodeMs = 0;
    let fsIoMs = 0;
    let parseMs = 0;
    let inputPtr = 0;
    let fsInPath: string | null = null;
    let fsOutPath: string | null = null;
    let directApiUsed = false;

    try {
        const tInputReadStart = performance.now();
        const inputBytes = new Uint8Array(await file.arrayBuffer());
        inputReadMs = performance.now() - tInputReadStart;

        const hasFs = !!module.FS;
        const directRender = (window as any).VPCC_WASM_DIRECT !== false;
        const wantDirectApi =
            directRender &&
            hasFs &&
            typeof (module as any)._vpcc_decode_file_direct === 'function' &&
            typeof (module as any)._vpcc_get_splat_count === 'function' &&
            typeof (module as any)._vpcc_get_property_ptr === 'function' &&
            !!module.HEAPF32;

        let outputBytes: Uint8Array = new Uint8Array(0);
        let gsplatData: VpccImportFile['gsplatData'];

        if (wantDirectApi && module.FS) {
            const fs = module.FS;
            const inPath = `/tmp/vpcc/${inputName}`;
            fsInPath = inPath;
            const tFsStart = performance.now();
            const skipPreUnlink = (window as any).VPCC_WASM_SKIP_PREUNLINK === true;
            try {
                fs.mkdirTree('/tmp/vpcc');
                if (!skipPreUnlink) {
                    try {
                        fs.unlink(inPath);
                    } catch (_err) {}
                }
                (fs as any).writeFile(inPath, inputBytes, { canOwn: true });
            } finally {
                fsIoMs += performance.now() - tFsStart;
            }

            const tDecodeStart = performance.now();
            const decodeResult = module.ccall('vpcc_decode_file_direct', 'number', ['string'], [inPath]);
            decodeMs = performance.now() - tDecodeStart;
            if (decodeResult !== 0) {
                const decoderError = module.ccall('vpcc_get_last_error', 'string', [], []) as string;
                throw new Error(decoderError || `VPCC WASM direct decoder failed with code ${decodeResult}`);
            }

            const tParseStart = performance.now();
            const numSplats = module.ccall('vpcc_get_splat_count', 'number', [], []) as number;
            const propCount = module.ccall('vpcc_get_property_count', 'number', [], []) as number;
            if (numSplats <= 0 || propCount <= 0) {
                throw new Error(`VPCC direct decoder produced empty result (splats=${numSplats}, props=${propCount})`);
            }
            const order: string[] = new Array(propCount);
            const attrs: Record<string, Float32Array> = {};
            const heap = module.HEAPF32 as Float32Array;
            for (let i = 0; i < propCount; i++) {
                const name = module.ccall('vpcc_get_property_name', 'string', ['number'], [i]) as string;
                const ptr = module.ccall('vpcc_get_property_ptr', 'number', ['number'], [i]) as number;
                if (!name || ptr === 0) {
                    throw new Error(`VPCC direct decoder missing property at index ${i}`);
                }
                const view = new Float32Array(heap.buffer, ptr, numSplats);
                attrs[name] = view.slice();
                order[i] = name;
            }
            module.ccall('vpcc_reset_decoded', null, [], []);
            let shRest = 0;
            for (const n of order) if (n.startsWith('f_rest_')) shRest++;
            const shDegree: 0 | 1 | 2 | 3 = shRest >= 45 ? 3 : shRest >= 24 ? 2 : shRest >= 9 ? 1 : 0;
            const bundle: VpccDecodedBundle = {
                numSplats,
                shDegree,
                propertyOrder: order,
                attrs,
                byIndex: () => undefined
            };
            gsplatData = buildGSplatDataFromBundle(bundle);
            parseMs = performance.now() - tParseStart;
            directApiUsed = true;
        } else if (hasFs && module.FS) {
            const fs = module.FS;
            const inPath = `/tmp/vpcc/${inputName}`;
            const outPath = `/tmp/vpcc/${outputName}`;
            fsInPath = inPath;
            fsOutPath = outPath;
            const tFsStart = performance.now();
            const skipPreUnlink = (window as any).VPCC_WASM_SKIP_PREUNLINK === true;
            try {
                fs.mkdirTree('/tmp/vpcc');
                if (!skipPreUnlink) {
                    try {
                        fs.unlink(inPath);
                    } catch (_err) {}
                    try {
                        fs.unlink(outPath);
                    } catch (_err) {}
                }
                (fs as any).writeFile(inPath, inputBytes, { canOwn: true });
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
            outputBytes = fs.readFile(outPath);
            fsIoMs += performance.now() - tFsReadStart;
        } else {
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
            outputBytes = module.HEAPU8.slice(outputPtr, outputPtr + outputSize);
        }

        ok = true;

        // 走 PLY 路径时（老 WASM 或 directRender=false），如需直连渲染则就地 parse
        if (!directApiUsed && directRender && outputBytes.length > 0) {
            const tParseStart = performance.now();
            try {
                const bundle = parseVpccDecodedPly(outputBytes);
                gsplatData = buildGSplatDataFromBundle(bundle);
            } catch (parseErr) {
                console.warn('[VPCC][direct] fallback to file-based PLY load:', parseErr);
                gsplatData = undefined;
            }
            parseMs = performance.now() - tParseStart;
        }

        if (directApiUsed && gsplatData) {
            return { filename: outputName, gsplatData };
        }

        return {
            filename: outputName,
            contents: new File([outputBytes as unknown as BlobPart], outputName, {
                type: 'application/octet-stream'
            }),
            gsplatData
        };
    } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        throw error;
    } finally {
        const tCleanupStart = performance.now();
        if (inputPtr !== 0) {
            module._free(inputPtr);
        }
        if (module.FS) {
            if (fsInPath) {
                try {
                    module.FS.unlink(fsInPath);
                } catch (_err) {}
            }
            if (fsOutPath) {
                try {
                    module.FS.unlink(fsOutPath);
                } catch (_err) {}
            }
        }
        try {
            module.ccall('vpcc_clear_output_buffer', null, [], []);
        } catch (_err) {}
        if (directApiUsed) {
            try {
                module.ccall('vpcc_reset_decoded', null, [], []);
            } catch (_err) {}
        }

        const tCleanupEnd = performance.now();
        if (!ok && errorMessage === null) {
            errorMessage = 'VPCC WASM decode failed (unknown error)';
        }

        if (timingEnabled()) {
            const tTotalEnd = performance.now();
            console.log('[VPCC TIMING][WASM]', {
                path: directApiUsed ? 'main-thread/wasm-direct' : 'main-thread/ply',
                file: file.name,
                ok,
                error: errorMessage,
                totalMs: tTotalEnd - tTotalStart,
                moduleLoadMs: tModuleEnd - tModuleStart,
                inputReadMs,
                decodeMs,
                fsIoMs,
                parseMs,
                cleanupMs: tCleanupEnd - tCleanupStart
            });
        }
    }
};

// ---------------------------------------------------------------------------
// Worker 客户端主流程
// ---------------------------------------------------------------------------

const decodeOnWorker = async (file: File, client: WorkerClient): Promise<VpccImportFile> => {
    const tTotalStart = performance.now();

    const tReadStart = performance.now();
    const inputBuffer = await file.arrayBuffer();
    const inputReadMs = performance.now() - tReadStart;

    const opts = readOpts();

    let ok = false;
    let errorMessage: string | null = null;
    let reply: Extract<WorkerResponse, { ok: true }> | null = null;

    try {
        const req: WorkerRequest = {
            token: 0, // 由 client.post 填入
            inputBuffer,
            filename: file.name,
            options: opts
        };

        reply = await client.post(req, [inputBuffer]);
        ok = true;

        const outputBytes = new Uint8Array(reply.outputBuffer);

        let gsplatData: VpccImportFile['gsplatData'];
        if (opts.directParse && reply.direct && !reply.direct.error) {
            const tBuildStart = performance.now();
            try {
                const bundle: VpccDecodedBundle = {
                    numSplats: reply.direct.numSplats,
                    shDegree: reply.direct.shDegree,
                    propertyOrder: reply.direct.propertyOrder,
                    attrs: reply.direct.attrs,
                    byIndex: () => undefined
                };
                gsplatData = buildGSplatDataFromBundle(bundle);
            } catch (buildErr) {
                console.warn('[VPCC][worker][direct] buildGSplatData failed, fallback to PLY path:', buildErr);
                gsplatData = undefined;
            }
            if (timingEnabled()) {
                console.log('[VPCC TIMING][WASM][direct-build-main]', {
                    file: file.name,
                    path: reply.path,
                    buildMs: performance.now() - tBuildStart,
                    splats: gsplatData?.numSplats ?? 0
                });
            }
        } else if (opts.directParse && reply.direct?.error) {
            console.warn('[VPCC][worker][direct] parse error in worker, fallback to PLY:', reply.direct.error);
        }

        // 方案 4 走 wasm-direct 时 outputBuffer 是 0 字节，直接使用 gsplatData，
        // 不再构造无意义的 File（file-handler 在 gsplatData 存在时会完全跳过 PLY 回流）。
        if (reply.path === 'wasm-direct' && gsplatData) {
            return { filename: reply.filename, gsplatData };
        }

        return {
            filename: reply.filename,
            contents: new File([outputBytes as unknown as BlobPart], reply.filename, {
                type: 'application/octet-stream'
            }),
            gsplatData
        };
    } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        throw error;
    } finally {
        if (timingEnabled()) {
            console.log('[VPCC TIMING][WASM]', {
                path: 'worker',
                file: file.name,
                ok,
                error: errorMessage,
                totalMs: performance.now() - tTotalStart,
                inputReadMs,
                worker: reply?.timing ?? null
            });
        }
    }
};

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 应用启动 idle 阶段调用，提前把 Worker + WASM 模块拉起来。
 * 作用是把用户首次 import 时的 moduleLoadMs（大文件常见几百 ms 到 2s）
 * 提前摊平到启动后空闲期。
 *
 * 行为：
 * - 已经有健康 worker 时走快路径，只触发 loadModule 消息
 * - 任何失败都静默吞掉，不影响后续真正 decode 流程
 * - `window.VPCC_WASM_NO_PREWARM === true` 可显式关闭
 * - `window.VPCC_WASM_NO_WORKER === true` 时跳过（主线程路径没 worker 可热身）
 */
const prewarmVpccWasm = async (): Promise<boolean> => {
    if ((window as any).VPCC_WASM_NO_PREWARM === true) return false;
    if (isWorkerDisabled()) return false;

    try {
        const client = await getWorkerClient();
        if (!client) return false;

        const req: WorkerRequest = { token: 0, type: 'warm' };
        const tStart = performance.now();
        try {
            await client.post(req, []);
        } catch (err) {
            console.warn('[VPCC][prewarm] warm request failed:', err);
            return false;
        }

        if (timingEnabled()) {
            console.log('[VPCC TIMING][prewarm]', {
                ms: performance.now() - tStart
            });
        }
        return true;
    } catch (err) {
        console.warn('[VPCC][prewarm] unexpected error:', err);
        return false;
    }
};

const decodeVpccWithWasm = async (file: File): Promise<VpccImportFile> => {
    // 优先 worker，失败/不支持时回退主线程。整个过程对上层透明。
    try {
        const client = await getWorkerClient();
        if (client) {
            try {
                return await decodeOnWorker(file, client);
            } catch (workerErr) {
                console.warn('[VPCC][worker] decode failed, falling back to main-thread once:', workerErr);
                // 一次性回退；不重新抛，交给主线程尝试完成
            }
        }
    } catch (setupErr) {
        console.warn('[VPCC][worker] setup failed, using main-thread:', setupErr);
    }
    return await decodeOnMainThread(file);
};

export { decodeVpccWithWasm, prewarmVpccWasm };
