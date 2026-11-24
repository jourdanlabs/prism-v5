import { add, neg, ONE, ZERO } from './rational.js';
import { refuse } from './input.js';
import { simplexLP } from './simplex-lp.js';

export function model(size) {
  return { size, A: [], b: [], A_eq: [], b_eq: [] };
}

export function row(size, terms) {
  const result = Array(size).fill(ZERO);
  for (const [index, coefficient] of terms) result[index] = add(result[index], coefficient);
  return result;
}

export function constrain(polytope, terms, rhs = ZERO, equality = false) {
  const [matrix, bounds] = equality ? ['A_eq', 'b_eq'] : ['A', 'b'];
  polytope[matrix].push(row(polytope.size, terms));
  polytope[bounds].push(rhs);
}

export function extend(source, size, homogenize = false) {
  const result = model(size);
  for (const [matrix, bounds] of [['A', 'b'], ['A_eq', 'b_eq']]) {
    result[matrix] = source[matrix].map((coefficients, i) => {
      const expanded = [...coefficients, ...Array(size - source.size).fill(ZERO)];
      if (homogenize) expanded[size - 1] = neg(source[bounds][i]);
      return expanded;
    });
    result[bounds] = homogenize ? source[bounds].map(() => ZERO) : [...source[bounds]];
  }
  return result;
}

export function condition(polytope, columns) {
  const normalized = extend(polytope, polytope.size + 1, true);
  constrain(normalized, columns.map((column) => [column, ONE]), ONE, true);
  return normalized;
}

export function optimize(polytope, terms, sense) {
  return simplexLP({ ...polytope, c: row(polytope.size, terms), sense });
}

export function optimum(polytope, terms, sense) {
  const result = optimize(polytope, terms, sense);
  if (result.status !== 'OPTIMAL') {
    refuse(`LP_${result.status}`, 'Expected a bounded, feasible objective on the credal polytope');
  }
  return result;
}

export function stateTerms(columns, coefficients) {
  return columns.map((column, i) => [column, coefficients[i]]);
}
