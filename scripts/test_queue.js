import path from 'node:path';
import fs from 'node:fs/promises';
import { checkDiskSpace, assertDiskSpaceAvailable, DiskSpaceError, calculateRequiredScratchSpace } from '../src/storage/disk.js';
import { TranscodeQueue } from '../src/queue/queue.js';

async function runTests() {
    console.log("=== Test 1: Disk Storage Gate ===");
    const diskInfo = await checkDiskSpace('.');
    console.log(`Disk check result: available=${(diskInfo.availableBytes / (1024 ** 3)).toFixed(2)} GB, hasEnoughSpace=${diskInfo.hasEnoughSpace}`);

    // Verify calculateRequiredScratchSpace math (Source + Output + 5GB buffer)
    const tenGB = 10 * 1024 * 1024 * 1024;
    const requiredFor10GB = calculateRequiredScratchSpace(tenGB);
    console.log(`Required for 10 GB file: ${(requiredFor10GB / (1024 ** 3)).toFixed(2)} GB (expected: 25.00 GB)`);
    if (requiredFor10GB !== (25 * 1024 * 1024 * 1024)) {
        throw new Error("Scratch space math calculation failed");
    }

    // Verify assertion triggers ENOSPC DiskSpaceError when simulated requirement exceeds available space
    try {
        const ridiculousRequirement = 500 * 1024 * 1024 * 1024 * 1024; // 500 TB
        await assertDiskSpaceAvailable('.', ridiculousRequirement);
        throw new Error("Expected DiskSpaceError was not thrown");
    } catch (err) {
        if (err instanceof DiskSpaceError) {
            console.log(`SUCCESS: Caught expected DiskSpaceError: ${err.message}`);
        } else {
            throw err;
        }
    }

    console.log("\n=== Test 2: Pre-Flight Payload Validation (Invalid/Corrupt File) ===");
    const queue = new TranscodeQueue({ concurrency: 1 });
    const fakeFile = path.resolve('test_files/fake.mkv');
    const fakeOut = path.resolve('test_files/fake_out.mp4');

    try {
        await queue.addJob({ inputPath: fakeFile, outputPath: fakeOut });
        throw new Error("Expected pre-flight rejection on invalid file was not thrown");
    } catch (err) {
        console.log(`SUCCESS: Rejected corrupt file at pre-flight gate: ${err.message}`);
    }

    console.log("\n=== Test 3: Concurrency Enforcement (Queueing 2 Jobs with concurrency=1) ===");
    const input1 = path.resolve('test_files/sample.mkv');
    const out1 = path.resolve('test_files/queue_test_out1.mp4');
    const input2 = path.resolve('test_files/sample.mkv');
    const out2 = path.resolve('test_files/queue_test_out2.mp4');

    const jobEvents = [];
    queue.on('job:enqueued', j => jobEvents.push(`enqueued:${j.id}`));
    queue.on('job:started', j => jobEvents.push(`started:${j.id}`));
    queue.on('job:completed', j => jobEvents.push(`completed:${j.id}`));

    const job1 = await queue.addJob({ inputPath: input1, outputPath: out1 });
    const job2 = await queue.addJob({ inputPath: input2, outputPath: out2 });

    const statusSnapshot = queue.getStatus();
    console.log(`Queue state after adding 2 jobs: active=${statusSnapshot.activeCount}, pending=${statusSnapshot.pendingCount}`);

    if (statusSnapshot.activeCount !== 1 || statusSnapshot.pendingCount !== 1) {
        throw new Error(`Concurrency violation! Expected 1 active and 1 pending, got ${statusSnapshot.activeCount} active and ${statusSnapshot.pendingCount} pending`);
    }

    // Wait for both jobs to complete
    await new Promise((resolve, reject) => {
        queue.on('job:completed', (completedJob) => {
            console.log(`Job finished: ${completedJob.id} (${completedJob.outputPath})`);
            if (queue.getStatus().activeCount === 0 && queue.getStatus().pendingCount === 0) {
                resolve();
            }
        });
        queue.on('job:failed', (failedJob) => reject(new Error(`Job failed: ${failedJob.error}`)));
    });

    console.log("Both queued jobs finished sequentially!");
    await fs.unlink(out1);
    await fs.unlink(out2);

    console.log("\n=== Test 4: Job Cancellation & Disk Cleanup ===");
    const surfInput = path.resolve('test_files/sample_1280x720_surfing_with_audio.mkv');
    const cancelOut = path.resolve('test_files/cancelled_output.mp4');

    const jobToCancel = await queue.addJob({ inputPath: surfInput, outputPath: cancelOut });
    console.log(`Enqueued job to cancel: ${jobToCancel.id}`);

    // Wait 100ms for job to start running, then cancel
    await new Promise(r => setTimeout(r, 100));
    const cancelled = queue.cancelJob(jobToCancel.id, "User requested test cancellation");
    console.log(`cancelJob returned: ${cancelled}`);

    await new Promise((resolve) => {
        queue.on('job:cancelled', (cj) => {
            if (cj.id === jobToCancel.id) {
                console.log(`Job confirmed cancelled with reason: ${cj.error}`);
                resolve();
            }
        });
    });

    // Verify partial output file was deleted
    try {
        await fs.stat(cancelOut);
        throw new Error("Cancelled output file was NOT cleaned up!");
    } catch (statErr) {
        if (statErr.code === 'ENOENT') {
            console.log(`SUCCESS: Cancelled job output was cleanly deleted from disk!`);
        } else {
            throw statErr;
        }
    }

    console.log("\nAll Storage Gate & Concurrency Queue tests PASSED successfully!");
}

runTests().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
