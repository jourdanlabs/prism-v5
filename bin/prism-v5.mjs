#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { canonicalJson, createReceipt, verifyReceipt } from '../src/core/receipt.js';
import { runIncident } from '../src/packs/incident.js';
import { runClinicalTriage } from '../src/packs/clinical-bayes.js';
import { serveMcp } from '../src/mcp/server.js';

const usage = `Usage
  prism-v5 incident <input.json|-> [--sign-key <private.pem>]
  prism-v5 clinical <input.json|-> [--sign-key <private.pem>]
  prism-v5 verify <receipt.json|-> <pinned-public.pem>
  prism-v5 mcp [--sign-key <private.pem>] [--pinned-key <public.pem>]
  prism-v5 bench`;

async function jsonFrom(path) {
  if (path !== '-') return JSON.parse(await readFile(path, 'utf8'));
  let buffer = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) buffer += chunk;
  return JSON.parse(buffer);
}

async function readOptions(args, allowed) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const [option, path] = [args[i], args[i + 1]];
    if (!allowed.includes(option) || !path || path.startsWith('--') || values.has(option)) throw new Error(usage);
    values.set(option, await readFile(path, 'utf8'));
  }
  return values;
}

async function main([command, ...args]) {
  if (['incident', 'clinical'].includes(command)) {
    const [path, ...flags] = args;
    if (!path) throw new Error(usage);
    const options = await readOptions(flags, ['--sign-key']);
    const input = await jsonFrom(path);
    const result = command === 'incident' ? runIncident(input) : runClinicalTriage(input);
    const key = options.get('--sign-key');
    const payload = key ? { result, receipt: createReceipt({ operation: command, input, result }, key) } : result;
    console.log(canonicalJson(payload));
    if (result.status === 'REFUSED') process.exitCode = 1;
  } else if (command === 'verify' && args.length === 2) {
    const [json, pinnedPublicKey] = await Promise.all([jsonFrom(args[0]), readFile(args[1], 'utf8')]);
    const result = verifyReceipt(json.receipt ?? json, pinnedPublicKey);
    console.log(canonicalJson(result));
    if (!result.verified) process.exitCode = 1;
  } else if (command === 'mcp') {
    const options = await readOptions(args, ['--sign-key', '--pinned-key']);
    await serveMcp({ signingKey: options.get('--sign-key'), pinnedPublicKey: options.get('--pinned-key') });
  } else if (command === 'bench' && args.length === 0) {
    const { runBenchmark } = await import('../test/killshot-bench.mjs');
    if (!runBenchmark()) process.exitCode = 1;
  } else if (command === '--help' || command === '-h') {
    console.log(usage);
  } else {
    throw new Error(usage);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
