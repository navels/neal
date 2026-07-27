#!/usr/bin/env node
// Identity-oracle checker for the orchestrator test split (PLAN.md Scopes 12–13).
//
// A standalone plain-Node script (not a `*.test.ts` suite member). It parses
// real TypeScript syntax via the typescript compiler API, which performs the
// balanced-delimiter scan (string literals, template literals, and comments
// included) that segmenting top-level units requires; textual scans cannot do
// this — comments, string literals, and `import type` forms would all
// masquerade as executing code (see PLAN.md Repository Facts).
//
// Modes:
//   emit <files...>                                  print sorted sha256 lines, one per top-level segment
//   verify <fixture> <files...>                      compare recomputed segment multiset against fixture
//   imports <files...>                               print sorted binding<TAB>export<TAB>resolved-target lines
//   imports-verify <bindings> <identifiers> <files...>  validate every value import against the fixtures
//   identifiers <files...>                           print sorted top-level declared identifier names
//   env-verify <files...>                            require a value-level side-effect import of the env module in every file
//   home-verify --require <pattern> <files...>       validate process.env.HOME isolation across files
//
// Segmentation rules (emit/verify):
//   - A segment is one top-level statement plus its leading comment trivia.
//   - Exactly two normalizations: an optional leading `export ` modifier is
//     stripped from a declaration before hashing, and leading/trailing blank
//     lines around each segment are trimmed. Nothing else is normalized.
//   - Exactly one exclusion class: `import` statements and top-level
//     `process.env.HOME = ...` assignment statements are excluded entirely
//     (both legitimately differ per split file; they are checked separately
//     by imports-verify/env-verify and home-verify).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const ENV_MODULE_TARGET = 'test/helpers/orchestrator-env';
const EXTRACTION_MODULE_PATTERN = /^test\/helpers\/orchestrator-[^/]+$/;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function canonicalFilePath(file) {
  const rel = path.relative(process.cwd(), path.resolve(file));
  return rel.split(path.sep).join('/');
}

function parseFile(file) {
  const text = readFileSync(file, 'utf8');
  const scriptKind = file.endsWith('.mjs') || file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
  return { text, sourceFile };
}

function isProcessEnv(expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'env' &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'process'
  );
}

// Returns the RHS expression of a top-level `process.env.HOME = ...`
// assignment statement, or null when the statement is not one.
function getHomeAssignmentRhs(statement) {
  if (!ts.isExpressionStatement(statement)) return null;
  const expression = statement.expression;
  if (!ts.isBinaryExpression(expression)) return null;
  if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  const lhs = expression.left;
  const isHomeProperty =
    ts.isPropertyAccessExpression(lhs) && lhs.name.text === 'HOME' && isProcessEnv(lhs.expression);
  const isHomeElement =
    ts.isElementAccessExpression(lhs) &&
    ts.isStringLiteralLike(lhs.argumentExpression) &&
    lhs.argumentExpression.text === 'HOME' &&
    isProcessEnv(lhs.expression);
  return isHomeProperty || isHomeElement ? expression.right : null;
}

function trimBlankLines(segment) {
  const lines = segment.split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

function sha256(textValue) {
  return createHash('sha256').update(textValue, 'utf8').digest('hex');
}

function computeSegmentHashes(file) {
  const { text, sourceFile } = parseFile(file);
  const hashes = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) continue;
    if (getHomeAssignmentRhs(statement)) continue;
    const fullStart = statement.getFullStart();
    const end = statement.end;
    let segment;
    const exportModifier = ts.canHaveModifiers(statement)
      ? (ts.getModifiers(statement) ?? []).find((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      : undefined;
    if (exportModifier) {
      // Normalization: strip the `export ` keyword (plus the whitespace run
      // separating it from the rest of the declaration) before hashing.
      const modifierStart = exportModifier.getStart(sourceFile);
      let afterModifier = exportModifier.end;
      while (afterModifier < end && /\s/.test(text[afterModifier])) afterModifier += 1;
      segment = text.slice(fullStart, modifierStart) + text.slice(afterModifier, end);
    } else {
      segment = text.slice(fullStart, end);
    }
    hashes.push(sha256(trimBlankLines(segment)));
  }
  return hashes;
}

function multisetFromLines(lines) {
  const counts = new Map();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function readFixtureLines(fixturePath) {
  return readFileSync(fixturePath, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

// Collects value-level import rows from one file. Type-only imports (both
// whole-declaration `import type` and inline `type` specifiers) are not value
// imports and are never emitted; typecheck already validates them and they
// cannot change which runtime paths execute.
function collectImportRows(file) {
  const canonFile = canonicalFilePath(file);
  const { sourceFile } = parseFile(file);
  const rows = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    const target = resolveTarget(canonFile, specifier.text);
    const clause = statement.importClause;
    if (!clause) {
      rows.push({ binding: '', exported: '', target, sideEffect: true });
      continue;
    }
    if (clause.isTypeOnly) continue;
    if (clause.name) {
      rows.push({ binding: clause.name.text, exported: 'default', target, sideEffect: false });
    }
    const namedBindings = clause.namedBindings;
    if (namedBindings) {
      if (ts.isNamespaceImport(namedBindings)) {
        rows.push({ binding: namedBindings.name.text, exported: '*', target, sideEffect: false });
      } else {
        for (const element of namedBindings.elements) {
          if (element.isTypeOnly) continue;
          rows.push({
            binding: element.name.text,
            exported: (element.propertyName ?? element.name).text,
            target,
            sideEffect: false,
          });
        }
      }
    }
  }
  return rows;
}

// Resolves a raw module specifier against the importing file's own directory
// into a canonical repo-relative target. Bare specifiers are recorded as-is.
function resolveTarget(canonFile, specifier) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(canonFile), specifier));
  }
  return specifier;
}

function importRowLine(row) {
  return `${row.binding}\t${row.exported}\t${row.target}`;
}

function stripModuleExtension(target) {
  return target.replace(/\.(?:js|mjs|cjs|ts|mts|cts)$/, '');
}

function isEnvModuleTarget(target) {
  return stripModuleExtension(target) === ENV_MODULE_TARGET;
}

function isExtractionModuleTarget(target) {
  return EXTRACTION_MODULE_PATTERN.test(stripModuleExtension(target));
}

function collectTopLevelIdentifiers(file) {
  const { sourceFile } = parseFile(file);
  const names = [];
  const collectBindingNames = (bindingName) => {
    if (ts.isIdentifier(bindingName)) {
      names.push(bindingName.text);
      return;
    }
    if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
      for (const element of bindingName.elements) {
        if (ts.isBindingElement(element)) collectBindingNames(element.name);
      }
    }
  };
  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name);
      }
    }
  }
  return names;
}

function isTmpdirCall(expression) {
  if (!ts.isCallExpression(expression) || expression.arguments.length !== 0) return false;
  const callee = expression.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'tmpdir';
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'tmpdir';
}

function isStaticStringLiteral(expression) {
  return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression);
}

// Canonicalizes an approved HOME-assignment RHS shape into the resolved path
// the assignment produces at runtime. Returns null for any other expression
// shape (statically unverifiable).
function canonicalizeHomeRhs(rhs) {
  if (ts.isCallExpression(rhs)) {
    const callee = rhs.expression;
    const isJoinCallee =
      (ts.isIdentifier(callee) && callee.text === 'join') ||
      (ts.isPropertyAccessExpression(callee) && callee.name.text === 'join');
    if (
      isJoinCallee &&
      rhs.arguments.length === 2 &&
      isTmpdirCall(rhs.arguments[0]) &&
      isStaticStringLiteral(rhs.arguments[1])
    ) {
      return path.join(tmpdir(), rhs.arguments[1].text);
    }
    return null;
  }
  if (
    ts.isBinaryExpression(rhs) &&
    rhs.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    isTmpdirCall(rhs.left) &&
    isStaticStringLiteral(rhs.right)
  ) {
    return tmpdir() + rhs.right.text;
  }
  return null;
}

function globToRegExp(pattern) {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+^${}()|[\]\\?]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${escaped}$`);
}

function runEmit(files) {
  const hashes = files.flatMap((file) => computeSegmentHashes(file));
  hashes.sort();
  process.stdout.write(hashes.map((hash) => `${hash}\n`).join(''));
}

function runVerify(fixturePath, files) {
  const expected = multisetFromLines(readFixtureLines(fixturePath));
  const actual = multisetFromLines(files.flatMap((file) => computeSegmentHashes(file)));
  const problems = [];
  for (const [hash, count] of expected) {
    const have = actual.get(hash) ?? 0;
    if (have < count) problems.push(`missing x${count - have}: ${hash}`);
  }
  for (const [hash, count] of actual) {
    const have = expected.get(hash) ?? 0;
    if (count > have) problems.push(`extra x${count - have}: ${hash}`);
  }
  if (problems.length > 0) {
    fail(`segment multiset mismatch against ${fixturePath}:\n${problems.join('\n')}`);
  }
}

function runImports(files) {
  const lines = files.flatMap((file) => collectImportRows(file).map((row) => importRowLine(row)));
  lines.sort();
  process.stdout.write(lines.map((line) => `${line}\n`).join(''));
}

function runImportsVerify(bindingsFixturePath, identifiersFixturePath, files) {
  const fixtureLines = new Set(readFixtureLines(bindingsFixturePath));
  const originalIdentifiers = new Set(readFixtureLines(identifiersFixturePath));
  const violations = [];
  for (const file of files) {
    for (const row of collectImportRows(file)) {
      const line = importRowLine(row);
      if (fixtureLines.has(line)) continue;
      if (row.sideEffect && isEnvModuleTarget(row.target)) continue;
      if (
        !row.sideEffect &&
        isExtractionModuleTarget(row.target) &&
        row.binding !== '' &&
        row.binding === row.exported &&
        originalIdentifiers.has(row.binding)
      ) {
        continue;
      }
      violations.push(`${file}: unapproved import ${JSON.stringify(line)}`);
    }
  }
  if (violations.length > 0) {
    fail(`import-binding violations:\n${violations.join('\n')}`);
  }
}

function runIdentifiers(files) {
  const names = files.flatMap((file) => collectTopLevelIdentifiers(file));
  names.sort();
  process.stdout.write(names.map((name) => `${name}\n`).join(''));
}

function runEnvVerify(files) {
  const missing = files.filter(
    (file) => !collectImportRows(file).some((row) => row.sideEffect && isEnvModuleTarget(row.target)),
  );
  if (missing.length > 0) {
    fail(
      `files missing a value-level side-effect import of ${ENV_MODULE_TARGET}:\n${missing.join('\n')}`,
    );
  }
}

function runHomeVerify(args) {
  if (args[0] !== '--require' || args.length < 3) {
    fail('usage: home-verify --require <pattern> <files...>');
  }
  const requiredPattern = globToRegExp(args[1]);
  const files = args.slice(2);
  const problems = [];
  const canonicalPaths = new Map();
  for (const file of files) {
    const canonFile = canonicalFilePath(file);
    const required = requiredPattern.test(canonFile);
    const { sourceFile } = parseFile(file);
    const assignments = [];
    for (const statement of sourceFile.statements) {
      const rhs = getHomeAssignmentRhs(statement);
      if (rhs) assignments.push(rhs);
    }
    if (required && assignments.length !== 1) {
      problems.push(
        `${canonFile}: required file must contain exactly one top-level process.env.HOME assignment (found ${assignments.length})`,
      );
      continue;
    }
    if (!required && assignments.length === 0) continue;
    if (!required && assignments.length > 1) {
      problems.push(
        `${canonFile}: contains ${assignments.length} top-level process.env.HOME assignments (at most one may participate)`,
      );
      continue;
    }
    for (const rhs of assignments) {
      const canonical = canonicalizeHomeRhs(rhs);
      if (canonical === null) {
        problems.push(
          `${canonFile}: process.env.HOME assignment is not statically verifiable (expected join(tmpdir(), '<literal>') or tmpdir() + '<literal>')`,
        );
        continue;
      }
      const existing = canonicalPaths.get(canonical);
      if (existing) {
        problems.push(`${canonFile}: HOME path ${JSON.stringify(canonical)} collides with ${existing}`);
      } else {
        canonicalPaths.set(canonical, canonFile);
      }
    }
  }
  if (problems.length > 0) {
    fail(`HOME-isolation violations:\n${problems.join('\n')}`);
  }
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  switch (mode) {
    case 'emit':
      if (rest.length === 0) fail('usage: emit <files...>');
      runEmit(rest);
      return;
    case 'verify':
      if (rest.length < 2) fail('usage: verify <fixture> <files...>');
      runVerify(rest[0], rest.slice(1));
      return;
    case 'imports':
      if (rest.length === 0) fail('usage: imports <files...>');
      runImports(rest);
      return;
    case 'imports-verify':
      if (rest.length < 3) fail('usage: imports-verify <bindings-fixture> <identifiers-fixture> <files...>');
      runImportsVerify(rest[0], rest[1], rest.slice(2));
      return;
    case 'identifiers':
      if (rest.length === 0) fail('usage: identifiers <files...>');
      runIdentifiers(rest);
      return;
    case 'env-verify':
      if (rest.length === 0) fail('usage: env-verify <files...>');
      runEnvVerify(rest);
      return;
    case 'home-verify':
      runHomeVerify(rest);
      return;
    default:
      fail(
        'usage: orchestrator-split-check.mjs <emit|verify|imports|imports-verify|identifiers|env-verify|home-verify> ...',
      );
  }
}

main();
