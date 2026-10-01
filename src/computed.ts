import { parseVariableSelector } from './tokenSyntax';
import type { VariableSelector } from './tokenSyntax';

export interface ComputedDependency {
  name: string;
  guid: string;
  selector?: string;
}

export interface ComputedReference {
  name: string;
  selector?: VariableSelector;
}

export type ComputedExpressionNode =
  | { type: 'number'; value: number }
  | { type: 'reference'; reference: ComputedReference; sourceFrom: number; sourceTo: number }
  | { type: 'unary'; operator: '+' | '-'; operand: ComputedExpressionNode }
  | { type: 'binary'; operator: '+' | '-' | '*' | '/' | '%' | '^'; left: ComputedExpressionNode; right: ComputedExpressionNode }
  | { type: 'call'; name: string; arguments: ComputedExpressionNode[] };

export interface ParsedComputedExpression {
  ast: ComputedExpressionNode;
  references: ComputedReference[];
}

interface Token {
  type: 'number' | 'identifier' | 'string' | 'reference' | 'selector' | 'operator' | 'left-paren' | 'right-paren' | 'comma' | 'end';
  value: string;
  position: number;
}

type RuntimeValue = unknown;

const MAX_EXPRESSION_LENGTH = 10_000;
const MAX_EXPRESSION_TOKENS = 2_048;

export class ComputedExpressionError extends Error {
  constructor(message: string, readonly position?: number) {
    super(position === undefined ? message : `${message} at character ${position + 1}`);
    this.name = 'ComputedExpressionError';
  }
}

export function parseComputedExpression(source: string): ParsedComputedExpression {
  if (source.length > MAX_EXPRESSION_LENGTH) {
    throw new ComputedExpressionError(`Computed expressions cannot exceed ${MAX_EXPRESSION_LENGTH} characters`);
  }
  const parser = new ComputedParser(source);
  const ast = parser.parse();
  const references = new Map<string, ComputedReference>();
  collectReferences(ast, references);
  return { ast, references: [...references.values()] };
}

export async function evaluateComputedExpression(
  ast: ComputedExpressionNode,
  resolveReference: (reference: ComputedReference) => Promise<unknown>,
): Promise<number> {
  const value = await evaluateNode(ast, resolveReference);
  return toFiniteNumber(value, 'The expression result');
}

export function normalizeComputedPrecision(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  return value >= 0 && value <= 12 ? value : undefined;
}

/** Rewrite parsed references only, preserving operators, literals and selectors. */
export function rewriteComputedReferences(source: string, replacements: ReadonlyMap<string, string>): string {
  const { ast } = parseComputedExpression(source);
  const edits: Array<{ from: number; to: number; value: string }> = [];
  const visit = (node: ComputedExpressionNode): void => {
    if (node.type === 'reference') {
      const name = replacements.get(node.reference.name);
      if (name) edits.push({ from: node.sourceFrom, to: node.sourceTo, value: /^[\p{L}\p{N}_.]+$/u.test(name) ? `@${name}` : `var(${JSON.stringify(name)})` });
    } else if (node.type === 'binary') { visit(node.left); visit(node.right); }
    else if (node.type === 'unary') visit(node.operand);
    else if (node.type === 'call') node.arguments.forEach(visit);
  };
  visit(ast);
  for (const edit of edits.sort((a, b) => b.from - a.from)) source = source.slice(0, edit.from) + edit.value + source.slice(edit.to);
  return source;
}

export function formatComputedNumber(value: number, precision?: number): string | number {
  return precision === undefined ? value : value.toFixed(precision);
}

async function evaluateNode(
  node: ComputedExpressionNode,
  resolveReference: (reference: ComputedReference) => Promise<unknown>,
): Promise<RuntimeValue> {
  if (node.type === 'number') return node.value;
  if (node.type === 'reference') return resolveReference(node.reference);
  if (node.type === 'unary') {
    const value = toFiniteNumber(await evaluateNode(node.operand, resolveReference), 'Unary operand');
    return node.operator === '-' ? -value : value;
  }
  if (node.type === 'binary') {
    const left = toFiniteNumber(await evaluateNode(node.left, resolveReference), 'Left operand');
    const right = toFiniteNumber(await evaluateNode(node.right, resolveReference), 'Right operand');
    let result: number;
    switch (node.operator) {
      case '+': result = left + right; break;
      case '-': result = left - right; break;
      case '*': result = left * right; break;
      case '/':
        if (right === 0) throw new ComputedExpressionError('Cannot divide by zero');
        result = left / right;
        break;
      case '%':
        if (right === 0) throw new ComputedExpressionError('Cannot divide by zero');
        result = left % right;
        break;
      case '^': result = left ** right; break;
    }
    return requireFiniteResult(result);
  }

  const values = await Promise.all(node.arguments.map((argument) => evaluateNode(argument, resolveReference)));
  return evaluateFunction(node.name, values);
}

function evaluateFunction(name: string, values: RuntimeValue[]): number {
  const numbers = (): number[] => values.flatMap((value, index) => {
    const candidates = Array.isArray(value) ? value : [value];
    return candidates.map((candidate) => toFiniteNumber(candidate, `Argument ${index + 1} to ${name}()`));
  });
  const exact = (count: number): number[] => {
    if (values.length !== count) {
      throw new ComputedExpressionError(`${name}() expects ${count} argument${count === 1 ? '' : 's'}`);
    }
    return values.map((value, index) => toFiniteNumber(value, `Argument ${index + 1} to ${name}()`));
  };

  let result: number;
  switch (name) {
    case 'abs': result = Math.abs(exact(1)[0]); break;
    case 'floor': result = Math.floor(exact(1)[0]); break;
    case 'ceil': result = Math.ceil(exact(1)[0]); break;
    case 'sqrt': result = Math.sqrt(exact(1)[0]); break;
    case 'pow': {
      const [base, exponent] = exact(2);
      result = base ** exponent;
      break;
    }
    case 'round': {
      if (values.length < 1 || values.length > 2) {
        throw new ComputedExpressionError('round() expects one or two arguments');
      }
      const value = toFiniteNumber(values[0], 'Argument 1 to round()');
      const precision = values.length === 2
        ? toFiniteNumber(values[1], 'Argument 2 to round()')
        : 0;
      if (!Number.isInteger(precision) || precision < 0 || precision > 12) {
        throw new ComputedExpressionError('round() precision must be a whole number from 0 to 12');
      }
      const factor = 10 ** precision;
      result = Math.round((value + Number.EPSILON) * factor) / factor;
      break;
    }
    case 'clamp': {
      const [value, minimum, maximum] = exact(3);
      if (minimum > maximum) throw new ComputedExpressionError('clamp() minimum cannot exceed its maximum');
      result = Math.min(Math.max(value, minimum), maximum);
      break;
    }
    case 'min': {
      const args = numbers();
      if (!args.length) throw new ComputedExpressionError('min() expects at least one value');
      result = Math.min(...args);
      break;
    }
    case 'max': {
      const args = numbers();
      if (!args.length) throw new ComputedExpressionError('max() expects at least one value');
      result = Math.max(...args);
      break;
    }
    case 'sum': {
      const args = numbers();
      if (!args.length) throw new ComputedExpressionError('sum() expects at least one value');
      result = args.reduce((total, value) => total + value, 0);
      break;
    }
    case 'average': {
      const args = numbers();
      if (!args.length) throw new ComputedExpressionError('average() expects at least one value');
      result = args.reduce((total, value) => total + value, 0) / args.length;
      break;
    }
    default: throw new ComputedExpressionError(`Unknown function '${name}()'`);
  }
  return requireFiniteResult(result);
}

function toFiniteNumber(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(text)) {
      const parsed = Number(text);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  throw new ComputedExpressionError(`${label} must be a number or a strictly numeric text value`);
}

function requireFiniteResult(value: number): number {
  if (!Number.isFinite(value)) throw new ComputedExpressionError('The calculation produced a non-finite result');
  return value;
}

function collectReferences(
  node: ComputedExpressionNode,
  references: Map<string, ComputedReference>,
): void {
  if (node.type === 'reference') {
    if (!references.has(node.reference.name)) references.set(node.reference.name, node.reference);
    return;
  }
  if (node.type === 'unary') collectReferences(node.operand, references);
  else if (node.type === 'binary') {
    collectReferences(node.left, references);
    collectReferences(node.right, references);
  } else if (node.type === 'call') {
    for (const argument of node.arguments) collectReferences(argument, references);
  }
}

class ComputedParser {
  private position = 0;
  private token: Token;
  private tokenCount = 1;

  constructor(private readonly source: string) {
    this.token = this.readToken();
  }

  parse(): ComputedExpressionNode {
    if (this.token.type === 'end') throw new ComputedExpressionError('A computed expression is required');
    const expression = this.parseAdditive();
    if (this.currentToken().type !== 'end') this.fail(`Unexpected '${this.token.value}'`);
    return expression;
  }

  private parseAdditive(): ComputedExpressionNode {
    let expression = this.parseMultiplicative();
    while (this.isOperator('+') || this.isOperator('-')) {
      const operator = this.token.value as '+' | '-';
      this.advance();
      expression = { type: 'binary', operator, left: expression, right: this.parseMultiplicative() };
    }
    return expression;
  }

  private parseMultiplicative(): ComputedExpressionNode {
    let expression = this.parseUnary();
    while (this.isOperator('*') || this.isOperator('/') || this.isOperator('%')) {
      const operator = this.token.value as '*' | '/' | '%';
      this.advance();
      expression = { type: 'binary', operator, left: expression, right: this.parseUnary() };
    }
    return expression;
  }

  private parseUnary(): ComputedExpressionNode {
    if (this.isOperator('+') || this.isOperator('-')) {
      const operator = this.token.value as '+' | '-';
      this.advance();
      return { type: 'unary', operator, operand: this.parseUnary() };
    }
    return this.parsePower();
  }

  private parsePower(): ComputedExpressionNode {
    const left = this.parsePrimary();
    if (!this.isOperator('^')) return left;
    this.advance();
    return { type: 'binary', operator: '^', left, right: this.parseUnary() };
  }

  private parsePrimary(): ComputedExpressionNode {
    if (this.token.type === 'number') {
      const value = Number(this.token.value);
      this.advance();
      return { type: 'number', value };
    }
    if (this.token.type === 'reference') {
      const source = this.token.value;
      const position = this.token.position;
      const parsed = parseVariableSelector(source);
      if (source.includes('::') && !parsed.selector) {
        throw new ComputedExpressionError('Invalid variable selector', position);
      }
      this.advance();
      return { type: 'reference', reference: { name: parsed.name, selector: parsed.selector }, sourceFrom: position, sourceTo: position + 1 + parsed.name.length };
    }
    if (this.token.type === 'identifier') return this.parseCall();
    if (this.token.type === 'left-paren') {
      this.advance();
      const expression = this.parseAdditive();
      this.expect('right-paren', "Expected ')'");
      return expression;
    }
    this.fail('Expected a number, variable reference, function, or parenthesized expression');
  }

  private parseCall(): ComputedExpressionNode {
    const name = this.token.value.toLocaleLowerCase();
    const position = this.token.position;
    this.advance();
    this.expect('left-paren', `Expected '(' after '${name}'`);
    if (name === 'var') {
      if (this.token.type !== 'string') this.fail('var() expects a quoted variable name');
      const variableName = this.token.value.trim();
      if (!variableName) this.fail('var() variable name cannot be empty');
      this.advance();
      const sourceTo = this.token.position + 1;
      this.expect('right-paren', "Expected ')' after the variable name");
      let selectorSource = '';
      if (this.currentToken().type === 'selector') {
        selectorSource = this.token.value;
        this.advance();
      }
      const parsed = parseVariableSelector(`${variableName}${selectorSource}`);
      if (selectorSource && !parsed.selector) {
        throw new ComputedExpressionError('Invalid variable selector', position);
      }
      return { type: 'reference', reference: { name: parsed.name, selector: parsed.selector }, sourceFrom: position, sourceTo };
    }
    const argumentsList: ComputedExpressionNode[] = [];
    if (this.token.type !== 'right-paren') {
      while (true) {
        argumentsList.push(this.parseAdditive());
        if (this.token.type !== 'comma') break;
        this.advance();
      }
    }
    if (this.token.type !== 'right-paren') {
      throw new ComputedExpressionError(`Expected ')' after ${name}() arguments`, position);
    }
    this.advance();
    return { type: 'call', name, arguments: argumentsList };
  }

  private expect(type: Token['type'], message: string): void {
    if (this.token.type !== type) this.fail(message);
    this.advance();
  }

  private isOperator(value: string): boolean {
    return this.token.type === 'operator' && this.token.value === value;
  }

  private currentToken(): Token {
    return this.token;
  }

  private advance(): void {
    this.tokenCount++;
    if (this.tokenCount > MAX_EXPRESSION_TOKENS) {
      throw new ComputedExpressionError(`Computed expressions cannot exceed ${MAX_EXPRESSION_TOKENS} tokens`);
    }
    this.token = this.readToken();
  }

  private fail(message: string): never {
    throw new ComputedExpressionError(message, this.token.position);
  }

  private readToken(): Token {
    while (/\s/u.test(this.source[this.position] ?? '')) this.position++;
    const start = this.position;
    if (start >= this.source.length) return { type: 'end', value: '', position: start };
    const character = this.source[start];
    if (/[0-9.]/u.test(character)) {
      const match = this.source.slice(start).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u);
      if (!match) throw new ComputedExpressionError('Invalid number', start);
      this.position += match[0].length;
      return { type: 'number', value: match[0], position: start };
    }
    if (character === '@') {
      this.position++;
      const nameMatch = this.source.slice(this.position).match(/^[\p{L}\p{N}_.]+/u);
      if (!nameMatch) throw new ComputedExpressionError("Expected a variable name after '@'", start);
      let value = nameMatch[0];
      this.position += nameMatch[0].length;
      value += this.readSelectorSource();
      return { type: 'reference', value, position: start };
    }
    if (character === ':' && this.source.startsWith('::', start)) {
      const value = this.readSelectorSource();
      if (!value) throw new ComputedExpressionError('Invalid selector', start);
      return { type: 'selector', value, position: start };
    }
    if (/[\p{L}_]/u.test(character)) {
      const match = this.source.slice(start).match(/^[\p{L}\p{N}_]+/u);
      if (!match) throw new ComputedExpressionError('Invalid identifier', start);
      this.position += match[0].length;
      return { type: 'identifier', value: match[0], position: start };
    }
    if (character === '"' || character === "'") return this.readString(character);
    this.position++;
    if ('+-*/%^'.includes(character)) return { type: 'operator', value: character, position: start };
    if (character === '(') return { type: 'left-paren', value: character, position: start };
    if (character === ')') return { type: 'right-paren', value: character, position: start };
    if (character === ',') return { type: 'comma', value: character, position: start };
    throw new ComputedExpressionError(`Unexpected '${character}'`, start);
  }

  private readSelectorSource(): string {
    let value = '';
    while (this.source.startsWith('::', this.position)) {
      const start = this.position;
      const match = this.source.slice(this.position + 2).match(/^[\p{L}_][\p{L}\p{N}_-]*/u);
      if (!match) throw new ComputedExpressionError('Invalid selector name', start);
      this.position += 2 + match[0].length;
      if (this.source[this.position] !== '(') throw new ComputedExpressionError("Expected '(' after selector name", this.position);
      const close = this.source.indexOf(')', this.position + 1);
      if (close === -1) throw new ComputedExpressionError("Expected ')' after selector arguments", this.position);
      this.position = close + 1;
      value += this.source.slice(start, this.position);
    }
    return value;
  }

  private readString(quote: string): Token {
    const start = this.position++;
    let value = '';
    while (this.position < this.source.length) {
      const character = this.source[this.position++];
      if (character === quote) return { type: 'string', value, position: start };
      if (character === '\\') {
        if (this.position >= this.source.length) break;
        const escaped = this.source[this.position++];
        if (escaped === 'n') value += '\n';
        else if (escaped === 't') value += '\t';
        else value += escaped;
      } else value += character;
    }
    throw new ComputedExpressionError('Unterminated string', start);
  }
}
