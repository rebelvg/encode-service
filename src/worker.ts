import * as _ from 'lodash';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as uuid from 'uuid';
import * as path from 'path';

import { FFMPEG_PATH, FFMPEG_PRESETS, SERVICES } from './config';

import { httpClient } from './clients/http';
import { log } from './logs';
import { SUBSCRIBERS } from './app';

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
  API_ORIGIN: string;
  API_SECRET: string;
  CHANNELS: {
    id: string;
    name: string;
    app: string;
    tasks: ITask[];
  }[];
}

interface IStreamsResponse {
  streams: IStream[];
}

interface IStream {
  _id: string;
  name: string;
  app: string;
  server: string;
  viewers: number;
  duration: number;
  bitrate: number;
  lastBitrate: number;
  startTime: string;
  protocol: 'rtmp';
  userName: string | null;
  urls: {
    web: string;
    edge: string;
  };
}

class Channel {
  public runningTasks: {
    id: string;
    taskCreated: Date;
    protocol: 'hls' | 'mpd';
    bytes: number;
  }[] = [];
  private isLive = false;

  constructor(
    public sourceUrl: string,
    public id: string,
    public name: string,
    public app: string,
    public tasks: ITask[] = [],
  ) {}

  async start() {
    log('start', this.name);

    let connectAttempts = 0;

    this.isLive = true;

    while (true) {
      log('connectAttempts', connectAttempts);

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
              `./logs/${startTime.toISOString().replaceAll(':', '-')}-${task}-${p.pid}-stderr.log`,
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

      this.runningTasks = [];

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

    const runningTask: (typeof this.runningTasks)[0] = {
      id: uuid.v4(),
      taskCreated: new Date(),
      protocol: 'mpd',
      bytes: 0,
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

    sourceProcess.stdout.on('data', (data: Buffer) => {
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

    const runningTask: (typeof this.runningTasks)[0] = {
      id: uuid.v4(),
      taskCreated: new Date(),
      protocol: 'hls',
      bytes: 0,
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

    sourceProcess.stdout.on('data', (data: Buffer) => {
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

async function main(SERVICES: IService[]) {
  for (const { API_ORIGIN, API_SECRET, CHANNELS } of SERVICES) {
    for (const channel of CHANNELS) {
      log('channel', channel.name);

      if (channel.name === '*') {
        continue;
      }

      const data = await httpClient.get<IStreamsResponse>(
        `${API_ORIGIN}/channels/${channel.name}`,
      );

      if (!data) {
        continue;
      }

      const foundChannel = _.find(ONLINE_CHANNELS, {
        id: channel.id,
        name: channel.name,
      });

      log('foundChannel', !!foundChannel);

      const stream = _.find(data.streams, {
        name: channel.name,
        app: channel.app,
        protocol: 'rtmp',
      });

      if (!stream) {
        if (foundChannel) {
          foundChannel.stop();

          log('offline', foundChannel.id, foundChannel.sourceUrl);

          _.pull(ONLINE_CHANNELS, foundChannel);
        }

        continue;
      }

      if (foundChannel) {
        continue;
      }

      const channelLink = stream.urls.edge;

      const { origin: rtmpOrigin } = new URL(channelLink);

      const tasks = channel.tasks.map((task) => {
        switch (task.type) {
          case 'transfer':
          case 'encode':
            return {
              ...task,
              urls: task.urls.map((url) =>
                url.replace('${ORIGIN}', rtmpOrigin),
              ),
            };

          default:
            return {
              ...task,
            };
        }
      });

      const channelRecord = new Channel(
        channelLink,
        channel.id,
        channel.name,
        channel.app,
        tasks,
      );

      ONLINE_CHANNELS.push(channelRecord);

      log('online', channelRecord.id, channelLink);

      if (tasks.length > 0) {
        log('start', channelLink);

        channelRecord.start();
      }
    }

    await sendStats(API_ORIGIN, API_SECRET);
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
      CHANNELS: service.CHANNELS.map((channel) => {
        return {
          ...channel,
          app: channel.app,
          id: uuid.v4(),
        };
      }),
    };
  });
}

interface IStats {
  app: string;
  channels: {
    channel: string;
    publisher: {
      connectId: string;
      connectCreated: Date;
      connectUpdated: Date;
      bytes: number;
      protocol: string;
    };
    subscribers: {
      connectId: string;
      connectCreated: Date;
      connectUpdated: Date;
      bytes: number;
      ip: string;
      protocol: string;
    }[];
  }[];
}

async function sendStats(origin: string, token: string) {
  const stats: IStats[] = [];

  const connectUpdated = new Date();

  ONLINE_CHANNELS.forEach(({ name: channel, app: appName, runningTasks }) => {
    runningTasks.forEach((runningTask) => {
      let app = _.find(stats, { app: appName });

      if (!app) {
        app = {
          app: appName,
          channels: [],
        };

        stats.push(app);
      }

      const subscribers = _.filter(SUBSCRIBERS, {
        app: appName,
        channel,
        protocol: runningTask.protocol,
        initDone: true,
      });

      app.channels.push({
        channel,
        publisher: {
          connectId: runningTask.id,
          connectCreated: runningTask.taskCreated,
          connectUpdated,
          bytes: runningTask.bytes,
          protocol: runningTask.protocol,
        },
        subscribers: subscribers.map((subscriber) => {
          return {
            connectId: subscriber.id,
            connectCreated: subscriber.connectCreated,
            connectUpdated: subscriber.connectUpdated,
            bytes: subscriber.bytes,
            ip: subscriber.ip,
            protocol: subscriber.protocol,
          };
        }),
      });
    });
  });

  await httpClient.post(`${origin}/push/kolpaque-encode`, token, { stats });
}

(async () => {
  const services = setupConfig(SERVICES);

  while (true) {
    try {
      await main(services);
    } catch (error) {
      log('main_error', error);
    }

    await sleep(5000);
  }
})();
