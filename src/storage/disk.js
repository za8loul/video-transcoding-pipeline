import fs from 'node:fs/promises';
import path from 'node:path';

export const FIVE_GB = 5 * 1024 * 1024 * 1024;
export const THIRTY_GB = 30 * 1024 * 1024 * 1024;
export const DEFAULT_REQUIRED_SCRATCH_SPACE = 65 * 1024 * 1024 * 1024; // ~65 GB (DESIGN.md §2)

export class DiskSpaceError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'DiskSpaceError';
        this.code = 'ENOSPC';
        this.details = details;
    }
}

/**
 * Calculates projected scratch disk space required for a job based on input file size.
 * Formula from DESIGN.md §2:
 * Source file (up to 30GB) + Output file (up to 30GB) + 5GB safety buffer.
 *
 * @param {number|null} [inputSizeBytes]
 * @returns {number} Required bytes
 */
export function calculateRequiredScratchSpace(inputSizeBytes = null) {
    if (!inputSizeBytes || inputSizeBytes <= 0) {
        return DEFAULT_REQUIRED_SCRATCH_SPACE;
    }

    const sourceSize = Math.min(inputSizeBytes, THIRTY_GB);
    const projectedOutput = sourceSize; // worst case remux is ~= source size
    return sourceSize + projectedOutput + FIVE_GB;
}

/**
 * Checks available free disk space on the partition hosting targetPath.
 *
 * @param {string} targetPath - Path to file or directory
 * @param {number} requiredBytes - Bytes needed
 * @returns {Promise<{ hasEnoughSpace: boolean, availableBytes: number, requiredBytes: number }>}
 */
export async function checkDiskSpace(targetPath, requiredBytes = DEFAULT_REQUIRED_SCRATCH_SPACE) {
    const dir = path.dirname(path.resolve(targetPath));

    try {
        const stats = await fs.statfs(dir);
        const availableBytes = Number(stats.bavail) * Number(stats.bsize);
        const hasEnoughSpace = availableBytes >= requiredBytes;

        return {
            hasEnoughSpace,
            availableBytes,
            requiredBytes
        };
    } catch (err) {
        throw new Error(`Failed to check disk space at ${dir}: ${err.message}`);
    }
}

/**
 * Asserts that sufficient disk space is available, throwing DiskSpaceError if not.
 *
 * @param {string} targetPath - Path to file or directory
 * @param {number} requiredBytes - Bytes needed
 * @throws {DiskSpaceError} If free space < requiredBytes
 */
export async function assertDiskSpaceAvailable(targetPath, requiredBytes = DEFAULT_REQUIRED_SCRATCH_SPACE) {
    const { hasEnoughSpace, availableBytes } = await checkDiskSpace(targetPath, requiredBytes);

    if (!hasEnoughSpace) {
        const availGB = (availableBytes / (1024 ** 3)).toFixed(2);
        const reqGB = (requiredBytes / (1024 ** 3)).toFixed(2);
        throw new DiskSpaceError(
            `Insufficient scratch disk space: ${availGB} GB available, but ${reqGB} GB required to safely convert without ENOSPC.`,
            { availableBytes, requiredBytes }
        );
    }
}
