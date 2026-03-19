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
    const apiUrl = new URL('/api/vpcc/decode', getVpccApiOrigin());
    apiUrl.searchParams.set('filename', file.name);

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
        throw new Error(`Failed to reach local VPCC decode service at ${apiUrl.origin}. Start it with \`npm run develop:vpcc\` or \`npm run serve:vpcc\`.`);
    }

    const result = await response.json() as VpccDecodeResponse;
    if (!response.ok) {
        throw new Error(result.logTail ? `${result.error}\n\n${result.logTail}` : result.error || `Request failed with status ${response.status}`);
    }

    if (!result.firstFile?.url) {
        throw new Error('Decoder did not return a reconstructed PLY file');
    }

    return {
        filename: result.firstFile.name,
        url: result.firstFile.url
    };
};

export { decodeVpccWithLocalService };
