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

const taskSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mpd') }).strict(),
  z.object({ type: z.literal('hls') }).strict(),
  z
    .object({
      type: z.literal('encode'),
      preset: z.string(),
      urls: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      type: z.literal('write'),
      paths: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      type: z.literal('transfer'),
      urls: z.array(z.string()),
    })
    .strict(),
]);

const channelSchema = z.object({
  app: z.string(),
  name: z.string(),
  tasks: z.array(taskSchema),
});

export type IChannel = z.infer<typeof channelSchema>;

export type IService = z.infer<typeof serviceSchema>;

const serviceSchema = z.object({
  API_ORIGIN: z.string(),
  API_SECRET: z.string(),
  CHANNELS: z.array(channelSchema),
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
