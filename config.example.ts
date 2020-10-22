export const APP_PORT = 8000;
export const FFMPEG_PATH = 'ffmpeg.exe';
export const FFMPEG_PRESETS = {
  '540p': {
    scale: 540,
    fps: 30,
    preset: 'superfast',
    crf: 27,
    vBitrate: 1024,
    aBitrate: 128,
  },
};

export const SERVICES = [
  {
    api: 'https://stats.klpq.men/api/channels/nms/live',
    rtmp: 'rtmp://klpq.men/live',
    channels: [
      {
        name: 'test1',
        tasks: [
          {
            task: 'write',
            paths: ['/d/'],
          },
          {
            task: 'transfer',
            hosts: ['rtmp://klpq.men/live/test2'],
          },
          {
            task: 'encode',
            preset: '540p',
            hosts: ['rtmp://klpq.men/live/test3'],
          },
          {
            task: 'mpd',
            path: 'test',
          },
        ],
      },
    ],
  },
];
