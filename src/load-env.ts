import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Локальная разработка: `.env` в корне проекта. На хостинге переменные задаются в панели. */
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) config({ path: envPath });
