export function determineFfmpegArgs(streams, inputPath, outputPath) {
    if (!Array.isArray(streams) || streams.length === 0) {
        throw new Error("Invalid or empty streams data");
    }

    const videoStream = streams.find(s => s.codec_type === 'video');
    const audioStream = streams.find(s => s.codec_type === 'audio');

    if (!videoStream) {
        throw new Error("Video stream not found");
    }

    // Video eligibility check (H.264/HEVC, yuv420p, safe profile)
    const normalizedProfile = (videoStream.profile || '').toLowerCase();
    const isProfileEligible = !videoStream.profile || 
        ['baseline', 'main', 'high'].some(p => normalizedProfile.includes(p));

    const isVideoEligible = ['h264', 'hevc'].includes(videoStream.codec_name) &&
        videoStream.pix_fmt === 'yuv420p' &&
        isProfileEligible;

    // Audio eligibility check (AAC, AC3, EAC3 only)
    const isAudioEligible = audioStream 
        ? ['aac', 'ac3', 'eac3'].includes(audioStream.codec_name)
        : false;

    const args = ['-y', '-i', inputPath];

    // Explicit stream mapping: map first video stream, and first audio stream if present
    args.push('-map', '0:v:0');
    if (audioStream) {
        args.push('-map', `0:${audioStream.index ?? 'a:0'}`);
    }

    // Independent video routing
    if (isVideoEligible) {
        args.push('-c:v', 'copy');
    } else {
        // Enforce yuv420p so non-standard inputs (e.g. yuv444p) become streaming-compliant
        args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
    }

    // Independent audio routing
    if (audioStream) {
        if (isAudioEligible) {
            args.push('-c:a', 'copy');
        } else {
            args.push('-c:a', 'aac');
        }
    } else {
        args.push('-an');
    }

    // Container flags and output target
    args.push('-movflags', '+faststart', outputPath);

    return {
        args,
        strategy: {
            video: isVideoEligible ? 'copy' : 'transcode',
            audio: audioStream ? (isAudioEligible ? 'copy' : 'transcode') : 'none'
        }
    };
}
