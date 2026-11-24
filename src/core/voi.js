import { buildCredal, describeBelief, posteriorBounds } from './credal-dag.js';
import { evaluateDominance, parseActions, posteriorWitness } from './dominance.js';
import { exact, interval, own, records, refuse, refusalResult, uniqueIds } from './input.js';
import { condition, constrain, extend, optimum, stateTerms } from './polytope.js';
import { add, compare, min, neg, ONE, subtract, sum, ZERO } from './rational.js';

const POLICY_LIMIT = 4096;

export function parseProbes(states, probes, { requireReadOnlyProbes = true } = {}) {
  const ids = uniqueIds(records(probes, 'Probes'), 'Probes');
  return ids.map((id, index) => {
    const probe = probes[index];
    if (requireReadOnlyProbes && probe.readOnly !== true) {
      refuse('NON_READONLY_PROBE_REFUSED', `Probe ${id} lacks readOnly: true`);
    }
    const cost = exact(probe.cost, `Cost of probe ${id}`);
    if (cost.n < 0n) refuse('INVALID_PROBE_COST', `Probe ${id} has a negative cost`);
    const scope = probe.likelihoodScope ?? 'STATE_ONLY';
    if (!['STATE_ONLY', 'CONDITIONAL_ON_EVIDENCE'].includes(scope)) {
      refuse('INVALID_PROBE_LIKELIHOOD_SCOPE', `Unrecognized likelihood scope for ${id}`);
    }
    const outcomeIds = uniqueIds(records(probe.outcomes, `Outcomes of ${id}`, 2), `Outcomes of ${id}`);
    const outcomes = outcomeIds.map((outcome, o) => ({
      id: outcome,
      bounds: states.map((state) =>
        interval(own(probe.outcomes[o].likelihoods, state), `Likelihood of ${id}/${outcome} in ${state}`)),
    }));
    for (let i = 0; i < states.length; i++) {
      const lows = sum(outcomes.map(({ bounds }) => bounds[i][0]));
      const highs = sum(outcomes.map(({ bounds }) => bounds[i][1]));
      if (compare(lows, ONE) > 0 || compare(highs, ONE) < 0) {
        refuse('INFEASIBLE_PROBE_OUTCOMES', `Outcomes of ${id} cannot sum to one in ${states[i]}`);
      }
    }
    return { id, cost, outcomes, label: probe.label ?? id, scope, independent: probe.independentOfObservations === true };
  });
}

function jointProbeModel(belief, probe) {
  const { states, polytope, posteriorColumns, priorColumns } = belief;
  const stateOnly = probe.scope === 'STATE_ONLY' && !probe.independent;
  // Certain evidence leaves state-conditional likelihoods unchanged.
  const needsIntersection = stateOnly && compare(belief.evidenceProbability[0], ONE) < 0;
  const jointSize = states.length * probe.outcomes.length;
  const joint = extend(polytope, polytope.size + jointSize * (needsIntersection ? 2 : 1));
  const outcomeColumns = probe.outcomes.map((_, outcome) => states.map(
    (_, state) => polytope.size + outcome * states.length + state,
  ));
  for (let i = 0; i < states.length; i++) {
    const q = posteriorColumns[i];
    const x = priorColumns[i];
    const observations = outcomeColumns.map((columns) => [columns[i], ONE]);
    constrain(joint, [...observations, [q, neg(ONE)]], ZERO, true);
    if (needsIntersection) {
      constrain(joint, [...observations.map(([z]) => [z + jointSize, ONE]), [x, neg(ONE)]], ZERO, true);
    }
    for (let o = 0; o < probe.outcomes.length; o++) {
      const z = outcomeColumns[o][i];
      const [lo, hi] = probe.outcomes[o].bounds[i];
      if (needsIntersection) {
        // x is scaled prior mass, q is scaled evidence mass, r is scaled outcome mass.
        // The shared sums make all Fréchet intersections belong to the same partition.
        const r = z + jointSize;
        constrain(joint, [[r, ONE], [x, neg(hi)]]);
        constrain(joint, [[r, neg(ONE)], [x, lo]]);
        constrain(joint, [[z, ONE], [r, neg(ONE)]]);
        constrain(joint, [[q, ONE], [r, ONE], [x, neg(ONE)], [z, neg(ONE)]]);
      } else {
        constrain(joint, [[z, ONE], [q, neg(hi)]]);
        constrain(joint, [[z, neg(ONE)], [q, lo]]);
      }
    }
  }
  return { joint, outcomeColumns, method: stateOnly ? 'FRECHET' : probe.scope === 'CONDITIONAL_ON_EVIDENCE'
    ? 'CONDITIONAL_LIKELIHOODS' : 'LICENSED_INDEPENDENCE' };
}

function bestPolicyGap(joint, terms, actions, belief, floor) {
  // Maximize the minimum gain over immediate actions, using a shifted hypograph.
  const comparison = extend(joint, joint.size + 1);
  const gap = joint.size;
  for (const action of actions) {
    constrain(comparison, [
      [gap, ONE],
      ...terms.map(([column, coefficient]) => [column, neg(coefficient)]),
      ...stateTerms(belief.posteriorColumns, action.utility),
    ], neg(floor));
  }
  return add(optimum(comparison, [[gap, ONE]], 'maximize').objective, floor);
}

function policyBounds(joint, reachable, probe, actions, belief, decisive) {
  const allUtilities = actions.flatMap(({ utility }) => utility);
  const lowUtility = allUtilities.reduce(min);
  const highUtility = allUtilities.reduce((a, b) => compare(a, b) >= 0 ? a : b);
  const floor = subtract(lowUtility, highUtility);
  const candidates = reachable.map(({ decision }) => decision.optimalAction
    ? actions.filter(({ id }) => id === decision.optimalAction)
    : actions.filter(({ id }) => decision.undominatedActions.includes(id)));

  let lowest;
  if (decisive) {
    const policy = reachable.flatMap(({ columns }, i) => stateTerms(columns, candidates[i][0].utility));
    for (const action of actions) {
      const result = optimum(joint, [
        ...policy, ...stateTerms(belief.posteriorColumns, action.utility.map(neg)),
      ], 'minimize');
      if (!lowest || compare(result.objective, lowest.objective) < 0) lowest = { ...result, baseline: action.id };
    }
    return {
      interval: [subtract(lowest.objective, probe.cost), subtract(bestPolicyGap(joint, policy, actions, belief, floor), probe.cost)],
      worstCase: { immediateAction: lowest.baseline, posterior: posteriorWitness(belief, lowest.point) },
    };
  }

  // For an unresolved probe these are the exact model-wise Bayes envelope bounds.
  // The lower bound minimizes the sum of outcome maxima with one epigraph per outcome.
  const epigraph = extend(joint, joint.size + reachable.length);
  const maxima = reachable.map((_, i) => [joint.size + i, ONE]);
  for (let i = 0; i < reachable.length; i++) {
    for (const action of candidates[i]) {
      constrain(epigraph, [
        ...stateTerms(reachable[i].columns, action.utility.map((utility) => subtract(utility, lowUtility))),
        [joint.size + i, neg(ONE)],
      ]);
    }
  }
  for (const action of actions) {
    const result = optimum(epigraph, [
      ...maxima, ...stateTerms(belief.posteriorColumns, action.utility.map(neg)),
    ], 'minimize');
    if (!lowest || compare(result.objective, lowest.objective) < 0) lowest = { ...result, baseline: action.id };
  }

  // The upper bound maximizes over fixed contingent policies and then over models.
  const count = candidates.reduce((total, options) => total * BigInt(options.length), 1n);
  if (count > BigInt(POLICY_LIMIT)) refuse('VOI_POLICY_LIMIT', `Probe ${probe.id} exceeds ${POLICY_LIMIT} contingent policies`);
  let upper = floor;
  for (let index = 0n; index < count; index++) {
    let choice = index;
    const policy = reachable.flatMap(({ columns }, i) => {
      const radix = BigInt(candidates[i].length);
      const candidate = candidates[i][Number(choice % radix)];
      choice /= radix;
      return stateTerms(columns, candidate.utility);
    });
    const value = bestPolicyGap(joint, policy, actions, belief, floor);
    if (compare(value, upper) > 0) upper = value;
  }
  return {
    interval: [subtract(add(lowest.objective, lowUtility), probe.cost), subtract(upper, probe.cost)],
    worstCase: { immediateAction: lowest.baseline, posterior: posteriorWitness(belief, lowest.point) },
  };
}

export function evaluateProbes(belief, actions, probes, decision, { evaluateWhenDecided = false } = {}) {
  if (decision.status === 'PROVED_OPTIMAL_ACTION' && !evaluateWhenDecided) {
    return { status: 'DECISION_ALREADY_PROVED', recommendedProbe: null, probes: [] };
  }
  const evaluations = probes.map((probe) => {
    const { joint, outcomeColumns, method } = jointProbeModel(belief, probe);
    const evaluations = probe.outcomes.map(({ id }, index) => {
      const columns = outcomeColumns[index];
      const mass = columns.map((column) => [column, ONE]);
      const hi = optimum(joint, mass, 'maximize').objective;
      const lo = hi.n === 0n ? ZERO : optimum(joint, mass, 'minimize').objective;
      if (hi.n === 0n) return { id, columns, probability: [lo, hi], decision: null };
      const conditional = { states: belief.states, posteriorColumns: columns, polytope: condition(joint, columns) };
      const decision = evaluateDominance(conditional, actions, { includeAdmissibility: false });
      return { id, columns, probability: [lo, hi], posterior: posteriorBounds(conditional), decision };
    });
    const reachable = evaluations.filter(({ decision }) => decision !== null);
    const decisive = reachable.every(({ decision }) => decision.status === 'PROVED_OPTIMAL_ACTION');
    const net = policyBounds(joint, reachable, probe, actions, belief, decisive);
    return {
      id: probe.id, label: probe.label, cost: probe.cost, likelihoodMethod: method, guaranteedDecisive: decisive,
      netVoI: net.interval, worstCase: net.worstCase, valueBasis: decisive ? 'CERTIFIED_POLICY' : 'MODEL_WISE_OPTIMUM',
      outcomes: evaluations.map(({ columns, ...outcome }) => outcome),
    };
  });
  evaluations.sort((a, b) => {
    if (a.guaranteedDecisive !== b.guaranteedDecisive) return a.guaranteedDecisive ? -1 : 1;
    return compare(b.netVoI[0], a.netVoI[0]) || compare(b.netVoI[1], a.netVoI[1])
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const recommended = evaluations.find(({ guaranteedDecisive, netVoI }) => guaranteedDecisive && netVoI[0].n > 0n);
  return {
    status: recommended ? 'RECOMMEND_DIAGNOSTIC_PROBE' : 'NO_INFORMATIVE_PROBE',
    recommendedProbe: recommended?.id ?? null,
    probes: evaluations,
  };
}

export function planVoI(belief, actions, probes, options) {
  const parsedActions = parseActions(belief.states, actions);
  const parsedProbes = parseProbes(belief.states, probes, options);
  return evaluateProbes(belief, parsedActions, parsedProbes, evaluateDominance(belief, parsedActions));
}

export function decideAndPlanVoI(input, options) {
  try {
    const belief = buildCredal(input, options);
    const actions = parseActions(belief.states, input.actions);
    const probes = parseProbes(belief.states, input.probes ?? [], options);
    const decision = evaluateDominance(belief, actions);
    return {
      ...describeBelief(belief), ...decision, voi: evaluateProbes(belief, actions, probes, decision),
    };
  } catch (error) {
    return refusalResult(error);
  }
}
