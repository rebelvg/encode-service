import * as fs from 'fs';
import * as path from 'path';

import { app } from './app';
import { APP_PORT, APP_HOST } from './config';
import { log } from './logs';
import './worker';

['./mpd', './hls'].map((dirName) => {
  fs.readdirSync(dirName, { withFileTypes: true }).map((dirItem) => {
    if (dirItem.isDirectory()) {
      fs.rmSync(path.resolve(dirName, dirItem.name), {
        recursive: true,
        force: true,
      });
    }
  });
});

process.on('unhandledRejection', (reason, p) => {
  throw reason;
});

process.on('uncaughtException', (error) => {
  console.error('uncaughtException', error);

  throw error;
});

// remove previous unix socket
if (typeof APP_PORT === 'string') {
  if (fs.existsSync(APP_PORT)) {
    fs.unlinkSync(APP_PORT);
  }
}

(async () => {
  app.listen(APP_PORT, APP_HOST, () => {
    log('http_running', APP_PORT, APP_HOST);

    // set unix socket rw rights for nginx
    if (typeof APP_PORT === 'string') {
      fs.chmodSync(APP_PORT, '777');
    }
  });
})();
