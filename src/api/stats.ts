import { Next } from 'koa';
import * as Router from 'koa-router';
import * as path from 'path';
import * as _ from 'lodash';

import { ONLINE_CHANNELS } from '../worker';
import { SUBSCRIBERS } from '../app';

export const router = new Router();

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

router.get('/:server', (ctx: Router.IRouterContext, next: Next) => {
  const { server } = ctx.params;

  const stats: IStats[] = [];

  const connectUpdated = new Date();

  ONLINE_CHANNELS.forEach(({ channelName, serviceLink, runningTasks }) => {
    runningTasks.forEach((runningTask) => {
      const { host } = new URL(serviceLink);

      if (host !== server) {
        return;
      }

      const appBaseName = path.basename(serviceLink);

      const appName = `${appBaseName}_${runningTask.protocol}`;

      let app = _.find(stats, { app: appName });

      if (!app) {
        app = {
          app: appName,
          channels: [],
        };

        stats.push(app);
      }

      const subscribers = _.filter(SUBSCRIBERS, {
        app: appBaseName,
        channel: channelName,
        protocol: runningTask.protocol,
      });

      app.channels.push({
        channel: channelName,
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

  ctx.body = { stats };
});
