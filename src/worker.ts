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
  type: 'write';
  paths: string[];
}

interface ITransferTask {
  type: 'transfer';
  urls: string[];
}

interface IEncodeTask {
  type: 'encode';
  preset: string;
  urls: string[];
}

interface IMpdTask {
  type: 'mpd';
}

interface IHlsTask {
  type: 'hls';
}

type ITask = IWriteTask | ITransferTask | IEncodeTask | IMpdTask | IHlsTask;

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
  stats: string;
  channels: {
    id: string;
    name: string;
    app: string;
    tasks: ITask[];
    isImported: boolean;
  }[];
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
  origin: string;
}

class Channel {
  public runningTasks: {
    id: string;
    taskCreated: Date;
    protocol: string;
    bytes: number;
    path: string;
  }[] = [];
  private isLive = false;

  constructor(
    public sourceUrl: string,
    public id: string,
    public name: string,
    public tasks: ITask[] = [],
  ) {}

  async start() {
    log('start', this.name);

    let connectAttempts = 0;

    this.isLive = true;

    while (true) {
      log('started', connectAttempts);

      if (!this.isLive) {
        break;
      }

      const startTime = new Date();

      const sourceProcess = this.pipeStream();

      log('pipe_created');

      const promise = new Promise((resolve, reject) => {
        sourceProcess.on('error', reject);

        sourceProcess.on('exit', resolve);
      });

      connectAttempts++;

      const childProcesses: {
        task: string;
        process: childProcess.ChildProcessWithoutNullStreams;
      }[] = [];

      const writeStreams: {
        task: string;
        stream: fs.WriteStream;
      }[] = [];

      _.forEach(this.tasks, (task) => {
        switch (task.type) {
          case 'write': {
            this.writeStream(sourceProcess, task.paths).map((p) =>
              writeStreams.push({
                task: task.type,
                stream: p,
              }),
            );

            break;
          }
          case 'transfer': {
            this.transferStreams(sourceProcess, task.urls).map((p) =>
              childProcesses.push({
                task: task.type,
                process: p,
              }),
            );

            break;
          }
          case 'encode': {
            this.encodeStream(sourceProcess, task.preset, task.urls).map((p) =>
              childProcesses.push({
                task: task.type,
                process: p,
              }),
            );

            break;
          }
          case 'mpd': {
            childProcesses.push({
              task: task.type,
              process: this.createMpd(sourceProcess),
            });

            break;
          }
          case 'hls': {
            childProcesses.push({
              task: task.type,
              process: this.createHls(sourceProcess),
            });

            break;
          }
          default: {
            break;
          }
        }
      });

      log(
        'tasks_stared',
        childProcesses.map((p) => p.task),
        writeStreams.map((s) => s.task),
      );

      [
        {
          task: 'source',
          process: sourceProcess,
        },
        ...childProcesses,
      ].map(({ task, process: p }) => {
        p.stderr.on('error', log);
        p.stdin.on('error', log);
        p.stdout.on('error', log);

        p.stderr.setEncoding('utf8');

        p.stderr.on('data', (data: string) => {
          fs.promises
            .appendFile(
              `./logs/${startTime.toISOString()}-${task}-${p.pid}-stderr.log`,
              data,
            )
            .catch();
        });
      });

      childProcesses.map(({ task, process: p }) => {
        p.on('error', log);

        p.on('exit', () => {
          log('exit_child', task, this.sourceUrl);

          sourceProcess.kill();
        });
      });

      try {
        await promise;
      } catch (error) {
        log('promise', error);
      }

      log('pipe_exited');

      childProcesses.map(({ process: p }) => p.kill());

      sourceProcess.kill();

      await sleep(connectAttempts * 10 * 1000);
    }
  }

  async stop() {
    this.isLive = false;
  }

  pipeStream() {
    log('pipeStream', this.sourceUrl);

    return childProcess.spawn(
      FFMPEG_PATH,
      [
        '-loglevel',
        '+warning',
        '-re',
        '-i',
        this.sourceUrl,
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
    destinationUrl: string,
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
        destinationUrl,
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
    destinationUrls: string[],
  ) {
    return _.map(destinationUrls, (destinationUrl) =>
      this.transferStream(sourceProcess, destinationUrl),
    );
  }

  encodeStream(
    sourceProcess: childProcess.ChildProcessWithoutNullStreams,
    preset: string,
    destinationUrls: string[],
  ) {
    if (destinationUrls.length === 0) return [];

    const ffmpegPreset: IFFMpegPresets['preset'] = FFMPEG_PRESETS[preset];

    if (!ffmpegPreset) {
      console.error('bad_preset', preset);

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
      this.sourceUrl,
      preset,
      encodeParams.join(' '),
    );

    const ffmpegProcess = childProcess.spawn(FFMPEG_PATH, encodeParams, {
      stdio: 'pipe',
      windowsHide: true,
    });

    sourceProcess.stdout.pipe(ffmpegProcess.stdin);

    return this.transferStreams(ffmpegProcess, destinationUrls);
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
      if (fs.existsSync(`mpd/${path}`)) {
        fs.rmSync(`mpd/${path}`, { force: true, recursive: true });
      }
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
      if (fs.existsSync(`mpd/${path}`)) {
        fs.rmSync(`mpd/${path}`, { force: true, recursive: true });
      }
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

async function main(SERVICES: IService[]) {
  for (const service of SERVICES) {
    const serviceRecord = new KolpaqueStreamService(service.stats);

    for (const channel of service.channels) {
      log('channel', channel.name);

      if (channel.name === '*') {
        continue;
      }

      const apiLink = serviceRecord.getStatsUrl(channel.name);

      const data = await httpClient.get<IStreamsResponse>(apiLink);

      if (!data) {
        continue;
      }

      const stream = _.find(data.streams, {
        name: channel.name,
        app: channel.app,
      });

      if (!stream) {
        continue;
      }

      const rtmpOrigin = stream.origin;

      const channelLink = `${rtmpOrigin}/${stream.app}/${channel.name}`;

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
          channelLink,
          channel.id,
          channel.name,
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

log('worker_running');

function setupConfig(services: typeof SERVICES): IService[] {
  const clonedServices = _.cloneDeep(services);

  return clonedServices.map((service) => {
    return {
      ...service,
      channels: service.channels.map((channel) => {
        return {
          ...channel,
          app: channel.app,
          id: uuid.v4(),
          isImported: false,
        };
      }),
    };
  });
}

async function resolveDynamicChannels(services: IService[]) {
  for (const service of services) {
    const serviceRecord = new KolpaqueStreamService(service.stats);

    service.channels = [];

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
        log('dynamic_channel_removed', importedChannel.name);

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
            log('dynamic_channel_added', needsResolvingChannel.name);

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
      const servicesWithDynamicChannels =
        await resolveDynamicChannels(services);

      log('servicesWithDynamicChannels', servicesWithDynamicChannels);

      await main(servicesWithDynamicChannels);
    } catch (error) {
      log('main_error', error);
    }

    await sleep(5000);
  }
})();
