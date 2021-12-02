import * as Koa from 'koa';
import * as koaStatic from 'koa-static';
import * as koaMount from 'koa-mount';
import * as cors from '@koa/cors';
import * as Router from 'koa-router';

import { router as stats } from './api/stats';

export const app = new Koa();

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

const staticApp = new Koa();

staticApp.use(koaStatic('mpd'));
staticApp.use(koaStatic('hls'));

app.use(koaMount('/mpd', staticApp));
app.use(koaMount('/hls', staticApp));

const router = new Router();

router.use('/api/stats', stats.routes());

app.use(router.routes());

app.use((ctx) => {
  ctx.throw(404);
});
