import { Next } from 'koa';
import * as Router from 'koa-router';
import * as path from 'path';
import * as _ from 'lodash';

import { ONLINE_CHANNELS } from '../worker';

export const router = new Router();

interface IStats {
  app: string;
  channels: {
    channel: string;
    publisher: {
      app: string;
      channel: string;
      connectId: string;
      connectCreated: Date;
      connectUpdated: Date;
      bytes: number;
      protocol: string;
    };
    subscribers: {
      app: string;
      channel: string;
      connectId: string;
      connectCreated: Date;
      connectUpdated: Date;
      bytes: number;
      ip: string;
      protocol: string;
    }[];
  }[];
}

router.get('/:server', (ctx: Router.IRouterContext, next: Next) => {
  const { server } = ctx.params;

  const stats: IStats[] = [];

  const connectUpdated = new Date();

  ONLINE_CHANNELS.forEach((onlineChannel) => {
    onlineChannel.runningTasks.forEach((runningTask) => {
      const { host } = new URL(onlineChannel.serviceLink);

      if (host !== server) {
        return;
      }

      const appName = `${path.basename(onlineChannel.serviceLink)}_${
        runningTask.protocol
      }`;

      const app = _.find(stats, { app: appName });

      if (!app) {
        stats.push({
          app: appName,
          channels: [
            {
              channel: onlineChannel.channelName,
              publisher: {
                app: appName,
                channel: runningTask.path,
                connectId: runningTask.id,
                connectCreated: runningTask.taskCreated,
                connectUpdated,
                bytes: runningTask.bytes,
                protocol: runningTask.protocol,
              },
              subscribers: [],
            },
          ],
        });
      } else {
        app.channels.push({
          channel: onlineChannel.channelName,
          publisher: {
            app: appName,
            channel: runningTask.path,
            connectId: runningTask.id,
            connectCreated: runningTask.taskCreated,
            connectUpdated,
            bytes: runningTask.bytes,
            protocol: runningTask.protocol,
          },
          subscribers: [],
        });
      }
    });
  });

  ctx.body = { stats };
});
