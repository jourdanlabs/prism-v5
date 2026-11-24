# PRISM v5

COSMIC K5 implements the credal value-of-information kernel (`@omnis/credal-voi-kernel`) as the `@omnis/prism-v5` Node.js package. It solves multi-state decisions with exact interval probabilities and utilities. The Day-1 packs implement the structured incident and clinical Bayes paths from `08-OMNIS-INCIDENT.md` and Leg A of `04-OMNIS-EVIDENCE.md`.

Requires Node.js 22 or later. The package uses Node built-ins and has no install step.

```sh
node --test test/prism-v5.test.mjs
node bin/prism-v5.mjs bench
```

## Exact inference and decisions

Enter probabilities, costs, and utilities as integers or strings such as `"7/12"` and `"0.125"`. An interval is `[lo, hi]` or `{ "lo": lo, "hi": hi }`. A scalar specifies a point interval. JavaScript callers can also pass `bigint` or reduced rational objects. CLI and MCP results encode rationals as reduced `"n/d"` strings.

- **DAG and evidence.** The DAG uses `nodes` and directed `edges` of the form `{ from, to }`. An observation supplies `id`, optional `nodeId`, and a likelihood interval for each state. Without an independence license, the conjunction has bounds `[max(0, 1 − Σ(1 − loᵢ)), min(hiᵢ)]`. To license a product, supply `independence: { groups: [[...], [...]] }` covering all observations exactly once. Every group can contain dependent observations, and the groups must be mutually independent conditional on each state. An array of IDs is shorthand for all singleton groups. A topology conflict falls back to a Fréchet conjunction and reports `UNWITNESSED_INDEPENDENCE_CASCADE`. A known interval for the entire conjunction can be supplied as `jointLikelihoods` in place of observations.
- **Charnes–Cooper.** For prior `pₖ`, conjunction likelihood `Lₖ`, and evidence mass `Z = Σ pₖLₖ`, set `t = 1/Z`, `xₖ = t pₖ`, and `qₖ = xₖ Lₖ`. The LP enforces `Σxₖ = t`, `Σqₖ = 1`, `pₖ_lo t ≤ xₖ ≤ pₖ_hi t`, and `Lₖ_lo xₖ ≤ qₖ ≤ Lₖ_hi xₖ`. Minimizing and maximizing each `qₖ` yields its exact posterior interval. With mixed zero and positive evidence support, the default conditions on the positive-support models. The API option `requirePositiveSupport` and the incident input field of the same name can require support in every feasible model.
- **Dominance.** The kernel minimizes `(uₐ − uᵦ)·q` over the full posterior polytope. A positive margin proves strict dominance and a zero margin preserves the tie. Reports include the maximal undominated set, expected utility intervals, and exact worst-case posterior witnesses. The core also supplies E-admissibility witnesses identifying actions that attain a Bayes optimum at some feasible posterior.
- **NetVoI.** Each probe supplies `id`, `readOnly: true`, `cost`, and an outcome partition with a likelihood interval per state and outcome. The default `STATE_ONLY` scope uses a joint Fréchet model with the existing evidence, unless `independentOfObservations: true` licenses the product. Use `CONDITIONAL_ON_EVIDENCE` for likelihoods already calibrated conditional on that evidence. All outcome masses share one joint LP. Conditioning for outcome decisions uses a second Charnes–Cooper transform. Expected policy utilities use the joint mass directly because multiplying by the outcome probability cancels the denominator.
- **Probe release.** NetVoI compares the outcome policy to the best immediate action in each feasible model and subtracts cost in the same units. A recommendation requires a single proved action for every reachable outcome and strictly positive worst-case NetVoI. For an unresolved probe the reported interval is the exact model-wise optimum bound, which can include strategies that depend on knowing the model. The planner orders guaranteed-decisive probes first and then by worst-case gain, best-case gain, and ID. Simplex and unresolved-policy searches have explicit refusal limits.

These functions are available from the package entry point. The raw utilities are backed by `BigInt` rationals.

```js
import { solveCredal } from '@omnis/prism-v5'

const result = solveCredal({
  states: ['app', 'database', 'other'],
  priors: { app: '1/2', database: '1/3', other: '1/6' },
  observations: [
    { id: 'alert', likelihoods: { app: '3/4', database: '1/4', other: '1/4' } },
  ],
})
// result.posterior.app is [{ n: 3n, d: 4n }, { n: 3n, d: 4n }]
```

Use `buildCredal(input)` to obtain the LP and posterior variable indices for `decideDominance(belief, actions)` or `planVoI(belief, actions, probes)`. `decideAndPlanVoI(input)` combines both stages and returns structured refusals. A proof result contains `status: "PROVED_OPTIMAL_ACTION"` and `optimalAction`. An indeterminate action result can include `voi.status: "RECOMMEND_DIAGNOSTIC_PROBE"` and the ID of the next probe.

## Incident pack

Save the following incident model as `incident.json` and run `node bin/prism-v5.mjs incident incident.json`.

```json
{
  "clockSkewToleranceMs": 0,
  "topology": {
    "nodes": ["db", "api"],
    "edges": [{ "from": "db", "to": "api" }]
  },
  "deployments": [{ "id": "r42", "timestampMs": 100 }],
  "hypotheses": [
    { "id": "deploy", "kind": "deploy", "nodeId": "api", "changeRef": "r42", "priorInterval": "1/2" },
    { "id": "database", "kind": "dependency", "nodeId": "db", "priorInterval": "1/3" },
    { "id": "other", "kind": "other_unknown", "nodeId": "external", "priorInterval": "1/6" }
  ],
  "observations": [
    {
      "id": "api_5xx",
      "nodeId": "api",
      "onsetTimestampMs": 120,
      "isPrimarySlo": true,
      "polarity": "ANOMALOUS",
      "likelihoods": { "deploy": "3/4", "database": "1/4", "other": "1/4" }
    }
  ],
  "actions": [
    { "id": "rollback", "actionKind": "rollback", "payoffs": [0, -10, -10] },
    { "id": "failover", "actionKind": "failover", "payoffs": [-10, 0, -10] },
    { "id": "hold", "actionKind": "hold", "payoffs": [-5, -5, -5] }
  ]
}
```

The deploy posterior is `[3/4, 3/4]`. Rollback has margins of `35/6` over failover and `5/2` over hold. Payoffs can also be supplied as state-keyed maps or compiled from separate nonnegative `downtimeCost` and `dataLossCost` maps.

A change later than anomaly onset plus clock tolerance triggers `TEMPORAL_PRECEDENCE_VIOLATION`. The clock ambiguity window widens the corresponding evidence likelihoods. An observation with a supplied `ambientRate` uses that rate for unreachable hypotheses and refuses likelihoods elevated above it. A destructive applied migration with unverified reversibility triggers `IRREVERSIBLE_DDL_BLOCK` if rollback appears in the action set. The guard uses supplied migration assessments and checks structured statement text for destructive operations.

Approved probe IDs are `pg_stat_activity`, `envoy_upstream_stats`, and `redis_slowlog`. Each configured probe must have `readOnly: true`. If query text or an engine is supplied, it must match the catalog entry exported as `INCIDENT_PROBES`. Probe cost can also be computed from `latencySeconds × bleedRatePerSecond`. The pack consumes evidence and proposes modeled actions or a next diagnostic ID. Production query execution and remediation remain with the operator.

## Clinical Bayes pack

Save this synthetic model as `clinical.json` and run `node bin/prism-v5.mjs clinical clinical.json`.

```json
{
  "queryCtx": "synthetic-cohort",
  "prevalence": "1/5",
  "triage": {
    "treatPayoffs": { "disease": 8, "noDisease": -2 },
    "watchPayoffs": { "disease": 0, "noDisease": 0 },
    "candidateTest": {
      "testId": "synthetic-lab",
      "readOnly": true,
      "sensitivity": "9/10",
      "specificity": "9/10",
      "testCostHarm": "1/5"
    }
  }
}
```

The direct treat-versus-watch threshold is `1/5`. The test crosses watch at `2/37` and treat at `8/13`. Here the proved action is `TEST` with NetVoI `27/25`. Its modeled policy treats after a positive result and watches after a negative result. Accuracy intervals expand the thresholds and utilities by exact corner evaluation.

Add `observedTests` to update prevalence before triage. For example, with prevalence `1/10`, a positive observation with `lrPos: "6"` yields posterior `2/5`. Observed tests accept the result-specific `lrPos` or `lrNeg`, or both sensitivity and specificity. Multiple observed tests require a single mutual-independence license in `condIndepLicenses` covering their IDs and matching `queryCtx`. A lab considered after observed tests needs either a license covering the lab and the observed tests or `likelihoodScope: "CONDITIONAL_ON_EVIDENCE"`. Test utilities, calibration, and clinical context are supplied by the caller.

## CLI, receipts, and MCP

Both pack commands accept `-` for JSON input on stdin. Add `--sign-key private.pem` to return a result bundled with a signed receipt.

```sh
node bin/prism-v5.mjs incident incident.json --sign-key private.pem > signed.json
node bin/prism-v5.mjs verify signed.json pinned-public.pem
node bin/prism-v5.mjs mcp --pinned-key pinned-public.pem
```

The `omnis.prism.v5` receipt binds the full input and computed result using canonical JSON, SHA-256, and Ed25519. The verifier checks the signature against an independently supplied public key and verifies the receipt digest. A trusted pin comes from the verifier configuration. For per-call pins, the caller supplies a public key obtained independently of the receipt. The signature authenticates the supplied model and result as signed by the holder of that key.

The local MCP server uses protocol `2024-11-05` with newline-delimited JSON-RPC on stdin and stdout. It exposes `prism5_solve_credal`, `prism5_decide_and_plan_voi`, `prism5_run_incident`, `prism5_run_clinical_triage`, and `prism5_verify_receipt`. Use `--sign-key` on MCP startup to sign tool results. A startup pin overrides per-call pins.

## Kill-shot scorecard

| Suite | Minimal pairs | Exact answerables | Traps caught | Wrong releases |
| --- | ---: | ---: | ---: | ---: |
| SRE Incident | 10 | 10/10 | 10/10 | 0/20 |
| Clinical Bayes | 10 | 10/10 | 10/10 | 0/20 |
| **Total** | **20** | **20/20** | **20/20** | **0/40** |

The unit suite compares exact posterior bounds against prior/likelihood vertex enumeration for `K = 3, 4, 5`, and cross-checks 48 two-variable LPs with independent exact vertex calculations. It also exercises a cycling tableau, real stdio MCP, and offline receipt tamper detection.
