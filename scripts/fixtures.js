import fsp from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

/**
 * Ensures required test fixtures exist in test_files/.
 * If missing, generates synthetic lightweight samples via FFmpeg on the fly.
 */
export async function ensureTestFixtures() {
    const dir = path.resolve('test_files');
    await fsp.mkdir(dir, { recursive: true });

    // 1. Corrupt payload fixture
    const fakePath = path.join(dir, 'fake.mkv');
    try {
        await fsp.access(fakePath);
    } catch {
        await fsp.writeFile(fakePath, 'Corrupt fake MKV header invalid binary data 0123456789');
    }

    // 2. Small 2-second sample
    const samplePath = path.join(dir, 'sample.mkv');
    try {
        await fsp.access(samplePath);
    } catch {
        await execa('ffmpeg', [
            '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=24',
            '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-y', samplePath
        ]);
    }

    // 3. 720p sample for executor and watchdog tests
    const surfPath = path.join(dir, 'sample_1280x720_surfing_with_audio.mkv');
    try {
        await fsp.access(surfPath);
    } catch {
        await execa('ffmpeg', [
            '-f', 'lavfi', '-i', 'testsrc=duration=3:size=1280x720:rate=30',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-y', surfPath
        ]);
    }
}
