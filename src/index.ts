import * as fs from 'fs';

import { app } from './app';
import { APP_PORT, APP_HOST } from './config';
import { log } from './logs';
import './worker';

if (!fs.existsSync('./logs')) {
  fs.mkdirSync('./logs');
}

process.on('unhandledRejection', (reason, p) => {
  throw reason;
});

process.on('uncaughtException', (error) => {
  console.error('uncaughtException', error);

  process.exit(1);
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
