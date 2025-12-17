import Koa from 'koa';
import cors from '@koa/cors';
import koaSession from 'koa-session';
import * as uuid from 'uuid';
import * as path from 'path';
import * as _ from 'lodash';
import * as fs from 'fs';
const sanitizeFileName = require('sanitize-filename');

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

router.get('/channels/:channelName/mpd', (ctx, next) => {
  let { channelName } = ctx.params;
  const { ip } = ctx;

  channelName = sanitizeFileName(channelName);

  const channelRecord = _.find(ONLINE_CHANNELS, { name: channelName });

  if (!channelRecord) {
    throw new Error();
  }

  const id = uuid.v4();

  const protocol = 'mpd';

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

  ctx.cookies.set('', '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: true, // if HTTPS
    maxAge: 1000 * 60 * 60, // 1 hour (tune)
    path: '/', // important
  });

  ctx.status = 307;
  ctx.res.setHeader('cache-control', 'no-store');
  ctx.res.setHeader('location', `/streams/${id}/index.mpd`);

  return;

  ctx.body = {
    id,
  };
});

router.get('/channels/:channelName/:indexFile', (ctx, next) => {
  let { indexFile, channelName } = ctx.params;
  const { ip } = ctx;

  indexFile = sanitizeFileName(indexFile);
  channelName = sanitizeFileName(channelName);

  const channelRecord = _.find(ONLINE_CHANNELS, { name: channelName });

  if (!channelRecord) {
    throw new Error();
  }

  const id = uuid.v4();

  const [, ext] = indexFile.split('.');

  let protocol: string;

  switch (ext) {
    case 'mpd':
      protocol = 'mpd';

      break;
    case 'm3u8':
      protocol = 'hls';

      break;
    default:
      throw new Error();
  }

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

  ctx.status = 307;
  ctx.res.setHeader('cache-control', 'no-store');
  ctx.res.setHeader('location', `/streams/${indexFile}?client=${id}`);

  return;

  ctx.body = {
    id,
  };
});

router.get('/streams/:id/:file', async (ctx) => {
  let { file, id } = ctx.params;

  log(id);

  file = sanitizeFileName(file);

  log(file);

  const client = _.find(SUBSCRIBERS, { id });

  if (!client) {
    throw new Error('bad_client');
  }

  const { protocol } = client;

  const filePath = path.join(process.cwd(), protocol, client.channelId, file);

  try {
    await fs.promises.access(filePath);
  } catch (error) {
    throw new NotFoundErrorHttp(error.message);
  }

  const readStream = fs.createReadStream(filePath);

  const [baseName] = file.split('.');

  if (baseName !== 'index') {
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
