import * as _ from 'lodash';

import { ONLINE_CHANNELS } from '../worker';
import { SUBSCRIBERS } from '../app';
import { Router } from '@koa/router';

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

router.get('/:server', (ctx, next) => {
  const { server } = ctx.params;

  const stats: IStats[] = [];

  const connectUpdated = new Date();

  ONLINE_CHANNELS.forEach(
    ({ name: channelName, url: channelLink, runningTasks }) => {
      runningTasks.forEach((runningTask) => {
        const { hostname } = new URL(channelLink);

        if (hostname !== server) {
          return;
        }

        const appName = `${runningTask.protocol}`;

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
    },
  );

  ctx.body = { stats };
});
