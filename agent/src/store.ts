import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG } from './config.js';
import { DEPLOYMENT } from './config.js';
import type { DecisionPreimage } from './ledger.js';
import type { Proposal } from './particle.js';

export type RecordedOutcome = 'FILLED' | 'REFUSED' | 'BREACH_REVERTED' | 'ERROR';

export type DecisionRecord = {
  id: string;
  ts: number;
  decisionHash: string;
  outcome: RecordedOutcome;
  preimage: DecisionPreimage;
  reasoning: string;
  proposal: Proposal;
  model: string;
  usedFallback: boolean;
  latencyMs: number;
  tokens: number;
  intent?: { isBuy: boolean; amountIn: string; minAmountOut: string };
  amountOut?: string;
  txHash?: string;
  seq?: number;
  head?: string;
  error?: { name: string; message: string; args: unknown[] };
};

const dataDir = CONFIG.dataDir;
// Keyed to the deployment so a fresh chain never shows another chain's records.
const stamp = `${DEPLOYMENT.network}-${DEPLOYMENT.envelope.slice(2, 10)}`;
const file = join(dataDir, `records-${stamp}.jsonl`);

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
if (!existsSync(file)) writeFileSync(file, '');

let cache: DecisionRecord[] = [];
try {
  cache = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DecisionRecord);
} catch {
  cache = [];
}

export const allRecords = (): DecisionRecord[] => cache;

export const findRecord = (id: string) => cache.find((r) => r.id === id || r.decisionHash === id);

export const saveRecord = (record: DecisionRecord) => {
  cache.push(record);
  appendFileSync(file, JSON.stringify(record) + '\n');
  return record;
};

export const updateRecord = (id: string, patch: Partial<DecisionRecord>) => {
  const index = cache.findIndex((r) => r.id === id);
  if (index === -1) return undefined;
  cache[index] = { ...cache[index], ...patch };
  writeFileSync(file, cache.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return cache[index];
};
