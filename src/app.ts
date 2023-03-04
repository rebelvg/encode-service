import * as Koa from 'koa';
import * as cors from '@koa/cors';
import * as Router from 'koa-router';
import * as koaSession from 'koa-session';
import * as uuid from 'uuid';
import * as path from 'path';
import * as _ from 'lodash';
import * as fs from 'fs';
const sanitizeFileName = require('sanitize-filename');

import { router as stats } from './api/stats';

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
}[] = [];

router.get('/generate/:protocol/:appChannel', (ctx, next) => {
  let { protocol, appChannel } = ctx.params;
  const { ip } = ctx;

  protocol = sanitizeFileName(protocol);
  appChannel = sanitizeFileName(appChannel);

  const id = uuid.v4();

  const [app, channel] = appChannel.split('_');

  SUBSCRIBERS.push({
    id,
    protocol,
    app,
    channel,
    ip,
    bytes: 0,
    connectCreated: new Date(),
    connectUpdated: new Date(),
  });

  ctx.body = {
    id,
  };
});

router.get('/watch/:id/:fileName', async (ctx) => {
  const { id, fileName } = ctx.params;
  const { ip } = ctx;

  const client = _.find(SUBSCRIBERS, { id });

  if (!client) {
    throw new Error('bad_client');
  }

  const { protocol, app, channel } = client;

  const indexFilePath = path.join(
    process.cwd(),
    protocol,
    `${app}_${channel}`,
    fileName,
  );

  try {
    await fs.promises.access(indexFilePath);
  } catch (error) {
    throw new NotFoundErrorHttp(error.message);
  }

  const readStream = fs.createReadStream(indexFilePath);

  const [baseName] = fileName.split('.');

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
