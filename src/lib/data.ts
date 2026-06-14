import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../db.js';
import type { Course, RequirementSet } from '../types.js';

// server/data/*.json は data 担当エージェントが並行生成中。
// 存在しない・壊れている場合は空配列を返す(サーバは起動し続ける)。

interface CacheEntry<T> {
  mtimeMs: number;
  value: T;
}

const cache = new Map<string, CacheEntry<unknown>>();

function loadJsonArray<T>(fileName: string): T[] {
  const filePath = path.join(DATA_DIR, fileName);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }
  const cached = cache.get(fileName) as CacheEntry<T[]> | undefined;
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const value = Array.isArray(parsed) ? (parsed as T[]) : [];
    cache.set(fileName, { mtimeMs: stat.mtimeMs, value });
    return value;
  } catch (e) {
    console.error(`[data] failed to load ${fileName}:`, e);
    return [];
  }
}

export function loadCourses(): Course[] {
  return loadJsonArray<Course>('courses.json');
}

export function loadRequirements(): RequirementSet[] {
  return loadJsonArray<RequirementSet>('requirements.json');
}
