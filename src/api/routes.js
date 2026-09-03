import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execa } from 'execa';
import { openFileDialog, openFolderDialog } from '../utils/dialog.js';

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4'
};

export function createRouter({ uploadManager, queue, sseBroker, frontendDir, convertedDir }) {
    return async function handleRequest(req, res) {
        // Set basic CORS headers for local/testing access
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Upload-Offset');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = url.pathname;

        try {
            // === API Routes ===
            if (pathname.startsWith('/api/')) {
                // 1. POST /api/uploads (Initialize Upload)
                if (req.method === 'POST' && pathname === '/api/uploads') {
                    const body = await readJsonBody(req);
                    const session = await uploadManager.initUpload({
                        filename: body.filename,
                        totalSize: Number(body.totalSize),
                        outputDir: body.outputDir || null
                    });
                    sendJson(res, 201, session);
                    return;
                }

                // 2. GET /api/uploads/:id (Check Upload Offset / Resumption)
                const uploadMatch = pathname.match(/^\/api\/uploads\/([a-zA-Z0-9_-]+)$/);
                if (uploadMatch) {
                    const uploadId = uploadMatch[1];
                    if (req.method === 'GET') {
                        const offsetInfo = await uploadManager.getUploadOffset(uploadId);
                        sendJson(res, 200, offsetInfo);
                        return;
                    }

                    // 3. PATCH /api/uploads/:id (Append Chunk Directly to Disk)
                    if (req.method === 'PATCH') {
                        const offsetHeader = req.headers['upload-offset'];
                        if (offsetHeader === undefined) {
                            sendJson(res, 400, { error: "Missing Upload-Offset header" });
                            return;
                        }

                        const clientOffset = Number(offsetHeader);
                        try {
                            const { currentOffset, isComplete, session } = await uploadManager.appendChunk(
                                uploadId,
                                req,
                                clientOffset
                            );

                            if (isComplete) {
                                // Write directly to custom outputDir or default convertedDir
                                const targetDir = session.outputDir ? path.resolve(session.outputDir) : convertedDir;
                                await fsp.mkdir(targetDir, { recursive: true });

                                const outputFilename = `${path.basename(session.diskFilename, path.extname(session.diskFilename))}.mp4`;
                                const outputPath = path.join(targetDir, outputFilename);

                                const job = await queue.addJob({
                                    inputPath: session.filePath,
                                    outputPath
                                });

                                sendJson(res, 200, {
                                    status: 'completed',
                                    currentOffset,
                                    jobId: job.id,
                                    outputPath
                                });
                            } else {
                                sendJson(res, 200, {
                                    status: 'uploading',
                                    currentOffset
                                });
                            }
                        } catch (err) {
                            if (err.code === 'OFFSET_MISMATCH') {
                                sendJson(res, 409, {
                                    error: err.message,
                                    actualOffset: err.actualOffset
                                });
                            } else {
                                throw err;
                            }
                        }
                        return;
                    }
                }

                // 4. POST /api/jobs/local (Direct In-Place / Local File Conversion - Zero Upload/Download)
                if (req.method === 'POST' && pathname === '/api/jobs/local') {
                    const body = await readJsonBody(req);
                    if (!body.inputPath) {
                        sendJson(res, 400, { error: "Missing inputPath parameter" });
                        return;
                    }

                    const cleanInput = body.inputPath.replace(/^["']+|["']+$/g, '').trim();
                    const inputPath = path.resolve(cleanInput);
                    try {
                        await fsp.access(inputPath);
                    } catch {
                        sendJson(res, 404, { error: `Input file not found at: ${inputPath}` });
                        return;
                    }

                    const rawOutputDir = body.outputDir || convertedDir;
                    const cleanOutputDir = rawOutputDir.replace(/^["']+|["']+$/g, '').trim();
                    const targetDir = path.resolve(cleanOutputDir);
                    await fsp.mkdir(targetDir, { recursive: true });

                    const baseName = path.basename(inputPath, path.extname(inputPath));
                    const outputFilename = `${baseName}.mp4`;
                    const outputPath = path.join(targetDir, outputFilename);

                    try {
                        const job = await queue.addJob({ inputPath, outputPath });
                        sendJson(res, 201, {
                            jobId: job.id,
                            inputPath,
                            outputPath,
                            job
                        });
                    } catch (jobErr) {
                        sendJson(res, 400, {
                            error: jobErr.message,
                            name: jobErr.name || 'JobError',
                            details: jobErr.technicalDetails || null
                        });
                    }
                    return;
                }

                // 5. POST /api/dialog/pick-file (Open native Windows File Picker)
                if (req.method === 'POST' && pathname === '/api/dialog/pick-file') {
                    try {
                        const selectedPath = await openFileDialog();
                        sendJson(res, 200, { path: selectedPath });
                    } catch (err) {
                        sendJson(res, 500, { error: err.message });
                    }
                    return;
                }

                // 6. POST /api/dialog/pick-folder (Open native Windows Folder Picker)
                if (req.method === 'POST' && pathname === '/api/dialog/pick-folder') {
                    try {
                        const selectedPath = await openFolderDialog();
                        sendJson(res, 200, { path: selectedPath });
                    } catch (err) {
                        sendJson(res, 500, { error: err.message });
                    }
                    return;
                }

                // 7. GET /api/jobs/:id (Get Job Status)
                const jobMatch = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]+)$/);
                if (jobMatch && req.method === 'GET') {
                    const jobId = jobMatch[1];
                    const job = queue.getJob(jobId);
                    if (!job) {
                        sendJson(res, 404, { error: "Job not found" });
                        return;
                    }
                    sendJson(res, 200, job);
                    return;
                }

                // 6. POST /api/jobs/:id/reveal (Open in File Explorer)
                const revealMatch = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]+)\/reveal$/);
                if (revealMatch && req.method === 'POST') {
                    const jobId = revealMatch[1];
                    const job = queue.getJob(jobId);
                    if (!job || !job.outputPath) {
                        sendJson(res, 404, { error: "Job output path not found" });
                        return;
                    }

                    const rawPath = job.outputPath.replace(/^["']+|["']+$/g, '').trim();
                    const fullPath = path.resolve(rawPath);
                    const winPath = fullPath.replace(/\//g, '\\');
                    const folderPath = path.dirname(fullPath).replace(/\//g, '\\');

                    try {
                        if (process.platform === 'win32') {
                            const fileExists = fs.existsSync(fullPath);
                            if (fileExists) {
                                await execa('powershell', [
                                    '-NoProfile',
                                    '-Command',
                                    `Start-Process explorer.exe -ArgumentList '/select,"${winPath}"'`
                                ], { timeout: 5000 }).catch(async () => {
                                    const cp = spawn('explorer.exe', [folderPath], { detached: true, stdio: 'ignore' });
                                    cp.unref();
                                });
                            } else {
                                const cp = spawn('explorer.exe', [folderPath], { detached: true, stdio: 'ignore' });
                                cp.unref();
                            }
                        } else if (process.platform === 'darwin') {
                            await execa('open', ['-R', fullPath]);
                        } else {
                            await execa('xdg-open', [folderPath]);
                        }
                        sendJson(res, 200, { success: true, path: fullPath });
                    } catch (revealErr) {
                        sendJson(res, 500, { error: `Failed to open folder: ${revealErr.message}` });
                    }
                    return;
                }

                // 7. GET /api/jobs/:id/events (Server-Sent Events)
                const jobEventsMatch = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]+)\/events$/);
                if (jobEventsMatch && req.method === 'GET') {
                    const jobId = jobEventsMatch[1];
                    sseBroker.addClient(jobId, res);
                    return;
                }

                // 8. DELETE /api/jobs/:id (Cancel Job)
                if (jobMatch && req.method === 'DELETE') {
                    const jobId = jobMatch[1];
                    const cancelled = queue.cancelJob(jobId, 'Cancelled via API');
                    sendJson(res, 200, { success: cancelled });
                    return;
                }

                // 9. GET /api/jobs/:id/stream (Stream Output MP4 with Range Support)
                const streamMatch = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]+)\/stream$/);
                if (streamMatch && req.method === 'GET') {
                    const jobId = streamMatch[1];
                    const job = queue.getJob(jobId);
                    if (!job || job.state !== 'completed') {
                        sendJson(res, 404, { error: "Job output is not ready or not found" });
                        return;
                    }

                    await serveMediaStream(req, res, job.outputPath);
                    return;
                }

                // Fallback for unknown API route
                sendJson(res, 404, { error: "API endpoint not found" });
                return;
            }

            // === Static Frontend Serving ===
            await serveStatic(req, res, frontendDir, pathname);
        } catch (err) {
            console.error(`HTTP Error [${req.method} ${pathname}]:`, err);
            sendJson(res, err.code === 'ENOSPC' ? 507 : 500, {
                error: err.message,
                code: err.code || 'INTERNAL_ERROR'
            });
        }
    };
}

/**
 * Serves media files with HTTP 206 Partial Content (Range requests)
 */
async function serveMediaStream(req, res, filePath) {
    const stats = await fsp.stat(filePath);
    const fileSize = stats.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (start >= fileSize || end >= fileSize || start > end) {
            res.writeHead(416, {
                'Content-Range': `bytes */${fileSize}`
            });
            res.end();
            return;
        }

        const chunksize = (end - start) + 1;
        const fileStream = fs.createReadStream(filePath, { start, end });

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4'
        });

        fileStream.pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes'
        });
        fs.createReadStream(filePath).pipe(res);
    }
}

/**
 * Serves static files from the frontend directory.
 */
async function serveStatic(req, res, frontendDir, pathname) {
    let relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    let safePath = path.normalize(path.join(frontendDir, relativePath));

    if (!safePath.startsWith(frontendDir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    try {
        let stat = await fsp.stat(safePath);
        if (stat.isDirectory()) {
            safePath = path.join(safePath, 'index.html');
            stat = await fsp.stat(safePath);
        }

        const ext = path.extname(safePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stat.size
        });

        fs.createReadStream(safePath).pipe(res);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end("404 Not Found");
    }
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

async function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 1e6) { // 1 MB limit for metadata
                reject(new Error("Request body too large"));
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error("Malformed JSON"));
            }
        });
        req.on('error', reject);
    });
}
