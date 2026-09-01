# System Design Document: Large-File MKV to MP4 Transcoding Pipeline

## 0. Scale Assumption

This system is designed for **personal / low-traffic use** (myself and one other user), not a public multi-tenant service. This assumption directly drives several decisions below — low concurrency limits, no per-user quota system, single-server storage. If this were rebuilt for public scale, storage would move to object storage (S3) and concurrency would need to be horizontally scaled across workers, not capped on one machine.

---

## 1. Scope and Codec Matrix

The system converts video files wrapped in an **MKV (Matroska)** container into a streaming-compatible **MP4 (MPEG-4 Part 14)** container. To balance performance with hardware compatibility, the pipeline distinguishes between **remuxing** (container swap) and **transcoding** (re-encoding).

### Supported Input Specs
* **Container:** `.mkv`
* **Video Codecs:**
  * H.264 / AVC (Advanced Video Coding)
  * H.265 / HEVC (High Efficiency Video Coding)
* **Audio Codecs:**
  * AAC (Advanced Audio Coding)
  * AC-3 / E-AC-3 (Dolby Digital / Dolby Digital Plus)
  * DTS (Digital Theater Systems)

### Target Output Spec
* **Container:** `.mp4`
* **Video Codec:** Passthrough (copy) if H.264/H.265; transcode to H.264 (`libx264`) if incompatible.
* **Audio Codec:** AAC (`aac`, stereo/5.1 downmix) or AC-3 passthrough for hardware compatibility.
* **Faststart:** Enabled (`-movflags +faststart`) to move the `moov` atom to the beginning of the file for immediate web/TV playback.

### Execution Strategy
* **Fast Path (Remuxing):** If input is `H.264 + AAC/AC3`, execute direct stream copy (`-c copy`). Target duration: < 30 seconds for a 25GB file (I/O bound).
* **Slow Path (Audio Transcode):** If input is `H.264/H.265 + DTS`, copy video stream (`-c:v copy`) and re-encode audio to AAC (`-c:a aac`). Target duration: 1–3 minutes.
* **Full Transcode:** Fallback only when video codec is unsupported by target screens.

---

## 2. File Size Ceiling & Storage Bounds

* **Maximum File Size:** **30 GB**
* **Justification:** High-bitrate 4K UHD remuxes and 1080p bluray rips commonly range between 15 GB and 25 GB. A 30 GB ceiling accommodates the 99th percentile of target media files while leaving overhead for metadata and processing.

### Upload Strategy (determines scratch space math)
Chunked/resumable uploads write each incoming chunk by **appending directly to a single growing file on disk** (tus-protocol style), rather than storing chunks as separate files to be merged later. This avoids a second full-size temporary copy during the upload phase itself — merging separately-stored chunks would require holding both the chunk set *and* the merged file on disk simultaneously, roughly doubling upload-phase storage for no benefit.

### Scratch Space Calculation
| Component | Size | Reasoning |
|---|---|---|
| Source file (post-upload) | 30 GB | Full uploaded MKV, retained until job completes |
| Output file (in progress) | up to 30 GB | Being written by ffmpeg; sized ~= source for remux, smaller for transcode |
| Working buffer | 5 GB | ffprobe temp data, partial/interrupted job remnants, safety margin |
| **Total per job** | **~65 GB** | |

With a concurrency limit of 1–2 simultaneous jobs (see §0), worst-case scratch space is **~130 GB**. This must be checked against available disk before a job is accepted (see §3).

---

## 3. Failure Modes & Edge Cases

| Failure Mode | Root Cause | System-Level Impact | Mitigation Strategy |
|---|---|---|---|
| **Mid-Transfer Drop** | Network disconnect or timeout at high byte offsets (e.g., 22 GB / 25 GB). | Incomplete file left on disk; wasted bandwidth if restarted from byte 0. | Chunked, resumable uploads (tus protocol pattern) — resume from last confirmed byte offset. |
| **Invalid/Corrupted Payload** | Non-video binary uploaded with `.mkv` extension, or broken bitstream. | FFmpeg crashes, hangs indefinitely, or spawns a zombie child process. | Pre-execution validation via `ffprobe` JSON stream check before the job is queued. |
| **Process Hang / Deadlock** | Broken video frames cause FFmpeg to stall waiting for I/O. | Worker process blocked indefinitely; job queue starves. | Hard timeout wrapper: **10x the fast-path target duration** (e.g., 5 min cap for remux, 30 min cap for full transcode). On timeout: send `SIGTERM`, wait 5s for graceful exit, then `SIGKILL` if still alive. Always delete partial output file after a kill — otherwise disk space leaks silently over repeated failures. |
| **Disk Exhaustion (ENOSPC)** | Multiple concurrent large conversions exceed available local storage. | `write()` calls fail with `ENOSPC`; without explicit handling, this can leave the Node process or job state inconsistent (NOT an OS crash — the OS itself handles this fine, it's an application-level failure to plan for). | Pre-flight disk-space check gate before accepting a job (require free space >= projected job size from §2 math). Enforce concurrency limit of 1–2 active jobs. |
| **Out-Of-Memory (OOM)** | Server buffers entire stream or large chunks into Node.js heap instead of streaming. | Node.js process crashes (`JavaScript heap out of memory`). | Strict stream piping (`fs.createReadStream` / `createWriteStream`, or piping directly into ffmpeg's stdin) — never buffer a full file in memory. |