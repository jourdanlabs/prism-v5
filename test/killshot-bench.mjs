import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { toWire } from '../src/core/receipt.js';
import { runIncident } from '../src/packs/incident.js';
import { runClinicalTriage } from '../src/packs/clinical-bayes.js';
import { clinicalFixture, incidentFixture, incidentProbeFixture, lrFixture, probeFixture } from './fixtures.mjs';

const proved = (action, facts = {}) => ({ status: 'PROVED_OPTIMAL_ACTION', optimalAction: action, ...facts });
const refused = (code) => ({ status: 'REFUSED', code });
const indeterminate = (facts = {}) => ({ status: 'DECISION_INDETERMINATE', optimalAction: null, ...facts });
const point = (state, value) => ({ posterior: { [state]: [value, value] } });
const rollback = proved('rollback', { ...point('deploy', '3/4'), dominanceMargins: { failover: '35/6', hold: '5/2' } });
const edit = (input, mutate) => {
  const copy = structuredClone(input);
  mutate(copy);
  return copy;
};
const pair = (name, input, mutate, answer, trap) => ({ name, input, trapInput: edit(input, mutate), answer, trap });

function incidentPairs() {
  const correlation = incidentFixture();
  correlation.observations.push({ ...correlation.observations[0], id: 'secondary', nodeId: 'monitor', isPrimarySlo: false });
  correlation.independence = ['app_5xx', 'secondary'];
  correlation.actions[2].payoffs = [-2, -2, -2];
  const reachability = incidentFixture();
  reachability.observations[0].ambientRate = '1/4';
  const diagnostic = incidentProbeFixture();
  return [
    pair('deploy precedence', incidentFixture(), (x) => { x.deployments[0].timestampMs = 121; },
      rollback, refused('TEMPORAL_PRECEDENCE_VIOLATION')),
    pair('destructive migration reversibility', { ...incidentFixture(),
      diffAnalysis: { statements: ['ALTER TABLE jobs DROP COLUMN owner'], downMigrationTested: true } },
    (x) => { x.diffAnalysis.downMigrationTested = false; }, rollback, refused('IRREVERSIBLE_DDL_BLOCK')),
    pair('static read-only probe', { ...incidentFixture(), probes: [probeFixture()] },
      (x) => { x.probes[0].queryText = 'DROP INDEX reserved_idx'; }, rollback, refused('NON_READONLY_PROBE_REFUSED')),
    pair('downstream alert cascade', correlation, (x) => { x.observations[1].nodeId = 'edge'; },
      proved('rollback', { ...point('deploy', '9/10'), dominanceMargins: { hold: '1/1' } }),
      indeterminate({ warnings: ['UNWITNESSED_INDEPENDENCE_CASCADE'], posterior: { deploy: ['2/3', '1/1'] },
        undominatedActions: ['hold', 'rollback'], voi: { status: 'NO_INFORMATIVE_PROBE' } })),
    pair('service cycle', incidentFixture(), (x) => { x.topology.edges.push({ from: 'edge', to: 'db' }); },
      rollback, refused('DAG_CYCLE_DETECTED')),
    pair('simultaneous prior mass', incidentFixture(), (x) => { x.hypotheses[2].priorInterval = '1/3'; },
      rollback, refused('INFEASIBLE_CREDAL_SET')),
    pair('zero-support telemetry', incidentFixture(), (x) => { x.observations[0].likelihoods = { deploy: 0, database: 0, unknown: 0 }; },
      rollback, refused('ZERO_PROBABILITY_EVIDENCE')),
    pair('strict release margin', incidentFixture(), (x) => { x.actions[2].payoffs = Array(3).fill('-5/2'); },
      rollback, indeterminate({ undominatedActions: ['hold', 'rollback'], pairwise: { rollback: { hold: { margin: '0/1' } } } })),
    pair('diagnostic bleed cost', diagnostic, (x) => { x.probes[0].cost = 4; },
      indeterminate({ voi: { status: 'RECOMMEND_DIAGNOSTIC_PROBE', recommendedProbe: 'pg_stat_activity',
        probes: [{ netVoI: ['3/1', '3/1'], guaranteedDecisive: true }] } }),
      indeterminate({ voi: { status: 'NO_INFORMATIVE_PROBE', recommendedProbe: null, probes: [{ netVoI: ['0/1', '0/1'] }] } })),
    pair('causal reachability', reachability, (x) => { x.observations[0].nodeId = 'db'; },
      rollback, refused('UNREACHABLE_LIKELIHOOD_CONFLICT')),
  ];
}

function clinicalPairs() {
  const seSp = { testId: 'assay', result: 'POS', sensitivity: '9/10', specificity: '9/10' };
  const cohort = { ...clinicalFixture('1/10', false),
    observedTests: [lrFixture('one', 'POS', 3), lrFixture('two', 'POS', 4)],
    condIndepLicenses: [{ ctx: 'synthetic-cohort', testIds: ['one', 'two'] }] };
  return [
    pair('LR+ above one', { ...clinicalFixture('1/10', false), observedTests: [lrFixture('assay', 'POS', 6)] },
      (x) => { x.observedTests[0].sensitivity = '9/10'; },
      proved('TREAT', point('disease', '2/5')), refused('AMBIGUOUS_CLINICAL_ACCURACY')),
    pair('LR− update', { ...clinicalFixture('1/2', false), observedTests: [lrFixture('assay', 'NEG', '1/10')] },
      (x) => { x.observedTests[0].lrPos = x.observedTests[0].lrNeg; delete x.observedTests[0].lrNeg; },
      proved('WATCH', point('disease', '1/11')), refused('MISSING_LIKELIHOOD_RATIO')),
    pair('sensitivity and specificity required', { ...clinicalFixture('1/10', false), observedTests: [seSp] },
      (x) => { delete x.observedTests[0].specificity; },
      proved('TREAT', point('disease', '1/2')), refused('MISSING_SENSITIVITY_SPECIFICITY')),
    pair('test harm at exact break-even', clinicalFixture(),
      (x) => { x.triage.candidateTest.testCostHarm = '32/25'; },
      proved('TEST', { voi: { status: 'RECOMMEND_DIAGNOSTIC_PROBE', probes: [{ netVoI: ['27/25', '27/25'] }] } }),
      indeterminate({ undominatedActions: ['TREAT', 'WATCH', 'TEST'], voi: { status: 'NO_INFORMATIVE_PROBE', probes: [{ netVoI: ['0/1', '0/1'] }] } })),
    pair('watch-to-test threshold', clinicalFixture('1/20'), (x) => { x.prevalence = '2/37'; },
      proved('WATCH', { thresholds: { test: { bounds: ['2/37', '2/37'] } } }),
      indeterminate({ undominatedActions: ['WATCH', 'TEST'], voi: { status: 'NO_INFORMATIVE_PROBE' } })),
    pair('test-to-treat threshold', clinicalFixture('2/3'), (x) => { x.prevalence = '8/13'; },
      proved('TREAT', { thresholds: { treat: { bounds: ['8/13', '8/13'] } } }),
      indeterminate({ undominatedActions: ['TREAT', 'TEST'], voi: { status: 'NO_INFORMATIVE_PROBE' } })),
    pair('interval posterior flip', { ...clinicalFixture(['1/5', '1/4'], false),
      observedTests: [lrFixture('assay', 'POS', ['2', '3'])] },
    (x) => { x.prevalence[0] = '1/10'; },
    proved('TREAT', { posterior: { disease: ['1/3', '1/2'] } }),
    indeterminate({ posterior: { disease: ['2/11', '1/2'] }, undominatedActions: ['TREAT', 'WATCH'] })),
    pair('clinical context license', cohort, (x) => { x.condIndepLicenses[0].ctx = 'another-cohort'; },
      proved('TREAT', point('disease', '4/7')), refused('UNLICENSED_INDEPENDENCE')),
    pair('perfect assay with no pre-test support', { ...clinicalFixture('1/10', false),
      observedTests: [{ ...seSp, sensitivity: 1, specificity: 1 }] },
    (x) => { x.prevalence = 0; }, proved('TREAT', point('disease', '1/1')), refused('ZERO_PROBABILITY_EVIDENCE')),
    pair('read-only lab gate', clinicalFixture(), (x) => { x.triage.candidateTest.readOnly = false; },
      proved('TEST', { thresholds: { treatVsWatch: '1/5' } }), refused('NON_READONLY_PROBE_REFUSED')),
  ];
}

function assertFacts(actual, expected, path = '') {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path);
    assert.equal(actual.length, expected.length, path);
    expected.forEach((entry, i) => assertFacts(actual[i], entry, `${path}[${i}]`));
  } else if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', path);
    for (const [key, value] of Object.entries(expected)) assertFacts(actual[key], value, `${path}.${key}`);
  } else {
    assert.equal(actual, expected, path);
  }
}

export function runBenchmark(write = console.log) {
  let answers = 0;
  let traps = 0;
  let wrongReleases = 0;
  let total = 0;
  for (const [pack, execute, pairs] of [
    ['incident', runIncident, incidentPairs()], ['clinical-bayes', runClinicalTriage, clinicalPairs()],
  ]) {
    for (const { name, input, trapInput, answer, trap } of pairs) {
      for (const [kind, scenario, expected] of [['answer', input, answer], ['trap', trapInput, trap]]) {
        total++;
        let actual;
        try {
          actual = toWire(execute(scenario));
          if (kind === 'trap') {
            assert.equal(actual.optimalAction ?? null, null);
            assert.equal(actual.voi?.recommendedProbe ?? null, null);
          }
          assertFacts(actual, expected);
          if (kind === 'answer') answers++;
          else traps++;
          write(`PASS ${pack} / ${name} / ${kind}`);
        } catch (error) {
          if (actual?.status === 'PROVED_OPTIMAL_ACTION' || actual?.voi?.recommendedProbe != null) wrongReleases++;
          write(`FAIL ${pack} / ${name} / ${kind} — ${error.message}`);
        }
      }
    }
  }
  write(`Kill-shot scorecard  ${answers}/20 answerables exact  ${traps}/20 traps caught  ${answers + traps}/${total} passed  ${wrongReleases}/${total} wrong releases`);
  return answers === 20 && traps === 20 && total === 40 && wrongReleases === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && !runBenchmark()) process.exitCode = 1;
