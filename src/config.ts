import * as fs from 'fs';

const configJson = JSON.parse(
  fs.readFileSync('./config.json', { encoding: 'utf-8' }),
);

export const APP_PORT = configJson.API_PORT;
export const FFMPEG_PATH = configJson.FFMPEG_PATH;
export const FFMPEG_PRESETS = configJson.FFMPEG_PRESETS;

export const SERVICES = configJson.SERVICES;
