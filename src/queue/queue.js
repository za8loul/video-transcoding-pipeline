import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { probeFile } from '../ffmpeg/probe.js';
import { determineFfmpegArgs } from '../ffmpeg/routing.js';
import { executeFfmpeg } from '../ffmpeg/executor.js';
import { calculateRequiredScratchSpace, assertDiskSpaceAvailable } from '../storage/disk.js';

export class TranscodeQueue extends EventEmitter {
    /**
     * @param {Object} [options]
     * @param {number} [options.concurrency=1] - Maximum concurrent transcoding jobs (1-2 recommended)
     * @param {number} [options.maxHistory=50] - Number of finished jobs to keep in memory
     */
    constructor(options = {}) {
        super();
        this.concurrency = Math.max(1, options.concurrency ?? 1);
        this.maxHistory = options.maxHistory ?? 50;
        this.activeJobs = new Map();
        this.pendingQueue = [];
        this.completedJobs = new Map();
    }

    /**
     * Adds a new conversion job to the queue.
     * Performs pre-flight disk space assertion and stream validation before enqueueing.
     *
     * @param {Object} params
     * @param {string} params.inputPath - Path to source video file
     * @param {string} params.outputPath - Destination path for converted MP4
     * @param {Object} [params.options] - Optional execution overrides
     * @returns {Promise<Object>} The enqueued job object
     */
    async addJob({ inputPath, outputPath, options = {} }) {
        // 1. Verify input file exists & retrieve file size
        const fileStats = await fs.stat(inputPath);
        const inputSizeBytes = fileStats.size;

        // 2. Pre-flight Disk Check Gate (DESIGN.md §2 & §3)
        const requiredScratchBytes = calculateRequiredScratchSpace(inputSizeBytes);
        await assertDiskSpaceAvailable(outputPath, requiredScratchBytes);

        // 3. Pre-flight Payload Validation via ffprobe (DESIGN.md §3)
        // Rejects non-video or corrupt binaries before job is queued
        let streams;
        try {
            streams = await probeFile(inputPath);
        } catch (probeErr) {
            const err = new Error("Corrupt or invalid video file. The file headers could not be parsed by FFprobe.");
            err.name = "CorruptMediaError";
            err.technicalDetails = probeErr.message || String(probeErr);
            throw err;
        }

        const hasVideo = streams.some(s => s.codec_type === 'video');
        if (!hasVideo) {
            const err = new Error("The selected file contains no playable video streams.");
            err.name = "NoVideoStreamError";
            throw err;
        }

        // 4. Determine routing and FFmpeg arguments
        const { args, strategy } = determineFfmpegArgs(streams, inputPath, outputPath);

        // 5. Build Job entity
        const job = {
            id: crypto.randomUUID(),
            inputPath,
            outputPath,
            streams,
            strategy,
            args,
            duration: streams.duration,
            fileSizeBytes: inputSizeBytes,
            state: 'pending', // 'pending' | 'active' | 'completed' | 'failed' | 'cancelled'
            progress: { percent: 0, fps: 0, speed: 'N/A', outTime: '00:00:00', frame: 0 },
            abortController: new AbortController(),
            options,
            createdAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
            error: null,
            result: null
        };

        this.pendingQueue.push(job);
        this.emit('job:enqueued', this._formatJob(job));

        // Attempt dispatch if worker slots available
        this._processNext();

        return this._formatJob(job);
    }

    /**
     * Processes next pending jobs up to the concurrency limit.
     * @private
     */
    async _processNext() {
        if (this.activeJobs.size >= this.concurrency) {
            return;
        }

        if (this.pendingQueue.length === 0) {
            return;
        }

        const job = this.pendingQueue.shift();
        job.state = 'active';
        job.startedAt = new Date().toISOString();
        this.activeJobs.set(job.id, job);

        this.emit('job:started', this._formatJob(job));

        try {
            const result = await executeFfmpeg({
                args: job.args,
                outputPath: job.outputPath,
                strategy: job.strategy,
                duration: job.duration,
                fileSizeBytes: job.fileSizeBytes,
                options: {
                    ...job.options,
                    signal: job.abortController.signal,
                    onProgress: (progress) => {
                        job.progress = progress;
                        this.emit('job:progress', {
                            jobId: job.id,
                            progress
                        });
                    }
                }
            });

            job.state = 'completed';
            job.finishedAt = new Date().toISOString();
            job.result = result;

            this._finishJob(job);
            this.emit('job:completed', this._formatJob(job));
        } catch (err) {
            job.state = job.abortController.signal.aborted ? 'cancelled' : 'failed';
            job.finishedAt = new Date().toISOString();
            job.error = err.message;

            this._finishJob(job);
            this.emit(job.state === 'cancelled' ? 'job:cancelled' : 'job:failed', this._formatJob(job));
        } finally {
            // Trigger next job in queue
            this._processNext();
        }
    }

    /**
     * Moves a job from active map to completed map, maintaining history bounds.
     * @private
     */
    _finishJob(job) {
        this.activeJobs.delete(job.id);
        this.completedJobs.set(job.id, job);

        // Enforce maxHistory capacity
        if (this.completedJobs.size > this.maxHistory) {
            const oldestKey = this.completedJobs.keys().next().value;
            this.completedJobs.delete(oldestKey);
        }
    }

    /**
     * Retrieves a job by ID from any state (active, pending, or completed).
     *
     * @param {string} jobId
     * @returns {Object|null}
     */
    getJob(jobId) {
        if (this.activeJobs.has(jobId)) {
            return this._formatJob(this.activeJobs.get(jobId));
        }

        const pending = this.pendingQueue.find(j => j.id === jobId);
        if (pending) {
            return this._formatJob(pending);
        }

        if (this.completedJobs.has(jobId)) {
            return this._formatJob(this.completedJobs.get(jobId));
        }

        return null;
    }

    /**
     * Cancels a job if it is pending or active.
     *
     * @param {string} jobId
     * @param {string} [reason='Cancelled by user']
     * @returns {boolean} True if job was found and cancelled
     */
    cancelJob(jobId, reason = 'Cancelled by user') {
        // 1. Check pending queue
        const pendingIdx = this.pendingQueue.findIndex(j => j.id === jobId);
        if (pendingIdx !== -1) {
            const [job] = this.pendingQueue.splice(pendingIdx, 1);
            job.state = 'cancelled';
            job.finishedAt = new Date().toISOString();
            job.error = reason;
            this._finishJob(job);
            this.emit('job:cancelled', this._formatJob(job));
            return true;
        }

        // 2. Check active jobs
        const active = this.activeJobs.get(jobId);
        if (active) {
            active.abortController.abort(reason);
            return true;
        }

        return false;
    }

    /**
     * Returns a snapshot of queue statistics.
     *
     * @returns {Object}
     */
    getStatus() {
        return {
            concurrency: this.concurrency,
            activeCount: this.activeJobs.size,
            pendingCount: this.pendingQueue.length,
            completedCount: this.completedJobs.size
        };
    }

    /**
     * Returns a public representation of the job without internal handles.
     * @private
     */
    _formatJob(job) {
        return {
            id: job.id,
            inputPath: job.inputPath,
            outputPath: job.outputPath,
            state: job.state,
            strategy: job.strategy,
            duration: job.duration,
            fileSizeBytes: job.fileSizeBytes,
            progress: job.progress,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            error: job.error,
            result: job.result
        };
    }
}
