import * as fs from 'fs';
import { z } from 'zod';

const ffmpegPresetSchema = z.object({
  scale: z.number(),
  fps: z.number(),
  preset: z.string(),
  crf: z.number(),
  vBitrate: z.number(),
  aBitrate: z.number(),
});

const ffmpegPresetsSchema = z.record(z.string(), ffmpegPresetSchema);

const taskSchema = z.discriminatedUnion('task', [
  z.object({ task: z.literal('mpd') }),
  z.object({ task: z.literal('hls') }),
  z.object({
    task: z.literal('encode'),
    preset: z.string(),
    hosts: z.array(z.string()),
  }),
  z.object({
    task: z.literal('write'),
    paths: z.array(z.string()),
  }),
  z.object({
    task: z.literal('transfer'),
    hosts: z.array(z.string()),
  }),
]);

const channelSchema = z.object({
  name: z.string(),
  tasks: z.array(taskSchema),
});

const serviceSchema = z.object({
  service: z.string(),
  stats: z.string(),
  rtmp: z.string(),
  channels: z.array(channelSchema),
});

const configSchema = z.object({
  APP_PORT: z.number(),
  APP_HOST: z.string(),
  FFMPEG_PATH: z.string(),
  FFMPEG_PRESETS: ffmpegPresetsSchema,
  SERVICES: z.array(serviceSchema),
});

const config = configSchema.parse(
  JSON.parse(fs.readFileSync('./config.json', { encoding: 'utf-8' })),
);

export const APP_PORT = config.APP_PORT;
export const APP_HOST = config.APP_HOST;
export const FFMPEG_PATH = config.FFMPEG_PATH;
export const FFMPEG_PRESETS = config.FFMPEG_PRESETS;

export const SERVICES = config.SERVICES;
