import {probeFile} from '../src/ffmpeg/probe.js';
import {determineFfmpegArgs} from '../src/ffmpeg/routing.js';

async function test() {
    const streams = await probeFile(process.argv[2]);
    const {args, strategy} = determineFfmpegArgs(streams, process.argv[2], 'output.mp4');
    console.log('Strategy:', strategy);
    console.log('Args:', args);
}

test();
