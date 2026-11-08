import 'dotenv/config';

import { readPositiveInteger } from './env.js';

const port = readPositiveInteger(process.env, 'PORT', 3000, 65535);

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port,
};
