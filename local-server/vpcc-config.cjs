const path = require('path');

const supersplatRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(supersplatRoot, '..');
const vpccRoot = path.resolve(workspaceRoot, 'GS4-vpcc', 'mpeg-pcc-tmc2');

const config = {
    host: process.env.VPCC_SERVER_HOST || '127.0.0.1',
    port: Number(process.env.VPCC_SERVER_PORT || 3001),
    publicOrigin: process.env.VPCC_PUBLIC_ORIGIN || null,
    maxUploadBytes: Number(process.env.VPCC_MAX_UPLOAD_BYTES || 1024 * 1024 * 1024),
    jobsDir: process.env.VPCC_JOBS_DIR || path.join(supersplatRoot, '.vpcc-jobs'),
    successfulJobRetentionMs: Number(process.env.VPCC_JOB_RETENTION_MS || 10 * 60 * 1000),
    decoderPath: process.env.VPCC_DECODER_PATH || path.join(vpccRoot, 'bin', 'Release', 'PccAppDecoder.exe'),
    decoderWorkingDirectory: process.env.VPCC_DECODER_CWD || path.join(vpccRoot, 'bin', 'Release'),
    supportedExtensions: new Set(['.bin', '.v3c'])
};

module.exports = {
    config
};
