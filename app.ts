import * as Koa from 'koa';
import * as Router from 'koa-router';
import * as fs from 'fs';
import * as koaStatic from 'koa-static';
import * as koaMount from 'koa-mount';

export const app = new Koa();

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

app.use(koaMount('/mpd', staticApp));

app.use((ctx) => {
  ctx.throw(404);
});
