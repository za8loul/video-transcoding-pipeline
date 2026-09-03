import {execa} from 'execa';

export async function probeFile(filePath) {
    const {stdout} = await execa('ffprobe', [
        '-v', 'error',
        '-show_entries', 'stream=index,codec_name,codec_type,profile,pix_fmt,width,height:format=duration,size,bit_rate',
        '-of', 'json',
        filePath
    ]);
    const data = JSON.parse(stdout);
    const streams = data.streams || [];
    streams.streams = streams; // Allow destructuring { streams }
    streams.format = data.format || {};
    streams.duration = data.format?.duration ? parseFloat(data.format.duration) : null;
    streams.size = data.format?.size ? parseInt(data.format.size, 10) : null;
    return streams;
}