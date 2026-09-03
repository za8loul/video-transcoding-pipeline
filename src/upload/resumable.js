import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { calculateRequiredScratchSpace, assertDiskSpaceAvailable } from '../storage/disk.js';

export class UploadManager {
    /**
     * @param {Object} options
     * @param {string} options.scratchDir - Directory to store in-progress and completed uploads
     */
    constructor(options = {}) {
        this.scratchDir = path.resolve(options.scratchDir ?? 'tmp/uploads');
        this.uploads = new Map();
    }

    /**
     * Ensures scratch directories exist.
     */
    async init() {
        await fsp.mkdir(this.scratchDir, { recursive: true });
    }

    /**
     * Initializes a new resumable upload session.
     * Enforces pre-flight storage assertions before allocating space.
     *
     * @param {Object} params
     * @param {string} params.filename - Original file name
     * @param {number} params.totalSize - Expected file size in bytes
     * @param {string} [params.outputDir] - Custom target output directory
     * @returns {Promise<Object>} Upload session info
     */
    async initUpload({ filename, totalSize, outputDir = null }) {
        if (!filename || typeof filename !== 'string') {
            throw new Error("Invalid filename provided");
        }
        if (!totalSize || totalSize <= 0) {
            throw new Error("Invalid total file size");
        }

        // 1. Pre-Flight Storage Check Gate (DESIGN.md §2 & §3)
        const requiredScratch = calculateRequiredScratchSpace(totalSize);
        await assertDiskSpaceAvailable(this.scratchDir, requiredScratch);

        const uploadId = crypto.randomUUID();
        const ext = path.extname(filename) || '.mkv';
        const sanitizedBase = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
        const diskFilename = `${sanitizedBase}_${uploadId}${ext}`;
        const filePath = path.join(this.scratchDir, diskFilename);

        // 2. Touch the file to ensure write permissions and initialize with 0 bytes
        await fsp.writeFile(filePath, Buffer.alloc(0));

        const session = {
            id: uploadId,
            originalFilename: filename,
            diskFilename,
            filePath,
            totalSize,
            outputDir,
            createdAt: new Date().toISOString(),
            status: 'uploading' // 'uploading' | 'completed' | 'aborted'
        };

        this.uploads.set(uploadId, session);

        return {
            uploadId,
            filename,
            totalSize,
            currentOffset: 0
        };
    }

    /**
     * Gets the current verified byte offset on disk for an upload.
     * Used by client to resume after a network interruption.
     *
     * @param {string} uploadId
     * @returns {Promise<{ uploadId: string, currentOffset: number, totalSize: number, status: string }>}
     */
    async getUploadOffset(uploadId) {
        const session = this.uploads.get(uploadId);
        if (!session) {
            throw new Error(`Upload ${uploadId} not found`);
        }

        const stat = await fsp.stat(session.filePath);
        return {
            uploadId,
            currentOffset: stat.size,
            totalSize: session.totalSize,
            status: session.status
        };
    }

    /**
     * Appends a chunk stream directly to the target file on disk.
     * Prevents OOM by streaming directly to disk without memory buffering.
     *
     * @param {string} uploadId
     * @param {import('node:stream').Readable} chunkStream - Incoming HTTP request or readable stream
     * @param {number} clientOffset - Byte offset client claims to be writing at
     * @returns {Promise<{ currentOffset: number, isComplete: boolean, session: Object }>}
     */
    async appendChunk(uploadId, chunkStream, clientOffset) {
        const session = this.uploads.get(uploadId);
        if (!session) {
            throw new Error(`Upload ${uploadId} not found`);
        }

        // 1. Verify byte offset matches disk exactly (DESIGN.md §3 Mid-Transfer Drop)
        const stat = await fsp.stat(session.filePath);
        const actualDiskOffset = stat.size;

        if (clientOffset !== actualDiskOffset) {
            const err = new Error(`Offset mismatch: client expected ${clientOffset}, but disk offset is ${actualDiskOffset}`);
            err.code = 'OFFSET_MISMATCH';
            err.actualOffset = actualDiskOffset;
            throw err;
        }

        // 2. Stream chunk directly to disk via append mode (flags: 'a')
        await new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(session.filePath, { flags: 'a' });

            chunkStream.pipe(writeStream);

            writeStream.on('finish', resolve);
            writeStream.on('error', (err) => {
                writeStream.destroy();
                reject(err);
            });
            chunkStream.on('error', (err) => {
                writeStream.destroy();
                reject(err);
            });
        });

        // 3. Check updated size
        const updatedStat = await fsp.stat(session.filePath);
        const currentOffset = updatedStat.size;
        const isComplete = currentOffset >= session.totalSize;

        if (isComplete) {
            session.status = 'completed';
        }

        return {
            currentOffset,
            isComplete,
            session
        };
    }

    /**
     * Cleans up an aborted or failed upload.
     *
     * @param {string} uploadId
     */
    async cleanupUpload(uploadId) {
        const session = this.uploads.get(uploadId);
        if (!session) return;

        try {
            await fsp.unlink(session.filePath);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error(`Failed to unlink upload file ${session.filePath}:`, err);
            }
        }

        this.uploads.delete(uploadId);
    }
}
