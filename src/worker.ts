import * as _ from 'lodash';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as uuid from 'uuid';
import * as path from 'path';

import { FFMPEG_PATH, FFMPEG_PRESETS, SERVICES } from './config';

import { httpClient } from './clients/http';
import { log } from './logs';

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
  token: string;
  originRtmpApp: string;
  channels: IServiceChannel[];
}

interface IServiceChannel {
  id: string;
  name: string;
  tasks: Partial<ITask>[];
}

interface IServiceChannelExt extends IServiceChannel {
  isImported: boolean;
}

interface IServiceExt extends IService {
  channels: IServiceChannelExt[];
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
  public timestamp: Date;

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
    this.timestamp = new Date();

    log(this);
  }
}

function pipeStream(channelLink: string) {
  log('pipeStream', channelLink);

  return childProcess.spawn(
    FFMPEG_PATH,
    [
      '-loglevel',
      '+warning',
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
  _.forEach(paths, (fsPath) => {
    log('writeStream', channelObj.id, channelObj.channelLink, fsPath);

    const writeFile = fs.createWriteStream(
      path.resolve(fsPath, `${channelObj.channelName}_${Date.now()}.mp4`),
    );

    channelObj.pipedProcess.stdout.pipe(writeFile);
  });
}

function transferStream(
  channelObj: Channel,
  pipedProcess: childProcess.ChildProcess,
  toHost: string,
) {
  log('transferStream', channelObj.id, toHost, pipedProcess.pid);

  const ffmpegProcess = childProcess.spawn(
    FFMPEG_PATH,
    [
      '-loglevel',
      '+warning',
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

  log('transferStream_ffmpegProcess_created', channelObj.id, ffmpegProcess.pid);

  handleEvents(ffmpegProcess, 'transferStream');

  pipedProcess.stdout.pipe(ffmpegProcess.stdin);

  log(
    'transferStream_piping_pipedProcess_into_ffmpegProcess',
    channelObj.id,
    pipedProcess.pid,
    '-->',
    ffmpegProcess.pid,
  );

  ffmpegProcess.stdin.on('error', function (err) {
    log(
      'transferStream_ffmpegProcess_stdin_error',
      channelObj.id,
      toHost,
      err.message,
      ffmpegProcess.pid,
    );
  });

  ffmpegProcess.on('error', function (err) {
    log(
      'transferStream_ffmpegProcess_error',
      channelObj.id,
      toHost,
      err.message,
      ffmpegProcess.pid,
    );

    pipedProcess.kill();
  });

  ffmpegProcess.on('exit', function (code, signal) {
    log(
      'transferStream_ffmpegProcess_exit',
      channelObj.id,
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
      `logs/${channelObj.timestamp.getTime()}-transfer-stream-${
        ffmpegProcess.pid
      }`,
      `${new Date().toLocaleString()} ${data}`,
      () => {},
    );
  });
}

function transferStreams(
  channelObj: Channel,
  pipedProcess: childProcess.ChildProcess,
  hosts: string[],
) {
  _.forEach(hosts, (host) => {
    transferStream(
      channelObj,
      pipedProcess,
      host.replace('*', channelObj.channelName),
    );
  });
}

function encodeStream(channelObj: Channel, taskObj: Partial<ITask>) {
  if (taskObj.hosts.length === 0) return;

  const ffmpegPreset: IFFMpegPresets['preset'] = FFMPEG_PRESETS[taskObj.preset];

  if (!ffmpegPreset) {
    console.error('bad_preset', taskObj.preset);

    return;
  }

  const encodeParams = [
    '-loglevel',
    '+warning',
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
  ];

  log(
    'encodeStream',
    channelObj.id,
    channelObj.channelLink,
    taskObj.preset,
    encodeParams.join(' '),
  );

  const ffmpegProcess = childProcess.spawn(FFMPEG_PATH, encodeParams, {
    stdio: 'pipe',
    windowsHide: true,
  });

  log('encodeStream_ffmpegProcess_created', channelObj.id, ffmpegProcess.pid);

  handleEvents(ffmpegProcess, 'encodeStream');

  const pipedProcess = channelObj.pipedProcess;

  pipedProcess.stdout.pipe(ffmpegProcess.stdin);

  log(
    'encodeStream_piping_pipedProcess_into_ffmpegProcess',
    channelObj.id,
    pipedProcess.pid,
    '-->',
    ffmpegProcess.pid,
  );

  ffmpegProcess.stdin.on('error', function (err) {
    log(
      'encodeStream_ffmpegProcess_stdin_error',
      channelObj.id,
      channelObj.channelLink,
      err.message,
      ffmpegProcess.pid,
    );
  });

  ffmpegProcess.on('error', function (err) {
    log(
      'encodeStream_ffmpegProcess_error',
      channelObj.id,
      channelObj.channelLink,
      err.message,
      ffmpegProcess.pid,
    );

    pipedProcess.kill();
  });

  ffmpegProcess.on('exit', function (code, signal) {
    log(
      'encodeStream_ffmpegProcess_exit',
      channelObj.id,
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
      `logs/${channelObj.timestamp.getTime()}-encode-stream-${
        ffmpegProcess.pid
      }`,
      `${new Date().toLocaleString()} ${data}`,
      () => {},
    );
  });

  transferStreams(channelObj, ffmpegProcess, taskObj.hosts);
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

  log('createMpd', channelObj.id, path);

  fs.rmSync(`mpd/${path}`, { force: true, recursive: true });

  fs.mkdirSync(`mpd/${path}`);

  const ffmpegProcess = childProcess.spawn(
    FFMPEG_PATH,
    [
      '-y',
      '-loglevel',
      '+warning',
      '-re',
      '-i',
      '-',
      '-vcodec',
      'copy',
      '-acodec',
      'copy',
      '-window_size',
      '10',
      '-extra_window_size',
      '10',
      '-f',
      'dash',
      `mpd/${path}/index.mpd`,
    ],
    {
      stdio: 'pipe',
      windowsHide: true,
    },
  );

  log('createMpd_ffmpegProcess_created', channelObj.id, ffmpegProcess.pid);

  handleEvents(ffmpegProcess, 'createMpd');

  pipedProcess.stdout.on('data', (data: Buffer) => {
    runningTask.bytes += data.length;
  });

  pipedProcess.stdout.pipe(ffmpegProcess.stdin);

  log(
    'createMpd_piping_pipedProcess_into_ffmpegProcess',
    channelObj.id,
    pipedProcess.pid,
    '-->',
    ffmpegProcess.pid,
  );

  ffmpegProcess.stdin.on('error', function (err) {
    log(
      'createMpd_ffmpegProcess_stdin_error',
      channelObj.id,
      path,
      err.message,
      ffmpegProcess.pid,
    );
  });

  ffmpegProcess.on('error', function (err) {
    log(
      'createMpd_ffmpegProcess_error',
      channelObj.id,
      path,
      err.message,
      ffmpegProcess.pid,
    );

    pipedProcess.kill();
  });

  ffmpegProcess.on('exit', function (code, signal) {
    log(
      'createMpd_ffmpegProcess_exit',
      channelObj.id,
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
      `logs/${channelObj.timestamp.getTime()}-convert-mpd-${ffmpegProcess.pid}`,
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

  log('createHls', channelObj.id, path);

  fs.rmSync(`hls/${path}`, { force: true, recursive: true });

  fs.mkdirSync(`hls/${path}`);

  const ffmpegProcess = childProcess.spawn(
    FFMPEG_PATH,
    [
      '-y',
      '-loglevel',
      '+warning',
      '-re',
      '-i',
      '-',
      '-vcodec',
      'copy',
      '-acodec',
      'copy',
      '-hls_flags',
      'delete_segments',
      '-hls_list_size',
      '10',
      '-hls_delete_threshold',
      '10',
      '-f',
      'hls',
      `hls/${path}/index.m3u8`,
    ],
    {
      stdio: 'pipe',
      windowsHide: true,
    },
  );

  log('createHls_ffmpegProcess_created', channelObj.id, ffmpegProcess.pid);

  handleEvents(ffmpegProcess, 'createHls');

  pipedProcess.stdout.on('data', (data: Buffer) => {
    runningTask.bytes += data.length;
  });

  pipedProcess.stdout.pipe(ffmpegProcess.stdin);

  log(
    'createHls_piping_pipedProcess_into_ffmpegProcess',
    channelObj.id,
    pipedProcess.pid,
    '-->',
    ffmpegProcess.pid,
  );

  ffmpegProcess.stdin.on('error', function (err) {
    log(
      'createHls_ffmpegProcess_stdin_error',
      channelObj.id,
      path,
      err.message,
      ffmpegProcess.pid,
    );
  });

  ffmpegProcess.on('error', function (err) {
    log(
      'createHls_ffmpegProcess_error',
      channelObj.id,
      path,
      err.message,
      ffmpegProcess.pid,
    );

    pipedProcess.kill();
  });

  ffmpegProcess.on('exit', function (code, signal) {
    log(
      'createHls_ffmpegProcess_exit',
      channelObj.id,
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
      `logs/${channelObj.timestamp.getTime()}-convert-hls-${ffmpegProcess.pid}`,
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
        transferStreams(channelObj, channelObj.pipedProcess, taskObj.hosts);
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
  log(
    'createPipeStream',
    channelObj.id,
    channelObj.channelName,
    channelObj.channelLink,
  );

  log('waiting...', channelObj.id, channelObj.connectAttempts * 10);

  await sleep(channelObj.connectAttempts * 10 * 1000);

  if (!ONLINE_CHANNELS.includes(channelObj)) {
    log(
      'createPipeStream_channel_not_online',
      channelObj.id,
      channelObj.channelLink,
    );

    return;
  }

  if (channelObj.pipedProcess) {
    log(
      'createPipeStream_piperProcess_already_exists',
      channelObj.id,
      channelObj.channelLink,
    );

    return;
  }

  channelObj.runningTasks = [];

  const ffmpegProcess = pipeStream(channelObj.channelLink);

  log(
    'createPipeStream_ffmpegProcess_created',
    channelObj.id,
    ffmpegProcess.pid,
  );

  handleEvents(ffmpegProcess, 'createPipeStream');

  ffmpegProcess.on('error', function (err) {
    log(
      'createPipeStream_ffmpegProcess_error',
      channelObj.id,
      channelObj.channelLink,
      err.message,
      ffmpegProcess.pid,
    );

    channelObj.connectAttempts++;

    channelObj.pipedProcess = null;

    createPipeStream(channelObj).catch((error) => console.error(error));
  });

  ffmpegProcess.on('exit', function (code, signal) {
    log(
      'createPipeStream_ffmpegProcess_exit',
      channelObj.id,
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
      `logs/${channelObj.timestamp.getTime()}-create-pipe-stream-${
        ffmpegProcess.pid
      }`,
      `${new Date().toLocaleString()} ${data}`,
      () => {},
    );
  });

  channelObj.pipedProcess = ffmpegProcess;
  channelObj.timestamp = new Date();

  launchTasks(channelObj);
}

function handleEvents(
  ffmpegProcess: childProcess.ChildProcess,
  logEntry: string,
) {
  ffmpegProcess.stderr.on('error', (error: Error) => {
    log(
      'ffmpegProcess.stderr_error',
      logEntry,
      ffmpegProcess.pid,
      error.message,
    );
  });
  ffmpegProcess.stderr.on('close', () => {
    log('ffmpegProcess.stderr_close', logEntry, ffmpegProcess.pid);
  });
  ffmpegProcess.stderr.on('end', () => {
    log('ffmpegProcess.stderr_end', logEntry, ffmpegProcess.pid);
  });

  ffmpegProcess.stdin.on('error', (error: Error) => {
    log(
      'ffmpegProcess.stdin_error',
      logEntry,
      ffmpegProcess.pid,
      error.message,
    );
  });
  ffmpegProcess.stdin.on('close', () => {
    log('ffmpegProcess.stdin_close', logEntry, ffmpegProcess.pid);
  });
  ffmpegProcess.stdin.on('finish', () => {
    log('ffmpegProcess.stdin_finish', logEntry, ffmpegProcess.pid);
  });

  ffmpegProcess.stdout.on('error', (error: Error) => {
    log(
      'ffmpegProcess.stdout_error',
      logEntry,
      ffmpegProcess.pid,
      error.message,
    );
  });
  ffmpegProcess.stdout.on('close', () => {
    log('ffmpegProcess.stdout_close', logEntry, ffmpegProcess.pid);
  });
  ffmpegProcess.stdout.on('end', () => {
    log('ffmpegProcess.stdout_end', logEntry, ffmpegProcess.pid);
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

async function main(SERVICES: IServiceExt[]) {
  for (const service of SERVICES) {
    const serviceRecord = SERVICE_SETTINGS[service.serviceName];

    if (!serviceRecord) {
      continue;
    }

    for (const channel of service.channels) {
      if (channel.name === '*') {
        continue;
      }

      const apiLink = serviceRecord.channelStats(
        service.statsBase,
        new URL(service.rtmpBase).hostname,
        service.originRtmpApp,
        channel.name,
      );

      const data = await httpClient.get<IStatsResponse>(apiLink, service.token);

      if (!data) {
        continue;
      }

      const channelLink = `${service.rtmpBase}/${service.originRtmpApp}/${channel.name}`;

      const foundChannel = _.find(ONLINE_CHANNELS, {
        id: channel.id,
        channelName: channel.name,
      });

      if (data.isLive) {
        if (foundChannel) {
          continue;
        }

        const channelObj = new Channel(
          channel.id,
          `${service.rtmpBase}/${service.originRtmpApp}`,
          channel.name,
          channelLink,
          channel.tasks,
          service.originRtmpApp,
        );

        ONLINE_CHANNELS.push(channelObj);

        log('channel_went_online', channelObj.id, channelLink);

        if (channel.tasks.length > 0) {
          log(
            'createPipeStream_before',
            channelObj.id,
            channel.name,
            channelObj.channelLink,
          );

          createPipeStream(channelObj).catch((error) => console.error(error));
        }
      } else {
        if (!foundChannel) {
          continue;
        }

        log('channel_went_offline', foundChannel.id, channelLink);

        foundChannel.pipedProcess?.kill();

        _.pull(ONLINE_CHANNELS, foundChannel);
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

log('worker_running');

function setupConfig(services: IService[]): IServiceExt[] {
  const clonedServices = _.cloneDeep(services);

  return clonedServices.map((service) => {
    return {
      ...service,
      channels: service.channels.map((channel) => {
        return {
          ...channel,
          id: uuid.v4(),
          isImported: false,
        };
      }),
    };
  });
}

async function resolveDynamicChannels(services: IServiceExt[]) {
  for (const service of services) {
    const serviceRecord = SERVICE_SETTINGS[service.serviceName];

    if (!serviceRecord) {
      continue;
    }

    const needsResolvingChannels = _.filter(service.channels, (channel) => {
      return channel.name === '*';
    });

    if (needsResolvingChannels.length === 0) {
      return services;
    }

    const channelsData = await httpClient.get<IChannelsListResponse>(
      serviceRecord.channels(service.statsBase),
      service.token,
    );

    if (!channelsData) {
      return services;
    }

    const importedChannels = _.filter(service.channels, { isImported: true });

    for (const importedChannel of importedChannels) {
      if (!channelsData.channels.includes(importedChannel.name)) {
        _.pull(service.channels, importedChannel);
      }
    }

    for (const dynamicChannel of channelsData.channels) {
      for (const needsResolvingChannel of needsResolvingChannels) {
        const needsResolvingChannelId = `${needsResolvingChannel.id}_${dynamicChannel}`;

        const existingDynamicChannel = _.find(service.channels, {
          id: needsResolvingChannelId,
        });

        if (!existingDynamicChannel) {
          service.channels.push({
            ..._.cloneDeep(needsResolvingChannel),
            name: dynamicChannel,
            id: needsResolvingChannelId,
            isImported: true,
          });
        }
      }
    }
  }

  return services;
}

(async () => {
  const services = setupConfig(SERVICES);

  while (true) {
    try {
      const servicesWithDynamicChannels = await resolveDynamicChannels(
        services,
      );

      await main(servicesWithDynamicChannels);
    } catch (error) {
      log('main_error', error);
    }

    await sleep(5000);
  }
})();
