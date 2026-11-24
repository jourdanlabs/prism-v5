import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  abs, add, buildCredal, canonicalJson, compare, createReceipt, decimalPreview, decideAndPlanVoI,
  decideDominance, divide, eq, fractionText, frechet, INCIDENT_PROBES, multiply, neg, parseExact,
  rational, runClinicalTriage, runIncident, simplexLP, solveCredal, subtract, sum, verifyReceipt, ZERO, ONE,
} from '../src/index.js';
import { toWire } from '../src/core/receipt.js';
import { clinicalFixture, incidentFixture, incidentProbeFixture, lrFixture, probeFixture } from './fixtures.mjs';

const wire = (value) => toWire(value);
const bounds = (result, id) => wire(result.posterior[id]);
const run = (args, input) => spawnSync(process.execPath, ['bin/prism-v5.mjs', ...args], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), input, encoding: 'utf8', timeout: 5000,
});

test('rational arithmetic reduces signed fractions and preserves integers beyond Number precision', () => {
  const input = parseExact('9007199254740993123456789.125');
  assert.equal(fractionText(input), '72057594037927944987654313/8');
  assert.equal(fractionText(rational(10n, -20n)), '-1/2');
  assert.equal(fractionText(abs(neg(input))), fractionText(input));
  assert.equal(fractionText(add(parseExact('1/3'), parseExact('1/6'))), '1/2');
  assert.equal(fractionText(subtract(parseExact('1/3'), parseExact('1/2'))), '-1/6');
  assert.equal(fractionText(multiply(parseExact('-15/7'), parseExact('7/5'))), '-3/1');
  assert.equal(fractionText(divide(parseExact('5/12'), parseExact('-10/9'))), '-3/8');
  assert.equal(compare(parseExact('1/9007199254740993'), parseExact('1/9007199254740992')), -1);
  assert.equal(eq(parseExact('.5'), parseExact('1/2')), true);
  assert.equal(decimalPreview(parseExact('-1/3'), 5), '-0.33333');
  assert.throws(() => parseExact(0.1), TypeError);
  assert.throws(() => parseExact('1/0'), RangeError);
});

test('simplex solves exact fractional optimum with a negative RHS and an equality', () => {
  const lp = { c: [2, 1], A: [[-1, 0], [1, 0]], b: ['-1/7', '1/3'], A_eq: [[1, 1]], b_eq: ['2/3'] };
  assert.deepEqual(wire(simplexLP(lp)), { status: 'OPTIMAL', objective: '1/1', point: ['1/3', '1/3'] });
  assert.deepEqual(wire(simplexLP({ ...lp, sense: 'minimize' })),
    { status: 'OPTIMAL', objective: '17/21', point: ['1/7', '11/21'] });
});

test('simplex distinguishes infeasibility and unboundedness across both phases', () => {
  assert.equal(simplexLP({ c: [1], A: [[1], [-1]], b: [1, -2] }).status, 'INFEASIBLE');
  assert.equal(simplexLP({ c: [1], A_eq: [[1], [1]], b_eq: [0, 1] }).status, 'INFEASIBLE');
  assert.equal(simplexLP({ c: [1], A: [[-1]], b: [-1] }).status, 'UNBOUNDED');
  assert.equal(simplexLP({ c: [1] }).status, 'UNBOUNDED');
  assert.equal(simplexLP({ c: [-1], sense: 'minimize' }).status, 'UNBOUNDED');
});

test('Bland terminates Beale’s cycling tableau and the pivot limit fails closed', () => {
  const cycling = {
    c: [10, -57, -9, -24], A: [['1/2', '-11/2', '-5/2', 9], ['1/2', '-3/2', '-1/2', 1], [1, 0, 0, 0]],
    b: [0, 0, 1],
  };
  assert.deepEqual(wire(simplexLP(cycling)), {
    status: 'OPTIMAL', objective: '1/1', point: ['1/1', '0/1', '1/1', '0/1'],
  });
  assert.throws(() => simplexLP({ ...cycling, maxPivots: 1 }), { code: 'SIMPLEX_ITERATION_LIMIT' });
});

test('simplex agrees with exact line-intersection enumeration on 48 two-variable LPs', () => {
  const dot = (a, b) => sum(a.map((x, i) => multiply(x, b[i])));
  for (let seed = 0; seed < 48; seed++) {
    const A = [[1, 0], [0, 1], [-1, 0], [0, -1], [2, -1], [-1, 3]];
    const b = [3, 5, -(seed % 3), -(seed % 4), (seed % 7) - 2, (seed % 11) - 3];
    const c = [3 - (seed % 7), (seed % 9) - 4];
    const rows = A.map((entry) => entry.map(parseExact));
    const rhs = b.map(parseExact);
    const costs = c.map(parseExact);
    const values = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const [a, b] = rows[i];
        const [c, d] = rows[j];
        const det = subtract(multiply(a, d), multiply(b, c));
        if (det.n === 0n) continue;
        const point = [
          divide(subtract(multiply(rhs[i], d), multiply(b, rhs[j])), det),
          divide(subtract(multiply(a, rhs[j]), multiply(rhs[i], c)), det),
        ];
        if (rows.every((row, k) => compare(dot(row, point), rhs[k]) <= 0)) values.push(dot(costs, point));
      }
    }
    values.sort(compare);
    for (const sense of ['minimize', 'maximize']) {
      const result = simplexLP({ c, A, b, sense });
      assert.equal(result.status, values.length > 0 ? 'OPTIMAL' : 'INFEASIBLE', `LP ${seed}`);
      if (values.length > 0) {
        assert.equal(eq(result.objective, sense === 'minimize' ? values[0] : values.at(-1)), true, `LP ${seed}`);
        assert.ok(rows.every((row, i) => compare(dot(row, result.point), rhs[i]) <= 0));
      }
    }
  }
});

function boxCorners(bounds) {
  return bounds.reduce((corners, endpoints) => corners.flatMap((corner) =>
    endpoints.map((endpoint) => [...corner, endpoint])), [[]]);
}

function enumeratedPosteriors(prior, likelihood) {
  const values = prior.map(() => []);
  for (let free = 0; free < prior.length; free++) {
    for (const vertex of boxCorners(prior.map((range, i) => i === free ? [ZERO] : range))) {
      vertex[free] = subtract(ONE, sum(vertex));
      if (compare(vertex[free], prior[free][0]) < 0 || compare(vertex[free], prior[free][1]) > 0) continue;
      for (const likelihoodVertex of boxCorners(likelihood)) {
        const masses = vertex.map((value, i) => multiply(value, likelihoodVertex[i]));
        const mass = sum(masses);
        if (mass.n > 0n) masses.forEach((value, i) => values[i].push(divide(value, mass)));
      }
    }
  }
  return values.map((entries) => {
    entries.sort(compare);
    return [entries[0], entries.at(-1)];
  });
}

for (const [count, prior, likelihood] of [
  [3, [['1/5', '3/5'], ['1/10', '1/2'], ['1/5', '1/2']], [['1/10', '7/9'], ['3/10', '2/3'], ['4/13', '5/8']]],
  [4, [['1/10', '1/2'], ['1/9', '4/7'], ['1/12', '2/5'], ['1/8', '3/8']],
    [['1/7', '1/2'], ['0', '1/2'], ['1/2', '3/4'], ['1/5', '3/5']]],
  [5, [['0', '1/13'], ['1/5', '2/5'], ['1/7', '2/7'], ['1/6', '1/3'], ['1/11', '4/11']],
    [['0', '0'], ['1/3', '2/3'], ['2/5', '4/5'], ['1/2', '5/6'], ['1/4', '1/3']]],
]) {
  test(`K=${count} Charnes–Cooper bounds equal exact prior/likelihood vertex enumeration`, () => {
    const states = prior.map((_, i) => `h${i}`);
    const dictionary = (entries) => Object.fromEntries(states.map((state, i) => [state, entries[i]]));
    const input = { states, priors: dictionary(prior), jointLikelihoods: dictionary(likelihood) };
    const actual = solveCredal(input);
    assert.equal(actual.status, 'SOLVED');
    const asRational = (intervals) => intervals.map((endpoints) => endpoints.map(parseExact));
    const expected = enumeratedPosteriors(asRational(prior), asRational(likelihood));
    assert.deepEqual(wire(actual.posterior), wire(dictionary(expected)));
  });
}

test('feasibility and support use the coupled prior polytope', () => {
  const states = ['a', 'b', 'c'];
  assert.equal(solveCredal({ states, priors: { a: '1/2', b: '1/2', c: '1/2' } }).code, 'INFEASIBLE_CREDAL_SET');
  assert.equal(solveCredal({ states, priors: { a: '1/5', b: '1/5', c: '1/5' } }).code, 'INFEASIBLE_CREDAL_SET');
  const input = { states, priors: { a: 0, b: '2/3', c: '1/3' }, jointLikelihoods: { a: 1, b: 0, c: 0 } };
  assert.equal(solveCredal(input).code, 'ZERO_PROBABILITY_EVIDENCE');
  input.priors = { a: [0, '1/3'], b: ['1/3', '2/3'], c: '1/3' };
  assert.deepEqual(bounds(solveCredal(input), 'a'), ['1/1', '1/1']);
  assert.equal(solveCredal(input, { requirePositiveSupport: true }).code, 'ZERO_SUPPORT_POSSIBLE');
});

test('Fréchet bounds apply to unlicensed and causally connected evidence', () => {
  assert.deepEqual(wire(frechet([['4/5', '9/10'], ['3/5', '7/10'], ['1/2', '3/4']]
    .map((values) => values.map(parseExact)))), ['0/1', '7/10']);
  const states = ['a', 'b'];
  const likelihoods = { a: '3/4', b: '1/4' };
  const input = {
    states, priors: { a: '1/2', b: '1/2' },
    observations: [{ id: 'up', nodeId: 'db', likelihoods }, { id: 'down', nodeId: 'api', likelihoods }],
    dag: { nodes: ['db', 'api'], edges: [{ from: 'db', to: 'api' }] },
  };
  const noLicense = solveCredal(input);
  assert.deepEqual(bounds(noLicense, 'a'), ['2/3', '1/1']);
  assert.deepEqual(noLicense.warnings, ['UNWITNESSED_INDEPENDENCE_CASCADE']);
  const overridden = solveCredal({ ...input, independence: ['up', 'down'] });
  assert.deepEqual(bounds(overridden, 'a'), ['2/3', '1/1']);
  const licensed = solveCredal({ ...input, independence: ['up', 'down'], dag: { ...input.dag, edges: [] } });
  assert.deepEqual(bounds(licensed, 'a'), ['9/10', '9/10']);
  assert.equal(solveCredal({ ...input, dag: { ...input.dag, edges: [...input.dag.edges, { from: 'api', to: 'db' }] } }).code,
    'DAG_CYCLE_DETECTED');
});

test('a licensed partition multiplies independent groups and keeps within-group Fréchet', () => {
  const observations = ['first', 'second', 'third'].map((id) => ({ id, likelihoods: { x: '3/4', y: '3/4' } }));
  const result = solveCredal({ states: ['x', 'y'], priors: { x: '1/2', y: '1/2' }, observations,
    independence: { groups: [['first', 'second'], ['third']] } });
  assert.deepEqual(wire(result.factors[0].likelihood), ['3/8', '9/16']);
  assert.deepEqual(result.warnings, ['UNWITNESSED_INDEPENDENCE_CASCADE']);
});

test('malformed topology, actions and evidence fail closed with explicit input errors', () => {
  const input = { states: ['a', 'b'], priors: { a: '1/2', b: '1/2' } };
  assert.equal(solveCredal({ ...input, dag: null }).code, 'INVALID_INPUT');
  assert.equal(solveCredal({ ...input, observations: ['alert'] }).code, 'INVALID_INPUT');
  assert.equal(decideAndPlanVoI({ ...input, actions: ['x', 'y'] }).code, 'INVALID_INPUT');
  assert.equal(runIncident({ ...incidentFixture(), observations: ['alert'] }).code, 'INVALID_INPUT');
});

test('dominance uses exact posterior constraints beyond marginal boxes', () => {
  const belief = buildCredal({
    states: ['a', 'b', 'c'], priors: { a: '1/3', b: [0, '2/3'], c: [0, '2/3'] },
    jointLikelihoods: { a: 1, b: '1/2', c: '1/4' },
  });
  const decision = decideDominance(belief, [{ id: 'left', utilities: [2, 0, -1] }, { id: 'right', utilities: [0, 0, 0] }]);
  assert.equal(decision.status, 'PROVED_OPTIMAL_ACTION');
  assert.deepEqual(wire(decision.dominanceMargins), { right: '1/1' });
  assert.deepEqual(wire(decision.utilityIntervals.left), ['1/1', '1/1']);
  assert.deepEqual(decision.eAdmissibleActions, ['left']);
});

test('dominance supplies exact flip witnesses and distinguishes maximality from E-admissibility', () => {
  const belief = buildCredal({ states: ['a', 'b', 'c'], priors: { a: [0, 1], b: [0, 1], c: 0 } });
  const decision = decideDominance(belief, [
    { id: 'a', utilities: [1, 0, 0] }, { id: 'b', utilities: [0, 1, 0] },
    { id: 'below_envelope', utilities: ['2/5', '2/5', 0] },
  ]);
  assert.equal(decision.status, 'DECISION_INDETERMINATE');
  assert.deepEqual(decision.undominatedActions, ['a', 'b', 'below_envelope']);
  assert.deepEqual(decision.eAdmissibleActions, ['a', 'b']);
  assert.deepEqual(wire(decision.pairwise.a.b), { margin: '-1/1', witness: { a: '0/1', b: '1/1', c: '0/1' } });
  assert.deepEqual(wire(decision.pairwise.b.a), { margin: '-1/1', witness: { a: '1/1', b: '0/1', c: '0/1' } });
});

function accuracyProbe(id, accuracy, cost = 0) {
  const correct = parseExact(accuracy);
  const wrong = subtract(ONE, correct);
  return { id, readOnly: true, cost, outcomes: [
    { id: 'x', likelihoods: { a: correct, b: wrong } },
    { id: 'y', likelihoods: { a: wrong, b: correct } },
  ] };
}

function twoStateDecision(prior) {
  return {
    states: ['a', 'b'], priors: { a: prior, b: prior },
    actions: [{ id: 'left', utilities: [1, 0] }, { id: 'right', utilities: [0, 1] }],
  };
}

test('probe ranking uses guaranteed exact gain and ignores impossible outcomes', () => {
  const best = accuracyProbe('best', 1, '1/10');
  best.outcomes.push({ id: 'impossible', likelihoods: { a: 0, b: 0 } });
  const result = decideAndPlanVoI({ ...twoStateDecision('1/2'), probes: [
    accuracyProbe('costly', 1, '2/5'), best, accuracyProbe('uninformative', '1/2'),
  ] });
  assert.equal(result.voi.status, 'RECOMMEND_DIAGNOSTIC_PROBE');
  assert.equal(result.voi.recommendedProbe, 'best');
  assert.deepEqual(result.voi.probes.map(({ id, netVoI }) => [id, wire(netVoI)]), [
    ['best', ['2/5', '2/5']], ['costly', ['1/10', '1/10']], ['uninformative', ['0/1', '0/1']],
  ]);
  assert.deepEqual(wire(result.voi.probes[0].outcomes.at(-1)), {
    id: 'impossible', probability: ['0/1', '0/1'], decision: null,
  });
});

test('K=5 dominance and a three-outcome probe produce an exact contingent policy', () => {
  const states = ['a0', 'a1', 'b0', 'b1', 'c0'];
  const actions = [
    { id: 'a', utilities: [10, 10, 0, 0, 0] }, { id: 'b', utilities: [0, 0, 10, 10, 0] },
    { id: 'c', utilities: [0, 0, 0, 0, 10] }, { id: 'hold', utilities: [3, 3, 3, 3, 3] },
  ];
  const probes = [{
    id: 'split', readOnly: true, cost: '1/3',
    outcomes: ['a', 'b', 'c'].map((id) => ({
      id, likelihoods: Object.fromEntries(states.map((state) => [state, state.startsWith(id) ? 1 : 0])),
    })),
  }];
  const result = decideAndPlanVoI({ states, actions, probes, priors: Object.fromEntries(
    states.map((state) => [state, '1/5']),
  ) });
  assert.deepEqual(result.undominatedActions, ['a', 'b']);
  const [evaluation] = result.voi.probes;
  assert.equal(result.voi.recommendedProbe, 'split');
  assert.deepEqual(wire(evaluation.netVoI), ['17/3', '17/3']);
  assert.deepEqual(evaluation.outcomes.map(({ id, decision }) => [id, decision.optimalAction]),
    [['a', 'a'], ['b', 'b'], ['c', 'c']]);
  assert.deepEqual(wire(evaluation.outcomes[0].posterior.a0), ['1/2', '1/2']);
});

test('best-case NetVoI optimizes against the model-wise best immediate action', () => {
  const result = decideAndPlanVoI({ ...twoStateDecision(['1/4', '3/4']), probes: [accuracyProbe('sq', '7/10')] });
  assert.equal(result.voi.status, 'NO_INFORMATIVE_PROBE');
  assert.equal(result.voi.probes[0].valueBasis, 'MODEL_WISE_OPTIMUM');
  assert.deepEqual(wire(result.voi.probes[0].netVoI), ['0/1', '1/5']);
});

test('probe intervals share one conditional partition and give exact worst-case NetVoI', () => {
  const probe = { id: 'probe', readOnly: true, cost: '1/100', outcomes: [
    { id: 'x', likelihoods: { a: ['3/4', '9/10'], b: ['1/20', '1/8'] } },
    { id: 'y', likelihoods: { a: ['1/8', '1/3'], b: ['7/8', '9/10'] } },
  ] };
  const result = decideAndPlanVoI({ ...twoStateDecision('1/2'), probes: [probe] });
  assert.equal(result.voi.recommendedProbe, 'probe');
  assert.deepEqual(wire(result.voi.probes[0].netVoI), ['121/400', '151/400']);
  probe.outcomes[1].likelihoods.a = '1/2';
  assert.equal(decideAndPlanVoI({ ...twoStateDecision('1/2'), probes: [probe] }).code, 'INFEASIBLE_PROBE_OUTCOMES');
  probe.readOnly = false;
  assert.equal(decideAndPlanVoI({ ...twoStateDecision('1/2'), probes: [probe] }).code, 'NON_READONLY_PROBE_REFUSED');
});

test('an unlicensed probe uses Fréchet intersections against existing evidence', () => {
  const probe = accuracyProbe('followup', '3/4');
  const input = { ...twoStateDecision('1/2'), jointLikelihoods: { a: '1/2', b: '1/2' }, probes: [probe] };
  const dependent = decideAndPlanVoI(input).voi;
  assert.equal(dependent.status, 'NO_INFORMATIVE_PROBE');
  assert.equal(dependent.probes[0].likelihoodMethod, 'FRECHET');
  assert.deepEqual(wire(dependent.probes[0].netVoI), ['0/1', '1/2']);
  probe.independentOfObservations = true;
  const independent = decideAndPlanVoI(input).voi;
  assert.equal(independent.recommendedProbe, 'followup');
  assert.deepEqual(wire(independent.probes[0].netVoI), ['1/4', '1/4']);
});

test('incident temporal precedence is exact and clock tolerance only widens the evidence', () => {
  const input = incidentFixture();
  input.deployments[0].timestampMs = '900719925474099300000';
  input.observations[0].onsetTimestampMs = '900719925474099300020';
  assert.equal(runIncident(input).optimalAction, 'rollback');
  input.clockSkewToleranceMs = 20;
  const ambiguous = runIncident(input);
  assert.equal(ambiguous.status, 'DECISION_INDETERMINATE');
  assert.equal(ambiguous.temporalWitness[0].status, 'TEMPORAL_AMBIGUITY_WIDENED');
  assert.deepEqual(bounds(ambiguous, 'deploy'), ['0/1', '3/4']);
  input.deployments[0].timestampMs = '900719925474099300041';
  assert.equal(runIncident(input).code, 'TEMPORAL_PRECEDENCE_VIOLATION');
});

test('incident blocks destructive DDL and unsafe probes even with a decisive posterior', () => {
  const input = incidentFixture();
  input.migrations = [{ statements: ['ALTER TABLE items DROP COLUMN notes'] }];
  assert.equal(runIncident(input).code, 'IRREVERSIBLE_DDL_BLOCK');
  input.migrations[0].downMigrationTested = true;
  assert.equal(runIncident(input).optimalAction, 'rollback');
  input.probes = [{ ...probeFixture(), id: 'restart_primary' }];
  assert.equal(runIncident(input).code, 'NON_READONLY_PROBE_REFUSED');
  input.probes = [{ ...probeFixture(), queryText: INCIDENT_PROBES.pg_stat_activity.queryText }];
  assert.equal(runIncident(input).optimalAction, 'rollback');
  input.probes[0].queryText += ';';
  assert.equal(runIncident(input).code, 'NON_READONLY_PROBE_REFUSED');
});

test('incident combines downtime, data-loss, and probe latency in exact utility units', () => {
  const input = incidentProbeFixture();
  input.actions[0] = { id: 'rollback', downtimeCost: { deploy: 0, database: 9, unknown: '5/2' },
    dataLossCost: { deploy: 0, database: 1, unknown: '15/2' } };
  delete input.probes[0].cost;
  input.probes[0].latencySeconds = '3/2';
  input.bleedRatePerSecond = '2/3';
  const result = runIncident(input);
  assert.equal(result.status, 'DECISION_INDETERMINATE');
  assert.equal(result.voi.recommendedProbe, 'pg_stat_activity');
  assert.deepEqual(wire(result.voi.probes[0].netVoI), ['3/1', '3/1']);
});

test('incident conclusions are invariant under hypothesis and action permutation', () => {
  const input = incidentFixture();
  for (const action of input.actions) {
    action.payoffs = Object.fromEntries(input.hypotheses.map(({ id }, i) => [id, action.payoffs[i]]));
  }
  const first = runIncident(input);
  input.hypotheses.reverse();
  input.actions.reverse();
  const second = runIncident(input);
  for (const key of ['posterior', 'dominanceMargins', 'optimalAction', 'utilityIntervals', 'undominatedActions']) {
    assert.deepEqual(wire(first[key]), wire(second[key]));
  }
});

test('clinical computes exact LR+ above one and reports virtual evidence correctly', () => {
  const input = { ...clinicalFixture(['1/10', '1/5'], false),
    observedTests: [lrFixture('assay', 'POS', ['5/2', '15/2'])] };
  const result = runClinicalTriage(input);
  assert.deepEqual(bounds(result, 'disease'), ['5/23', '15/23']);
  assert.equal(result.optimalAction, 'TREAT');
  assert.deepEqual(wire(result.likelihoodRatios.assay), ['5/2', '15/2']);
  assert.ok(Object.hasOwn(result, 'virtualEvidenceNormalization'));
});

test('clinical propagates Se/Sp and LR− intervals exactly', () => {
  const result = runClinicalTriage({ ...clinicalFixture(['1/5', '1/3'], false),
    observedTests: [{ id: 'assay', result: 'NEG', sensitivity: ['4/5', '9/10'], specificity: ['3/4', '9/10'] }],
  });
  assert.deepEqual(wire(result.likelihoodRatios.assay), ['1/9', '4/15']);
  assert.deepEqual(bounds(result, 'disease'), ['1/37', '2/17']);
  assert.equal(result.optimalAction, 'WATCH');
});

test('clinical triage crosses the exact Pauker–Kassirer thresholds', () => {
  const watch = runClinicalTriage(clinicalFixture('1/20'));
  const test = runClinicalTriage(clinicalFixture());
  const treat = runClinicalTriage(clinicalFixture('7/10'));
  assert.deepEqual([watch.optimalAction, test.optimalAction, treat.optimalAction], ['WATCH', 'TEST', 'TREAT']);
  assert.deepEqual(wire(test.thresholds), {
    treatVsWatch: '1/5', test: { bounds: ['2/37', '2/37'], definedAtAllCorners: true },
    treat: { bounds: ['8/13', '8/13'], definedAtAllCorners: true },
  });
  assert.equal(test.voi.recommendedProbe, 'synthetic-lab');
  assert.deepEqual(wire(test.voi.probes[0].netVoI), ['27/25', '27/25']);
  assert.equal(runClinicalTriage(clinicalFixture('2/37')).status, 'DECISION_INDETERMINATE');
});

test('clinical tests uncertain assay corners and emits exact threshold envelopes', () => {
  const input = clinicalFixture('3/50');
  input.triage.candidateTest.sensitivity = ['4/5', '9/10'];
  input.triage.candidateTest.specificity = ['4/5', '9/10'];
  const result = runClinicalTriage(input);
  assert.equal(result.status, 'DECISION_INDETERMINATE');
  assert.deepEqual(result.undominatedActions, ['WATCH', 'TEST']);
  assert.deepEqual(wire(result.thresholds.test.bounds), ['2/37', '3/34']);
  assert.deepEqual(wire(result.thresholds.treat.bounds), ['7/16', '8/13']);
  assert.equal(result.voi.status, 'NO_INFORMATIVE_PROBE');
});

test('clinical refuses missing accuracy and unlicensed or mismatched contexts', () => {
  const input = clinicalFixture();
  delete input.triage.candidateTest.specificity;
  assert.equal(runClinicalTriage(input).code, 'MISSING_SENSITIVITY_SPECIFICITY');
  input.triage.candidateTest.specificity = '1/10';
  assert.equal(runClinicalTriage(input).code, 'NON_DIAGNOSTIC_TEST');
  input.triage.candidateTest.specificity = '9/10';
  input.observedTests = [lrFixture('one', 'POS', 2), lrFixture('two', 'POS', 3), lrFixture('three', 'NEG', '1/2')];
  input.condIndepLicenses = [['one', 'two'], ['one', 'three'], ['two', 'three']].map((testIds) => ({
    ctx: input.queryCtx, testIds,
  }));
  assert.equal(runClinicalTriage(input).code, 'UNLICENSED_INDEPENDENCE');
  input.condIndepLicenses.push({ ctx: input.queryCtx, testIds: ['one', 'two', 'three'] });
  assert.equal(runClinicalTriage(input).code, 'UNLICENSED_INDEPENDENCE');
  input.triage.candidateTest.likelihoodScope = 'CONDITIONAL_ON_EVIDENCE';
  assert.equal(runClinicalTriage(input).pack, 'clinical-bayes');
  input.observedTests[1].ctx = 'mismatched';
  assert.equal(runClinicalTriage(input).code, 'CLINICAL_CONTEXT_MISMATCH');
});

test('canonical receipts bind result and input, enforce a public-key pin and reject one-byte tampering', () => {
  const first = generateKeyPairSync('ed25519');
  const second = generateKeyPairSync('ed25519');
  const input = incidentProbeFixture();
  const result = runIncident(input);
  const receipt = createReceipt({ operation: 'incident', input, result }, first.privateKey);
  assert.equal(canonicalJson({ 2: 'b', 11: 'a', z: ONE }), '{"11":"a","2":"b","z":"1/1"}');
  assert.throws(() => canonicalJson([, 2]), TypeError);
  assert.throws(() => canonicalJson(0.1), TypeError);
  assert.equal(verifyReceipt(receipt, first.publicKey).verified, true);
  assert.equal(verifyReceipt(receipt).code, 'PINNED_PUBLIC_KEY_REQUIRED');
  assert.equal(verifyReceipt(receipt, second.publicKey).code, 'RECEIPT_SIGNER_MISMATCH');
  const tampered = canonicalJson(receipt).replace('synthetic-checkout', 'synthetic-Checkout');
  assert.equal(verifyReceipt(JSON.parse(tampered), first.publicKey).code, 'RECEIPT_DIGEST_MISMATCH');
  const changedSignature = (receipt.signature[0] === 'A' ? 'B' : 'A') + receipt.signature.slice(1);
  assert.equal(verifyReceipt({ ...receipt, signature: changedSignature }, first.publicKey).code, 'RECEIPT_SIGNATURE_INVALID');
});

test('CLI issues a signed receipt from stdin and verifies it with an offline key file', async () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const path = await mkdtemp(join(root, '.prism-v5-test-'));
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const secret = join(path, 'sign.pem');
    const pin = join(path, 'pin.pem');
    await writeFile(secret, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await writeFile(pin, publicKey.export({ type: 'spki', format: 'pem' }));
    const signed = run(['clinical', '-', '--sign-key', secret], JSON.stringify(clinicalFixture()));
    assert.equal(signed.status, 0, signed.stderr);
    assert.equal(JSON.parse(signed.stdout).result.optimalAction, 'TEST');
    const verified = run(['verify', '-', pin], signed.stdout);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).verified, true);
    const tampered = run(['verify', '-', pin], signed.stdout.replaceAll('synthetic-lab', 'Synthetic-lab'));
    assert.equal(tampered.status, 1);
    assert.equal(JSON.parse(tampered.stdout).code, 'RECEIPT_DIGEST_MISMATCH');
  } finally {
    await rm(path, { recursive: true });
  }
});

test('real NDJSON stdio MCP exposes all five tools and returns exact framed outputs', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const receipt = createReceipt({ operation: 'test', input: {}, result: { margin: '7/13' } }, privateKey);
  const pin = publicKey.export({ type: 'spki', format: 'pem' });
  const request = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
  const call = (id, name, args) => request(id, 'tools/call', { name: 'prism5_' + name, arguments: args });
  const lines = [
    request(0, 'tools/list'), request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'test', version: '1' } }),
    { jsonrpc: '2.0', method: 'notifications/initialized' }, request(2, 'tools/list'),
    call(3, 'solve_credal', { states: ['alpha', 'beta'], priors: { alpha: '3/7', beta: '4/7' } }),
    call(4, 'decide_and_plan_voi', twoStateDecision('1/2')), call(5, 'run_incident', incidentFixture()),
    call(6, 'run_clinical_triage', clinicalFixture()), call(7, 'verify_receipt', { receipt, pinnedPublicKey: pin }),
    call(8, 'verify_receipt', { receipt }), request(9, 'missing'),
  ];
  const process = run(['mcp'], lines.map((line) => JSON.stringify(line)).join('\n') + '\n{malformed\n');
  assert.equal(process.status, 0, process.stderr);
  assert.equal(process.stderr, '');
  const responses = process.stdout.trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(responses.map(({ id }) => id), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, null]);
  const [before, initialize, tools, ...calls] = responses;
  assert.equal(before.error.code, -32002);
  assert.equal(initialize.result.protocolVersion, '2024-11-05');
  assert.deepEqual(initialize.result.serverInfo, { name: 'prism-v5-mcp', version: '5.0.0' });
  assert.equal(tools.result.tools.length, 5);
  const payloads = calls.slice(0, 6).map(({ result }) => JSON.parse(result.content[0].text));
  assert.deepEqual(payloads[0].posterior.alpha, ['3/7', '3/7']);
  assert.equal(payloads[1].status, 'DECISION_INDETERMINATE');
  assert.equal(payloads[2].optimalAction, 'rollback');
  assert.equal(payloads[3].optimalAction, 'TEST');
  assert.equal(payloads[4].verified, true);
  assert.equal(payloads[5].code, 'PINNED_PUBLIC_KEY_REQUIRED');
  assert.equal(calls[6].error.code, -32601);
  assert.equal(calls[7].error.code, -32700);
});
