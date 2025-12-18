import Koa from 'koa';
import cors from '@koa/cors';
import koaSession from 'koa-session';
import * as uuid from 'uuid';
import * as path from 'path';
import * as _ from 'lodash';
import * as fs from 'fs';
import sanitizeFileName from 'sanitize-filename';

import { router as stats } from './api/stats';
import { ONLINE_CHANNELS } from './worker';
import { Router } from '@koa/router';
import { log } from './logs';

export const app = new Koa();

app.keys = [uuid.v4()];

app.use(koaSession({ signed: true }, app));

app.use(cors());

app.proxy = true;

app.use(async (ctx, next) => {
  log(ctx.url);

  try {
    await next();
  } catch (error) {
    log('error', ctx.url, error.message);

    ctx.status = error.status || 500;
    ctx.body = { error: error.message };
  }
});

class NotFoundErrorHttp extends Error {
  public status = 404;
}

const router = new Router();

export const SUBSCRIBERS: {
  id: string;
  protocol: string;
  app: string;
  channel: string;
  ip: string;
  bytes: number;
  connectCreated: Date;
  connectUpdated: Date;
  channelId: string;
}[] = [];

router.get('/channels/:channelName/index.mpd', async (ctx, next) => {
  let { channelName } = ctx.params;
  const { ip } = ctx;

  const protocol = 'mpd';

  const channelRecord = _.find(ONLINE_CHANNELS, { name: channelName });

  if (!channelRecord) {
    throw new Error();
  }

  const id = uuid.v4();

  SUBSCRIBERS.push({
    id,
    protocol,
    app: protocol,
    channel: channelName,
    ip,
    bytes: 0,
    connectCreated: new Date(),
    connectUpdated: new Date(),
    channelId: channelRecord.id,
  });

  const filePath = path.join(
    process.cwd(),
    'mpd',
    channelRecord.id,
    'index.mpd',
  );

  try {
    await fs.promises.access(filePath);
  } catch (error) {
    throw new NotFoundErrorHttp(error.message);
  }

  const indexFileContent = await fs.promises.readFile(filePath, {
    encoding: 'utf-8',
  });

  const newFile = indexFileContent
    .replace(/init-stream/g, `/streams/mpd/${id}/init-stream`)
    .replace(/chunk-stream/g, `/streams/mpd/${id}/chunk-stream`);

  ctx.body = newFile;
});

router.get('/channels/:channelName/index.m3u8', async (ctx, next) => {
  let { channelName } = ctx.params;
  const { ip } = ctx;

  const protocol = 'hls';

  const channelRecord = _.find(ONLINE_CHANNELS, { name: channelName });

  if (!channelRecord) {
    throw new Error();
  }

  const id = uuid.v4();

  SUBSCRIBERS.push({
    id,
    protocol,
    app: protocol,
    channel: channelName,
    ip,
    bytes: 0,
    connectCreated: new Date(),
    connectUpdated: new Date(),
    channelId: channelRecord.id,
  });

  ctx.status = 308;
  ctx.res.setHeader('cache-control', 'no-store');
  ctx.res.setHeader('location', `/streams/hls/${id}/index.m3u8`);
});

router.get('/streams/:protocol/:userId/:fileName', async (ctx) => {
  let { userId, fileName, protocol } = ctx.params;

  protocol = sanitizeFileName(protocol);
  fileName = sanitizeFileName(fileName);

  const client = _.find(SUBSCRIBERS, { id: userId });

  if (!client) {
    throw new Error('bad_client');
  }

  const filePath = path.join(
    process.cwd(),
    protocol,
    client.channelId,
    fileName,
  );

  try {
    await fs.promises.access(filePath);
  } catch (error) {
    throw new NotFoundErrorHttp(error.message);
  }

  const readStream = fs.createReadStream(filePath);

  if (!fileName.includes('index')) {
    client.connectUpdated = new Date();

    readStream.on('data', (data: Buffer) => {
      client.bytes += data.length;
    });
  }

  ctx.body = readStream;
});

router.use('/api/stats', stats.routes());

app.use(router.routes());

app.use((ctx) => {
  log('404', ctx.url);

  ctx.throw(404);
});

setInterval(() => {
  _.remove(SUBSCRIBERS, (subscriber) => {
    return Date.now() - subscriber.connectUpdated.getTime() > 60 * 1000;
  });
}, 10 * 1000);
