export const APP_PORT = 8000;
export const FFMPEG_PATH = 'ffmpeg';
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
    serviceName: 'KLPQ_STREAM',
    statsBase: 'https://stats-api.klpq.io',
    rtmpBase: 'rtmp://mediaserver.klpq.io',
    originRtmpApp: 'live',
    channels: [
      {
        name: '*',
        tasks: [
          {
            task: 'mpd',
          },
          {
            task: 'hls',
          },
        ],
      },
      {
        name: 'test1',
        tasks: [
          {
            task: 'write',
            paths: ['/d/'],
          },
          {
            task: 'transfer',
            hosts: ['rtmp://mediaserver.klpq.io/live/test2'],
          },
          {
            task: 'encode',
            preset: '540p',
            hosts: ['rtmp://mediaserver.klpq.io/live/test3'],
          },
        ],
      },
    ],
  },
];
