export function incidentFixture() {
  return {
    incidentId: 'synthetic-checkout',
    clockSkewToleranceMs: 0,
    topology: {
      nodes: ['db', 'app', 'edge', 'monitor'],
      edges: [{ from: 'db', to: 'app' }, { from: 'app', to: 'edge' }],
    },
    hypotheses: [
      { id: 'deploy', nodeId: 'app', kind: 'deploy', changeRef: 'release-42', priorInterval: '1/2' },
      { id: 'database', nodeId: 'db', kind: 'dependency', priorInterval: '1/3' },
      { id: 'unknown', nodeId: 'external', kind: 'other_unknown', priorInterval: '1/6' },
    ],
    deployments: [{ id: 'release-42', timestampMs: 100 }],
    observations: [{
      id: 'app_5xx', nodeId: 'app', isPrimarySlo: true, polarity: 'ANOMALOUS', onsetTimestampMs: 120,
      likelihoods: { deploy: '3/4', database: '1/4', unknown: '1/4' },
    }],
    actions: [
      { id: 'rollback', actionKind: 'rollback', payoffs: [0, -10, -10] },
      { id: 'failover', actionKind: 'failover', payoffs: [-10, 0, -10] },
      { id: 'hold', actionKind: 'hold', payoffs: [-5, -5, -5] },
    ],
  };
}

export function probeFixture() {
  return {
    id: 'pg_stat_activity', readOnly: true, cost: 1, targetNodeId: 'db', outcomes: [
      { id: 'deploy_pattern', likelihoods: { deploy: 1, database: 0, unknown: 0 } },
      { id: 'no_deploy_pattern', likelihoods: { deploy: 0, database: 1, unknown: 1 } },
    ],
  };
}

export function incidentProbeFixture() {
  const input = incidentFixture();
  input.onsetTimestampMs = 120;
  input.observations = [];
  input.priors = { deploy: '2/5', database: '2/5', unknown: '1/5' };
  input.actions[2].payoffs = [-7, -7, -7];
  input.probes = [probeFixture()];
  return input;
}

export function clinicalFixture(prevalence = '1/5', withLab = true) {
  return {
    queryCtx: 'synthetic-cohort',
    prevalence,
    triage: {
      treatPayoffs: { disease: 8, noDisease: -2 },
      watchPayoffs: { disease: 0, noDisease: 0 },
      ...(withLab ? { candidateTest: {
        testId: 'synthetic-lab', readOnly: true, sensitivity: '9/10', specificity: '9/10', testCostHarm: '1/5',
      } } : {}),
    },
  };
}

export function lrFixture(testId, result, ratio) {
  return { testId, result, ctx: 'synthetic-cohort', [result === 'POS' ? 'lrPos' : 'lrNeg']: ratio };
}
