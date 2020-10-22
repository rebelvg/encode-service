import * as _ from 'lodash';
import axios from 'axios';
import * as childProcess from 'child_process';
import * as fs from 'fs';

import { FFMPEG_PATH, FFMPEG_PRESETS, SERVICES } from './config';

const ONLINE_CHANNELS: {
  [link: string]: Channel;
} = {};

interface IWriteTask {
  task: string;
  paths: string[];
}

interface ITransferTask {
  task: string;
  hosts: string[];
}

interface IEncodeTask {
  task: string;
  preset: string;
  hosts: string[];
}

interface IMpdTask {
  task: string;
  path: string;
}

interface ITask extends IWriteTask, ITransferTask, IEncodeTask, IMpdTask {}

interface IFFMpegPresets {
  [resolution: string]: {
    scale: number;
    fps: number;
    preset: string;
    crf: number;
    vBitrate: number;
    aBitrate: number;
  };
}

interface IService {
  api: string;
  rtmp: string;
  channels: {
    name: string;
    tasks: Partial<ITask>[];
  }[];
}

class Channel {
  public serviceLink: string;
  public channelName: string;
  public channelLink: string;
  public tasks: Partial<ITask>[];
  public pipedProcess: childProcess.ChildProcess;

  constructor(
    serviceLink: string,
    channelName: string,
    channelLink: string,
    tasks: Partial<ITask>[],
  ) {
    this.serviceLink = serviceLink;
    this.channelName = channelName;
    this.channelLink = channelLink;
    this.tasks = tasks;
    this.pipedProcess = null;
  }
}

function pipeStream(channelLink: string) {
  console.log('pipeStream', channelLink);

  return childProcess.spawn(
    FFMPEG_PATH,
    [
      '-re',
      '-i',
      channelLink,
      '-vcodec',
      'copy',
      '-acodec',
      'copy',
      '-f',
      'flv',
      '-',
    ],
    {
      stdio: 'pipe',
      windowsHide: true,
    },
  );
}

function writeStream(channelObj: Channel, paths: string[]) {
  _.forEach(paths, (path) => {
    console.log('writeStream', channelObj.channelLink, path);

    const writeFile = fs.createWriteStream(
      `${path}${channelObj.channelName}_${Date.now()}.mp4`,
    );

    channelObj.pipedProcess.stdout.pipe(writeFile);
  });
}

function transferStream(
  pipedProcess: childProcess.ChildProcess,
  toHost: string,
) {
  console.log('transferStream', toHost, pipedProcess.pid);

  const ffmpegProcess = childProcess.spawn(
    FFMPEG_PATH,
    [
      '-re',
      '-i',
      '-',
      '-vcodec',
      'copy',
      '-acodec',
      'copy',
      '-f',
      'flv',
      toHost,
    ],
    {
      stdio: 'pipe',
      windowsHide: true,
    },
  );

  console.log('transferStream ffmpegProcess created', ffmpegProcess.pid);

  pipedProcess.stdout.pipe(ffmpegProcess.stdin);

  console.log(
    'transferStream piping pipedProcess into ffmpegProcess',
    pipedProcess.pid,
    '-->',
    ffmpegProcess.pid,
  );

  ffmpegProcess.stdin.on('error', function (err) {
    console.log(
      'transferStream ffmpegProcess stdin error',
      toHost,
      err.message,
      ffmpegProcess.pid,
    );
  });

  ffmpegProcess.on('error', function (err) {
    console.log(
      'transferStream ffmpegProcess error',
      toHost,
      err.message,
      ffmpegProcess.pid,
    );

    pipedProcess.kill();
  });

  ffmpegProcess.on('exit', function (code, signal) {
    console.log(
      'transferStream ffmpegProcess exit',
      toHost,
      code,
      signal,
      ffmpegProcess.pid,
    );

    pipedProcess.kill();
  });

  ffmpegProcess.stderr.setEncoding('utf8');

  ffmpegProcess.stderr.on('data', (data: string) => {
    fs.appendFile(`log-transfer-stream-${ffmpegProcess.pid}`, data, () => {});
  });
}

function transferStreams(
  pipedProcess: childProcess.ChildProcess,
  hosts: string[],
) {
  _.forEach(hosts, (host) => {
    transferStream(pipedProcess, host);
  });
}

function encodeStream(channelObj: Channel, taskObj: Partial<ITask>) {
  if (taskObj.hosts.length === 0) return;

  const ffmpegPreset: IFFMpegPresets['preset'] = FFMPEG_PRESETS[taskObj.preset];

  if (!ffmpegPreset) {
    console.error('bad_preset', taskObj.preset);

    return;
  }

  console.log('encodeStream', channelObj.channelLink, taskObj.preset);

  const ffmpegProcess = childProcess.spawn(
    FFMPEG_PATH,
    [
      '-re',
      '-i',
      '-',
      '-vf',
      `scale=-2:${ffmpegPreset.scale}, fps=fps=${ffmpegPreset.fps}`,
      '-c:v',
      'libx264',
      '-preset',
      `${ffmpegPreset.preset}`,
      '-tune',
      'fastdecode',
      '-tune',
      'zerolatency',
      '-crf',
      `${ffmpegPreset.crf}`,
      '-maxrate',
      `${ffmpegPreset.vBitrate}k`,
      '-bufsize',
      `${ffmpegPreset.vBitrate}k`,
      '-acodec',
      'aac',
      '-strict',
      'experimental',
      '-b:a',
      `${ffmpegPreset.aBitrate}k`,
      '-f',
      'flv',
      `-`,
    ],
    {
      stdio: 'pipe',
      windowsHide: true,
    },
  );

  console.log('encodeStream ffmpegProcess created', ffmpegProcess.pid);

  const pipedProcess = channelObj.pipedProcess;

  pipedProcess.stdout.pipe(ffmpegProcess.stdin);

  console.log(
    'encodeStream piping pipedProcess into ffmpegProcess',
    pipedProcess.pid,
    '-->',
    ffmpegProcess.pid,
  );

  ffmpegProcess.stdin.on('error', function (err) {
    console.log(
      'encodeStream ffmpegProcess stdin error',
      channelObj.channelLink,
      err.message,
      ffmpegProcess.pid,
    );
  });

  ffmpegProcess.on('error', function (err) {
    console.log(
      'encodeStream ffmpegProcess error',
      channelObj.channelLink,
      err.message,
      ffmpegProcess.pid,
    );

    pipedProcess.kill();
  });

  ffmpegProcess.on('exit', function (code, signal) {
    console.log(
      'encodeStream ffmpegProcess exit',
      channelObj.channelLink,
      code,
      signal,
      ffmpegProcess.pid,
    );

    pipedProcess.kill();
  });

  ffmpegProcess.stderr.setEncoding('utf8');

  ffmpegProcess.stderr.on('data', (data: string) => {
    fs.appendFile(
      `log-encode-stream-${channelObj.channelName}`,
      data,
      () => {},
    );
  });

  transferStreams(ffmpegProcess, taskObj.hosts);
}

function createMpd(pipedProcess: childProcess.ChildProcess, path: string) {
  console.log('createMpd', path);

  if (!fs.existsSync(`mpd/${path}`)) {
    fs.mkdirSync(`mpd/${path}`);
  }

  const ffmpegProcess = childProcess.spawn(
    FFMPEG_PATH,
    [
      '-nostats',
      '-re',
      '-i',
      '-',
      '-vcodec',
      'copy',
      '-acodec',
      'copy',
      '-f',
      'dash',
      `mpd/${path}/index.mpd`,
    ],
    {
      stdio: 'pipe',
      windowsHide: true,
    },
  );

  console.log('createMpd ffmpegProcess created', ffmpegProcess.pid);

  pipedProcess.stdout.pipe(ffmpegProcess.stdin);

  ffmpegProcess.stdin.on('error', function (err) {
    console.log(
      'createMpd ffmpegProcess stdin error',
      path,
      err.message,
      ffmpegProcess.pid,
    );
  });

  ffmpegProcess.on('error', function (err) {
    console.log(
      'createMpd ffmpegProcess error',
      path,
      err.message,
      ffmpegProcess.pid,
    );

    pipedProcess.kill();
  });

  ffmpegProcess.on('exit', function (code, signal) {
    console.log(
      'createMpd ffmpegProcess exit',
      path,
      code,
      signal,
      ffmpegProcess.pid,
    );

    pipedProcess.kill();
  });
}

function launchTasks(channelObj: Channel) {
  _.forEach(channelObj.tasks, (taskObj) => {
    switch (taskObj.task) {
      case 'write': {
        writeStream(channelObj, taskObj.paths);
        break;
      }
      case 'transfer': {
        transferStreams(channelObj.pipedProcess, taskObj.hosts);
        break;
      }
      case 'encode': {
        encodeStream(channelObj, taskObj);
        break;
      }
      case 'mpd': {
        createMpd(channelObj.pipedProcess, taskObj.path);
        break;
      }
      default: {
        break;
      }
    }
  });
}

function createPipeStream(channelObj: Channel) {
  console.log('createPipeStream', channelObj.channelLink);

  if (!ONLINE_CHANNELS.hasOwnProperty(channelObj.channelLink)) return;

  const ffmpegProcess = pipeStream(channelObj.channelLink);

  console.log('createPipeStream ffmpegProcess created', ffmpegProcess.pid);

  channelObj.pipedProcess = ffmpegProcess;

  ffmpegProcess.on('error', function (err) {
    console.log(
      'createPipeStream ffmpegProcess error',
      channelObj.channelLink,
      err.message,
      ffmpegProcess.pid,
    );

    createPipeStream(channelObj);
  });

  ffmpegProcess.on('exit', function (code, signal) {
    console.log(
      'createPipeStream ffmpegProcess exit',
      channelObj.channelLink,
      code,
      signal,
      ffmpegProcess.pid,
    );

    createPipeStream(channelObj);
  });

  ffmpegProcess.stderr.setEncoding('utf8');

  ffmpegProcess.stderr.on('data', (data: string) => {
    fs.appendFile(
      `log-create-pipe-stream-${channelObj.channelName}`,
      data,
      () => {},
    );
  });

  launchTasks(channelObj);
}

async function main() {
  for (const service of SERVICES as IService[]) {
    for (const channel of service.channels) {
      const apiLink = `${service.api}/${channel.name}`;

      const { data } = await axios.get(apiLink);

      const channelLink = `${service.rtmp}/${channel.name}`;

      if (data.isLive) {
        if (ONLINE_CHANNELS.hasOwnProperty(channelLink)) {
          continue;
        }

        const channelObj = new Channel(
          service.rtmp,
          channel.name,
          channelLink,
          channel.tasks,
        );

        ONLINE_CHANNELS[channelLink] = channelObj;

        console.log(channelLink, 'channel went online.');

        if (channel.tasks.length > 0) {
          createPipeStream(channelObj);
        }
      } else {
        if (!ONLINE_CHANNELS.hasOwnProperty(channelLink)) {
          continue;
        }

        console.log(channelLink, 'channel went offline.');

        const channelObj = ONLINE_CHANNELS[channelLink];

        channelObj.pipedProcess.kill();

        delete ONLINE_CHANNELS[channelLink];
      }
    }
  }
}

if (!fs.existsSync(FFMPEG_PATH)) {
  throw new Error('bad_ffmpeg_path');
}

if (!fs.existsSync('mpd')) {
  fs.mkdirSync('mpd');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log('worker_running');

(async () => {
  while (true) {
    try {
      await main();
    } catch (error) {
      console.error(error);
    }

    await sleep(5000);
  }
})();
