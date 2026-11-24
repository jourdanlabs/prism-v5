import { buildCredal, describeBelief } from '../core/credal-dag.js';
import { evaluateDominance, parseActions, summarizeDominance } from '../core/dominance.js';
import { exact, interval, list, records, refuse, refusalResult, uniqueIds } from '../core/input.js';
import { add, compare, divide, max, min, multiply, ONE, subtract, ZERO } from '../core/rational.js';
import { evaluateProbes, parseProbes } from '../core/voi.js';

function diagnosticAccuracy(test) {
  if (test.sensitivity == null || test.specificity == null) {
    refuse('MISSING_SENSITIVITY_SPECIFICITY', `Test ${test.testId ?? test.id} requires both sensitivity and specificity`);
  }
  const sensitivity = interval(test.sensitivity, 'Sensitivity');
  const specificity = interval(test.specificity, 'Specificity');
  if (compare(add(sensitivity[1], specificity[1]), ONE) <= 0) {
    refuse('NON_DIAGNOSTIC_TEST', 'Sensitivity plus specificity cannot exceed one');
  }
  if (compare(add(sensitivity[0], specificity[0]), ONE) <= 0) {
    refuse('UNPROVED_DIAGNOSTIC_TEST', 'Sensitivity plus specificity must exceed one throughout the stated intervals');
  }
  return { sensitivity, specificity };
}

function complement([lo, hi]) { return [subtract(ONE, hi), subtract(ONE, lo)]; }

function compiledEvidence(test, id, states, context) {
  if (!['POS', 'NEG'].includes(test.result)) refuse('INVALID_CLINICAL_RESULT', `Invalid result for ${id}`);
  if (test.ctx !== undefined && test.ctx !== context) refuse('CLINICAL_CONTEXT_MISMATCH', `Test ${id} is from a different clinical context`);
  const positive = test.result === 'POS';
  const ratio = positive ? test.lrPos : test.lrNeg;
  let disease;
  let alternative;
  let likelihoodRatio;
  if (test.lrPos !== undefined || test.lrNeg !== undefined) {
    if (test.sensitivity !== undefined || test.specificity !== undefined) {
      refuse('AMBIGUOUS_CLINICAL_ACCURACY', `Test ${id} mixes likelihood ratios and sensitivity/specificity`);
    }
    if (ratio == null) refuse('MISSING_LIKELIHOOD_RATIO', `Test ${id} needs an LR for its result`);
    likelihoodRatio = interval(ratio, `Likelihood ratio of ${id}`, { upper: null, strictLower: true });
    // The fixed common scale cancels in Bayes' rule and keeps the virtual weights in [0,1].
    const scale = max(ONE, likelihoodRatio[1]);
    disease = likelihoodRatio.map((value) => divide(value, scale));
    alternative = [divide(ONE, scale), divide(ONE, scale)];
  } else {
    const { sensitivity, specificity } = diagnosticAccuracy(test);
    disease = positive ? sensitivity : complement(sensitivity);
    alternative = positive ? complement(specificity) : specificity;
    likelihoodRatio = [alternative[1].n === 0n ? 'INFINITY' : divide(disease[0], alternative[1]),
      alternative[0].n === 0n ? 'INFINITY' : divide(disease[1], alternative[0])];
  }
  return { id, likelihoods: { [states[0]]: disease, [states[1]]: alternative },
    likelihoodRatio, virtualEvidence: ratio != null };
}

function payoff(action, name) {
  return [exact(action?.disease, `${name} utility with disease`), exact(action?.noDisease, `${name} utility without disease`)];
}

function thresholdRange(crossings) {
  const defined = crossings.filter((value) => value !== null);
  if (defined.length === 0) return { bounds: null, definedAtAllCorners: false };
  return { bounds: [defined.reduce(min), defined.reduce(max)], definedAtAllCorners: defined.length === crossings.length };
}

function mergeCorners(actions, corners) {
  const entries = actions.flatMap(({ id }) => actions.filter((rival) => rival.id !== id).map((rival) => {
    const weakest = corners.reduce((a, b) =>
      compare(a.decision.pairwise[id][rival.id].margin, b.decision.pairwise[id][rival.id].margin) <= 0 ? a : b,
    );
    const { margin, witness } = weakest.decision.pairwise[id][rival.id];
    return { action: id, rival: rival.id, margin, witness: {
      posterior: witness, sensitivity: weakest.se, specificity: weakest.sp,
    } };
  }));
  const utilities = actions.map(({ id }) => [
    id, [corners.map(({ decision }) => decision.utilityIntervals[id][0]).reduce(min),
      corners.map(({ decision }) => decision.utilityIntervals[id][1]).reduce(max)],
  ]);
  return summarizeDominance(actions, entries, utilities);
}

export function runClinicalTriage(input) {
  try {
    const { targetDisease = 'disease', altState = 'noDisease', queryCtx, observedTests = [], triage } = input ?? {};
    const states = [targetDisease, altState];
    uniqueIds(states, 'Clinical states', 2);
    const prevalence = interval(input?.preTestProb ?? input?.prevalence, 'Pre-test probability');
    const ids = uniqueIds(records(observedTests, 'Observed tests').map((test) => test.testId ?? test.id), 'Observed tests');
    const licenses = list(input.condIndepLicenses ?? [], 'Clinical independence licenses');
    const observations = observedTests.map((test, i) => compiledEvidence(test, ids[i], states, queryCtx));
    if (ids.length > 1 && (typeof queryCtx !== 'string' || queryCtx.length === 0
        || !licenses.some((license) => license?.ctx === queryCtx && Array.isArray(license.testIds)
          && ids.every((id) => license.testIds.includes(id))))) {
      refuse('UNLICENSED_INDEPENDENCE', 'Multiple observed tests require a mutual-independence license for the clinical context');
    }
    const belief = buildCredal({
      states, priors: { [targetDisease]: prevalence, [altState]: complement(prevalence) },
      observations, independence: ids.length > 1 ? ids : undefined,
    });
    const description = describeBelief(belief);
    const { evidenceProbability, ...remaining } = description;
    const common = { pack: 'clinical-bayes', ...remaining,
      ...(observations.some(({ virtualEvidence }) => virtualEvidence)
        ? { virtualEvidenceNormalization: evidenceProbability } : { evidenceProbability }),
      likelihoodRatios: Object.fromEntries(observations.map(({ id, likelihoodRatio }) => [id, likelihoodRatio])) };
    if (triage === undefined) return { status: 'SOLVED', ...common };

    const treat = payoff(triage?.treatPayoffs, 'Treat');
    const watch = payoff(triage?.watchPayoffs, 'Watch');
    const benefit = subtract(treat[0], watch[0]);
    const harm = subtract(watch[1], treat[1]);
    if (benefit.n <= 0n || harm.n <= 0n) refuse('INVALID_CLINICAL_UTILITIES', 'Treating needs positive benefit with disease and positive harm without disease');
    const terminal = [{ id: 'TREAT', utilities: treat }, { id: 'WATCH', utilities: watch }];
    const actions = parseActions(states, terminal);
    const treatVsWatch = divide(harm, add(benefit, harm));
    const candidate = triage.candidateTest;
    if (candidate === undefined) return { ...common, ...evaluateDominance(belief, actions),
      thresholds: { treatVsWatch, test: null, treat: null },
      voi: { status: 'NO_INFORMATIVE_PROBE', recommendedProbe: null, probes: [] } };
    if (candidate?.readOnly !== true) refuse('NON_READONLY_PROBE_REFUSED', 'A candidate lab requires readOnly: true');
    if (candidate.ctx !== undefined && candidate.ctx !== queryCtx) {
      refuse('CLINICAL_CONTEXT_MISMATCH', 'Candidate lab is from a different clinical context');
    }
    const candidateId = candidate.testId ?? candidate.id;
    uniqueIds([...ids, candidateId], 'Clinical test IDs');
    const { sensitivity, specificity } = diagnosticAccuracy(candidate);
    if (candidate.likelihoodScope !== undefined && !['STATE_ONLY', 'CONDITIONAL_ON_EVIDENCE'].includes(candidate.likelihoodScope)) {
      refuse('INVALID_PROBE_LIKELIHOOD_SCOPE', 'Unrecognized candidate lab likelihood scope');
    }
    if (observations.length > 0 && candidate.likelihoodScope !== 'CONDITIONAL_ON_EVIDENCE'
        && !(typeof queryCtx === 'string' && queryCtx.length > 0 && licenses.some(
          (license) => license?.ctx === queryCtx && Array.isArray(license.testIds)
            && [...ids, candidateId].every((id) => license.testIds.includes(id)),
        ))) {
      refuse('UNLICENSED_INDEPENDENCE', 'Candidate lab needs accuracy conditional on observed evidence or a mutual-independence license');
    }
    const cost = exact(candidate.testCostHarm ?? candidate.cost, 'Candidate test cost');
    if (cost.n < 0n) refuse('INVALID_PROBE_COST', 'Candidate test cost must be nonnegative');
    const probes = parseProbes(states, [{
      id: candidateId, label: candidate.name, readOnly: true, cost,
      likelihoodScope: 'CONDITIONAL_ON_EVIDENCE',
      outcomes: [
        { id: 'POS', likelihoods: { [targetDisease]: sensitivity, [altState]: complement(specificity) } },
        { id: 'NEG', likelihoods: { [targetDisease]: complement(sensitivity), [altState]: specificity } },
      ],
    }]);

    const corners = [];
    for (const se of sensitivity) {
      for (const sp of specificity) {
        const falsePositiveHarm = multiply(subtract(ONE, sp), harm);
        const truePositiveBenefit = multiply(se, benefit);
        const harmAvoided = multiply(sp, harm);
        const missedBenefit = multiply(subtract(ONE, se), benefit);
        const utilities = [
          subtract(add(watch[0], truePositiveBenefit), cost),
          subtract(subtract(watch[1], falsePositiveHarm), cost),
        ];
        const testDenominator = add(falsePositiveHarm, truePositiveBenefit);
        const treatDenominator = add(harmAvoided, missedBenefit);
        corners.push({ se, sp,
          testThreshold: testDenominator.n === 0n ? null : divide(add(falsePositiveHarm, cost), testDenominator),
          treatThreshold: treatDenominator.n === 0n ? null : divide(subtract(harmAvoided, cost), treatDenominator),
          decision: evaluateDominance(belief, parseActions(states, [...terminal, { id: 'TEST', utilities }]),
            { includeAdmissibility: false }),
        });
      }
    }
    const decision = mergeCorners([...actions, { id: 'TEST' }], corners);
    const voi = evaluateProbes(belief, actions, probes, decision, { evaluateWhenDecided: decision.optimalAction === 'TEST' });
    return { ...common, ...decision, thresholds: {
      treatVsWatch,
      test: thresholdRange(corners.map(({ testThreshold }) => testThreshold)),
      treat: thresholdRange(corners.map(({ treatThreshold }) => treatThreshold)),
    }, voi };
  } catch (error) {
    return refusalResult(error);
  }
}
