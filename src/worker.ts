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
  service: string;
  stats: string;
  rtmp: string;
  channels: IServiceChannel[];
}

interface IServiceExt extends IService {
  channels: IServiceChannelExt[];
}

interface IServiceChannel {
  id: string;
  name: string;
  tasks: Partial<ITask>[];
}

interface IServiceChannelExt extends IServiceChannel {
  isImported: boolean;
}

interface IChannelsResponse {
  channels: IStreamsResponse[];
}

interface IStreamsResponse {
  streams: IStream[];
}

interface IStream {
  isLive: boolean;
  _id: string;
  name: string;
  app: string;
  server: string;
  viewers: number;
  duration: number;
  bitrate: number;
  lastBitrate: number;
  startTime: string;
  protocol: string;
  userName: string | null;
}

class Channel {
  public runningTasks: {
    id: string;
    taskCreated: Date;
    protocol: string;
    bytes: number;
    path: string;
  }[] = [];
  private childProcesses: childProcess.ChildProcessWithoutNullStreams[] = [];
  private isLive = false;

  constructor(
    public id: string,
    public name: string,
    public url: string,
    public tasks: Partial<ITask>[] = [],
  ) {}

  async start() {
    log('start', this.name);

    let connectAttempts = 0;

    this.isLive = true;

    while (true) {
      log('pipe_started', connectAttempts);

      if (!this.isLive) {
        break;
      }

      const sourceProcess = this.pipeStream();

      sourceProcess.on('error', (error) => {
        log('sourceProcess', error);
      });

      sourceProcess.stderr.setEncoding('utf8');

      sourceProcess.stderr.on('data', (data: string) => {
        fs.promises.appendFile(`./logs/${sourceProcess.pid}.log`, data).catch();
      });

      log('pipe_started');

      const promise = new Promise((resolve) => {
        sourceProcess.on('exit', resolve);
      });

      connectAttempts++;

      const childProcesses: childProcess.ChildProcessWithoutNullStreams[] = [];

      _.forEach(this.tasks, (taskObj) => {
        switch (taskObj.task) {
          case 'write': {
            this.writeStream(sourceProcess, taskObj.paths!);

            break;
          }
          case 'transfer': {
            childProcesses.push(
              ...this.transferStreams(sourceProcess, taskObj.hosts!),
            );

            break;
          }
          case 'encode': {
            childProcesses.push(...this.encodeStream(sourceProcess, taskObj));

            break;
          }
          case 'mpd': {
            childProcesses.push(this.createMpd(sourceProcess));

            break;
          }
          case 'hls': {
            childProcesses.push(this.createHls(sourceProcess));

            break;
          }
          default: {
            break;
          }
        }
      });

      this.childProcesses.push(...childProcesses);

      log('tasks_stared', this.childProcesses.length);

      childProcesses.map((p) => {
        p.stderr.setEncoding('utf8');

        p.stderr.on('data', (data: string) => {
          fs.promises.appendFile(`./logs/${p.pid}.log`, data).catch();
        });

        p.on('exit', () => {
          log('exit_child');

          sourceProcess.kill();
        });
      });

      await promise;

      log('pipe_exited');

      childProcesses.map((p) => p.kill());

      sourceProcess.kill();

      await sleep(connectAttempts * 10 * 1000);

      this.childProcesses = [];
    }
  }

  async stop() {
    this.isLive = false;

    this.childProcesses.map((p) => p.kill());
  }

  pipeStream() {
    log(
      'pipeStream',
      this.url,
      [
        '-loglevel',
        '+warning',
        '-re',
        '-i',
        this.url,
        '-vcodec',
        'copy',
        '-acodec',
        'copy',
        '-f',
        'flv',
        '-',
      ].join(' '),
    );

    return childProcess.spawn(
      FFMPEG_PATH,
      [
        '-loglevel',
        '+warning',
        '-re',
        '-i',
        this.url,
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

  writeStream(
    sourceProcess: childProcess.ChildProcessWithoutNullStreams,
    paths: string[],
  ) {
    return _.map(paths, (writePath) => {
      const writeFile = fs.createWriteStream(
        path.resolve(writePath, `${this.name}_${Date.now()}.mp4`),
      );

      sourceProcess.stdout.pipe(writeFile);

      return writeFile;
    });
  }

  transferStream(
    sourceProcess: childProcess.ChildProcessWithoutNullStreams,
    toHost: string,
  ) {
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

    sourceProcess.stdout.pipe(ffmpegProcess.stdin);

    return ffmpegProcess;
  }

  transferStreams(
    sourceProcess: childProcess.ChildProcessWithoutNullStreams,
    hosts: string[],
  ) {
    return _.map(hosts, (host) =>
      this.transferStream(sourceProcess, host.replace('*', this.name)),
    );
  }

  encodeStream(
    sourceProcess: childProcess.ChildProcessWithoutNullStreams,
    taskObj: Partial<ITask>,
  ) {
    if (taskObj.hosts?.length === 0) return [];

    const ffmpegPreset: IFFMpegPresets['preset'] =
      FFMPEG_PRESETS[taskObj.preset!];

    if (!ffmpegPreset) {
      console.error('bad_preset', taskObj.preset);

      return [];
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
      this.id,
      this.url,
      taskObj.preset,
      encodeParams.join(' '),
    );

    const ffmpegProcess = childProcess.spawn(FFMPEG_PATH, encodeParams, {
      stdio: 'pipe',
      windowsHide: true,
    });

    sourceProcess.stdout.pipe(ffmpegProcess.stdin);

    return this.transferStreams(ffmpegProcess, taskObj.hosts!);
  }

  createMpd(sourceProcess: childProcess.ChildProcessWithoutNullStreams) {
    const path = this.id;

    const runningTask = {
      id: uuid.v4(),
      taskCreated: new Date(),
      protocol: 'mpd',
      bytes: 0,
      path,
    };

    this.runningTasks.push(runningTask);

    log('createMpd', this.id);

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

    ffmpegProcess.stdout.on('data', (data: Buffer) => {
      runningTask.bytes += data.length;
    });

    sourceProcess.stdout.pipe(ffmpegProcess.stdin);

    ffmpegProcess.on('exit', (code, signal) => {
      fs.rmSync(`mpd/${path}`, { force: true, recursive: true });
    });

    return ffmpegProcess;
  }

  createHls(sourceProcess: childProcess.ChildProcessWithoutNullStreams) {
    const path = this.id;

    const runningTask = {
      id: uuid.v4(),
      taskCreated: new Date(),
      protocol: 'hls',
      bytes: 0,
      path,
    };

    this.runningTasks.push(runningTask);

    log('createHls', this.id);

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

    ffmpegProcess.stdout.on('data', (data: Buffer) => {
      runningTask.bytes += data.length;
    });

    sourceProcess.stdout.pipe(ffmpegProcess.stdin);

    ffmpegProcess.on('exit', (code, signal) => {
      fs.rmSync(`hls/${path}`, { force: true, recursive: true });
    });

    return ffmpegProcess;
  }
}

class KolpaqueStreamService {
  constructor(private baseUrl: string) {}

  getChannelsUrl() {
    return `${this.baseUrl}/channels`;
  }

  getStatsUrl(channel: string) {
    return `${this.baseUrl}/channels/${channel}`;
  }
}

async function main(SERVICES: IServiceExt[]) {
  log(SERVICES.length);

  for (const service of SERVICES) {
    const serviceRecord = new KolpaqueStreamService(service.stats);

    log(service.stats);

    for (const channel of service.channels) {
      log(channel.name);

      if (channel.name === '*') {
        continue;
      }

      const apiLink = serviceRecord.getStatsUrl(channel.name);

      log(apiLink);

      const data = await httpClient.get<IStreamsResponse>(apiLink);

      if (!data) {
        continue;
      }

      log(data);

      if (data.streams.length === 0) {
        continue;
      }

      const server = new URL(service.rtmp).hostname;

      log(server);

      const stream = _.find(data.streams, {
        server,
      });

      if (!stream) {
        continue;
      }

      log(stream);

      const channelLink = service.rtmp.replace('*', channel.name);

      const foundChannel = _.find(ONLINE_CHANNELS, {
        id: channel.id,
        name: channel.name,
      });

      log('foundChannel', !!foundChannel);

      if (stream.isLive) {
        if (foundChannel) {
          continue;
        }

        const channelObj = new Channel(
          channel.id,
          channel.name,
          channelLink,
          channel.tasks,
        );

        ONLINE_CHANNELS.push(channelObj);

        log('online', channelObj.id, channelLink);

        if (channel.tasks.length > 0) {
          log('start', channelLink);

          channelObj.start();
        }
      } else {
        if (!foundChannel) {
          continue;
        }

        foundChannel.stop();

        log('offline', foundChannel.id, channelLink);

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

function setupConfig(services: typeof SERVICES): IServiceExt[] {
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
    const serviceRecord = new KolpaqueStreamService(service.stats);

    const needsResolvingChannels = _.filter(service.channels, (channel) => {
      return channel.name === '*';
    });

    if (needsResolvingChannels.length === 0) {
      return services;
    }

    const channelsData = await httpClient.get<IChannelsResponse>(
      serviceRecord.getChannelsUrl(),
    );

    if (!channelsData) {
      return services;
    }

    const importedChannels = _.filter(service.channels, { isImported: true });

    for (const importedChannel of importedChannels) {
      if (
        !channelsData.channels.find((c) =>
          c.streams.find((s) => s.name === importedChannel.name),
        )
      ) {
        _.pull(service.channels, importedChannel);
      }
    }

    for (const { streams } of channelsData.channels) {
      for (const stream of streams) {
        for (const needsResolvingChannel of needsResolvingChannels) {
          const needsResolvingChannelId = `${needsResolvingChannel.id}_${stream.name}`;

          const existingDynamicChannel = _.find(service.channels, {
            id: needsResolvingChannelId,
          });

          if (!existingDynamicChannel) {
            service.channels.push({
              ..._.cloneDeep(needsResolvingChannel),
              name: stream.name,
              id: needsResolvingChannelId,
              isImported: true,
            });
          }
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
