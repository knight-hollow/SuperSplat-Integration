import type { GSplatData } from 'playcanvas';

type VpccImportFile = {
    filename: string;
    url?: string;
    contents?: File;
    /**
     * 直连渲染路径下已经构造完成的 GSplatData。
     * 一旦存在，file-handler 会绕过 splat-transform 的 PLY 二次解析。
     */
    gsplatData?: GSplatData;
};

export type { VpccImportFile };
