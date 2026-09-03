import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { UploadManager } from './upload/resumable.js';
import { TranscodeQueue } from './queue/queue.js';
import { SseBroker } from './api/sse.js';
import { createRouter } from './api/routes.js';

export async function createServer(options = {}) {
    const port = options.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 3000);
    const host = options.host ?? '0.0.0.0';

    const baseDir = path.resolve(options.baseDir ?? '.');
    const scratchDir = path.join(baseDir, 'tmp/uploads');
    const convertedDir = path.join(baseDir, 'output');
    const frontendDir = path.join(baseDir, 'frontend');

    // Ensure required storage directories exist
    await fsp.mkdir(scratchDir, { recursive: true });
    await fsp.mkdir(convertedDir, { recursive: true });

    const uploadManager = new UploadManager({ scratchDir });
    await uploadManager.init();

    const queue = new TranscodeQueue({
        concurrency: options.concurrency ?? 1
    });

    const sseBroker = new SseBroker();

    // Hook queue events into SSE broker for real-time client updates
    queue.on('job:progress', ({ jobId, progress }) => {
        sseBroker.broadcast(jobId, 'progress', progress);
    });

    queue.on('job:completed', (job) => {
        sseBroker.broadcast(job.id, 'completed', job);
    });

    queue.on('job:failed', (job) => {
        sseBroker.broadcast(job.id, 'failed', job);
    });

    queue.on('job:cancelled', (job) => {
        sseBroker.broadcast(job.id, 'cancelled', job);
    });

    const router = createRouter({
        uploadManager,
        queue,
        sseBroker,
        frontendDir,
        convertedDir
    });

    const server = http.createServer(router);

    return {
        server,
        queue,
        uploadManager,
        start() {
            return new Promise((resolve) => {
                server.listen(port, host, () => {
                    console.log(`Server listening on http://localhost:${port}`);
                    resolve(server.address());
                });
            });
        },
        stop() {
            return new Promise((resolve, reject) => {
                server.close((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }
    };
}

// Auto-run if executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))) {
    const app = await createServer();
    await app.start();
}
