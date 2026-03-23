import { getInputFormat, ReadFileSystem } from '@playcanvas/splat-transform';
import { AppBase, Asset, GSplatResource, Vec3 } from 'playcanvas';

import { Events } from './events';
import { loadGSplatData, validateGSplatData } from './io';
import { Splat } from './splat';

const getOrientation = (filename: string) => {
    switch (getInputFormat(filename)) {
        case 'spz':
            return new Vec3(0, 0, 0);
        case 'lcc':
            return new Vec3(90, 0, 180);
        default:
            return new Vec3(0, 0, 180);
    }
};

// handles loading gsplat assets using splat-transform
class AssetLoader {
    app: AppBase;
    events: Events;

    constructor(app: AppBase, events: Events) {
        this.app = app;
        this.events = events;
    }

    async load(filename: string, fileSystem: ReadFileSystem, animationFrame?: boolean, skipReorder?: boolean) {
        const tAllStart = performance.now();
        if (!animationFrame) {
            this.events.fire('startSpinner');
        }

        try {
            // Skip reordering for animation frames (speed) or when explicitly requested (already ordered)
            const tLoadGSplatDataStart = performance.now();
            const gsplatData = await loadGSplatData(filename, fileSystem, skipReorder || animationFrame);
            const tLoadGSplatDataEnd = performance.now();

            const tValidateStart = performance.now();
            validateGSplatData(gsplatData);
            const tValidateEnd = performance.now();

            const asset = new Asset(filename, 'gsplat', { url: `local-asset-${Date.now()}`, filename });
            this.app.assets.add(asset);

            const tResourceStart = performance.now();
            asset.resource = new GSplatResource(this.app.graphicsDevice, gsplatData);
            const tResourceEnd = performance.now();

            const splat = new Splat(asset, getOrientation(filename));
            console.log('[PLY TIMING][assetLoader.load]', {
                filename,
                animationFrame: !!animationFrame,
                skipReorder: !!skipReorder,
                loadGSplatDataMs: tLoadGSplatDataEnd - tLoadGSplatDataStart,
                validateMs: tValidateEnd - tValidateStart,
                gsplatResourceMs: tResourceEnd - tResourceStart,
                totalMs: performance.now() - tAllStart
            });

            return splat;
        } finally {
            if (!animationFrame) {
                this.events.fire('stopSpinner');
            }
        }
    }
}

export { AssetLoader };
