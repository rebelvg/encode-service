import * as _ from 'lodash';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as uuid from 'uuid';

import { FFMPEG_PATH, FFMPEG_PRESETS, SERVICES } from '../config';

import { httpClient } from './clients/http';

export const ONLINE_CHANNELS: Channel[] = [];

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
}

interface IHlsTask {
  task: string;
}

interface ITask
  extends IWriteTask,
    ITransferTask,
    IEncodeTask,
    IMpdTask,
    IHlsTask {}

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
  serviceName: string;
  statsBase: string;
  rtmpBase: string;
  originRtmpApp: string;
  channels: {
    id: string;
    name: string;
    tasks: Partial<ITask>[];
  }[];
}

interface IStatsResponse {
  isLive: boolean;
  viewers: number;
  duration: number;
  bitrate: number;
  lastBitrate: number;
  startTime: Date;
}

interface IChannelsListResponse {
  channels: string[];
  live: {
    app: string;
    channel: string;
    protocol: string;
  }[];
}

class Channel {
  public id: string;
  public channelName: string;
  public channelLink: string;
  public tasks: Partial<ITask>[];
  public pipedProcess: childProcess.ChildProcess;
  public connectAttempts: number = 0;
  public runningTasks: {
    id: string;
    taskCreated: Date;
    protocol: string;
    bytes: number;
    path: string;
  }[] = [];

  constructor(
    id: string,
    serviceLink: string,
    channelName: string,
    channelLink: string,
    tasks: Partial<ITask>[],
    public originRtmpApp: string,
  ) {
    this.id = id;
    this.channelName = channelName;
    this.channelLink = channelLink;
    this.tasks = tasks;
    this.pipedProcess = null;

    console.log(this);
  }
}

function pipeStream(channelLink: string) {
  console.log('pipeStream', channelLink);

  return childProcess.spawn(
    FFMPEG_PATH,
    [
      '-loglevel',
      'repeat+level+debug',
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
      '-loglevel',
      'repeat+level+debug',
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

  console.log('transferStream_ffmpegProcess_created', ffmpegProcess.pid);

  handleEvents(ffmpegProcess, 'transferStream');

  pipedProcess.stdout.pipe(ffmpegProcess.stdin);

  console.log(
    'transferStream_piping_pipedProcess_into_ffmpegProcess',
    pipedProcess.pid,
    '-->',
    ffmpegProcess.pid,
  );

  ffmpegProcess.stdin.on('error', function (err) {
    console.log(
      'transferStream_ffmpegProcess_stdin_error',
      toHost,
      err.message,
      ffmpegProcess.pid,
    );
  });

  ffmpegProcess.on('error', function (err) {
    console.log(
      'transferStream_ffmpegProcess_error',
      toHost,
      err.message,
      ffmpegProcess.pid,
    );

    pipedProcess.kill();
  });

  ffmpegProcess.on('exit', function (code, signal) {
    console.log(
      'transferStream_ffmpegProcess_exit',
      toHost,
      code,
      signal,
      ffmpegProcess.pid,
    );

    pipedProcess.kill();
  });

  ffmpegProcess.stderr.setEncoding('utf8');

  ffmpegProcess.stderr.on('data', (data: string) => {
    fs.appendFile(
      `logs/transfer-stream-${ffmpegProcess.pid}`,
      `${new Date().toLocaleString()} ${data}`,
      () => {},
    );
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
      '-loglevel',
      'repeat+level+debug',
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
      '-',
    ],
    {
      stdio: 'pipe',
      windowsHide: true,
    },
  );

  console.log('encodeStream_ffmpegProcess_created', ffmpegProcess.pid);

  handleEvents(ffmpegProcess, 'encodeStream');

  const pipedProcess = channelObj.pipedProcess;

  pipedProcess.stdout.pipe(ffmpegProcess.stdin);

  console.log(
    'encodeStream_piping_pipedProcess_into_ffmpegProcess',
    pipedProcess.pid,
    '-->',
    ffmpegProcess.pid,
  );

  ffmpegProcess.stdin.on('error', function (err) {
    console.log(
      'encodeStream_ffmpegProcess_stdin_error',
      channelObj.channelLink,
      err.message,
      ffmpegProcess.pid,
    );
  });

  ffmpegProcess.on('error', function (err) {
    console.log(
      'encodeStream_ffmpegProcess_error',
      channelObj.channelLink,
      err.message,
      ffmpegProcess.pid,
    );

    pipedProcess.kill();
  });

  ffmpegProcess.on('exit', function (code, signal) {
    console.log(
      'encodeStream_ffmpegProcess_exit',
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
      `logs/encode-stream-${ffmpegProcess.pid}`,
      `${new Date().toLocaleString()} ${data}`,
      () => {},
    );
  });

  transferStreams(ffmpegProcess, taskObj.hosts);
}

function createMpd(channelObj: Channel, taskObj: Partial<ITask>) {
  const path = `${channelObj.originRtmpApp}_${channelObj.channelName}`;
  const { pipedProcess } = channelObj;

  const runningTask = {
    id: uuid.v4(),
    taskCreated: new Date(),
    protocol: 'mpd',
    bytes: 0,
    path,
  };

  channelObj.runningTasks.push(runningTask);

  console.log('createMpd', path);

  fs.rmSync(`mpd/${path}`, { force: true, recursive: true });

  fs.mkdirSync(`mpd/${path}`);

  const ffmpegProcess = childProcess.spawn(
    FFMPEG_PATH,
    [
      '-y',
      '-loglevel',
      'repeat+level+debug',
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

  console.log('createMpd_ffmpegProcess_created', ffmpegProcess.pid);

  handleEvents(ffmpegProcess, 'createMpd');

  pipedProcess.stdout.on('data', (data: Buffer) => {
    runningTask.bytes += data.length;
  });

  pipedProcess.stdout.pipe(ffmpegProcess.stdin);

  console.log(
    'createMpd_piping_pipedProcess_into_ffmpegProcess',
    pipedProcess.pid,
    '-->',
    ffmpegProcess.pid,
  );

  ffmpegProcess.stdin.on('error', function (err) {
    console.log(
      'createMpd_ffmpegProcess_stdin_error',
      path,
      err.message,
      ffmpegProcess.pid,
    );
  });

  ffmpegProcess.on('error', function (err) {
    console.log(
      'createMpd_ffmpegProcess_error',
      path,
      err.message,
      ffmpegProcess.pid,
    );

    pipedProcess.kill();
  });

  ffmpegProcess.on('exit', function (code, signal) {
    console.log(
      'createMpd_ffmpegProcess_exit',
      path,
      code,
      signal,
      ffmpegProcess.pid,
    );

    fs.rmSync(`mpd/${path}`, { force: true, recursive: true });

    pipedProcess.kill();
  });

  ffmpegProcess.stderr.setEncoding('utf8');

  ffmpegProcess.stderr.on('data', (data: string) => {
    fs.appendFile(
      `logs/convert-mpd-${ffmpegProcess.pid}`,
      `${new Date().toLocaleString()} ${data}`,
      () => {},
    );
  });
}

function createHls(channelObj: Channel, taskObj: Partial<ITask>) {
  const path = `${channelObj.originRtmpApp}_${channelObj.channelName}`;
  const { pipedProcess } = channelObj;

  const runningTask = {
    id: uuid.v4(),
    taskCreated: new Date(),
    protocol: 'hls',
    bytes: 0,
    path,
  };

  channelObj.runningTasks.push(runningTask);

  console.log('createHls', path);

  fs.rmSync(`hls/${path}`, { force: true, recursive: true });

  fs.mkdirSync(`hls/${path}`);

  const ffmpegProcess = childProcess.spawn(
    FFMPEG_PATH,
    [
      '-y',
      '-loglevel',
      'repeat+level+debug',
      '-re',
      '-i',
      '-',
      '-vcodec',
      'copy',
      '-acodec',
      'copy',
      '-f',
      'hls',
      `hls/${path}/index.m3u8`,
    ],
    {
      stdio: 'pipe',
      windowsHide: true,
    },
  );

  console.log('createHls_ffmpegProcess_created', ffmpegProcess.pid);

  handleEvents(ffmpegProcess, 'createHls');

  pipedProcess.stdout.on('data', (data: Buffer) => {
    runningTask.bytes += data.length;
  });

  pipedProcess.stdout.pipe(ffmpegProcess.stdin);

  console.log(
    'createHls_piping_pipedProcess_into_ffmpegProcess',
    pipedProcess.pid,
    '-->',
    ffmpegProcess.pid,
  );

  ffmpegProcess.stdin.on('error', function (err) {
    console.log(
      'createHls_ffmpegProcess_stdin_error',
      path,
      err.message,
      ffmpegProcess.pid,
    );
  });

  ffmpegProcess.on('error', function (err) {
    console.log(
      'createHls_ffmpegProcess_error',
      path,
      err.message,
      ffmpegProcess.pid,
    );

    pipedProcess.kill();
  });

  ffmpegProcess.on('exit', function (code, signal) {
    console.log(
      'createHls_ffmpegProcess_exit',
      path,
      code,
      signal,
      ffmpegProcess.pid,
    );

    fs.rmSync(`hls/${path}`, { force: true, recursive: true });

    pipedProcess.kill();
  });

  ffmpegProcess.stderr.setEncoding('utf8');

  ffmpegProcess.stderr.on('data', (data: string) => {
    fs.appendFile(
      `logs/convert-hls-${ffmpegProcess.pid}`,
      `${new Date().toLocaleString()} ${data}`,
      () => {},
    );
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
        createMpd(channelObj, taskObj);
        break;
      }
      case 'hls': {
        createHls(channelObj, taskObj);
        break;
      }
      default: {
        break;
      }
    }
  });
}

async function createPipeStream(channelObj: Channel) {
  console.log('createPipeStream', channelObj.channelLink);

  console.log('waiting...', channelObj.connectAttempts * 10);

  await sleep(channelObj.connectAttempts * 10 * 1000);

  if (!ONLINE_CHANNELS.includes(channelObj)) {
    console.log('createPipeStream_channel_not_online', channelObj.channelLink);

    return;
  }

  if (channelObj.pipedProcess) {
    console.log(
      'createPipeStream_piperProcess_already_exists',
      channelObj.channelLink,
    );

    return;
  }

  channelObj.runningTasks = [];

  const ffmpegProcess = pipeStream(channelObj.channelLink);

  console.log('createPipeStream_ffmpegProcess_created', ffmpegProcess.pid);

  handleEvents(ffmpegProcess, 'createPipeStream');

  ffmpegProcess.on('error', function (err) {
    console.log(
      'createPipeStream_ffmpegProcess_error',
      channelObj.channelLink,
      err.message,
      ffmpegProcess.pid,
    );

    channelObj.connectAttempts++;

    channelObj.pipedProcess = null;

    createPipeStream(channelObj).catch((error) => console.error(error));
  });

  ffmpegProcess.on('exit', function (code, signal) {
    console.log(
      'createPipeStream_ffmpegProcess_exit',
      channelObj.channelLink,
      code,
      signal,
      ffmpegProcess.pid,
    );

    channelObj.connectAttempts++;

    channelObj.pipedProcess = null;

    createPipeStream(channelObj).catch((error) => console.error(error));
  });

  ffmpegProcess.stderr.setEncoding('utf8');

  ffmpegProcess.stderr.on('data', (data: string) => {
    fs.appendFile(
      `logs/create-pipe-stream-${ffmpegProcess.pid}`,
      `${new Date().toLocaleString()} ${data}`,
      () => {},
    );
  });

  channelObj.pipedProcess = ffmpegProcess;

  launchTasks(channelObj);
}

function handleEvents(
  ffmpegProcess: childProcess.ChildProcess,
  logEntry: string,
) {
  ffmpegProcess.stderr.on('error', (error: Error) => {
    console.log(
      'ffmpegProcess.stderr_error',
      logEntry,
      ffmpegProcess.pid,
      error.message,
    );
  });
  ffmpegProcess.stderr.on('close', () => {
    console.log('ffmpegProcess.stderr_close', logEntry, ffmpegProcess.pid);
  });
  ffmpegProcess.stderr.on('end', () => {
    console.log('ffmpegProcess.stderr_end', logEntry, ffmpegProcess.pid);
  });

  ffmpegProcess.stdin.on('error', (error: Error) => {
    console.log(
      'ffmpegProcess.stdin_error',
      logEntry,
      ffmpegProcess.pid,
      error.message,
    );
  });
  ffmpegProcess.stdin.on('close', () => {
    console.log('ffmpegProcess.stdin_close', logEntry, ffmpegProcess.pid);
  });
  ffmpegProcess.stdin.on('finish', () => {
    console.log('ffmpegProcess.stdin_finish', logEntry, ffmpegProcess.pid);
  });

  ffmpegProcess.stdout.on('error', (error: Error) => {
    console.log(
      'ffmpegProcess.stdout_error',
      logEntry,
      ffmpegProcess.pid,
      error.message,
    );
  });
  ffmpegProcess.stdout.on('close', () => {
    console.log('ffmpegProcess.stdout_close', logEntry, ffmpegProcess.pid);
  });
  ffmpegProcess.stdout.on('end', () => {
    console.log('ffmpegProcess.stdout_end', logEntry, ffmpegProcess.pid);
  });
}

const SERVICE_SETTINGS: {
  [serviceName: string]: {
    channels: (baseUrl: string) => string;
    channelStats: (
      baseUrl: string,
      host: string,
      originRtmpApp: string,
      channelName: string,
    ) => string;
  };
} = {
  KLPQ_STREAM: {
    channels: (baseUrl) => `${baseUrl}/channels/list`,
    channelStats: (baseUrl, host, originRtmpApp, channelName) =>
      `${baseUrl}/channels/${host}/${originRtmpApp}/${channelName}`,
  },
};

async function main() {
  for (const service of SERVICES as IService[]) {
    const serviceRecord = SERVICE_SETTINGS[service.serviceName];

    if (!serviceRecord) {
      continue;
    }

    for (const channel of service.channels) {
      let channels: string[] = [channel.name];

      if (channel.name === '*') {
        const channelsData = await httpClient.get<IChannelsListResponse>(
          serviceRecord.channels(service.statsBase),
        );

        if (!channelsData) {
          continue;
        }

        channels = channelsData.channels;
      }

      for (const channelName of channels) {
        const apiLink = serviceRecord.channelStats(
          service.statsBase,
          new URL(service.rtmpBase).host,
          service.originRtmpApp,
          channelName,
        );

        const data = await httpClient.get<IStatsResponse>(apiLink);

        if (!data) {
          continue;
        }

        const channelLink = `${service.rtmpBase}/${service.originRtmpApp}/${channelName}`;

        const foundChannel = _.find(ONLINE_CHANNELS, {
          id: channel.id,
          channelName,
        });

        if (data.isLive) {
          if (foundChannel) {
            continue;
          }

          const channelObj = new Channel(
            channel.id,
            `${service.rtmpBase}/${service.originRtmpApp}`,
            channelName,
            channelLink,
            channel.tasks,
            service.originRtmpApp,
          );

          ONLINE_CHANNELS.push(channelObj);

          console.log(channelLink, 'channel_went_online');

          if (channel.tasks.length > 0) {
            createPipeStream(channelObj).catch((error) => console.error(error));
          }
        } else {
          if (!foundChannel) {
            continue;
          }

          console.log(channelLink, 'channel_went_offline');

          foundChannel.pipedProcess?.kill();

          _.pull(ONLINE_CHANNELS, foundChannel);
        }
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

if (!fs.existsSync('hls')) {
  fs.mkdirSync('hls');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log('worker_running');

function setupConfig() {
  for (const SERVICE of SERVICES as IService[]) {
    for (const channel of SERVICE.channels) {
      channel.id = uuid.v4();
    }
  }
}

(async () => {
  setupConfig();

  while (true) {
    try {
      await main();
    } catch (error) {
      console.log('main_error', error);
    }

    await sleep(5000);
  }
})();
