import { createInterface } from 'node:readline';
import { canonicalJson, createReceipt, verifyReceipt } from '../core/receipt.js';
import { solveCredal } from '../core/credal-dag.js';
import { decideAndPlanVoI } from '../core/voi.js';
import { isRecord } from '../core/input.js';
import { runIncident } from '../packs/incident.js';
import { runClinicalTriage } from '../packs/clinical-bayes.js';

export const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'prism-v5-mcp', version: '5.0.0' };

const object = { type: 'object' };
const array = { type: 'array' };
const string = { type: 'string' };
const credal = { states: array, priors: object, observations: array, dag: object,
  independence: { anyOf: [array, object] }, jointLikelihoods: object };
const tool = (name, description, properties, required, run) => ({
  descriptor: { name, description, inputSchema: { type: 'object', properties, required } }, run,
});
const tools = [
  tool('prism5_solve_credal', 'Solve exact posterior bounds using the full credal DAG polytope.',
    credal, ['states'], solveCredal),
  tool('prism5_decide_and_plan_voi', 'Prove credal dominance or evaluate read-only diagnostic probes.',
    { ...credal, actions: array, probes: array }, ['states', 'actions'], decideAndPlanVoI),
  tool('prism5_run_incident', 'Evaluate SRE incident actions, temporal and migration guards, and approved probe identifiers.',
    { topology: object, hypotheses: array, observations: array, actions: array, probes: array, deployments: array, migrations: array },
    ['topology', 'hypotheses', 'actions'], runIncident),
  tool('prism5_run_clinical_triage', 'Evaluate supplied exact diagnostic evidence and TREAT, TEST, or WATCH utility models.',
    { preTestProb: {}, prevalence: {}, observedTests: array, triage: object, queryCtx: string,
      condIndepLicenses: array, targetDisease: string, altState: string }, [], runClinicalTriage),
  tool('prism5_verify_receipt', 'Verify a receipt with an independently pinned Ed25519 public key.',
    { receipt: object, pinnedPublicKey: string }, ['receipt'],
    (args, pinnedPublicKey) => verifyReceipt(args.receipt, pinnedPublicKey ?? args.pinnedPublicKey)),
];
const byName = new Map(tools.map((entry) => [entry.descriptor.name, entry]));

export async function serveMcp({
  input = process.stdin, output = process.stdout, signingKey, pinnedPublicKey,
} = {}) {
  const lines = createInterface({ input, terminal: false, crlfDelay: Infinity });
  let initialized = false;
  const send = (response) => output.write(canonicalJson({ jsonrpc: '2.0', ...response }) + '\n');
  function error(id, code, message) { send({ id, error: { code, message } }); }
  for await (const line of lines) {
    if (line.trim() === '') continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      error(null, -32700, 'Parse error');
      continue;
    }
    const id = request?.id ?? null;
    if (!isRecord(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
        || (id !== null && typeof id !== 'string' && !Number.isSafeInteger(id))) {
      error(null, -32600, 'Invalid request');
      continue;
    }
    if (!Object.hasOwn(request, 'id')) continue;
    try {
      switch (request.method) {
        case 'initialize':
          if (!isRecord(request.params) || typeof request.params.protocolVersion !== 'string') {
            error(id, -32602, 'Missing protocol version');
            break;
          }
          initialized = true;
          send({ id, result: { protocolVersion: PROTOCOL_VERSION, serverInfo: SERVER_INFO, capabilities: { tools: {} } } });
          break;
        case 'ping':
          send({ id, result: {} });
          break;
        case 'tools/list':
          if (!initialized) error(id, -32002, 'Server has not been initialized');
          else send({ id, result: { tools: tools.map(({ descriptor }) => descriptor) } });
          break;
        case 'tools/call': {
          if (!initialized) {
            error(id, -32002, 'Server has not been initialized');
            break;
          }
          const entry = byName.get(request.params?.name);
          const args = request.params?.arguments ?? {};
          if (!entry || !isRecord(args)) {
            error(id, -32602, 'Unknown tool or invalid arguments');
            break;
          }
          const verifying = entry.descriptor.name === 'prism5_verify_receipt';
          const result = entry.run(args, verifying ? pinnedPublicKey : undefined);
          const payload = signingKey && !verifying
            ? { result, receipt: createReceipt({ operation: entry.descriptor.name, input: args, result }, signingKey) }
            : result;
          send({ id, result: { content: [{ type: 'text', text: canonicalJson(payload) }] } });
          break;
        }
        default:
          error(id, -32601, 'Method not found');
      }
    } catch {
      error(id, -32603, 'Internal error');
    }
  }
}
