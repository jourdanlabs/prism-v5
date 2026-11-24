import { add, compare, divide, multiply, neg, ONE, parseExact, subtract, ZERO } from './rational.js';
import { refuse } from './input.js';

export const MAX_PIVOTS = 20_000;

/**
 * Exact tableau with one artificial variable for Phase I.
 * Equalities enter as opposing inequalities. All structural variables are nonnegative.
 */
export function simplexLP({
  c, A = [], b = [], A_eq = [], b_eq = [], sense = 'maximize', maxPivots = MAX_PIVOTS,
}) {
  if (!Array.isArray(c) || !['maximize', 'minimize'].includes(sense)
      || !Number.isSafeInteger(maxPivots) || maxPivots < 0
      || !Array.isArray(A) || !Array.isArray(b) || A.length !== b.length
      || !Array.isArray(A_eq) || !Array.isArray(b_eq) || A_eq.length !== b_eq.length) {
    refuse('INVALID_LP', 'Invalid objective, constraints or pivot limit');
  }

  const n = c.length;
  const parseRow = (row) => {
    if (!Array.isArray(row) || row.length !== n) refuse('INVALID_LP', 'Constraint width differs from objective');
    return row.map(parseExact);
  };
  const equalities = A_eq.map(parseRow);
  const equalRhs = b_eq.map(parseExact);
  const coefficients = [...A.map(parseRow), ...equalities, ...equalities.map((row) => row.map(neg))];
  const rhs = [...b.map(parseExact), ...equalRhs, ...equalRhs.map(neg)];
  const objective = c.map(parseExact);
  const m = rhs.length;
  const rhsCol = n + 1;
  const artificial = n + m;
  const basic = rhs.map((_, i) => n + i);
  const nonbasic = [...objective.map((_, j) => j), artificial];
  const tableau = coefficients.map((row, i) => [...row, neg(ONE), rhs[i]]);
  tableau.push([...objective.map((value) => sense === 'maximize' ? neg(value) : value), ZERO, ZERO]);
  tableau.push([...Array(n).fill(ZERO), ONE, ZERO]);
  let pivots = 0;

  function pivot(row, column) {
    if (pivots >= maxPivots) refuse('SIMPLEX_ITERATION_LIMIT', `Exact simplex exceeded ${maxPivots} pivots`);
    pivots++;
    const pivotRow = tableau[row];
    const reciprocal = divide(ONE, pivotRow[column]);
    for (let i = 0; i < tableau.length; i++) {
      if (i === row || tableau[i][column].n === 0n) continue;
      const other = tableau[i];
      const factor = multiply(other[column], reciprocal);
      for (let j = 0; j <= rhsCol; j++) {
        if (j !== column) other[j] = subtract(other[j], multiply(pivotRow[j], factor));
      }
      other[column] = neg(factor);
    }
    for (let j = 0; j <= rhsCol; j++) {
      if (j !== column) pivotRow[j] = multiply(pivotRow[j], reciprocal);
    }
    pivotRow[column] = reciprocal;
    [basic[row], nonbasic[column]] = [nonbasic[column], basic[row]];
  }

  function optimize(objectiveRow) {
    while (true) {
      let entering = -1;
      for (let j = 0; j <= n; j++) {
        if (nonbasic[j] !== artificial && tableau[objectiveRow][j].n < 0n
            && (entering === -1 || nonbasic[j] < nonbasic[entering])) entering = j;
      }
      if (entering === -1) return true;

      let leaving = -1;
      let bestRatio;
      for (let i = 0; i < m; i++) {
        if (tableau[i][entering].n <= 0n) continue;
        const ratio = divide(tableau[i][rhsCol], tableau[i][entering]);
        const order = leaving === -1 ? -1 : compare(ratio, bestRatio);
        if (order < 0 || (order === 0 && basic[i] < basic[leaving])) {
          leaving = i;
          bestRatio = ratio;
        }
      }
      if (leaving === -1) return false;
      pivot(leaving, entering);
    }
  }

  const failure = (status) => ({ status, objective: null, point: null });
  let lowest = -1;
  for (let i = 0; i < m; i++) {
    if (rhs[i].n < 0n && (lowest === -1 || compare(rhs[i], rhs[lowest]) < 0)) lowest = i;
  }
  if (lowest !== -1) {
    pivot(lowest, n);
    if (!optimize(m + 1) || tableau[m + 1][rhsCol].n !== 0n) return failure('INFEASIBLE');
    const row = basic.indexOf(artificial);
    if (row !== -1) {
      let entering = -1;
      for (let j = 0; j <= n; j++) {
        if (tableau[row][j].n !== 0n && (entering === -1 || nonbasic[j] < nonbasic[entering])) entering = j;
      }
      if (entering !== -1) pivot(row, entering);
    }
  }

  if (!optimize(m)) return failure('UNBOUNDED');
  const point = Array(n).fill(ZERO);
  for (let i = 0; i < m; i++) {
    if (basic[i] < n) point[basic[i]] = tableau[i][rhsCol];
  }
  const value = point.reduce((total, entry, i) => add(total, multiply(entry, objective[i])), ZERO);
  return { status: 'OPTIMAL', objective: value, point };
}
