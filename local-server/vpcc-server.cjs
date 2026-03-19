const http = require('http');
const path = require('path');
const fs = require('fs');
const { promises: fsp } = require('fs');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');

const { config } = require('./vpcc-config.cjs');

const jsonHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
};

const sendJson = (response, statusCode, payload) => {
    response.writeHead(statusCode, {
        ...jsonHeaders,
        'Content-Type': 'application/json; charset=utf-8'
    });
    response.end(JSON.stringify(payload));
};

const sendText = (response, statusCode, message) => {
    response.writeHead(statusCode, {
        ...jsonHeaders,
        'Content-Type': 'text/plain; charset=utf-8'
    });
    response.end(message);
};

const safeBasename = (filename) => {
    const base = path.basename(filename || 'upload.bin').replace(/[^\w.\-]+/g, '_');
    return base.length > 0 ? base : 'upload.bin';
};

const tailLines = (text, lineCount = 40) => {
    return text.split(/\r?\n/).slice(-lineCount).join('\n').trim();
};

const getPublicOrigin = () => {
    return config.publicOrigin || `http://${config.host}:${config.port}`;
};

const ensureServerDirectories = async () => {
    await fsp.mkdir(config.jobsDir, { recursive: true });
};

const cleanupTimers = new Map();

const clearScheduledCleanup = (jobId) => {
    const timer = cleanupTimers.get(jobId);
    if (timer) {
        clearTimeout(timer);
        cleanupTimers.delete(jobId);
    }
};

const deleteJobDir = async (jobId) => {
    clearScheduledCleanup(jobId);
    if (!jobId) {
        return;
    }

    const jobDir = path.join(config.jobsDir, jobId);
    await fsp.rm(jobDir, { recursive: true, force: true });
};

const scheduleJobCleanup = (jobId) => {
    const retentionMs = Number(config.successfulJobRetentionMs);
    if (!Number.isFinite(retentionMs) || retentionMs < 0) {
        return;
    }

    clearScheduledCleanup(jobId);

    const timer = setTimeout(async () => {
        try {
            await deleteJobDir(jobId);
        } catch (error) {
            console.warn(`Failed to clean VPCC job '${jobId}': ${error.message || String(error)}`);
        }
    }, retentionMs);

    if (typeof timer.unref === 'function') {
        timer.unref();
    }

    cleanupTimers.set(jobId, timer);
};

const readRequestToFile = async (request, destinationPath) => {
    await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(destinationPath);
        let totalBytes = 0;
        let completed = false;

        const fail = (error) => {
            if (completed) {
                return;
            }
            completed = true;
            output.destroy();
            reject(error);
        };

        output.on('error', fail);

        request.on('aborted', () => {
            fail(new Error('Upload aborted'));
        });

        request.on('error', fail);

        request.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > config.maxUploadBytes) {
                fail(new Error(`Upload exceeds ${config.maxUploadBytes} bytes`));
                request.destroy();
                return;
            }

            if (!output.write(chunk)) {
                request.pause();
            }
        });

        output.on('drain', () => {
            request.resume();
        });

        request.on('end', () => {
            if (completed) {
                return;
            }
            completed = true;
            output.end(() => resolve(totalBytes));
        });
    });
};

const runDecoder = async (inputPath, decodedPatternPath) => {
    return await new Promise((resolve, reject) => {
        const args = [
            `--compressedStreamPath=${inputPath}`,
            `--reconstructedDataPath=${decodedPatternPath}`
        ];

        const child = spawn(config.decoderPath, args, {
            cwd: config.decoderWorkingDirectory,
            windowsHide: true
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', (error) => {
            reject(error);
        });

        child.on('close', (code) => {
            resolve({
                code,
                stdout,
                stderr
            });
        });
    });
};

const listDecodedPlyFiles = async (decodedDir) => {
    const entries = await fsp.readdir(decodedDir, { withFileTypes: true });
    const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.ply'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

    const concreteFiles = files.filter((name) => !name.includes('%'));
    return concreteFiles.length > 0 ? concreteFiles : files;
};

const handleDecodeRequest = async (request, response, requestUrl) => {
    const filenameParam = requestUrl.searchParams.get('filename');
    const safeName = safeBasename(filenameParam);
    const extension = path.extname(safeName).toLowerCase();

    if (!config.supportedExtensions.has(extension)) {
        sendJson(response, 400, {
            error: `Unsupported file extension '${extension || '(none)'}'. Expected .bin or .v3c`
        });
        return;
    }

    if (!fs.existsSync(config.decoderPath)) {
        sendJson(response, 500, {
            error: `Decoder not found at '${config.decoderPath}'`
        });
        return;
    }

    const jobId = randomUUID();
    const jobDir = path.join(config.jobsDir, jobId);
    const uploadDir = path.join(jobDir, 'input');
    const decodedDir = path.join(jobDir, 'decoded');
    const logPath = path.join(jobDir, 'decoder.log');
    const inputPath = path.join(uploadDir, safeName);
    const decodedOutputPath = path.join(decodedDir, `${path.parse(safeName).name}.decoded.ply`);

    try {
        await fsp.mkdir(uploadDir, { recursive: true });
        await fsp.mkdir(decodedDir, { recursive: true });

        const uploadBytes = await readRequestToFile(request, inputPath);
        const result = await runDecoder(inputPath, decodedOutputPath);
        const combinedLog = `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ''}`;
        await fsp.writeFile(logPath, combinedLog, 'utf8');

        const plyFiles = await listDecodedPlyFiles(decodedDir);
        if (plyFiles.length === 0 && result.code !== 0) {
            sendJson(response, 500, {
                error: `Decoder exited with code ${result.code}`,
                logTail: tailLines(combinedLog)
            });
            return;
        }

        if (plyFiles.length === 0) {
            sendJson(response, 500, {
                error: 'Decoder finished without producing any PLY output',
                logTail: tailLines(combinedLog)
            });
            return;
        }

        const publicOrigin = getPublicOrigin();
        const files = plyFiles.map((name) => ({
            name,
            url: `${publicOrigin}/api/vpcc/result/${jobId}/${encodeURIComponent(name)}`
        }));

        sendJson(response, 200, {
            jobId,
            uploadBytes,
            inputFilename: safeName,
            decoderExitCode: result.code,
            logUrl: `${publicOrigin}/api/vpcc/log/${jobId}`,
            files,
            firstFile: files[0]
        });
        scheduleJobCleanup(jobId);
    } catch (error) {
        await deleteJobDir(jobId);
        sendJson(response, 500, {
            error: error.message || String(error)
        });
    }
};

const handleResultRequest = async (response, pathname) => {
    const parts = pathname.split('/').filter(Boolean);
    const jobId = parts[3];
    const filename = parts.slice(4).join('/');

    if (!jobId || !filename) {
        sendJson(response, 404, {
            error: 'Result not found'
        });
        return;
    }

    const resolvedPath = path.join(config.jobsDir, jobId, 'decoded', path.basename(decodeURIComponent(filename)));
    if (!resolvedPath.startsWith(path.join(config.jobsDir, jobId))) {
        sendJson(response, 400, {
            error: 'Invalid file path'
        });
        return;
    }

    if (!fs.existsSync(resolvedPath)) {
        sendJson(response, 404, {
            error: 'PLY file not found'
        });
        return;
    }

    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/octet-stream'
    });
    fs.createReadStream(resolvedPath).pipe(response);
};

const handleLogRequest = async (response, pathname) => {
    const parts = pathname.split('/').filter(Boolean);
    const jobId = parts[3];
    const logPath = path.join(config.jobsDir, jobId || '', 'decoder.log');

    if (!jobId || !fs.existsSync(logPath)) {
        sendJson(response, 404, {
            error: 'Log not found'
        });
        return;
    }

    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8'
    });
    fs.createReadStream(logPath).pipe(response);
};

const server = http.createServer(async (request, response) => {
    if (!request.url) {
        sendJson(response, 400, {
            error: 'Missing request URL'
        });
        return;
    }

    if (request.method === 'OPTIONS') {
        response.writeHead(204, jsonHeaders);
        response.end();
        return;
    }

    const requestUrl = new URL(request.url, getPublicOrigin());

    try {
        if (request.method === 'GET' && requestUrl.pathname === '/api/vpcc/health') {
            sendJson(response, 200, {
                ok: true,
                decoderPath: config.decoderPath,
                decoderExists: fs.existsSync(config.decoderPath),
                jobsDir: config.jobsDir
            });
            return;
        }

        if (request.method === 'POST' && requestUrl.pathname === '/api/vpcc/decode') {
            await handleDecodeRequest(request, response, requestUrl);
            return;
        }

        if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/vpcc/result/')) {
            await handleResultRequest(response, requestUrl.pathname);
            return;
        }

        if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/vpcc/log/')) {
            await handleLogRequest(response, requestUrl.pathname);
            return;
        }

        sendJson(response, 404, {
            error: 'Not found'
        });
    } catch (error) {
        sendJson(response, 500, {
            error: error.message || String(error)
        });
    }
});

const start = async () => {
    await ensureServerDirectories();

    server.listen(config.port, config.host, () => {
        console.log(`VPCC local server listening on ${getPublicOrigin()}`);
        console.log(`Decoder path: ${config.decoderPath}`);
        console.log(`Jobs directory: ${config.jobsDir}`);
    });
};

start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
