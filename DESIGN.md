# System Design Document: Large-File MKV to MP4 Transcoding Pipeline

## 1. Scope and Codec Matrix

The system converts video files wrapped in an **MKV (Matroska)** container into a streaming-compatible **MP4 (MPEG-4 Part 14)** container. To balance performance with hardware compatibility, the pipeline distinguishes between **remuxing** (container swap) and **transcoding** (re-encoding).

### Supported Input Specs
*   **Container:** `.mkv`
*   **Video Codecs:** 
    *   H.264 / AVC (Advanced Video Coding)
    *   H.265 / HEVC (High Efficiency Video Coding)
*   **Audio Codecs:** 
    *   AAC (Advanced Audio Coding)
    *   AC-3 / E-AC-3 (Dolby Digital / Dolby Digital Plus)
    *   DTS (Digital Theater Systems)

### Target Output Spec
*   **Container:** `.mp4`
*   **Video Codec:** Passthrough (copy) if H.264/H.265; transcode to H.264 (`libx264`) if incompatible.
*   **Audio Codec:** AAC (`aac`, stereo/5.1 downmix) or AC-3 passthrough for hardware compatibility.
*   **Faststart:** Enabled (`-movflags +faststart`) to move the `moov` atom to the beginning of the file for immediate web/TV playback.

### Execution Strategy
*   **Fast Path (Remuxing):** If input is `H.264 + AAC/AC3`, execute direct stream copy (`-c copy`). Target duration: < 30 seconds for a 25GB file (I/O bound).
*   **Slow Path (Audio Transcode):** If input is `H.264/H.265 + DTS`, copy video stream (`-c:v copy`) and re-encode audio to AAC (`-c:a aac`). Target duration: 1–3 minutes.
*   **Full Transcode:** Fallback only when video codec is unsupported by target screens.

---

## 2. File Size Ceiling & Storage Bounds

*   **Maximum File Size:** **30 GB**
*   **Justification:** High-bitrate 4K UHD Remuxes and 1080p bluray rips commonly range between 15 GB and 25 GB. A 30 GB ceiling accommodates the 99th percentile of target media files while leaving necessary overhead for metadata and temporary chunks.
*   **Disk Overhead Multiplier:** **2.5x**
    *   Each 30 GB file requires at least 75 GB of temporary scratch space during processing (30 GB source + 30 GB target + 15 GB working buffer/chunks).

---

## 3. Failure Modes & Edge Cases

| Failure Mode | Root Cause | System-Level Impact | Mitigation Strategy |
| :--- | :--- | :--- | :--- |
| **Mid-Transfer Drop** | Network disconnect or timeout at high byte offsets (e.g., 22 GB / 25 GB). | Incomplete file left on disk; wasted bandwidth if restarted from byte 0. | Implement chunked, resumable uploads (tus protocol pattern). |
| **Invalid/Corrupted Payload** | Non-video binary uploaded with `.mkv` extension or broken bitstream. | FFmpeg crashes, hangs indefinitely, or spawns a zombie child process. | Run pre-execution validation via `ffprobe` JSON stream check before queuing. |
| **Process Hang / Deadlock** | Broken video frames cause FFmpeg to stall waiting for I/O on `stderr`/`stdout`. | Worker process blocked indefinitely; job queue starves. | Implement hard timeout wrappers and process kill signals (`SIGKILL`) on workers. |
| **Disk Exhaustion (ENOSPC)** | Multiple concurrent 25 GB conversions exhaust local storage. | OS crashes or fails write operations across all active jobs. | Enforce strict concurrency limits (max 1–2 active jobs) and a disk-space check gate before accepting jobs. |
| **Out-Of-Memory (OOM)** | Server buffers entire stream or large chunks into Node.js heap. | Node.js process crashes (`JavaScript heap out of memory`). | Enforce strict stream piping (`fs.createReadStream` / `createWriteStream`) without buffering in RAM. |