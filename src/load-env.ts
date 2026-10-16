import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url'; // Добавлено для ESM
import { dirname } from 'path';     // Добавлено для ESM

/**
 * 1) корневой `.env` репозитория
 * 2) `vp-bot/.env` — перекрывает совпадающие ключи
 */
export function loadEnvFiles(): void {
  const __filename = fileURLToPath(import.meta.url); // Эквивалент __filename для ESM
  const here = dirname(__filename);                  // Эквивалент __dirname для ESM
  const repoRoot = resolve(here, '..', '..');
  const botRoot = resolve(here, '..');
  const rootEnv = resolve(repoRoot, '.env');
  const botEnv = resolve(botRoot, '.env');
  if (existsSync(rootEnv)) {
    config({ path: rootEnv });
  }
  if (existsSync(botEnv)) {
    config({ path: botEnv, override: true });
  }
}

loadEnvFiles();