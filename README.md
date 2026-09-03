# Large-File MKV to MP4 Transcoding Pipeline

A high-performance personal video transcoding and remuxing service engineered for massive media files (up to **30 GB**). Converts MKV containers into stream-optimized MP4 files with universal hardware compatibility, zero-transfer local disk processing, stall detection, and an intuitive dark-glassmorphism web interface.

---

## Key Features

* ⚡ **Instant Remuxing (< 30 seconds for 30 GB)**: Losslessly swaps containers without re-encoding when video is H.264/H.265 with standard `yuv420p` pixel formats.
* 🛡️ **Zero-Transfer Local Conversion**: Process files directly in-place on your hard drive with **0 MB uploaded** and **0 MB downloaded**.
* 📁 **Native Windows Explorer Integration**: Native File Explorer file selector, destination folder browser, and one-click "Open Folder" file reveal powered by PowerShell STA bridges.
* 🔒 **Silent Audio Mismatch Protection**: Whitelists compatible audio codecs (`aac`, `ac3`, `eac3`) to prevent silent MP4 audio corruption common in naive FFmpeg remuxing.
* ⏱️ **Watchdog Stall Detection**: Active heartbeat monitor tracks real-time frame progress every 180 seconds, replacing brittle static timeout caps and auto-cleaning partial files upon failure.
* 💾 **Native Storage Gate (`statfs`)**: Verifies contiguous scratch disk space ($Source + Projected Output + 5\text{ GB}$) before queueing to prevent mid-transcode `ENOSPC` errors.
* 🌐 **Resumable Chunked Uploads**: Append-only tus-style upload manager for remote/browser drag-and-drop transfers without duplicating chunks on disk.
* 🎬 **Faststart HTTP 206 Streaming**: Relocates the `moov` atom to the beginning of the file and serves Range-based partial content for instant in-browser scrubbing and playback.
* 🎨 **Diagnostic Error Modal**: Replaces browser alerts with an interactive modal offering plain-English explanations and collapsible technical FFprobe/FFmpeg logs.

---

## Architecture & Project Structure

The codebase strictly separates backend logic, media processing, and frontend presentation:

```
Large_Files_Converter/
├── src/                          # Backend Core Logic
│   ├── api/
│   │   ├── routes.js             # HTTP Router, API endpoints & static server
│   │   └── sse.js                # Server-Sent Events broker for live progress
│   ├── ffmpeg/
│   │   ├── executor.js           # Process manager with stall heartbeat & auto-cleanup
│   │   ├── probe.js              # FFprobe media & stream analyzer
│   │   └── routing.js            # Remux vs Partial vs Safe transcode decision matrix
│   ├── queue/
│   │   └── queue.js              # Concurrency-capped job queue (1-2 workers)
│   ├── storage/
│   │   └── disk.js               # statfs scratch space assertion math
│   ├── upload/
│   │   └── resumable.js          # Tus-style append-to-disk upload engine
│   ├── utils/
│   │   └── dialog.js             # Base64 -EncodedCommand Windows native picker bridge
│   └── server.js                 # Native node:http server bootstrap
├── frontend/                     # Client Web Application
│   ├── index.html                # Unified dark-glassmorphism dashboard
│   ├── css/
│   │   └── style.css             # Vanilla CSS design system & micro-animations
│   └── js/
│       ├── app.js                # Dashboard controller, dialogs & event subscribers
│       └── uploader.js           # Resumable chunked upload client
├── scripts/                      # Automated Verification & Test Suites
│   ├── run_probe_test.js         # Probe smoke test
│   ├── test_executor.js          # Watchdog & stall abortion tests
│   ├── test_queue.js             # Concurrency & storage gate tests
│   └── test_server.js            # End-to-end integration test (Upload, Transcode, Stream)
├── test_files/                   # Sample video fixtures for automated testing
├── output/                       # Default destination directory for converted MP4s
├── DESIGN.md                     # Comprehensive system design specification
├── package.json
└── README.md
```

---

## Prerequisites

1. **Node.js**: Version 18.0.0 or higher (compatible with Node 20, 22, and 24).
2. **FFmpeg & FFprobe**: Must be installed and accessible in your system's `PATH`.
   * **Windows**: Install via `winget install Gyan.FFmpeg` or download from [ffmpeg.org](https://ffmpeg.org/download.html).
   * Verify by running in terminal:
     ```bash
     ffmpeg -version
     ffprobe -version
     ```

---

## Quickstart & Local Setup

1. **Clone and enter the directory**:
   ```bash
   cd c:\Projects\Large_Files_Converter
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the application**:
   ```bash
   npm start
   ```
   *The server starts listening on **http://localhost:3000**.*

4. **Open the Dashboard**:
   Navigate to [http://localhost:3000](http://localhost:3000) in your web browser.

---

## How to Use

### 1. Direct Local Conversion (Fastest & Zero Transfer)
1. Click the big **"Choose an MKV video to convert"** box (or click *"Or paste file path manually"*).
2. The native **Windows File Explorer** dialog will open. Select any `.mkv` file on your computer and click **Open**.
3. Choose your **Destination Folder** (click **"Browse..."** or leave as `./output`).
4. Click **"Start Conversion"**.
5. Watch the real-time conversion metrics (speed multiplier, FPS, elapsed time, percentage).
6. When complete, click **"Open Folder"** to reveal the new MP4 in Windows File Explorer!

### 2. Browser Upload & Drag-and-Drop
* Drag any MKV video file directly into the dropzone.
* The file will be streamed to the server using chunked resumable ingestion, automatically converted, and saved to your chosen destination folder.

---

## Sample Videos & Testing Fixtures

If you need MKV sample files to test conversion speed, quality, or failure handling, you can use these resources:

### 1. Download Free MKV Sample Videos
* **FileSamples MKV Collection**: [https://filesamples.com/formats/mkv](https://filesamples.com/formats/mkv) — Various resolutions (360p to 4K) and codecs.
* **Jellyfish High-Bitrate 1080p Sample (20 MB)**: [https://test-videos.co.uk/vids/jellyfish/mkv/1080/Jellyfish_1080_10s_20MB.mkv](https://test-videos.co.uk/vids/jellyfish/mkv/1080/Jellyfish_1080_10s_20MB.mkv) — Excellent for testing fast remuxing and H.264 playback.

### 2. How to Create a Corrupted MKV (Testing Pre-Flight Failure Handling)
To test the pre-flight validation gate and see the dark-glassmorphism **Error Modal** in action, create an invalid MKV file:

* **Windows (PowerShell)**:
  ```powershell
  Set-Content -Path fake.mkv -Value "Corrupted non-video binary payload"
  ```
* **Git Bash / macOS / Linux**:
  ```bash
  echo "Corrupted non-video binary payload" > fake.mkv
  ```

Select this `fake.mkv` in the dashboard or run `npm test`. The system will safely reject it at the pre-flight gate without crashing and present the diagnostic error modal with full FFprobe parsing logs.

---

## Automated Test Suite

The repository includes a comprehensive integration test suite covering disk gates, corrupt payload rejection, queue concurrency, stall recovery, and HTTP 206 streaming:

```bash
npm test
```

### What the test suite validates:
1. **Disk Storage Gate**: Confirms that requests exceeding available volume space are safely rejected with `DiskSpaceError`.
2. **Pre-Flight Validation**: Verifies that corrupt bitstreams (`test_files/fake.mkv`) are identified and rejected before queueing.
3. **Queue Concurrency**: Tests that jobs adhere to sequential worker concurrency limits.
4. **Execution Watchdog & Cleanup**: Forces an FFmpeg stall and verifies that the process is terminated and the partial output file is cleanly unlinked from disk.
5. **End-to-End Server Protocol**: Runs a live server instance on port 3456, completes a chunked upload, transcodes the file, verifies HTTP 206 Range streaming, and executes a direct local file conversion.

---

## Codec Routing Strategy

| Video Codec & Format | Audio Codec | Pipeline Action | Resulting Video | Resulting Audio |
|:---|:---|:---|:---|:---|
| H.264 / HEVC (`yuv420p`, Safe Profile) | AAC, AC-3, E-AC-3 | **Fast Remux** | Lossless Copy (`-c:v copy`) | Lossless Copy (`-c:a copy`) |
| H.264 / HEVC (`yuv420p`, Safe Profile) | DTS, Vorbis, FLAC, etc. | **Partial Transcode** | Lossless Copy (`-c:v copy`) | AAC (`-c:a aac -b:a 192k`) |
| Non-standard / `yuv444p` / VC-1 / MPEG-2 | Any | **Safe Transcode** | H.264 (`-c:v libx264 -pix_fmt yuv420p`) | Whitelisted copy or AAC |

---

## API Reference

| Endpoint | Method | Description |
|:---|:---|:---|
| `/api/jobs/local` | `POST` | Enqueues a direct local file conversion (`{ inputPath, outputDir }`). |
| `/api/dialog/pick-file` | `POST` | Opens the native Windows File Picker dialog and returns `{ path }`. |
| `/api/dialog/pick-folder` | `POST` | Opens the native Windows Folder Picker dialog and returns `{ path }`. |
| `/api/jobs/:id/reveal` | `POST` | Opens Windows File Explorer with the completed MP4 highlighted. |
| `/api/jobs/:id/events` | `GET` | Server-Sent Events stream delivering live transcode progress metrics. |
| `/api/jobs/:id/stream` | `GET` | Stream-optimized MP4 delivery supporting HTTP 206 Range requests. |
| `/api/jobs/:id` | `GET` / `DELETE` | Queries job state or cancels an active transcode with disk cleanup. |
| `/api/uploads` | `POST` / `HEAD` / `PATCH` | Tus-style resumable chunked upload protocol. |

## 🗺️ Roadmap & Future Enhancements

### ⚡ Performance & Hardware Acceleration
- [ ] **GPU-Accelerated Transcoding**: Integrate automatic hardware encoder detection (`h264_nvenc` for Nvidia, `h264_qsv` for Intel, `h264_amf` for AMD) for 10x faster encoding on non-remuxable files.
- [ ] **Multi-Threaded Remuxing**: Optimize disk I/O buffers and stream piping for NVMe/SSD high-throughput workloads.

### 🎬 Media & Audio Fidelity
- [ ] **Multi-Track Audio Selection**: Allow users to inspect available audio tracks and select their preferred language or commentary track.
- [ ] **Subtitle Passthrough & Extraction**: Convert soft text subtitles (SRT, ASS) to MP4-compatible `mov_text` tracks.
- [ ] **Stereo Downmixing**: Optional downmix toggle for 7.1/5.1 audio streams to high-bitrate AAC stereo for broader mobile compatibility.

### 🔄 Automation & Batch Workflow
- [ ] **Batch File Queue**: Support selecting or dropping multiple MKV files at once for sequential batch processing.
- [ ] **Auto-Watch Folder**: Background directory monitor to automatically transcode any new `.mkv` files dropped into a designated folder.

### 🛡️ Resilience & Desktop Polish
- [ ] **Queue Persistence**: Store queue state in a lightweight SQLite database (`node:sqlite`) for automatic crash recovery after system reboots.
- [ ] **Native Windows Notifications**: Trigger desktop toast alerts when long-running background conversions complete.
- [ ] **Silent Background Launcher**: Single-click desktop shortcut (`.bat` / background runner) without keeping a terminal window open.

---

## License

MIT License © Abdullah Zaghloul. Designed and engineered for robust personal media conversion.
