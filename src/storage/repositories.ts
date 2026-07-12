import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonStore } from './json-store';
import type { Project, SubmittedReview, AgentJob } from '../domain/types';

export interface Repositories {
  dataDir: string;
  projects: JsonStore<Project>;
  reviews: JsonStore<SubmittedReview>;
  jobs: JsonStore<AgentJob>;
}

/**
 * Create the JSON-backed repositories under `dataDir`, creating the directory
 * if needed. Storage is accessed only through this interface so a hosted
 * database can replace the JSON stores later.
 */
export async function createRepositories(dataDir: string): Promise<Repositories> {
  await mkdir(dataDir, { recursive: true });
  return {
    dataDir,
    projects: new JsonStore<Project>(join(dataDir, 'projects.json')),
    reviews: new JsonStore<SubmittedReview>(join(dataDir, 'reviews.json')),
    jobs: new JsonStore<AgentJob>(join(dataDir, 'jobs.json')),
  };
}
