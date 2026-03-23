import type { VpccImportFile } from './types';

type VpccDecodeResponse = {
    error?: string;
    logTail?: string;
    firstFile?: {
        name: string;
        url: string;
    };
};

const getVpccApiOrigin = () => {
    return (window as any).VPCC_API_ORIGIN || `${window.location.protocol}//${window.location.hostname || '127.0.0.1'}:3001`;
};

const decodeVpccWithLocalService = async (file: File): Promise<VpccImportFile> => {
    const tTotalStart = performance.now();
    const apiUrl = new URL('/api/vpcc/decode', getVpccApiOrigin());
    apiUrl.searchParams.set('filename', file.name);
    const tFetchStart = performance.now();

    let response: Response;
    try {
        response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream'
            },
            body: file
        });
    } catch (error) {
        const tTotalEnd = performance.now();
        console.log('[VPCC TIMING][LOCAL]', {
            file: file.name,
            totalMs: tTotalEnd - tTotalStart,
            error: error instanceof Error ? error.message : String(error)
        });
        throw new Error(`Failed to reach local VPCC decode service at ${apiUrl.origin}. Start it with \`npm run develop:vpcc\` or \`npm run serve:vpcc\`.`);
    }

    const tFetchEnd = performance.now();
    const result = await response.json() as VpccDecodeResponse;
    const tJsonEnd = performance.now();

    console.log('[VPCC TIMING][LOCAL]', {
        file: file.name,
        uploadBytes: file.size,
        fetchMs: tFetchEnd - tFetchStart,
        responseJsonMs: tJsonEnd - tFetchEnd,
        totalMs: tJsonEnd - tTotalStart
    });
    if (!response.ok) {
        throw new Error(result.logTail ? `${result.error}\n\n${result.logTail}` : result.error || `Request failed with status ${response.status}`);
    }

    if (!result.firstFile?.url) {
        throw new Error('Decoder did not return a reconstructed PLY file');
    }

    // Download reconstructed PLY into memory so import timing includes fetch cost.
    // This makes local-middle vs WASM comparisons much more consistent.
    const tPlyFetchStart = performance.now();
    const plyResp = await fetch(result.firstFile.url);
    if (!plyResp.ok) {
        const tPlyFetchEnd = performance.now();
        console.log('[VPCC TIMING][LOCAL]', {
            file: file.name,
            plyDownloadMs: tPlyFetchEnd - tPlyFetchStart,
            plyFetchStatus: plyResp.status
        });
        throw new Error(`Failed to download decoded PLY from ${result.firstFile.url} (status ${plyResp.status})`);
    }
    const plyBlob = await plyResp.blob();
    const tPlyFetchEnd = performance.now();

    console.log('[VPCC TIMING][LOCAL]', {
        file: file.name,
        plyBytes: plyBlob.size,
        plyDownloadMs: tPlyFetchEnd - tPlyFetchStart
    });

    return {
        filename: result.firstFile.name,
        url: result.firstFile.url,
        contents: new File([plyBlob], result.firstFile.name, { type: 'application/octet-stream' })
    };
};

export { decodeVpccWithLocalService };
