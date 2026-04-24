/**
 * VPCC 属性映射常量层。
 *
 * 对齐 m76531v1 中给出的「G-PCC v1 Amd1 解码器属性索引 → 语义」约定，
 * 同时负责把 PccAppDecoder WASM 输出的二进制 PLY 直接解析为
 * 「每属性一个 Float32Array」的结构，供 PlayCanvas GSplatData 直连使用，
 * 从而在渲染链路中彻底跳过 splat-transform 的 PLY 二次解析 / DataTable 中转。
 *
 * 输出 PLY 的属性顺序由 C++ 侧 PCCPointSetGS::write 固化：
 *   x, y, z,
 *  [opacity],
 *  [scale_0, scale_1, scale_2],
 *  [rot_0, rot_1, rot_2, rot_3],
 *  [f_dc_0, f_dc_1, f_dc_2, f_rest_0 .. f_rest_(N-4)]
 * 全部为 float32 / little-endian。
 */

import { GSplatData } from 'playcanvas';

/**
 * 稳定的属性索引（对齐 m76531v1 的 getAttrVals(attrIndex) 约定）。
 *
 * 说明：
 * - 0..2    位置 x, y, z
 * - 3..5    SH DC (f_dc_0..2)
 * - 6..50   SH rest (f_rest_0..44，SH3 = 48 个 SH 分量 - 3 个 DC)
 * - 51..53  尺度 scale_0..2
 * - 54..57  旋转 rot_0..3
 * - 58      opacity
 *
 * 说明里的范围是 SH3 的满载情况，实际条数由 PLY 头里出现的属性数决定。
 */
const VPCC_ATTR = {
    POS_X: 0,
    POS_Y: 1,
    POS_Z: 2,

    F_DC_0: 3,
    F_DC_1: 4,
    F_DC_2: 5,

    F_REST_BASE: 6,
    F_REST_END_SH3: 50, // f_rest_44

    SCALE_0: 51,
    SCALE_1: 52,
    SCALE_2: 53,

    ROT_0: 54,
    ROT_1: 55,
    ROT_2: 56,
    ROT_3: 57,

    OPACITY: 58
} as const;

/**
 * 从属性索引映射到 PLY 属性名（与 PCCPointSetGS::write 的命名一致）。
 */
const attrIndexToName = (attrIndex: number): string => {
    switch (attrIndex) {
        case VPCC_ATTR.POS_X: return 'x';
        case VPCC_ATTR.POS_Y: return 'y';
        case VPCC_ATTR.POS_Z: return 'z';
        case VPCC_ATTR.F_DC_0: return 'f_dc_0';
        case VPCC_ATTR.F_DC_1: return 'f_dc_1';
        case VPCC_ATTR.F_DC_2: return 'f_dc_2';
        case VPCC_ATTR.SCALE_0: return 'scale_0';
        case VPCC_ATTR.SCALE_1: return 'scale_1';
        case VPCC_ATTR.SCALE_2: return 'scale_2';
        case VPCC_ATTR.ROT_0: return 'rot_0';
        case VPCC_ATTR.ROT_1: return 'rot_1';
        case VPCC_ATTR.ROT_2: return 'rot_2';
        case VPCC_ATTR.ROT_3: return 'rot_3';
        case VPCC_ATTR.OPACITY: return 'opacity';
        default:
            if (attrIndex >= VPCC_ATTR.F_REST_BASE && attrIndex <= VPCC_ATTR.F_REST_END_SH3) {
                return `f_rest_${attrIndex - VPCC_ATTR.F_REST_BASE}`;
            }
            return '';
    }
};

/**
 * 解析后的属性集合。
 * - `attrs` 以 PLY 属性名为键，值是与 numSplats 等长的 Float32Array。
 * - `byIndex` 以稳定索引检索（m76531v1 的 getAttrVals 语义）。
 */
type VpccDecodedBundle = {
    numSplats: number;
    shDegree: 0 | 1 | 2 | 3;
    propertyOrder: string[];
    attrs: Record<string, Float32Array>;
    byIndex: (attrIndex: number) => Float32Array | undefined;
};

const PLY_TYPE_BYTES: Record<string, number> = {
    char: 1, int8: 1,
    uchar: 1, uint8: 1,
    short: 2, int16: 2,
    ushort: 2, uint16: 2,
    int: 4, int32: 4,
    uint: 4, uint32: 4,
    float: 4, float32: 4,
    double: 8, float64: 8
};

const PLY_TYPE_IS_FLOAT32: Record<string, boolean> = {
    float: true, float32: true
};

type PlyPropDesc = {
    name: string;
    type: string;
    byteSize: number;
    isFloat32: boolean;
    offsetInRow: number;
};

const decodeHeaderAndBody = (bytes: Uint8Array): {
    headerLines: string[];
    bodyOffset: number;
    littleEndian: boolean;
    numVertices: number;
} => {
    const headerTerminator = new TextEncoder().encode('end_header\n');
    // 在前 64KB 内寻找 end_header\n
    const scanLimit = Math.min(bytes.length, 64 * 1024);
    let terminatorAt = -1;
    outer: for (let i = 0; i <= scanLimit - headerTerminator.length; i++) {
        for (let j = 0; j < headerTerminator.length; j++) {
            if (bytes[i + j] !== headerTerminator[j]) continue outer;
        }
        terminatorAt = i + headerTerminator.length;
        break;
    }
    if (terminatorAt < 0) {
        throw new Error('VPCC direct parser: cannot locate end_header in decoded PLY');
    }

    const headerText = new TextDecoder('ascii').decode(bytes.subarray(0, terminatorAt));
    const headerLines = headerText.split('\n').map(l => l.trim()).filter(Boolean);

    const format = headerLines.find(l => l.startsWith('format '))?.slice('format '.length) ?? '';
    if (!format.startsWith('binary_little_endian') && !format.startsWith('binary_big_endian')) {
        throw new Error(`VPCC direct parser only supports binary PLY, got: ${format}`);
    }
    const littleEndian = format.startsWith('binary_little_endian');

    const vertexLine = headerLines.find(l => l.startsWith('element vertex '));
    if (!vertexLine) {
        throw new Error('VPCC direct parser: missing "element vertex" line');
    }
    const numVertices = parseInt(vertexLine.split(/\s+/)[2], 10);
    if (!Number.isFinite(numVertices) || numVertices <= 0) {
        throw new Error(`VPCC direct parser: invalid vertex count: ${vertexLine}`);
    }

    return { headerLines, bodyOffset: terminatorAt, littleEndian, numVertices };
};

const collectVertexProps = (headerLines: string[]): PlyPropDesc[] => {
    const props: PlyPropDesc[] = [];
    let inVertex = false;
    let rowOffset = 0;
    for (const line of headerLines) {
        if (line.startsWith('element ')) {
            inVertex = line.startsWith('element vertex ');
            continue;
        }
        if (!inVertex) continue;
        if (!line.startsWith('property ')) continue;
        const parts = line.split(/\s+/);
        if (parts.length < 3) continue;
        // property <type> <name> 或 property list <idxType> <valType> <name>
        if (parts[1] === 'list') {
            throw new Error('VPCC direct parser: list properties are not expected on vertex element');
        }
        const type = parts[1];
        const name = parts[2];
        const byteSize = PLY_TYPE_BYTES[type];
        if (!byteSize) {
            throw new Error(`VPCC direct parser: unsupported property type "${type}" for "${name}"`);
        }
        props.push({
            name,
            type,
            byteSize,
            isFloat32: !!PLY_TYPE_IS_FLOAT32[type],
            offsetInRow: rowOffset
        });
        rowOffset += byteSize;
    }
    return props;
};

/**
 * 把 PccAppDecoder WASM 输出的二进制 PLY 直接解析为
 * 「每属性一个 Float32Array」的结构。
 *
 * 对 GS 常见输出（全 float32），只做一次顺序扫描 + 去交织；
 * 不会再触发一次全量反序列化。
 */
const parseVpccDecodedPly = (bytes: Uint8Array): VpccDecodedBundle => {
    const { headerLines, bodyOffset, littleEndian, numVertices } = decodeHeaderAndBody(bytes);
    const props = collectVertexProps(headerLines);
    if (!props.length) {
        throw new Error('VPCC direct parser: no vertex properties found');
    }

    const rowStride = props.reduce((s, p) => s + p.byteSize, 0);
    const bodySize = numVertices * rowStride;
    if (bodyOffset + bodySize > bytes.length) {
        throw new Error('VPCC direct parser: body size smaller than expected');
    }

    const attrs: Record<string, Float32Array> = {};
    for (const p of props) {
        attrs[p.name] = new Float32Array(numVertices);
    }

    const dv = new DataView(bytes.buffer, bytes.byteOffset + bodyOffset, bodySize);

    // 热路径：所有 props 都是 float32 的情况走紧凑循环，这对于 PCCPointSetGS::write 是默认场景。
    const allFloat32 = props.every(p => p.isFloat32);
    if (allFloat32 && littleEndian) {
        const propCount = props.length;
        const floatsTotal = numVertices * propCount;
        // 按 4 字节对齐的话直接一视同仁地当 Float32 来读，避免重复做 endian 判断。
        // rowStride 恰好 == propCount * 4，因此数据是"行 × 列"的简单行优先布局。
        if (rowStride !== propCount * 4) {
            throw new Error('VPCC direct parser: unexpected float-only row padding');
        }
        // 若字节对齐，直接用一个 Float32Array 视图 + 行优先扫描去交织，避免 DataView getFloat32 调用开销。
        const interleaved = ((bytes.byteOffset + bodyOffset) % 4 === 0)
            ? new Float32Array(bytes.buffer, bytes.byteOffset + bodyOffset, floatsTotal)
            : null;
        if (interleaved) {
            const columns: Float32Array[] = props.map(p => attrs[p.name]);
            for (let row = 0, base = 0; row < numVertices; row++, base += propCount) {
                for (let c = 0; c < propCount; c++) {
                    columns[c][row] = interleaved[base + c];
                }
            }
        } else {
            // 字节不对齐的兜底路径。
            for (let row = 0; row < numVertices; row++) {
                const rowBase = row * rowStride;
                for (let c = 0; c < propCount; c++) {
                    attrs[props[c].name][row] = dv.getFloat32(rowBase + props[c].offsetInRow, true);
                }
            }
        }
    } else {
        // 通用兜底：逐属性按类型读取。
        for (let row = 0; row < numVertices; row++) {
            const rowBase = row * rowStride;
            for (const p of props) {
                const off = rowBase + p.offsetInRow;
                let v = 0;
                switch (p.type) {
                    case 'float': case 'float32': v = dv.getFloat32(off, littleEndian); break;
                    case 'double': case 'float64': v = dv.getFloat64(off, littleEndian); break;
                    case 'uchar': case 'uint8': v = dv.getUint8(off); break;
                    case 'char': case 'int8': v = dv.getInt8(off); break;
                    case 'ushort': case 'uint16': v = dv.getUint16(off, littleEndian); break;
                    case 'short': case 'int16': v = dv.getInt16(off, littleEndian); break;
                    case 'uint': case 'uint32': v = dv.getUint32(off, littleEndian); break;
                    case 'int': case 'int32': v = dv.getInt32(off, littleEndian); break;
                    default: v = 0;
                }
                attrs[p.name][row] = v;
            }
        }
    }

    // 推断 SH 阶数。
    let shRestCount = 0;
    for (const p of props) {
        if (p.name.startsWith('f_rest_')) shRestCount++;
    }
    let shDegree: 0 | 1 | 2 | 3 = 0;
    if (shRestCount >= 45) shDegree = 3;
    else if (shRestCount >= 24) shDegree = 2;
    else if (shRestCount >= 9) shDegree = 1;
    else shDegree = 0;

    const propertyOrder = props.map(p => p.name);

    const byIndex = (attrIndex: number): Float32Array | undefined => {
        const name = attrIndexToName(attrIndex);
        return name ? attrs[name] : undefined;
    };

    return {
        numSplats: numVertices,
        shDegree,
        propertyOrder,
        attrs,
        byIndex
    };
};

/**
 * 把已经解析好的属性直接装成 PlayCanvas GSplatData，跳过 splat-transform。
 *
 * - 属性声明顺序与 loader.ts 里的 dataTableToGSplatData 保持语义一致（单 vertex element，各属性 type=float）。
 * - 如果缺少 scale_2（某些 2D splat），会补一个接近 0 的 scale_2，以便渲染器正常识别。
 */
const buildGSplatDataFromBundle = (bundle: VpccDecodedBundle): GSplatData => {
    const properties = bundle.propertyOrder.map((name) => {
        const storage = bundle.attrs[name];
        return {
            type: 'float',
            name,
            storage,
            byteSize: storage.BYTES_PER_ELEMENT
        };
    });

    const gsplatData = new GSplatData([{
        name: 'vertex',
        count: bundle.numSplats,
        properties
    }]);

    if (gsplatData.getProp('scale_0') && gsplatData.getProp('scale_1') && !gsplatData.getProp('scale_2')) {
        const scale2 = new Float32Array(gsplatData.numSplats).fill(Math.log(1e-6));
        gsplatData.addProp('scale_2', scale2);
        const props = gsplatData.getElement('vertex').properties;
        props.splice(
            props.findIndex((prop: any) => prop.name === 'scale_1') + 1,
            0,
            props.splice(props.length - 1, 1)[0]
        );
    }

    return gsplatData;
};

export {
    VPCC_ATTR,
    attrIndexToName,
    parseVpccDecodedPly,
    buildGSplatDataFromBundle
};
export type { VpccDecodedBundle };
