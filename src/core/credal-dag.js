import { compare, max, min, multiply, neg, ONE, subtract, sum, ZERO } from './rational.js';
import { idOf, interval, isRecord, list, own, records, refuse, refusalResult, uniqueIds } from './input.js';
import { constrain, model, optimum, stateTerms } from './polytope.js';

export function validateDag(dag) {
  if (!isRecord(dag)) refuse('INVALID_INPUT', 'DAG must be an object');
  const { nodes, edges = [] } = dag;
  const ids = uniqueIds(nodes, 'DAG nodes');
  const children = new Map(ids.map((id) => [id, new Set()]));
  const incoming = new Map(ids.map((id) => [id, 0]));
  for (const { from, to } of records(edges, 'DAG edges')) {
    if (!children.has(from) || !children.has(to)) {
      refuse('TOPOLOGY_INCOMPLETE', 'DAG edge references an undeclared node');
    }
    if (!children.get(from).has(to)) {
      children.get(from).add(to);
      incoming.set(to, incoming.get(to) + 1);
    }
  }
  const order = ids.filter((id) => incoming.get(id) === 0);
  for (let i = 0; i < order.length; i++) {
    for (const child of children.get(order[i])) {
      incoming.set(child, incoming.get(child) - 1);
      if (incoming.get(child) === 0) order.push(child);
    }
  }
  if (order.length !== ids.length) refuse('DAG_CYCLE_DETECTED', 'Causal DAG contains a cycle');

  const reach = new Map();
  for (const id of [...order].reverse()) {
    const descendants = new Set([id]);
    for (const child of children.get(id)) {
      for (const descendant of reach.get(child)) descendants.add(descendant);
    }
    reach.set(id, descendants);
  }
  return { order, reach };
}

export function frechet(intervals) {
  if (intervals.length === 0) return [ONE, ONE];
  const failureSum = sum(intervals.map(([lo]) => subtract(ONE, lo)));
  return [max(ZERO, subtract(ONE, failureSum)), intervals.reduce((hi, [, upper]) => min(hi, upper), ONE)];
}

function licensedGroups(ids, independence) {
  if (independence == null) return [ids];
  const groups = Array.isArray(independence)
    ? independence.map((id) => [id])
    : independence.groups;
  list(groups, 'Independence groups', 1);
  const named = uniqueIds(groups.flatMap((group) => uniqueIds(group, 'Independence group', 1)), 'Independence groups');
  if (named.length !== ids.length || named.some((id) => !ids.includes(id))) {
    refuse('INVALID_INDEPENDENCE_LICENSE', 'An independence partition must cover every observation once');
  }
  return groups;
}

export function buildCredal(input, {
  independenceConflict,
  requirePositiveSupport = false,
} = {}) {
  const { states: suppliedStates, priors, observations = [], dag, independence, jointLikelihoods } = input ?? {};
  const states = uniqueIds(suppliedStates, 'States', 2);
  const topology = dag === undefined ? null : validateDag(dag);
  const dagOrder = topology?.order ?? null;
  const observationIds = uniqueIds(records(observations, 'Observations'), 'Observations');
  if (topology && observations.some(({ nodeId }) => nodeId !== undefined && !topology.reach.has(nodeId))) {
    refuse('TOPOLOGY_INCOMPLETE', 'Observation references an undeclared DAG node');
  }
  const conflicts = independenceConflict ?? ((left, right) => {
    if (!topology || left.nodeId === undefined || right.nodeId === undefined) return false;
    return topology.reach.get(left.nodeId).has(right.nodeId) || topology.reach.get(right.nodeId).has(left.nodeId)
      || topology.order.some((node) => topology.reach.get(node).has(left.nodeId) && topology.reach.get(node).has(right.nodeId));
  });
  const prior = states.map((id, i) => interval(
    own(priors, id) ?? suppliedStates[i]?.priorInterval ?? suppliedStates[i]?.prior, `Prior for ${id}`,
  ));
  const lowerSum = sum(prior.map(([lo]) => lo));
  const upperSum = sum(prior.map(([, hi]) => hi));
  if (compare(lowerSum, ONE) > 0 || compare(upperSum, ONE) < 0) {
    refuse('INFEASIBLE_CREDAL_SET', 'Prior bounds cannot sum to one');
  }
  if (jointLikelihoods !== undefined && (observations.length > 0 || independence != null)) {
    refuse('INVALID_INPUT', 'Joint likelihoods must describe the entire evidence event');
  }
  const byId = new Map(observations.map((observation) => [idOf(observation, 'Observation'), observation]));
  const declaredGroups = licensedGroups(observationIds, independence);
  const warnings = new Set();
  const factors = [];
  const likelihood = states.map((state) => {
    if (jointLikelihoods !== undefined) {
      const bounds = interval(own(jointLikelihoods, state), `Joint likelihood for ${state}`);
      factors.push({ state, method: 'EXPLICIT_JOINT', groups: [], likelihood: bounds });
      return bounds;
    }
    const contradicted = declaredGroups.some((group, i) => declaredGroups.slice(i + 1).some(
      (other) => group.some((left) => other.some((right) => conflicts(byId.get(left), byId.get(right), state))),
    ));
    const groups = contradicted ? [observationIds] : declaredGroups;
    const local = groups.map((group) => ({
      observationIds: group,
      bounds: frechet(group.map((id) => interval(own(byId.get(id).likelihoods, state), `Likelihood ${id} given ${state}`))),
    }));
    if (groups.some((group) => group.length > 1)) warnings.add('UNWITNESSED_INDEPENDENCE_CASCADE');
    const bounds = local.reduce(([lo, hi], { bounds: [a, b] }) => [multiply(lo, a), multiply(hi, b)], [ONE, ONE]);
    factors.push({ state, method: groups.length > 1 ? 'LICENSED_PRODUCT' : 'FRECHET', groups: local, likelihood: bounds });
    return bounds;
  });

  const count = states.length;
  const priorModel = model(count);
  const posteriorColumns = states.map((_, i) => i);
  const priorColumns = states.map((_, i) => i + count);
  const scale = count * 2;
  const polytope = model(scale + 1);
  for (let i = 0; i < count; i++) {
    const [lo, hi] = prior[i];
    constrain(priorModel, [[i, ONE]], hi);
    constrain(priorModel, [[i, neg(ONE)]], neg(lo));
    constrain(polytope, [[priorColumns[i], ONE], [scale, neg(hi)]]);
    constrain(polytope, [[priorColumns[i], neg(ONE)], [scale, lo]]);
    constrain(polytope, [[i, ONE], [priorColumns[i], neg(likelihood[i][1])]]);
    constrain(polytope, [[i, neg(ONE)], [priorColumns[i], likelihood[i][0]]]);
  }
  constrain(priorModel, posteriorColumns.map((column) => [column, ONE]), ONE, true);
  constrain(polytope, [...priorColumns.map((column) => [column, ONE]), [scale, neg(ONE)]], ZERO, true);
  constrain(polytope, posteriorColumns.map((column) => [column, ONE]), ONE, true);
  const evidenceProbability = ['minimize', 'maximize'].map((sense, endpoint) =>
    optimum(priorModel, stateTerms(posteriorColumns, likelihood.map((bounds) => bounds[endpoint])), sense).objective,
  );
  if (evidenceProbability[1].n === 0n) refuse('ZERO_PROBABILITY_EVIDENCE', 'Evidence is impossible under every feasible model');
  if (requirePositiveSupport && evidenceProbability[0].n === 0n) {
    refuse('ZERO_SUPPORT_POSSIBLE', 'Some feasible models assign zero probability to the evidence');
  }
  return {
    states, polytope, posteriorColumns, priorColumns, dagOrder, factors, evidenceProbability,
    warnings: [...warnings],
  };
}

export function posteriorBounds({ states, polytope, posteriorColumns }) {
  return Object.fromEntries(states.map((state, i) => [
    state, ['minimize', 'maximize'].map((sense) => optimum(polytope, [[posteriorColumns[i], ONE]], sense).objective),
  ]));
}

export function describeBelief(belief) {
  const { states, dagOrder, factors, evidenceProbability, warnings } = belief;
  return { states, posterior: posteriorBounds(belief), evidenceProbability, factors, dagOrder, warnings };
}

export function solveCredal(input, options) {
  try {
    return { status: 'SOLVED', ...describeBelief(buildCredal(input, options)) };
  } catch (error) {
    return refusalResult(error);
  }
}
