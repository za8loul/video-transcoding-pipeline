export class ResumableUploader {
    /**
     * @param {Object} options
     * @param {number} [options.chunkSize=5242880] - Default chunk size 5MB
     * @param {Function} [options.onProgress] - ({ percent, uploadedBytes, totalBytes, speedMBs }) => {}
     * @param {Function} [options.onComplete] - ({ jobId }) => {}
     * @param {Function} [options.onError] - (err) => {}
     */
    constructor(options = {}) {
        this.chunkSize = options.chunkSize ?? (5 * 1024 * 1024); // 5 MB chunks
        this.outputDir = options.outputDir ?? null;
        this.onProgress = options.onProgress ?? (() => {});
        this.onComplete = options.onComplete ?? (() => {});
        this.onError = options.onError ?? (() => {});
        this.abortController = null;
        this.uploadId = null;
        this.isAborted = false;
    }

    /**
     * Starts or resumes uploading a file.
     *
     * @param {File} file
     */
    async upload(file) {
        this.isAborted = false;
        this.abortController = new AbortController();

        try {
            // 1. Initialize upload session on server
            const initRes = await fetch('/api/uploads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename: file.name,
                    totalSize: file.size,
                    outputDir: this.outputDir
                }),
                signal: this.abortController.signal
            });

            if (!initRes.ok) {
                const errData = await initRes.json().catch(() => ({}));
                throw new Error(errData.error || `Initialization failed with status ${initRes.status}`);
            }

            const { uploadId } = await initRes.json();
            this.uploadId = uploadId;

            let offset = 0;
            let lastTime = Date.now();
            let lastBytes = 0;

            // 2. Loop through file chunks
            while (offset < file.size && !this.isAborted) {
                const chunkEnd = Math.min(file.size, offset + this.chunkSize);
                const chunk = file.slice(offset, chunkEnd);

                const chunkStartTime = Date.now();
                const patchRes = await this._sendChunkWithRetry(uploadId, chunk, offset);

                if (this.isAborted) break;

                const data = await patchRes.json();
                offset = data.currentOffset;

                // Compute instantaneous speed
                const timeDiffSec = Math.max(0.1, (Date.now() - chunkStartTime) / 1000);
                const speedMBs = ((chunk.size / (1024 * 1024)) / timeDiffSec).toFixed(1);

                const percent = Math.min(100, (offset / file.size) * 100);
                this.onProgress({
                    percent: parseFloat(percent.toFixed(1)),
                    uploadedBytes: offset,
                    totalBytes: file.size,
                    speedMBs
                });

                if (data.status === 'completed' && data.jobId) {
                    this.onComplete({ jobId: data.jobId });
                    return;
                }
            }
        } catch (err) {
            if (!this.isAborted) {
                this.onError(err);
            }
        }
    }

    /**
     * Sends a chunk, automatically handling offset realignment or retries on network drops.
     * @private
     */
    async _sendChunkWithRetry(uploadId, chunk, offset, retries = 3) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (this.isAborted) throw new Error("Upload aborted");

            try {
                const res = await fetch(`/api/uploads/${uploadId}`, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'Upload-Offset': offset.toString()
                    },
                    body: chunk,
                    signal: this.abortController.signal
                });

                if (res.status === 409) {
                    // Offset mismatch: server disk offset differs from client offset
                    const conflictData = await res.json();
                    offset = conflictData.actualOffset;
                    continue;
                }

                if (!res.ok) {
                    throw new Error(`Server returned HTTP ${res.status}`);
                }

                return res;
            } catch (err) {
                if (this.isAborted) throw err;
                if (attempt === retries) throw err;

                // Network glitch — query server for true disk offset and wait before retrying
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                try {
                    const checkRes = await fetch(`/api/uploads/${uploadId}`);
                    if (checkRes.ok) {
                        const checkData = await checkRes.json();
                        offset = checkData.currentOffset;
                    }
                } catch {
                    // Ignore query failure, will retry next loop
                }
            }
        }
    }

    /**
     * Aborts the ongoing upload.
     */
    cancel() {
        this.isAborted = true;
        if (this.abortController) {
            this.abortController.abort();
        }
    }
}
