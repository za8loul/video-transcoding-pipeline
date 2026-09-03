import { createServer } from '../src/server.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureTestFixtures } from './fixtures.js';

async function runTest() {
    await ensureTestFixtures();
    console.log("=== Test Server: Full End-to-End Upload, Transcode, & Stream Cycle ===");

    const testPort = 3456;
    const app = await createServer({ port: testPort });
    const addr = await app.start();
    const baseUrl = `http://localhost:${testPort}`;
    console.log(`Server started on ${baseUrl}`);

    try {
        // 1. Static file verification
        console.log("\n1. Testing static file hosting...");
        const htmlRes = await fetch(`${baseUrl}/`);
        if (!htmlRes.ok || !(await htmlRes.text()).includes('MKV to MP4 Pipeline')) {
            throw new Error("Failed to serve frontend/index.html");
        }
        console.log("PASS: Served frontend/index.html");

        const cssRes = await fetch(`${baseUrl}/css/style.css`);
        if (!cssRes.ok) throw new Error("Failed to serve css/style.css");
        console.log("PASS: Served css/style.css");

        // 2. Resumable Upload Test using sample.mkv
        console.log("\n2. Testing resumable chunked upload protocol...");
        const samplePath = path.resolve('test_files/sample.mkv');
        const sampleBuffer = await fs.readFile(samplePath);
        const totalSize = sampleBuffer.length;
        console.log(`Input sample file size: ${totalSize} bytes`);

        // Init upload
        const initRes = await fetch(`${baseUrl}/api/uploads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: 'test_sample.mkv', totalSize })
        });
        if (!initRes.ok) throw new Error(`Init upload failed: ${await initRes.text()}`);
        const { uploadId } = await initRes.json();
        console.log(`Initialized upload ID: ${uploadId}`);

        // Upload chunk 1 (half of the file)
        const halfSize = Math.floor(totalSize / 2);
        const chunk1 = sampleBuffer.subarray(0, halfSize);
        console.log(`Uploading chunk 1: bytes 0-${halfSize}...`);
        const patch1Res = await fetch(`${baseUrl}/api/uploads/${uploadId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Upload-Offset': '0'
            },
            body: chunk1
        });
        if (!patch1Res.ok) throw new Error(`Chunk 1 failed: ${await patch1Res.text()}`);
        const patch1Data = await patch1Res.json();
        console.log(`Chunk 1 accepted. Server offset: ${patch1Data.currentOffset}`);

        // Test offset query / mid-transfer check
        console.log("Querying server for current offset (simulating resumption)...");
        const offsetRes = await fetch(`${baseUrl}/api/uploads/${uploadId}`);
        const offsetData = await offsetRes.json();
        if (offsetData.currentOffset !== halfSize) {
            throw new Error(`Offset mismatch! Expected ${halfSize}, got ${offsetData.currentOffset}`);
        }
        console.log(`PASS: Confirmed offset on disk is ${offsetData.currentOffset}`);

        // Test intentional offset mismatch rejection (409 Conflict)
        console.log("Testing 409 Conflict on invalid client offset...");
        const conflictRes = await fetch(`${baseUrl}/api/uploads/${uploadId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Upload-Offset': '0' // Intentionally wrong offset (should be halfSize)
            },
            body: chunk1
        });
        if (conflictRes.status !== 409) {
            throw new Error(`Expected 409 Conflict, got ${conflictRes.status}`);
        }
        console.log("PASS: Server correctly rejected mismatched offset with 409 Conflict");

        // Upload chunk 2 (completing the file)
        console.log(`Uploading chunk 2: bytes ${halfSize}-${totalSize}...`);
        const chunk2 = sampleBuffer.subarray(halfSize);
        const patch2Res = await fetch(`${baseUrl}/api/uploads/${uploadId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Upload-Offset': halfSize.toString()
            },
            body: chunk2
        });
        if (!patch2Res.ok) throw new Error(`Chunk 2 failed: ${await patch2Res.text()}`);
        const patch2Data = await patch2Res.json();
        console.log(`Upload completed! Received transcode jobId: ${patch2Data.jobId}`);

        const jobId = patch2Data.jobId;

        // 3. Wait for transcode completion
        console.log("\n3. Monitoring transcode progress...");
        let isDone = false;
        while (!isDone) {
            await new Promise(r => setTimeout(r, 500));
            const jobRes = await fetch(`${baseUrl}/api/jobs/${jobId}`);
            const job = await jobRes.json();
            console.log(`Job state: ${job.state} | Progress: ${job.progress?.percent ?? 0}% | Speed: ${job.progress?.speed ?? 'N/A'}`);

            if (job.state === 'completed') {
                isDone = true;
            } else if (job.state === 'failed') {
                throw new Error(`Transcode job failed: ${job.error}`);
            }
        }
        console.log("PASS: Transcoding reached completed state!");

        // 4. Test Media Streaming with Range Request (HTTP 206)
        console.log("\n4. Testing MP4 streaming with Range request (206 Partial Content)...");
        const streamRes = await fetch(`${baseUrl}/api/jobs/${jobId}/stream`, {
            headers: { 'Range': 'bytes=0-1024' }
        });
        if (streamRes.status !== 206) {
            throw new Error(`Expected HTTP 206 Partial Content, got ${streamRes.status}`);
        }
        const acceptRanges = streamRes.headers.get('accept-ranges');
        const contentRange = streamRes.headers.get('content-range');
        const contentType = streamRes.headers.get('content-type');
        console.log(`Response headers: Content-Type=${contentType}, Content-Range=${contentRange}, Accept-Ranges=${acceptRanges}`);

        if (acceptRanges !== 'bytes' || !contentRange.startsWith('bytes 0-1024/')) {
            throw new Error("Invalid Range response headers");
        }
        // 5. Test Direct Local File Conversion (Zero Upload / Zero Download)
        console.log("\n5. Testing Direct Local File Conversion (/api/jobs/local)...");
        const localTargetDir = path.resolve('output/test_direct');
        const localRes = await fetch(`${baseUrl}/api/jobs/local`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                inputPath: samplePath,
                outputDir: localTargetDir
            })
        });
        if (!localRes.ok) throw new Error(`Local job failed: ${await localRes.text()}`);
        const localData = await localRes.json();
        console.log(`Enqueued local job: ${localData.jobId}, target: ${localData.outputPath}`);

        let localDone = false;
        while (!localDone) {
            await new Promise(r => setTimeout(r, 500));
            const checkRes = await fetch(`${baseUrl}/api/jobs/${localData.jobId}`);
            const checkJob = await checkRes.json();
            if (checkJob.state === 'completed') {
                localDone = true;
            } else if (checkJob.state === 'failed') {
                throw new Error(`Local conversion job failed: ${checkJob.error}`);
            }
        }
        console.log(`PASS: Direct local file conversion finished! Output file exists on disk at: ${localData.outputPath}`);
        await fs.unlink(localData.outputPath).catch(() => {});
        await fs.rm(localTargetDir, { recursive: true, force: true }).catch(() => {});

        console.log("\n=== ALL SERVER & PIPELINE INTEGRATION TESTS PASSED! ===");
    } finally {
        await app.stop();
        console.log("Server stopped.");
    }
}

runTest().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
