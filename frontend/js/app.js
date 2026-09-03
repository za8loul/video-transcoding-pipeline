import { ResumableUploader } from './uploader.js';

document.addEventListener('DOMContentLoaded', () => {
    // Dropzone & File Selection Elements
    const dropzone = document.getElementById('dropzone');
    const dropzoneTitle = document.getElementById('dropzoneTitle');
    const dropzoneSubtitle = document.getElementById('dropzoneSubtitle');
    const fileInput = document.getElementById('fileInput');
    const uploadCard = document.getElementById('uploadCard');
    const fileBanner = document.getElementById('fileBanner');
    const fileNameEl = document.getElementById('fileName');
    const filePathOrSizeEl = document.getElementById('filePathOrSize');
    const changeFileBtn = document.getElementById('changeFileBtn');

    // Manual Path Elements
    const toggleManualPathBtn = document.getElementById('toggleManualPathBtn');
    const manualPathContainer = document.getElementById('manualPathContainer');
    const manualPathInput = document.getElementById('manualPathInput');

    const outputDirInput = document.getElementById('outputDirInput');
    const browseFolderBtn = document.getElementById('browseFolderBtn');
    const startBtn = document.getElementById('startBtn');

    // Progress Elements
    const progressDashboard = document.getElementById('progressDashboard');
    const uploadProgressGroup = document.getElementById('uploadProgressGroup');
    const uploadPercentEl = document.getElementById('uploadPercent');
    const uploadBarFill = document.getElementById('uploadBarFill');
    const uploadStatsEl = document.getElementById('uploadStats');
    const uploadTag = document.getElementById('uploadTag');

    const transcodePercentEl = document.getElementById('transcodePercent');
    const transcodeBarFill = document.getElementById('transcodeBarFill');
    const transcodeStatsEl = document.getElementById('transcodeStats');
    const strategyTag = document.getElementById('strategyTag');
    const cancelBtn = document.getElementById('cancelBtn');

    // Result Card Elements
    const resultCard = document.getElementById('resultCard');
    const outputPathDisplay = document.getElementById('outputPathDisplay');
    const copyPathBtn = document.getElementById('copyPathBtn');
    const revealBtn = document.getElementById('revealBtn');
    const videoPlayer = document.getElementById('videoPlayer');
    const downloadBtn = document.getElementById('downloadBtn');
    const resetBtn = document.getElementById('resetBtn');

    // Error Modal Elements
    const errorModal = document.getElementById('errorModal');
    const errorModalTitle = document.getElementById('errorModalTitle');
    const errorModalBadge = document.getElementById('errorModalBadge');
    const errorModalMessage = document.getElementById('errorModalMessage');
    const errorModalDetailsContainer = document.getElementById('errorModalDetailsContainer');
    const errorModalDetails = document.getElementById('errorModalDetails');
    const errorModalCloseBtn = document.getElementById('errorModalCloseBtn');

    let localFilePath = null;
    let browserFile = null;
    let uploader = null;
    let activeJobId = null;
    let activeJobOutputPath = null;
    let eventSource = null;
    let isOpeningDialog = false;

    // Error Modal Handler
    function showErrorModal({ title, badge = "Error", message, details = null, onDismiss = null }) {
        errorModalTitle.textContent = title || "Conversion Error";
        errorModalBadge.textContent = badge;
        errorModalMessage.textContent = message || "An unexpected error occurred.";

        if (details && details.trim() && details.trim() !== message.trim()) {
            errorModalDetails.textContent = details.trim();
            errorModalDetailsContainer.classList.remove('hidden');
            errorModalDetailsContainer.open = false;
        } else {
            errorModalDetailsContainer.classList.add('hidden');
        }

        errorModal.classList.remove('hidden');

        const onClose = () => {
            errorModal.classList.add('hidden');
            errorModalCloseBtn.removeEventListener('click', onClose);
            if (onDismiss) onDismiss();
        };

        errorModalCloseBtn.addEventListener('click', onClose);
    }

    function handleConversionError(errData = {}, fallbackMsg = "An error occurred during conversion.") {
        const rawMsg = errData.error || fallbackMsg;
        const details = errData.details || rawMsg;

        let title = "Conversion Failed";
        let badge = "Error";
        let message = rawMsg;

        if (errData.name === 'CorruptMediaError' || rawMsg.includes('Corrupt') || rawMsg.includes('EBML') || rawMsg.includes('exit code 1') || rawMsg.includes('Invalid data found')) {
            title = "Corrupt or Invalid Video File";
            badge = "Invalid File";
            message = "The selected file is not a valid video or has corrupted headers (e.g. from an incomplete download). FFprobe could not read the streams.";
        } else if (errData.name === 'DiskSpaceError' || rawMsg.includes('ENOSPC') || rawMsg.includes('scratch disk space')) {
            title = "Insufficient Disk Space";
            badge = "Storage Limit";
            message = "There is not enough free scratch disk space on the destination drive to safely complete the conversion without risk of disk corruption.";
        } else if (errData.name === 'NoVideoStreamError' || rawMsg.includes('No video stream')) {
            title = "No Video Stream Found";
            badge = "Unsupported Format";
            message = "The selected file does not contain a playable video stream to convert.";
        } else if (rawMsg.includes('not found at')) {
            title = "File Not Found";
            badge = "Missing File";
            message = "The specified video file could not be found on disk. Please verify the file path.";
        }

        showErrorModal({
            title,
            badge,
            message,
            details,
            onDismiss: () => resetUI()
        });
    }

    // Toggle manual path
    toggleManualPathBtn.addEventListener('click', () => {
        manualPathContainer.classList.toggle('hidden');
        if (!manualPathContainer.classList.contains('hidden')) {
            manualPathInput.focus();
        }
    });

    manualPathInput.addEventListener('input', () => {
        const val = manualPathInput.value.replace(/^["']+|["']+$/g, '').trim();
        if (val) {
            setSelectedLocalFile(val);
        }
    });

    // Automatically strip quotes from destination folder input
    outputDirInput.addEventListener('input', () => {
        const clean = outputDirInput.value.replace(/^["']+|["']+$/g, '');
        if (clean !== outputDirInput.value) {
            outputDirInput.value = clean;
        }
    });

    // Dropzone Click: Open Windows Explorer Native File Dialog
    dropzone.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isOpeningDialog) return;
        isOpeningDialog = true;

        try {
            const res = await fetch('/api/dialog/pick-file', { method: 'POST' });
            if (res.ok) {
                const data = await res.json();
                if (data.path) {
                    setSelectedLocalFile(data.path);
                }
            }
        } catch (err) {
            console.error("Native file picker error:", err);
        } finally {
            isOpeningDialog = false;
        }
    });

    // Change File Button
    changeFileBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isOpeningDialog) return;
        isOpeningDialog = true;

        try {
            const res = await fetch('/api/dialog/pick-file', { method: 'POST' });
            if (res.ok) {
                const data = await res.json();
                if (data.path) {
                    setSelectedLocalFile(data.path);
                }
            }
        } catch (err) {
            console.error("Native file picker error:", err);
        } finally {
            isOpeningDialog = false;
        }
    });

    // Prevent fileInput clicks from bubbling
    fileInput.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // Native Folder Browser for Destination
    browseFolderBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isOpeningDialog) return;
        isOpeningDialog = true;

        browseFolderBtn.disabled = true;
        const origHtml = browseFolderBtn.innerHTML;
        browseFolderBtn.textContent = 'Selecting...';

        try {
            const res = await fetch('/api/dialog/pick-folder', { method: 'POST' });
            if (res.ok) {
                const data = await res.json();
                if (data.path) {
                    outputDirInput.value = data.path.replace(/^["']+|["']+$/g, '').trim();
                    highlightInput(outputDirInput);
                }
            }
        } catch (err) {
            console.error("Failed to open folder picker:", err);
        } finally {
            browseFolderBtn.disabled = false;
            browseFolderBtn.innerHTML = origHtml;
            isOpeningDialog = false;
        }
    });

    function setSelectedLocalFile(fullPath) {
        const cleanPath = fullPath.replace(/^["']+|["']+$/g, '').trim();
        localFilePath = cleanPath;
        browserFile = null;

        const parts = cleanPath.split(/[\\/]/);
        const name = parts[parts.length - 1];

        fileNameEl.textContent = name;
        filePathOrSizeEl.textContent = cleanPath;
        fileBanner.classList.remove('hidden');

        dropzoneTitle.textContent = `Selected: ${name}`;
        dropzoneSubtitle.textContent = cleanPath;
        dropzone.style.borderColor = 'var(--emerald-glow)';
        dropzone.style.background = 'rgba(16, 185, 129, 0.08)';

        manualPathInput.value = cleanPath;
        highlightInput(fileBanner);
    }

    function setSelectedBrowserFile(file) {
        browserFile = file;
        localFilePath = null;

        fileNameEl.textContent = file.name;
        filePathOrSizeEl.textContent = `${formatBytes(file.size)} • Dragged File`;
        fileBanner.classList.remove('hidden');

        dropzoneTitle.textContent = `Selected: ${file.name}`;
        dropzoneSubtitle.textContent = formatBytes(file.size);
        dropzone.style.borderColor = 'var(--emerald-glow)';
        dropzone.style.background = 'rgba(16, 185, 129, 0.08)';

        highlightInput(fileBanner);
    }

    // Drag and Drop
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            setSelectedBrowserFile(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
            setSelectedBrowserFile(e.target.files[0]);
        }
    });

    function highlightInput(el) {
        el.style.borderColor = 'var(--emerald-glow)';
        el.style.boxShadow = '0 0 16px rgba(16, 185, 129, 0.45)';
        setTimeout(() => {
            el.style.borderColor = '';
            el.style.boxShadow = '';
        }, 1500);
    }

    // Start Conversion
    startBtn.addEventListener('click', async () => {
        const rawOutputDir = outputDirInput.value.trim() || './output';
        const cleanOutputDir = rawOutputDir.replace(/^["']+|["']+$/g, '').trim();

        // 1. Direct Local File Mode (Zero Upload / Zero Download)
        if (localFilePath) {
            uploadCard.classList.add('hidden');
            progressDashboard.classList.remove('hidden');
            uploadProgressGroup.classList.add('hidden');
            resultCard.classList.add('hidden');

            transcodeBarFill.style.width = '0%';
            transcodePercentEl.textContent = '0%';
            transcodeStatsEl.textContent = 'Analyzing and validating video streams...';
            strategyTag.textContent = 'Validating';
            strategyTag.className = 'status-tag';

            try {
                const res = await fetch('/api/jobs/local', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        inputPath: localFilePath,
                        outputDir: cleanOutputDir
                    })
                });

                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    handleConversionError(errData, `Server returned HTTP ${res.status}`);
                    return;
                }

                const data = await res.json();
                activeJobId = data.jobId;
                activeJobOutputPath = data.outputPath;

                subscribeToJobEvents(activeJobId);
            } catch (err) {
                handleConversionError({ error: err.message }, err.message);
            }
            return;
        }

        // 2. Browser File Mode (when file is dragged & dropped)
        if (browserFile) {
            uploadCard.classList.add('hidden');
            progressDashboard.classList.remove('hidden');
            uploadProgressGroup.classList.remove('hidden');
            resultCard.classList.add('hidden');

            uploadBarFill.style.width = '0%';
            uploadPercentEl.textContent = '0%';
            uploadStatsEl.textContent = 'Initializing upload...';
            uploadTag.textContent = 'Uploading';
            uploadTag.className = 'status-tag tag-active';

            transcodeBarFill.style.width = '0%';
            transcodePercentEl.textContent = '0%';
            transcodeStatsEl.textContent = 'Awaiting upload completion...';
            strategyTag.textContent = 'Pending';
            strategyTag.className = 'status-tag';

            uploader = new ResumableUploader({
                outputDir: cleanOutputDir,
                onProgress: ({ percent, uploadedBytes, totalBytes, speedMBs }) => {
                    uploadBarFill.style.width = `${percent}%`;
                    uploadPercentEl.textContent = `${percent}%`;
                    uploadStatsEl.textContent = `${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)} • ${speedMBs} MB/s`;
                },
                onComplete: ({ jobId }) => {
                    activeJobId = jobId;
                    uploadTag.textContent = 'Uploaded';
                    uploadTag.className = 'status-tag tag-fast';
                    uploadStatsEl.textContent = 'Upload complete. Validating and transcoding...';

                    subscribeToJobEvents(jobId);
                },
                onError: (err) => {
                    handleConversionError({ error: err.message }, err.message);
                }
            });

            uploader.upload(browserFile);
            return;
        }

        // Neither selected
        showErrorModal({
            title: "No Video Selected",
            badge: "Selection Needed",
            message: "Please click on the box above to choose an MKV video file, or drag and drop a file into the window.",
            onDismiss: () => {
                dropzone.click();
            }
        });
    });

    // Cancel Job
    cancelBtn.addEventListener('click', async () => {
        if (confirm("Are you sure you want to cancel this conversion?")) {
            if (uploader) uploader.cancel();
            if (activeJobId) {
                await fetch(`/api/jobs/${activeJobId}`, { method: 'DELETE' }).catch(() => {});
            }
            if (eventSource) eventSource.close();
            resetUI();
        }
    });

    // Reset button
    resetBtn.addEventListener('click', () => {
        resetUI();
    });

    // Copy Path button
    copyPathBtn.addEventListener('click', async () => {
        if (activeJobOutputPath) {
            await navigator.clipboard.writeText(activeJobOutputPath).catch(() => {});
            copyPathBtn.textContent = 'Copied!';
            setTimeout(() => {
                copyPathBtn.textContent = 'Copy Path';
            }, 2000);
        }
    });

    // Reveal in File Explorer button
    revealBtn.addEventListener('click', async () => {
        if (activeJobId) {
            try {
                const res = await fetch(`/api/jobs/${activeJobId}/reveal`, { method: 'POST' });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    showErrorModal({
                        title: "Folder Reveal Notice",
                        badge: "Explorer",
                        message: data.error || "Could not reveal folder automatically.",
                        details: data.error
                    });
                }
            } catch (err) {
                showErrorModal({
                    title: "Folder Reveal Error",
                    badge: "Error",
                    message: err.message
                });
            }
        }
    });

    function resetUI() {
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
        if (videoPlayer) {
            videoPlayer.pause();
            videoPlayer.src = '';
        }
        localFilePath = null;
        browserFile = null;
        activeJobId = null;
        activeJobOutputPath = null;
        fileInput.value = '';
        manualPathInput.value = '';
        fileBanner.classList.add('hidden');
        dropzoneTitle.textContent = "Choose an MKV video to convert";
        dropzoneSubtitle.textContent = "Click to browse your computer, or drag and drop your file here";
        dropzone.style.borderColor = '';
        dropzone.style.background = '';
        uploadCard.classList.remove('hidden');
        progressDashboard.classList.add('hidden');
        resultCard.classList.add('hidden');
    }

    function subscribeToJobEvents(jobId) {
        eventSource = new EventSource(`/api/jobs/${jobId}/events`);

        eventSource.addEventListener('progress', (e) => {
            const progress = JSON.parse(e.data);
            const percent = progress.percent ?? 0;

            transcodeBarFill.style.width = `${percent}%`;
            transcodePercentEl.textContent = `${percent}%`;
            transcodeStatsEl.textContent = `Time: ${progress.outTime} • ${progress.fps} fps • Speed: ${progress.speed}`;
        });

        eventSource.addEventListener('completed', (e) => {
            const job = JSON.parse(e.data);
            eventSource.close();

            activeJobOutputPath = job.outputPath;

            // Strategy badge
            const isCopy = job.strategy?.video === 'copy';
            strategyTag.textContent = isCopy ? 'Fast Remux' : 'Video Re-encode';
            strategyTag.className = isCopy ? 'status-tag tag-fast' : 'status-tag tag-slow';

            transcodeBarFill.style.width = '100%';
            transcodePercentEl.textContent = '100%';
            transcodeStatsEl.textContent = 'Conversion completed!';

            setTimeout(() => {
                showSuccess(jobId, job.outputPath);
            }, 500);
        });

        eventSource.addEventListener('failed', (e) => {
            const job = JSON.parse(e.data);
            eventSource.close();
            handleConversionError({
                error: job.error,
                name: 'TranscodeError',
                details: job.error
            });
        });

        eventSource.addEventListener('cancelled', () => {
            eventSource.close();
            resetUI();
        });
    }

    function showSuccess(jobId, outputPath) {
        progressDashboard.classList.add('hidden');
        resultCard.classList.remove('hidden');

        outputPathDisplay.textContent = outputPath || 'Saved to destination folder';

        const streamUrl = `/api/jobs/${jobId}/stream`;
        videoPlayer.src = streamUrl;
        downloadBtn.href = streamUrl;
        downloadBtn.download = `converted_${jobId}.mp4`;
    }

    function formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
});
