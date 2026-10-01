import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ComputedExpressionError,
  evaluateComputedExpression,
  formatComputedNumber,
  parseComputedExpression,
  rewriteComputedReferences,
} from '../src/computed';

test('rewrites every parsed reference without changing selectors or unrelated names', () => {
  const source = 'round(@price * var("price") + @priceExtra + @prices::index(2), 2)';
  const rewritten = rewriteComputedReferences(source, new Map([['price', 'Unit price'], ['prices', 'newPrices']]));
  assert.equal(rewritten, 'round(var("Unit price") * var("Unit price") + @priceExtra + @newPrices::index(2), 2)');
  assert.deepEqual(parseComputedExpression(rewritten).references.map(({ name }) => name), ['Unit price', 'priceExtra', 'newPrices']);
});

async function evaluate(
  expression: string,
  values: Record<string, unknown> = {},
): Promise<number> {
  const parsed = parseComputedExpression(expression);
  return evaluateComputedExpression(parsed.ast, async ({ name }) => values[name]);
}

test('applies arithmetic precedence and right-associative powers', async () => {
  assert.equal(await evaluate('2 + 3 * 4'), 14);
  assert.equal(await evaluate('2 ^ 3 ^ 2'), 512);
  assert.equal(await evaluate('-2 ^ 2'), -4);
  assert.equal(await evaluate('(-2) ^ 2'), 4);
});

test('resolves simple and quoted variable references', async () => {
  const parsed = parseComputedExpression('@price * var("Tax rate")');
  assert.deepEqual(parsed.references.map(({ name }) => name), ['price', 'Tax rate']);
  assert.equal(await evaluateComputedExpression(parsed.ast, async ({ name }) => (
    name === 'price' ? '12.50' : 0.08
  )), 1);
});

test('retains selector pipelines on references', () => {
  const parsed = parseComputedExpression('@prices::index(2) + var("Sales totals")::item(q1)');
  assert.equal(parsed.references[0].selector?.steps[0].type, 'index');
  assert.equal(parsed.references[1].selector?.steps[0].type, 'item');
});

test('supports scalar and list math functions', async () => {
  assert.equal(await evaluate('round(average(@values), 2)', { values: ['1', 2, 4] }), 2.33);
  assert.equal(await evaluate('clamp(pow(3, 2), 0, 8)'), 8);
  assert.equal(await evaluate('sum(@values, 4)', { values: [1, '2', 3] }), 10);
  assert.equal(await evaluate('max(@values)', { values: [1, 7, 3] }), 7);
});

test('every documented math function and operator has a verified result', async () => {
  for (const [expression, expected] of [
    ['abs(-2.5)', 2.5], ['round(2.346, 2)', 2.35], ['round(2.6)', 3],
    ['floor(-2.1)', -3], ['ceil(-2.1)', -2], ['min(2, -3, 4)', -3],
    ['max(2, -3, 4)', 4], ['sum(1, 2, -3)', 0], ['average(1, 2, 6)', 3],
    ['clamp(-4, 0, 8)', 0], ['clamp(10, 0, 8)', 8], ['sqrt(9)', 3],
    ['pow(2, 3)', 8], ['7 % 3', 1], ['+5 - -2', 7], ['10 / 4', 2.5],
  ] as const) assert.equal(await evaluate(expression), expected, expression);
});

test('function validation rejects invalid arity, bounds, precision, and unknown executable forms', async () => {
  for (const expression of ['abs(1,2)', 'floor()', 'ceil(1,2)', 'sqrt()', 'pow(2)', 'clamp(1,3,2)', 'round(2,1.5)', 'round(2,13)', 'min()', 'max()', 'sum()', 'average()', 'eval(1)', 'random()']) {
    await assert.rejects(() => evaluate(expression), ComputedExpressionError, expression);
  }
  for (const expression of ['1 % 0', 'pow(10,1000)']) await assert.rejects(() => evaluate(expression), ComputedExpressionError);
  for (const value of [undefined, null, false, '', ' ', '1,000', {}, [1]]) await assert.rejects(() => evaluate('@value + 1', { value }), ComputedExpressionError);
});

test('rejects loose numeric coercion and unsafe results', async () => {
  await assert.rejects(() => evaluate('@value + 1', { value: '12px' }), ComputedExpressionError);
  await assert.rejects(() => evaluate('1 / 0'), /divide by zero/u);
  await assert.rejects(() => evaluate('sqrt(-1)'), /non-finite/u);
});

test('reports invalid syntax with a source position', () => {
  assert.throws(() => parseComputedExpression('2 + )'), /character 5/u);
  assert.throws(() => parseComputedExpression('var(unquoted)'), /quoted variable name/u);
  assert.throws(() => parseComputedExpression('@items::unknown(1)'), /Invalid variable selector/u);
});

test('bounds expression size before parsing or evaluation can exhaust the stack', () => {
  assert.throws(() => parseComputedExpression('1+'.repeat(6_000) + '1'), /cannot exceed 10000 characters/u);
  assert.throws(() => parseComputedExpression(Array.from({ length: 1_100 }, () => '1').join('+')), /cannot exceed 2048 tokens/u);
});

test('formats optional fixed precision without changing default numeric values', () => {
  assert.equal(formatComputedNumber(2.5), 2.5);
  assert.equal(formatComputedNumber(2.5, 2), '2.50');
});
