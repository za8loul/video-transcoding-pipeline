import {execa} from 'execa';
import readline from 'node:readline';
import fs from 'node:fs/promises';
import {probeFile} from './probe.js';

/**
 * Calculates a dynamic upper-bound ceiling for the FFmpeg job.
 * Ensures large files (up to 30GB) are never killed prematurely during full re-encodes.
 *
 * @param {Object} strategy - { video: 'copy'|'transcode', audio: 'copy'|'transcode'|'none' }
 * @param {number|null} duration - Video duration in seconds
 * @param {number|null} fileSizeBytes - Input file size in bytes
 * @returns {number} Timeout in milliseconds
 */
export function calculateJobTimeout(strategy = {}, duration = null, fileSizeBytes = null) {
    const isVideoCopy = strategy.video === 'copy';
    const isAudioCopy = strategy.audio === 'copy' || strategy.audio === 'none';

    if (isVideoCopy && isAudioCopy) {
        // Remux path: purely disk I/O. Minimum 10 minutes, scales with size (~30s per GB)
        const sizeGB = fileSizeBytes ? fileSizeBytes / (1024 ** 3) : 30;
        return Math.max(10 * 60 * 1000, Math.ceil(sizeGB * 30 * 1000));
    }

    if (isVideoCopy && !isAudioCopy) {
        // Partial transcode (audio only): ~20 minutes cap
        const dur = duration || 7200;
        return Math.max(20 * 60 * 1000, Math.ceil((dur / 4) * 1000));
    }

    // Full video transcode (libx264):
    // CPU video re-encoding takes 1.5x - 4x real-time depending on resolution/CPU.
    // Minimum 2 hours; for a 2-hour movie allow at least 6 hours.
    const dur = duration || 7200;
    return Math.max(2 * 60 * 60 * 1000, Math.ceil(dur * 3 * 1000));
}

/**
 * Executes FFmpeg command with progress tracking, stall detection, dynamic timeout,
 * automatic cleanup on failure, and post-conversion validation.
 *
 * @param {Object} params
 * @param {string[]} params.args - FFmpeg command line arguments
 * @param {string} params.outputPath - Target output file path
 * @param {Object} [params.strategy] - Strategy object { video, audio }
 * @param {number} [params.duration] - Media duration in seconds (for progress & ceiling)
 * @param {number} [params.fileSizeBytes] - File size in bytes (for remux ceiling)
 * @param {Object} [params.options] - Configuration overrides
 * @param {number} [params.options.stallTimeoutMs=180000] - Inactivity timeout (default 3 min)
 * @param {number} [params.options.maxCeilingMs] - Absolute ceiling override
 * @param {Function} [params.options.onProgress] - Callback invoked with progress metrics
 * @returns {Promise<{ outputPath: string, sizeBytes: number, streams: Array }>}
 */
export async function executeFfmpeg({
    args,
    outputPath,
    strategy = {},
    duration = null,
    fileSizeBytes = null,
    options = {}
}) {
    const stallTimeoutMs = options.stallTimeoutMs ?? (3 * 60 * 1000); // 3 minutes
    const maxCeilingMs = options.maxCeilingMs ?? calculateJobTimeout(strategy, duration, fileSizeBytes);
    const onProgress = options.onProgress ?? (() => {});

    // Ensure -progress pipe:1 is prepended so FFmpeg outputs machine-parseable progress
    const ffmpegArgs = ['-progress', 'pipe:1', ...args];

    let timedOut = false;
    let timeoutReason = null;
    let lastProgressTime = Date.now();

    // Spawn child process via execa with graceful kill escalation
    const childProcess = execa('ffmpeg', ffmpegArgs, {
        stdout: 'pipe',
        stderr: 'pipe',
        forceKillAfterTimeout: 5000 // Escalate to SIGKILL 5 seconds after SIGTERM
    });

    let currentProgress = {};

    // Parse machine-readable stdout progress lines
    const rl = readline.createInterface({
        input: childProcess.stdout,
        crlfDelay: Infinity
    });

    rl.on('line', (line) => {
        const idx = line.indexOf('=');
        if (idx === -1) return;

        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();

        currentProgress[key] = value;
        lastProgressTime = Date.now();

        if (key === 'progress') {
            const outTimeUs = currentProgress.out_time_us ? parseInt(currentProgress.out_time_us, 10) : 0;
            const outTimeSeconds = outTimeUs / 1_000_000;
            const percent = duration && duration > 0
                ? Math.min(100, Math.max(0, (outTimeSeconds / duration) * 100))
                : null;

            onProgress({
                percent: percent !== null ? parseFloat(percent.toFixed(2)) : null,
                fps: currentProgress.fps ? parseFloat(currentProgress.fps) : 0,
                speed: currentProgress.speed || 'N/A',
                outTime: currentProgress.out_time || '00:00:00',
                frame: currentProgress.frame ? parseInt(currentProgress.frame, 10) : 0,
                isEnd: value === 'end'
            });

            currentProgress = {};
        }
    });

    // Hard ceiling timer
    const ceilingTimer = setTimeout(() => {
        timedOut = true;
        timeoutReason = `Job exceeded maximum ceiling timeout of ${Math.round(maxCeilingMs / 1000)}s`;
        childProcess.kill('SIGTERM');
    }, maxCeilingMs);

    // Activity / stall timer interval
    const stallInterval = setInterval(() => {
        if (Date.now() - lastProgressTime > stallTimeoutMs) {
            timedOut = true;
            timeoutReason = `Job stalled: no progress received from FFmpeg for ${Math.round(stallTimeoutMs / 1000)}s`;
            clearInterval(stallInterval);
            childProcess.kill('SIGTERM');
        }
    }, Math.min(5000, Math.floor(stallTimeoutMs / 2)));

    // External cancellation via AbortSignal
    let abortListener = null;
    if (options.signal) {
        if (options.signal.aborted) {
            timedOut = true;
            timeoutReason = options.signal.reason || 'Job was cancelled';
            childProcess.kill('SIGTERM');
        } else {
            abortListener = () => {
                timedOut = true;
                timeoutReason = options.signal.reason || 'Job was cancelled';
                childProcess.kill('SIGTERM');
            };
            options.signal.addEventListener('abort', abortListener, { once: true });
        }
    }

    try {
        await childProcess;
    } catch (err) {
        // Process failed or was terminated
        rl.close();
        clearTimeout(ceilingTimer);
        clearInterval(stallInterval);

        // Mitigation: Always clean up partial output file on error or abort (DESIGN.md §3)
        await cleanupOutputFile(outputPath);

        if (timedOut) {
            throw new Error(`FFmpeg aborted: ${timeoutReason}`);
        }

        throw new Error(`FFmpeg process failed: ${err.stderr || err.message}`);
    } finally {
        rl.close();
        clearTimeout(ceilingTimer);
        clearInterval(stallInterval);
        if (options.signal && abortListener) {
            options.signal.removeEventListener('abort', abortListener);
        }
    }

    // Post-Execution Validation (DESIGN.md §1 & §3)
    try {
        const stats = await fs.stat(outputPath);
        if (stats.size === 0) {
            throw new Error("Output file was created but has 0 bytes");
        }

        // Verify the output file can be parsed and has a valid video stream
        const outputStreams = await probeFile(outputPath);
        const hasVideo = outputStreams.some(s => s.codec_type === 'video');
        if (!hasVideo) {
            throw new Error("Validation failed: Output file has no video stream");
        }

        return {
            outputPath,
            sizeBytes: stats.size,
            streams: outputStreams
        };
    } catch (validationErr) {
        // Output file is invalid or corrupt — delete it to avoid leaking disk space
        await cleanupOutputFile(outputPath);
        throw new Error(`Post-conversion validation failed: ${validationErr.message}`);
    }
}

/**
 * Safely removes a file if it exists, ignoring missing file errors.
 *
 * @param {string} filePath
 */
async function cleanupOutputFile(filePath) {
    if (!filePath) return;
    try {
        await fs.unlink(filePath);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`Failed to clean up partial file ${filePath}:`, err);
        }
    }
}
