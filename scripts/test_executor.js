import path from 'node:path';
import fs from 'node:fs/promises';
import { probeFile } from '../src/ffmpeg/probe.js';
import { determineFfmpegArgs } from '../src/ffmpeg/routing.js';
import { executeFfmpeg } from '../src/ffmpeg/executor.js';

async function runTests() {
    console.log("=== Test 1: Successful Conversion with Progress Reporting ===");
    const inputPath = path.resolve('test_files/sample_1280x720_surfing_with_audio.mkv');
    const outputPath = path.resolve('test_files/surfing_test_output.mp4');

    // 1. Probe input
    const streams = await probeFile(inputPath);
    console.log(`Probed file: duration=${streams.duration}s, size=${streams.size} bytes, streams=${streams.length}`);

    // 2. Determine args
    const { args, strategy } = determineFfmpegArgs(streams, inputPath, outputPath);
    console.log(`Determined strategy:`, strategy);

    // 3. Execute with progress logging
    let progressCount = 0;
    const result = await executeFfmpeg({
        args,
        outputPath,
        strategy,
        duration: streams.duration,
        fileSizeBytes: streams.size,
        options: {
            onProgress: (p) => {
                progressCount++;
                if (progressCount % 5 === 0 || p.isEnd) {
                    console.log(`Progress: ${p.percent}% | fps: ${p.fps} | speed: ${p.speed} | outTime: ${p.outTime}`);
                }
            }
        }
    });

    console.log(`Conversion succeeded! Output size: ${result.sizeBytes} bytes, streams: ${result.streams.length}`);

    // Clean up successful test output
    await fs.unlink(outputPath);
    console.log(`Cleaned up ${outputPath}`);

    console.log("\n=== Test 2: Timeout / Stall Abort and Partial File Cleanup ===");
    const failOutputPath = path.resolve('test_files/stall_test_output.mp4');
    
    try {
        // Force an immediate stall timeout of 500ms to verify abortion and cleanup
        await executeFfmpeg({
            args,
            outputPath: failOutputPath,
            strategy,
            duration: streams.duration,
            fileSizeBytes: streams.size,
            options: {
                stallTimeoutMs: 10, // Will immediately trigger
                maxCeilingMs: 50
            }
        });
        console.error("Test 2 FAILED: Expected timeout error was not thrown");
        process.exit(1);
    } catch (err) {
        console.log(`Caught expected error: ${err.message}`);
        
        // Verify partial file was cleaned up
        try {
            await fs.stat(failOutputPath);
            console.error(`Test 2 FAILED: Partial file was NOT deleted!`);
            process.exit(1);
        } catch (statErr) {
            if (statErr.code === 'ENOENT') {
                console.log(`SUCCESS: Partial output file ${failOutputPath} was cleanly deleted!`);
            } else {
                throw statErr;
            }
        }
    }

    console.log("\nAll executor tests passed successfully!");
}

runTests().catch((err) => {
    console.error("Test runner failed:", err);
    process.exit(1);
});
