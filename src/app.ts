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

export const app = new Koa();

app.keys = [uuid.v4()];

app.use(koaSession({ signed: true }, app));

app.use(cors());

app.proxy = true;

app.use(async (ctx, next) => {
  try {
    await next();
  } catch (error) {
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

router.get('/watch/:channelName/:protocol', (ctx, next) => {
  let { protocol, channelName } = ctx.params;
  const { ip } = ctx;

  protocol = sanitizeFileName(protocol);
  channelName = sanitizeFileName(channelName);

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

  let indexFileName: string;

  switch (protocol) {
    case 'mpd':
      indexFileName = 'index.mpd';

      break;
    case 'hls':
      indexFileName = 'index.m3u8';

      break;
    default:
      throw new Error();
  }

  ctx.redirect(`/stream/${id}/${indexFileName}`);
});

router.get('/stream/:id/:file', async (ctx) => {
  const { id, file } = ctx.params;
  const { ip } = ctx;

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
    client.ip = ip;
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
  ctx.throw(404);
});

setInterval(() => {
  _.remove(SUBSCRIBERS, (subscriber) => {
    return Date.now() - subscriber.connectUpdated.getTime() > 60 * 1000;
  });
}, 10 * 1000);
