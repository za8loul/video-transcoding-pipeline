# System Design Document: Large-File MKV to MP4 Transcoding Pipeline

## 0. Scale & Architecture Assumption

This system is designed for **personal, workstation-class, and low-traffic local use** (single-user or local network), not a multi-tenant cloud service. This assumption directly drives key architecture decisions:
* Concurrency is tightly throttled (1–2 workers) to protect CPU and I/O bandwidth.
* **Dual Ingestion Paths**:
  1. **Direct Local Path (Zero Transfer)**: Converted in-place directly on disk with zero network I/O, writing straight to a designated local folder.
  2. **Resumable Web Upload**: Append-only single-file streaming upload for remote or browser drag-and-drop scenarios.
* Direct host integration with native Windows File Explorer via Single-Threaded Apartment (STA) PowerShell bridges.

---

## 1. Scope and Codec Matrix

The system converts video files wrapped in an **MKV (Matroska)** container into a stream-optimized **MP4 (MPEG-4 Part 14)** container. To maximize speed while ensuring universal hardware and browser playback, the pipeline strictly distinguishes between **remuxing** (lossless container swap) and **transcoding** (re-encoding).

### Supported Input Specs
* **Container:** `.mkv`
* **Video Codecs:**
  * H.264 / AVC (Advanced Video Coding)
  * H.265 / HEVC (High Efficiency Video Coding)
* **Audio Codecs:**
  * AAC (Advanced Audio Coding)
  * AC-3 / E-AC-3 (Dolby Digital / Dolby Digital Plus)
  * DTS (Digital Theater Systems)
  * FLAC / Vorbis / Opus / MP3

### Target Output Spec
* **Container:** `.mp4`
* **Video Codec:** Passthrough (`-c:v copy`) if H.264/H.265 with safe profile and pixel format; re-encode to H.264 (`-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p`) if incompatible.
* **Audio Codec:** Passthrough (`-c:a copy`) only if explicitly whitelisted; transcode to AAC (`-c:a aac -b:a 192k`) otherwise. Supports silent videos (`-an`).
* **Faststart:** Enabled (`-movflags +faststart`) to relocate the `moov` atom to the beginning of the file for instant streaming and seek operations.

### Execution Strategy Matrix
| Video Stream Qualifies? | Audio Stream Qualifies? | Strategy | Video Arg | Audio Arg | Typical Duration (30 GB) |
|---|---|---|---|---|---|
| H.264/HEVC + Safe Profile + `yuv420p` | Whitelisted (`aac`, `ac3`, `eac3`) | **Fast Remux** | `-c:v copy` | `-c:a copy` | **< 30 seconds** (I/O bound) |
| H.264/HEVC + Safe Profile + `yuv420p` | Not whitelisted (DTS, Vorbis, etc.) | **Partial Transcode** | `-c:v copy` | `-c:a aac -b:a 192k` | **1–3 minutes** |
| Outside safe set (e.g. `yuv444p`, non-standard) | Any | **Full Transcode** | `-c:v libx264 -pix_fmt yuv420p` | Whitelisted copy or AAC | **30–90+ minutes** (CPU bound) |

> [!IMPORTANT]
> **Audio Copy Trap & Exit Code Rule:** Never use `-c:a copy` on an audio codec that has not been explicitly whitelisted. FFmpeg will copy unsupported bitstreams into an MP4 container and mislabel them with the `mp4a` fourcc code. FFmpeg exits with code 0, but the resulting file is corrupt in strict decoders (e.g., Windows Media Player, QuickTime). Compatibility must be verified by `ffprobe` prior to execution.

---

## 2. Storage Engineering & Scratch Math

* **Maximum File Size Supported:** **30 GB** (covers 99th percentile 4K remuxes and high-bitrate Blu-ray rips).
* **Direct Local Mode**: Requires **Source Size + Projected Output + 5 GB Buffer**.
* **Upload Mode (Tus-style Single File Append)**: Ingestion writes incoming chunks by appending directly to a growing file on disk (`fs.createWriteStream({ flags: 'a' })`), completely eliminating duplicate merged chunk copies.

### Scratch Space Gate Calculation
Native OS disk interrogation via `fs.promises.statfs` verifies that free disk space meets safety thresholds before any job is accepted:

$$\text{Required Scratch Space} = \text{Source Size} + \min(\text{Source Size}, 30\text{ GB}) + 5\text{ GB safety margin}$$

For a 30 GB file, the system asserts at least **65 GB** of contiguous free space on the destination volume, rejecting execution with a structured `DiskSpaceError` (HTTP 400) if insufficient.

---

## 3. Timeout & Stall Architecture

A static 30-minute timeout ceiling is fundamentally inadequate for 30 GB files when CPU re-encoding (`libx264`) is required. The execution engine uses a **two-tier watchdog**:
1. **Activity Stall Heartbeat (3-minute window)**: FFmpeg is invoked with `-progress pipe:1`. Real-time progress metrics (`out_time_us`, `frame`, `speed`) are parsed via `readline`. If no progress update is received for 180 seconds, the job is flagged as deadlocked and aborted.
2. **Dynamic Adaptive Ceiling**:
   * Remux jobs: $5 \text{ minutes}$.
   * Transcode jobs: $\max(60\text{ min}, 1.5 \times \text{media duration})$.
3. **Escalation & Cleanup**:
   * On cancellation or timeout: Process receives `SIGTERM`, waits 5 seconds for graceful shutdown, then escalates to `SIGKILL`.
   * The partial/orphaned `.mp4` file is immediately unlinked from disk to prevent silent storage leaks.

---

## 4. Native Windows OS Integration

To support a seamless desktop experience directly from the web dashboard:
* **Native Explorer File & Folder Pickers**:
  * Invokes `.NET OpenFileDialog` and `FolderBrowserDialog` in Single-Threaded Apartment (`-STA`) mode.
  * Encoded via Base64 UTF-16LE (`-EncodedCommand`) to avoid command-line quoting bugs and non-interactive `stdin` EOF premature closures.
* **Explorer Reveal**:
  * Uses `Start-Process explorer.exe -ArgumentList '/select,"<path>"'` with normalized backslashes (`\`).
  * Tolerates Windows Explorer's delegation exit code `1` via `{ reject: false }` and provides an automatic detached `spawn` fallback.

---

## 5. Failure Modes, Mitigations & Structured Errors

| Failure Mode | Root Cause | Impact | Mitigation Strategy |
|---|---|---|---|
| **Corrupt Payload / Broken Bitstream** | Non-video binary uploaded with `.mkv` extension, or truncated download. | FFmpeg hangs, deadlocks, or crashes. | Pre-flight `ffprobe` inspection before enqueueing. Structured `CorruptMediaError` with expandable technical logs in UI. |
| **Disk Exhaustion (`ENOSPC`)** | Large conversion runs out of scratch disk during write. | Partial files, potential corruption. | Pre-flight `statfs` disk gate requiring full scratch calculation before queueing. |
| **Memory Bloat / Heap OOM** | Buffering video streams into Node heap. | Process crash. | Strict stream piping (`fs.createReadStream` / `createWriteStream`) and Range-based HTTP 206 streaming. |
| **Silent Audio Mismatch** | Copying Vorbis/DTS into MP4 container. | Exit code 0, but unplayable audio in strict players. | Strict audio whitelisting (`aac`, `ac3`, `eac3`) prior to execution. Post-conversion `ffprobe` stream validation. |