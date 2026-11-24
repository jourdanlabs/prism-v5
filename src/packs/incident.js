import { validateDag } from '../core/credal-dag.js';
import { exact, interval, list, own, records, refuse, refusalResult, uniqueIds } from '../core/input.js';
import { abs, add, compare, multiply, neg, subtract, ZERO } from '../core/rational.js';
import { decideAndPlanVoI } from '../core/voi.js';

export const INCIDENT_PROBES = Object.freeze({
  pg_stat_activity: Object.freeze({
    engine: 'sql_readonly',
    queryText: 'SELECT state, wait_event_type, count(*) FROM pg_stat_activity GROUP BY state, wait_event_type',
  }),
  envoy_upstream_stats: Object.freeze({
    engine: 'promql', queryText: 'envoy_cluster_upstream_rq_pending_overflow',
  }),
  redis_slowlog: Object.freeze({ engine: 'redis_readonly', queryText: 'SLOWLOG GET 32' }),
});

function timestamp(value, label) {
  const time = exact(value, label);
  if (time.d !== 1n || time.n < 0n) refuse('MALFORMED_INCIDENT_IR', `${label} must be nonnegative integer milliseconds`);
  return time;
}

function temporalChecks(input, hypotheses, observations) {
  const skew = timestamp(input.clockSkewToleranceMs ?? 0, 'Clock skew tolerance');
  const primary = observations.filter((entry) => entry.isPrimarySlo === true && entry.polarity !== 'NORMAL');
  const onset = [
    ...(input.onsetTimestampMs === undefined ? [] : [{ id: null, time: timestamp(input.onsetTimestampMs, 'Incident onset') }]),
    ...primary.map((entry) => ({ id: entry.id, time: timestamp(entry.onsetTimestampMs, `Onset of ${entry.id}`) })),
  ];
  const timeline = records(input.deployments ?? input.timeline ?? [], 'Deploy timeline');
  const timelineIds = uniqueIds(timeline.map((entry) => entry?.changeRef ?? entry?.id), 'Deploy timeline');
  const changes = new Map(timeline.map((entry, i) => [
    timelineIds[i], timestamp(entry.changeTimestampMs ?? entry.timestampMs ?? entry.deployedAtMs, `Change time of ${timelineIds[i]}`),
  ]));
  const widened = new Map();
  const witnesses = [];
  for (const hypothesis of hypotheses) {
    if (!['deploy', 'config'].includes(hypothesis.kind) && hypothesis.changeTimestampMs === undefined
        && !changes.has(hypothesis.changeRef)) continue;
    const declared = hypothesis.changeTimestampMs === undefined ? null : timestamp(hypothesis.changeTimestampMs, `Change time of ${hypothesis.id}`);
    const recorded = changes.get(hypothesis.changeRef);
    if (declared && recorded && compare(declared, recorded) !== 0) {
      refuse('MALFORMED_INCIDENT_IR', `Hypothesis ${hypothesis.id} conflicts with the deploy timeline`);
    }
    const change = recorded ?? declared;
    if (!change || onset.length === 0) {
      refuse('MISSING_TEMPORAL_EVIDENCE', `Hypothesis ${hypothesis.id} requires a change time and anomaly onset`);
    }
    for (const { id, time } of onset) {
      if (compare(add(time, skew), change) < 0) {
        refuse('TEMPORAL_PRECEDENCE_VIOLATION', `Anomaly ${id ?? 'onset'} predates change for ${hypothesis.id}`);
      }
      const ambiguous = compare(abs(subtract(change, time)), skew) <= 0;
      witnesses.push({ hypothesis: hypothesis.id, observation: id, change, onset: time, skew,
        status: ambiguous ? 'TEMPORAL_AMBIGUITY_WIDENED' : 'CAUSALLY_ADMISSIBLE' });
      if (!ambiguous) continue;
      for (const entry of observations) {
        if ((id === null && entry.polarity !== 'NORMAL') || entry.id === id) {
          if (!widened.has(entry.id)) widened.set(entry.id, new Set());
          widened.get(entry.id).add(hypothesis.id);
        }
      }
    }
  }
  return { widened, witnesses };
}

const destructivePattern = /\b(?:DROP|TRUNCATE|DELETE|RENAME|MODIFY|CHANGE|ALTER\s+(?:COLUMN|TYPE))\b|\bALTER[\s\S]*\bALTER\b/i;

function requireReversibleRollback(input, actions) {
  const migrations = [...list(input.migrations ?? [], 'Migrations')];
  if (input.diffAnalysis !== undefined) migrations.push(input.diffAnalysis);
  if (input.migration !== undefined) migrations.push(input.migration);
  if (migrations.some((migration) => !migration || typeof migration !== 'object' || Array.isArray(migration))) {
    refuse('MALFORMED_INCIDENT_IR', 'Migration analyses must be objects');
  }
  const rollbacks = actions.filter(({ id, actionKind, kind }) =>
    actionKind === 'rollback' || kind === 'rollback' || /^rollback/i.test(id));
  if (rollbacks.length === 0) return;
  const blocked = migrations.some((migration) => {
    const statements = [
      ...list(migration.statements ?? [], 'Migration statements'),
      ...list(migration.ddlMatches ?? [], 'DDL matches').map((match) => match?.statement),
      ...(migration.ddl === undefined ? [] : [migration.ddl]),
    ];
    if (statements.some((statement) => typeof statement !== 'string')) {
      refuse('MALFORMED_INCIDENT_IR', 'Migration statements must be strings');
    }
    const destructive = migration.destructiveDdlDetected === true || migration.destructive === true
      || statements.some((statement) => destructivePattern.test(statement));
    return migration.applied !== false && (migration.irreversible === true
      || migration.reversible === false || (destructive && migration.downMigrationTested !== true));
  });
  if (blocked || rollbacks.some(({ reversible }) => reversible === false)) {
    refuse('IRREVERSIBLE_DDL_BLOCK', 'Rollback requires a reversible change and a tested down migration for destructive DDL');
  }
}

function compilePayoffs(states, actions) {
  return actions.map((action) => {
    if (action.utilities !== undefined || action.payoffs !== undefined) return action;
    return { id: action.id, utilities: Object.fromEntries(states.map((state) => {
      const downtime = exact(own(action.downtimeCost, state), `Downtime cost of ${action.id} in ${state}`);
      const dataLoss = exact(own(action.dataLossCost, state), `Data loss cost of ${action.id} in ${state}`);
      if (downtime.n < 0n || dataLoss.n < 0n) refuse('INVALID_INCIDENT_COST', 'Incident costs must be nonnegative');
      return [state, neg(add(downtime, dataLoss))];
    })) };
  });
}

export function runIncident(input) {
  try {
    const { topology, hypotheses, observations = [], actions, probes = [] } = input ?? {};
    if (!topology) refuse('TOPOLOGY_INCOMPLETE', 'Incident requires a service topology');
    const { order, reach } = validateDag(topology);
    const states = uniqueIds(records(hypotheses, 'Hypotheses', 2), 'Hypotheses');
    uniqueIds(records(observations, 'Telemetry observations'), 'Telemetry observations');
    uniqueIds(records(actions, 'Incident actions', 2), 'Incident actions');
    uniqueIds(records(probes, 'Incident probes'), 'Incident probes');
    const nodes = new Map(topology.nodes.map((node) => [typeof node === 'string' ? node : node.id, node]));
    const byState = new Map(hypotheses.map((hypothesis, i) => [states[i], hypothesis]));
    for (const { nodeId } of hypotheses) {
      if (nodeId !== 'external' && !nodes.has(nodeId)) refuse('TOPOLOGY_INCOMPLETE', 'Hypothesis references an undeclared node');
    }
    for (const { nodeId } of observations) {
      if (!nodes.has(nodeId)) refuse('TOPOLOGY_INCOMPLETE', 'Observation references an undeclared node');
    }
    const domains = new Map([...nodes].map(([id, node]) => [id, list(node.sharedFaultDomains ?? [], 'Shared fault domains')]));
    const sharesDomain = (left, right) => domains.get(left)?.some((domain) => domains.get(right)?.includes(domain)) === true;
    const related = (left, right, state) => {
      if (reach.get(left)?.has(right) || reach.get(right)?.has(left) || sharesDomain(left, right)) return true;
      const conditioned = byState.get(state)?.nodeId;
      return order.some((source) => source !== conditioned && reach.get(source).has(left) && reach.get(source).has(right));
    };

    const temporal = temporalChecks(input, hypotheses, observations);
    requireReversibleRollback(input, actions);
    const compiledProbes = probes.map((probe) => {
      const fixed = Object.hasOwn(INCIDENT_PROBES, probe.id) ? INCIDENT_PROBES[probe.id] : null;
      if (probe.readOnly !== true || !fixed
          || (probe.queryText !== undefined && probe.queryText !== fixed.queryText)
          || (probe.engine !== undefined && probe.engine !== fixed.engine)) {
        refuse('NON_READONLY_PROBE_REFUSED', `Probe ${probe.id} is outside the read-only allowlist`);
      }
      if (probe.targetNodeId !== undefined && !nodes.has(probe.targetNodeId)) {
        refuse('TOPOLOGY_INCOMPLETE', `Probe ${probe.id} references an undeclared node`);
      }
      let cost = probe.cost ?? probe.bleedCost;
      if (cost === undefined && probe.latencySeconds !== undefined) {
        const latency = exact(probe.latencySeconds, 'Probe latency');
        const rate = exact(input.bleedRatePerSecond, 'Outage bleed rate');
        if (latency.n <= 0n || rate.n < 0n) refuse('INVALID_PROBE_COST', 'Probe latency must be positive and bleed rate nonnegative');
        cost = multiply(latency, rate);
      }
      return { ...probe, cost, independentOfObservations: probe.independentOfObservations === true
        && (observations.length === 0 || (probe.targetNodeId !== undefined
          && !observations.some(({ nodeId }) => states.some((state) => related(nodeId, probe.targetNodeId, state))))) };
    });
    const evidence = observations.map((entry) => ({
      ...entry, likelihoods: Object.fromEntries(states.map((state) => {
        const hypothesis = byState.get(state);
        let bounds = interval(own(entry.likelihoods, state),
          `Likelihood of ${entry.id} in ${state}`);
        if (entry.ambientRate !== undefined && hypothesis.kind !== 'other_unknown'
            && hypothesis.nodeId !== 'external' && !reach.get(hypothesis.nodeId).has(entry.nodeId)
            && !sharesDomain(hypothesis.nodeId, entry.nodeId)) {
          const ambient = interval(entry.ambientRate, `Ambient rate for ${entry.id}`);
          if (compare(bounds[1], ambient[1]) > 0) {
            refuse('UNREACHABLE_LIKELIHOOD_CONFLICT', `${state} cannot reach ${entry.id} in the service DAG`);
          }
          bounds = ambient;
        }
        if (temporal.widened.get(entry.id)?.has(state)) bounds = [ZERO, bounds[1]];
        return [state, bounds];
      })),
    }));
    const result = decideAndPlanVoI({
      states: hypotheses, priors: input.priors, observations: evidence, dag: topology, independence: input.independence,
      actions: compilePayoffs(states, actions), probes: compiledProbes,
    }, { independenceConflict: (left, right, state) => related(left.nodeId, right.nodeId, state),
      requirePositiveSupport: input.requirePositiveSupport === true });
    return result.status === 'REFUSED' ? result : {
      pack: 'incident', ...result, temporalWitness: temporal.witnesses,
      reachability: Object.fromEntries(order.map((id) => [id, [...reach.get(id)]])),
    };
  } catch (error) {
    return refusalResult(error);
  }
}
