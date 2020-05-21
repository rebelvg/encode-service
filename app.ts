import * as Koa from 'koa';
import * as Router from 'koa-router';
import * as fs from 'fs';

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

const router = new Router();

router.get('/mpd/:server/:app/:channel', async (ctx) => {
  const { fileName } = ctx.params;

  const fileStream = fs.createReadStream(`C:\\Users\\rebel\\Desktop\\test\\${fileName}`);

  ctx.body = fileStream;
});

app.use(router.routes());

app.use((ctx) => {
  ctx.throw(404);
});
