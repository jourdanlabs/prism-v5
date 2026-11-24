import { compare, neg, subtract } from './rational.js';
import { exact, own, records, refuse, uniqueIds } from './input.js';
import { constrain, extend, optimize, optimum, stateTerms } from './polytope.js';

export function parseActions(states, actions) {
  const ids = uniqueIds(records(actions, 'Actions', 2), 'Actions');
  return ids.map((id, i) => {
    const values = actions[i].utilities ?? actions[i].payoffs;
    if (Array.isArray(values) && values.length !== states.length) {
      refuse('INVALID_INPUT', `Utilities for ${id} must match the state count`);
    }
    return {
      id, utility: states.map((state, j) =>
        exact(own(values, Array.isArray(values) ? j : state), `Utility of ${id} in ${state}`)),
    };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function posteriorWitness({ states, posteriorColumns }, point) {
  return Object.fromEntries(states.map((state, i) => [state, point[posteriorColumns[i]]]));
}

export function utilityDifference(left, right) {
  return left.utility.map((value, i) => subtract(value, right.utility[i]));
}

export function summarizeDominance(actions, entries, utilities) {
  const pairs = Object.fromEntries(actions.map(({ id }) => [
    id, Object.fromEntries(entries.filter(({ action }) => action === id).map(({ rival, ...entry }) => [
      rival, { margin: entry.margin, witness: entry.witness },
    ])),
  ]));
  const undominatedActions = actions.filter(({ id }) => !entries.some(
    ({ rival, margin }) => rival === id && margin.n > 0n,
  )).map(({ id }) => id);
  const winner = actions.find(({ id }) => Object.values(pairs[id]).every(({ margin }) => margin.n > 0n));
  return {
    status: winner ? 'PROVED_OPTIMAL_ACTION' : 'DECISION_INDETERMINATE',
    optimalAction: winner?.id ?? null,
    dominanceMargins: winner ? Object.fromEntries(Object.entries(pairs[winner.id]).map(
      ([id, { margin }]) => [id, margin],
    )) : null,
    undominatedActions,
    pairwise: pairs,
    utilityIntervals: Object.fromEntries(utilities),
  };
}

export function evaluateDominance(belief, actions, { includeAdmissibility = true } = {}) {
  const { polytope, posteriorColumns } = belief;
  const entries = [];
  const utilities = actions.map(({ id, utility }) => [
    id, ['minimize', 'maximize'].map((sense) =>
      optimum(polytope, stateTerms(posteriorColumns, utility), sense).objective),
  ]);
  for (let i = 0; i < actions.length; i++) {
    for (let j = i + 1; j < actions.length; j++) {
      const left = actions[i];
      const right = actions[j];
      const terms = stateTerms(posteriorColumns, utilityDifference(left, right));
      const low = optimum(polytope, terms, 'minimize');
      const high = optimum(polytope, terms, 'maximize');
      entries.push({ action: left.id, rival: right.id, margin: low.objective, witness: posteriorWitness(belief, low.point) });
      entries.push({ action: right.id, rival: left.id, margin: neg(high.objective), witness: posteriorWitness(belief, high.point) });
    }
  }
  const result = summarizeDominance(actions, entries, utilities);
  if (!includeAdmissibility) return result;
  const admissible = [];
  for (const candidate of actions.filter(({ id }) => result.undominatedActions.includes(id))) {
    const restricted = extend(polytope, polytope.size);
    for (const rival of actions) {
      if (rival !== candidate) constrain(restricted, stateTerms(posteriorColumns, utilityDifference(rival, candidate)));
    }
    const proof = optimize(restricted, [], 'minimize');
    if (proof.status === 'OPTIMAL') admissible.push([candidate.id, posteriorWitness(belief, proof.point)]);
    else if (proof.status !== 'INFEASIBLE') refuse(`LP_${proof.status}`, 'Could not check action admissibility');
  }
  const bestLower = utilities.reduce((best, [, [lo]]) => compare(lo, best) > 0 ? lo : best, utilities[0][1][0]);
  const admissibleActions = admissible.map(([id]) => id);
  const competitors = actions.filter(({ id }) => admissibleActions.includes(id));
  return {
    ...result,
    eAdmissibleActions: admissibleActions,
    admissibilityWitnesses: Object.fromEntries(admissible),
    separatingHyperplanes: competitors.flatMap((left, i) => competitors.slice(i + 1).map((right) => ({
      actions: [left.id, right.id],
      normal: Object.fromEntries(utilityDifference(left, right).map((value, j) => [belief.states[j], value])),
    }))),
    maximin: { advisoryOnly: true, actions: utilities.filter(([, [lo]]) => compare(lo, bestLower) === 0).map(([id]) => id) },
  };
}

export function decideDominance(belief, actions) {
  return evaluateDominance(belief, parseActions(belief.states, actions));
}
