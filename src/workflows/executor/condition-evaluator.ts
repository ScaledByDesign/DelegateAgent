// Condition evaluator for DAG workflow `when:` expressions.
//
// Ported from Archon `packages/workflows/src/condition-evaluator.ts`. Logger
// swapped for DA's `logger.ts`. No semantic changes.
//
// Supported grammar:
//   String equality:  "$nodeId.output == 'VALUE'" / "$nodeId.output != 'VALUE'"
//   Dot notation:     "$nodeId.output.field == 'VALUE'"
//   Numeric ops:      "$nodeId.output > '80'" / ">=" / "<" / "<="
//                     (both sides must parse as finite numbers; fail-closed otherwise)
//   Compound:         "$a.output == 'X' && $b.output != 'Y'"
//                     "$a.output == 'X' || $b.output == 'Y'"
//                     AND has higher precedence than OR. No parentheses.
//
// Returns true = run this node, false = skip it. Invalid/unparseable
// expressions default to false (fail-closed = skip the node).

import { logger } from '../../logger.js';
import type { NodeOutput } from '../schemas/index.js';

/**
 * Resolve a $nodeId.output or $nodeId.output.field reference to a string value.
 * Returns empty string if the node output is not found (logs warn), if the
 * output is empty/falsy (silent), or if JSON field access fails (logs warn).
 */
function resolveOutputRef(
  nodeId: string,
  field: string | undefined,
  nodeOutputs: Map<string, NodeOutput>,
): string {
  const nodeOutput = nodeOutputs.get(nodeId);
  if (!nodeOutput) {
    logger.warn({ nodeId }, 'condition_output_ref_unknown_node');
    return '';
  }
  if (!nodeOutput.output) return '';

  if (!field) return nodeOutput.output;

  try {
    const parsed = JSON.parse(nodeOutput.output) as Record<string, unknown>;
    const value = parsed[field];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean')
      return String(value);
    if (Array.isArray(value) || typeof value === 'object')
      return JSON.stringify(value);
    return '';
  } catch {
    logger.warn(
      { nodeId, field, outputPreview: nodeOutput.output.slice(0, 100) },
      'condition_json_parse_failed',
    );
    return '';
  }
}

/**
 * Split a string on a separator, but only when not inside single-quoted regions.
 * Returns at least one element (the full trimmed string if no split occurs).
 */
function splitOutsideQuotes(expr: string, sep: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === "'") {
      inQuote = !inQuote;
      current += expr[i++];
    } else if (!inQuote && expr.startsWith(sep, i)) {
      parts.push(current.trim());
      current = '';
      i += sep.length;
    } else {
      current += expr[i++];
    }
  }
  parts.push(current.trim());
  return parts;
}

/** Pattern matching a single condition atom: $nodeId.output[.field] OPERATOR 'value' */
const atomPattern =
  /^\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?\s*(==|!=|<=|>=|<|>)\s*'([^']*)'$/;

function evaluateAtom(
  expr: string,
  nodeOutputs: Map<string, NodeOutput>,
): { result: boolean; parsed: boolean } {
  const trimmed = expr.trim();
  const match = atomPattern.exec(trimmed);

  if (!match) {
    logger.debug({ expr }, 'condition_parse_failed');
    return { result: false, parsed: false };
  }

  const [, nodeId, field, operator, expected] = match;
  if (
    nodeId === undefined ||
    operator === undefined ||
    expected === undefined
  ) {
    logger.debug({ expr }, 'condition_parse_unexpected_undefined');
    return { result: false, parsed: false };
  }

  const actual = resolveOutputRef(nodeId, field, nodeOutputs);

  let result: boolean;
  if (operator === '==' || operator === '!=') {
    result = operator === '==' ? actual === expected : actual !== expected;
  } else {
    const actualNum = parseFloat(actual);
    const expectedNum = parseFloat(expected);
    if (!Number.isFinite(actualNum) || !Number.isFinite(expectedNum)) {
      logger.debug(
        { expr, actual, expected },
        'condition_numeric_parse_failed',
      );
      return { result: false, parsed: false };
    }
    if (operator === '<') result = actualNum < expectedNum;
    else if (operator === '>') result = actualNum > expectedNum;
    else if (operator === '<=') result = actualNum <= expectedNum;
    else result = actualNum >= expectedNum;
  }

  return { result, parsed: true };
}

/**
 * Evaluate a condition expression (possibly compound) against upstream node
 * outputs. Returns result=true to run, false to skip; parsed=false on any
 * parse failure (fail-closed: result defaults to false).
 */
export function evaluateCondition(
  expr: string,
  nodeOutputs: Map<string, NodeOutput>,
): { result: boolean; parsed: boolean } {
  const trimmed = expr.trim();
  const orClauses = splitOutsideQuotes(trimmed, '||');

  for (const orClause of orClauses) {
    const andAtoms = splitOutsideQuotes(orClause, '&&');
    let orClauseResult = true;

    for (const atom of andAtoms) {
      const { result, parsed } = evaluateAtom(atom, nodeOutputs);
      if (!parsed) return { result: false, parsed: false };
      if (!result) {
        orClauseResult = false;
        break;
      }
    }

    if (orClauseResult) return { result: true, parsed: true };
  }

  return { result: false, parsed: true };
}
