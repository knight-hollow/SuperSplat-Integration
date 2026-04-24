/**
 * VPCC WASM 解码 Worker 体。
 *
 * 设计要点：
 * - 以 Blob URL + Function.toString() 的方式启动「模块 Worker」，
 *   内部通过 await import() 动态加载 Emscripten 产物，与主线程相互隔离。
 * - 输入走 transferable ArrayBuffer（零拷贝），输出 PLY 字节与
 *   （可选的）每属性 Float32Array 同样以 transferable 方式回传主线程。
 * - Worker 内部内联了一份精简的 PLY 去交织（仅覆盖 PCCPointSetGS::write
 *   的 float32 + binary_little_endian 稳定输出格式），避免把整条 attribute-map
 *   也复制进 worker bundle，也确保解析本身在 worker 里完成，主线程只做
 *   GSplatData 的轻量构造。
 */


type WorkerOptions = {
    verboseConsole: boolean;
    skipPreUnlink: boolean;
    directParse: boolean;
};

type WorkerRequest = {
    token: number;
    /**
     * 'warm' 表示纯预热：只走 loadModule()，不做解码。主要用途是在应用启动
     * idle 阶段提前把 WASM 模块拉起来，后续首个 decode 可以省掉 moduleLoadMs。
     * 省略或 'decode' 时走标准解码流程。
     */
    type?: 'warm' | 'decode';
    inputBuffer?: ArrayBuffer;
    filename?: string;
    options?: WorkerOptions;
};

type WorkerDirectPayload = {
    numSplats: number;
    shDegree: 0 | 1 | 2 | 3;
    propertyOrder: string[];
    attrs: Record<string, Float32Array>;
    error?: string;
};

type WorkerTiming = {
    totalMs: number;
    moduleLoadMs: number;
    fsIoMs: number;
    decodeMs: number;
    parseMs: number;
};

type WorkerResponse =
    | {
        token: number;
        ok: true;
        filename: string;
        /**
         * 方案 4 直通路径下可能为 0 字节空 buffer（C++ 侧不再写 PLY）。
         * 上层按 direct != null 判定走哪条路。
         */
        outputBuffer: ArrayBuffer;
        direct: WorkerDirectPayload | null;
        timing: WorkerTiming;
        /**
         * 本次解码实际走的路径：
         * - 'wasm-direct'：C++ 直通 + 属性指针（方案 4）
         * - 'ply'       ：老路径（PLY write/read + JS 去交织）
         * - 'warm'      ：仅预热，未做解码（filename/outputBuffer 均为空）
         */
        path: 'wasm-direct' | 'ply' | 'warm';
    }
    | {
        token: number;
        ok: false;
        error: string;
        timing: WorkerTiming;
    };

type WorkerReadySignal = { __vpccWorkerReady: true };

/**
 * Worker 源代码体。之所以以函数承载再 toString，是为了在源层面保持
 * 常规 JS 语法高亮 / 校验；运行时会剥掉函数壳，在 Blob 里作为模块入口执行。
 */
const vpccWorkerBody = (wasmModuleUrlStr: string) => {
    const scope = self as any;

    let modulePromise: Promise<any> | null = null;
    let verboseConsole = false;

    const loadModule = async (): Promise<any> => {
        if (!modulePromise) {
            modulePromise = (async () => {
                const importedModule = await import(wasmModuleUrlStr);
                const factory = (importedModule.default || importedModule) as (o?: any) => Promise<any>;
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

    const END_HEADER = [0x65, 0x6E, 0x64, 0x5F, 0x68, 0x65, 0x61, 0x64, 0x65, 0x72, 0x0A]; // "end_header\n"

    /**
     * 仅覆盖 PCCPointSetGS::write 产出的稳定格式：binary_little_endian + 全 float32。
     * 如果遇到其它变体会抛错，由主线程 fallback 到 splat-transform 兜底。
     */
    const parseDecodedPly = (bytes: Uint8Array) => {
        const scanLimit = Math.min(bytes.length, 65536);
        let terminatorAt = -1;
        for (let i = 0; i <= scanLimit - END_HEADER.length; i++) {
            let matched = true;
            for (let j = 0; j < END_HEADER.length; j++) {
                if (bytes[i + j] !== END_HEADER[j]) {
                    matched = false;
                    break;
                }
            }
            if (matched) {
                terminatorAt = i + END_HEADER.length;
                break;
            }
        }
        if (terminatorAt < 0) throw new Error('VPCC worker: cannot locate end_header');

        const headerText = new TextDecoder('ascii').decode(bytes.subarray(0, terminatorAt));
        const lines = headerText.split('\n').map(l => l.trim()).filter(Boolean);

        const formatLine = lines.find(l => l.startsWith('format ')) || '';
        if (!formatLine.startsWith('format binary_little_endian')) {
            throw new Error(`VPCC worker: unsupported PLY format "${formatLine}"`);
        }
        const vertexLine = lines.find(l => l.startsWith('element vertex ')) || '';
        const numVertices = parseInt(vertexLine.split(/\s+/)[2], 10);
        if (!Number.isFinite(numVertices) || numVertices <= 0) {
            throw new Error(`VPCC worker: invalid vertex count: "${vertexLine}"`);
        }

        const props: { name: string; offset: number }[] = [];
        let rowStride = 0;
        let inVertex = false;
        for (const line of lines) {
            if (line.startsWith('element ')) {
                inVertex = line.startsWith('element vertex ');
                continue;
            }
            if (!inVertex) continue;
            if (!line.startsWith('property ')) continue;
            const parts = line.split(/\s+/);
            if (parts.length < 3) continue;
            if (parts[1] !== 'float' && parts[1] !== 'float32') {
                throw new Error(`VPCC worker: expected float32 property, got "${parts[1]} ${parts[2]}"`);
            }
            props.push({ name: parts[2], offset: rowStride });
            rowStride += 4;
        }
        if (props.length === 0) throw new Error('VPCC worker: no vertex properties parsed');

        const bodyOffset = terminatorAt;
        const bodySize = numVertices * rowStride;
        if (bodyOffset + bodySize > bytes.length) {
            throw new Error('VPCC worker: body size smaller than expected');
        }

        const propCount = props.length;
        const attrs: Record<string, Float32Array> = {};
        for (const p of props) attrs[p.name] = new Float32Array(numVertices);

        if ((bytes.byteOffset + bodyOffset) % 4 === 0) {
            const interleaved = new Float32Array(
                bytes.buffer,
                bytes.byteOffset + bodyOffset,
                numVertices * propCount
            );
            const columns: Float32Array[] = new Array(propCount);
            for (let c = 0; c < propCount; c++) columns[c] = attrs[props[c].name];
            for (let row = 0, base = 0; row < numVertices; row++, base += propCount) {
                for (let c = 0; c < propCount; c++) {
                    columns[c][row] = interleaved[base + c];
                }
            }
        } else {
            const dv = new DataView(bytes.buffer, bytes.byteOffset + bodyOffset, bodySize);
            for (let row = 0; row < numVertices; row++) {
                const rb = row * rowStride;
                for (const p of props) {
                    attrs[p.name][row] = dv.getFloat32(rb + p.offset, true);
                }
            }
        }

        let shRestCount = 0;
        for (const p of props) if (p.name.startsWith('f_rest_')) shRestCount++;
        let shDegree: 0 | 1 | 2 | 3 = 0;
        if (shRestCount >= 45) shDegree = 3;
        else if (shRestCount >= 24) shDegree = 2;
        else if (shRestCount >= 9) shDegree = 1;

        return {
            numSplats: numVertices,
            shDegree,
            propertyOrder: props.map(p => p.name),
            attrs
        };
    };

    const shDegreeFromOrder = (order: string[]): 0 | 1 | 2 | 3 => {
        let shRest = 0;
        for (const n of order) if (n.startsWith('f_rest_')) shRest++;
        if (shRest >= 45) return 3;
        if (shRest >= 24) return 2;
        if (shRest >= 9) return 1;
        return 0;
    };

    scope.onmessage = async (ev: MessageEvent) => {
        const req = ev.data as WorkerRequest;
        const t0 = (scope.performance || performance).now();

        // ----- 预热分支：只加载 WASM 模块，不走解码 -----
        if (req.type === 'warm') {
            let moduleLoadMs = 0;
            try {
                const tMod = performance.now();
                await loadModule();
                moduleLoadMs = performance.now() - tMod;
                const reply: WorkerResponse = {
                    token: req.token,
                    ok: true,
                    filename: '',
                    outputBuffer: new ArrayBuffer(0),
                    direct: null,
                    timing: {
                        totalMs: performance.now() - t0,
                        moduleLoadMs,
                        fsIoMs: 0,
                        decodeMs: 0,
                        parseMs: 0
                    },
                    path: 'warm'
                };
                scope.postMessage(reply);
            } catch (err: any) {
                const reply: WorkerResponse = {
                    token: req.token,
                    ok: false,
                    error: (err && err.message) || String(err),
                    timing: {
                        totalMs: performance.now() - t0,
                        moduleLoadMs,
                        fsIoMs: 0,
                        decodeMs: 0,
                        parseMs: 0
                    }
                };
                scope.postMessage(reply);
            }
            return;
        }

        const { token, inputBuffer, filename, options } = req as Required<WorkerRequest>;
        verboseConsole = !!(options && options.verboseConsole);

        let moduleLoadMs = 0;
        let fsIoMs = 0;
        let decodeMs = 0;
        let parseMs = 0;

        let fsInPath: string | null = null;
        let fsOutPath: string | null = null;
        let module: any;
        let directApiUsed = false;

        try {
            const tMod = performance.now();
            module = await loadModule();
            moduleLoadMs = performance.now() - tMod;

            const inputBytes = new Uint8Array(inputBuffer);
            const safeName = (filename || 'input').replace(/[^\w.\-]+/g, '_');
            const baseName = safeName.replace(/\.[^.]+$/, '') || 'decoded';
            const outputName = `${baseName}.decoded.ply`;

            const hasFs = !!module.FS;
            // 方案 4：优先尝试 C++ 直通路径（需要：新 WASM 导出 + MEMFS + directParse 启用）
            const wantDirectApi =
                options.directParse &&
                hasFs &&
                typeof module._vpcc_decode_file_direct === 'function' &&
                typeof module._vpcc_get_splat_count === 'function' &&
                typeof module._vpcc_get_property_ptr === 'function' &&
                !!module.HEAPF32;

            let outputBytes: Uint8Array = new Uint8Array(0);
            let direct: WorkerDirectPayload | null = null;
            const transferList: ArrayBuffer[] = [];

            if (wantDirectApi) {
                const fs = module.FS;
                const inPath = `/tmp/vpcc/${safeName}`;
                fsInPath = inPath;

                const tFs0 = performance.now();
                fs.mkdirTree('/tmp/vpcc');
                if (!options.skipPreUnlink) {
                    try {
                        fs.unlink(inPath);
                    } catch (_e) {}
                }
                fs.writeFile(inPath, inputBytes, { canOwn: true });
                fsIoMs += performance.now() - tFs0;

                const tDec0 = performance.now();
                const rc = module.ccall('vpcc_decode_file_direct', 'number', ['string'], [inPath]);
                decodeMs = performance.now() - tDec0;
                if (rc !== 0) {
                    const em = module.ccall('vpcc_get_last_error', 'string', [], []) as string;
                    throw new Error(em || `VPCC WASM direct decoder failed with code ${rc}`);
                }

                const tP0 = performance.now();
                const numSplats = module.ccall('vpcc_get_splat_count', 'number', [], []) as number;
                const propCount = module.ccall('vpcc_get_property_count', 'number', [], []) as number;
                if (numSplats <= 0 || propCount <= 0) {
                    throw new Error(`VPCC direct decoder produced empty result (splats=${numSplats}, props=${propCount})`);
                }

                const order: string[] = new Array(propCount);
                const attrs: Record<string, Float32Array> = {};
                // 直接把每列从 HEAPF32 切出来；slice() 会做一次 memcpy 到 JS 堆，
                // 产物的 ArrayBuffer 可以 transferable 回主线程。
                const heap = module.HEAPF32 as Float32Array;
                for (let i = 0; i < propCount; i++) {
                    const name = module.ccall('vpcc_get_property_name', 'string', ['number'], [i]) as string;
                    const ptr = module.ccall('vpcc_get_property_ptr', 'number', ['number'], [i]) as number;
                    if (!name || ptr === 0) {
                        throw new Error(`VPCC direct decoder missing property at index ${i}`);
                    }
                    // 注意：HEAPF32 的 byteOffset=0，ptr 本身是字节地址；
                    // Float32Array 的起始索引 = ptr / 4，因为 HEAPF32 覆盖整块 wasm memory。
                    const view = new Float32Array(heap.buffer, ptr, numSplats);
                    const copy = view.slice();
                    attrs[name] = copy;
                    order[i] = name;
                    transferList.push(copy.buffer as ArrayBuffer);
                }

                // 搬运完成立刻释放 WASM 里那块 buffer
                module.ccall('vpcc_reset_decoded', null, [], []);

                parseMs = performance.now() - tP0;

                direct = {
                    numSplats,
                    shDegree: shDegreeFromOrder(order),
                    propertyOrder: order,
                    attrs
                };
                directApiUsed = true;
            } else if (hasFs) {
                const fs = module.FS;
                const inPath = `/tmp/vpcc/${safeName}`;
                const outPath = `/tmp/vpcc/${outputName}`;
                fsInPath = inPath;
                fsOutPath = outPath;

                const tFs0 = performance.now();
                fs.mkdirTree('/tmp/vpcc');
                if (!options.skipPreUnlink) {
                    try {
                        fs.unlink(inPath);
                    } catch (_e) {}
                    try {
                        fs.unlink(outPath);
                    } catch (_e) {}
                }
                fs.writeFile(inPath, inputBytes, { canOwn: true });
                fsIoMs += performance.now() - tFs0;

                const tDec0 = performance.now();
                const rc = module.ccall('vpcc_decode_file', 'number', ['string', 'string'], [inPath, outPath]);
                decodeMs = performance.now() - tDec0;
                if (rc !== 0) {
                    const em = module.ccall('vpcc_get_last_error', 'string', [], []) as string;
                    throw new Error(em || `VPCC WASM decoder failed with code ${rc}`);
                }

                const tFsR = performance.now();
                outputBytes = fs.readFile(outPath) as Uint8Array;
                fsIoMs += performance.now() - tFsR;
                transferList.push(outputBytes.buffer as ArrayBuffer);
            } else {
                const inputPtr = module._malloc(inputBytes.byteLength);
                try {
                    module.HEAPU8.set(inputBytes, inputPtr);

                    const tDec0 = performance.now();
                    const rc = module.ccall(
                        'vpcc_decode_buffer', 'number',
                        ['number', 'number'],
                        [inputPtr, inputBytes.byteLength]
                    );
                    decodeMs = performance.now() - tDec0;
                    if (rc !== 0) {
                        const em = module.ccall('vpcc_get_last_error', 'string', [], []) as string;
                        throw new Error(em || `VPCC WASM decoder failed with code ${rc}`);
                    }

                    const outSize = module.ccall('vpcc_get_output_size', 'number', [], []) as number;
                    const outPtr = module.ccall('vpcc_get_output_buffer', 'number', [], []) as number;
                    if (outSize <= 0 || outPtr === 0) {
                        throw new Error('VPCC WASM decoder returned an empty output buffer');
                    }
                    outputBytes = (module.HEAPU8 as Uint8Array).slice(outPtr, outPtr + outSize);
                    transferList.push(outputBytes.buffer as ArrayBuffer);
                } finally {
                    module._free(inputPtr);
                }
            }

            // 老路径仍支持在 worker 里直接做 PLY 去交织。
            if (!directApiUsed && options.directParse && outputBytes.length > 0) {
                const tP0 = performance.now();
                try {
                    const bundle = parseDecodedPly(outputBytes);
                    const attrsOut: Record<string, Float32Array> = {};
                    for (const name of bundle.propertyOrder) {
                        attrsOut[name] = bundle.attrs[name];
                        transferList.push(bundle.attrs[name].buffer as ArrayBuffer);
                    }
                    direct = {
                        numSplats: bundle.numSplats,
                        shDegree: bundle.shDegree,
                        propertyOrder: bundle.propertyOrder,
                        attrs: attrsOut
                    };
                } catch (parseErr: any) {
                    direct = {
                        numSplats: 0,
                        shDegree: 0,
                        propertyOrder: [],
                        attrs: {},
                        error: (parseErr && parseErr.message) || String(parseErr)
                    };
                }
                parseMs = performance.now() - tP0;
            }

            const reply: WorkerResponse = {
                token,
                ok: true,
                filename: outputName,
                outputBuffer: outputBytes.buffer as ArrayBuffer,
                direct,
                timing: {
                    totalMs: performance.now() - t0,
                    moduleLoadMs,
                    fsIoMs,
                    decodeMs,
                    parseMs
                },
                path: directApiUsed ? 'wasm-direct' : 'ply'
            };
            scope.postMessage(reply, transferList);
        } catch (error: any) {
            const reply: WorkerResponse = {
                token,
                ok: false,
                error: (error && error.message) || String(error),
                timing: {
                    totalMs: performance.now() - t0,
                    moduleLoadMs,
                    fsIoMs,
                    decodeMs,
                    parseMs
                }
            };
            scope.postMessage(reply);
        } finally {
            if (module && module.FS) {
                if (fsInPath) {
                    try {
                        module.FS.unlink(fsInPath);
                    } catch (_e) {}
                }
                if (fsOutPath) {
                    try {
                        module.FS.unlink(fsOutPath);
                    } catch (_e) {}
                }
            }
            if (module) {
                try {
                    module.ccall('vpcc_clear_output_buffer', null, [], []);
                } catch (_e) {}
                if (directApiUsed) {
                    try {
                        module.ccall('vpcc_reset_decoded', null, [], []);
                    } catch (_e) {}
                }
            }
        }
    };

    const ready: WorkerReadySignal = { __vpccWorkerReady: true };
    scope.postMessage(ready);
};

/**
 * 把 worker 主体序列化成一段模块 Worker 源码，封进 Blob URL。
 * 调用方拿到 url 后做 `new Worker(url, { type: 'module' })` 即可。
 */
const createVpccWorkerUrl = (wasmModuleUrl: string): string => {
    const body = vpccWorkerBody.toString();
    const source = `(${body})(${JSON.stringify(wasmModuleUrl)});\n`;
    const blob = new Blob([source], { type: 'application/javascript' });
    return URL.createObjectURL(blob);
};

export { createVpccWorkerUrl };
export type { WorkerOptions, WorkerRequest, WorkerResponse, WorkerReadySignal, WorkerTiming, WorkerDirectPayload };
