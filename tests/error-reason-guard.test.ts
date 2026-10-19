import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';

type MessageSource = (node: ts.Expression) => boolean;

const normalizationMethods = new Set([
  'normalize',
  'slice',
  'substring',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'toLowerCase',
  'toUpperCase',
  'trim',
  'trimEnd',
  'trimStart',
]);
const receiverClassificationMethods = new Set([
  'endsWith',
  'includes',
  'match',
  'matchAll',
  'search',
  'startsWith',
]);

function symbolAt(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function collectForbiddenClassifications(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker | undefined,
  source: MessageSource,
): ts.Node[] {
  const tracked = new Set<ts.Symbol | string>();

  const trackedExpression = (node: ts.Expression): boolean => {
    if (source(node)) return true;
    if (ts.isIdentifier(node)) {
      const symbol = checker ? symbolAt(checker, node) : undefined;
      return tracked.has(symbol ?? node.text);
    }
    if (ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node)
      || ts.isNonNullExpression(node)) return trackedExpression(node.expression);
    if (ts.isConditionalExpression(node)) {
      return trackedExpression(node.whenTrue) || trackedExpression(node.whenFalse);
    }
    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.some(span => trackedExpression(span.expression));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return trackedExpression(node.left) || trackedExpression(node.right);
    }
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && normalizationMethods.has(node.expression.name.text)) {
      return trackedExpression(node.expression.expression);
    }
    return false;
  };

  const trackName = (name: ts.BindingName): boolean => {
    if (ts.isIdentifier(name)) {
      const symbol = checker ? symbolAt(checker, name) : undefined;
      const key = symbol ?? name.text;
      if (tracked.has(key)) return false;
      tracked.add(key);
      return true;
    }
    return false;
  };

  // Resolve chains such as `const detail = error.message; const normalized = detail.trim()`.
  // A fixed point also catches aliases declared before the assignment that taints them.
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isObjectBindingPattern(node.name)) {
          if (source(node.initializer)) {
            for (const element of node.name.elements) {
              const property = element.propertyName ?? element.name;
              if (ts.isIdentifier(property) && property.text === 'message') {
                changed = trackName(element.name) || changed;
              }
            }
          }
        } else if (trackedExpression(node.initializer)) {
          changed = trackName(node.name) || changed;
        }
      } else if (ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left)
        && trackedExpression(node.right)) {
        changed = trackName(node.left) || changed;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const findings: ts.Node[] = [];
  const add = (node: ts.Node): void => {
    if (!findings.includes(node)) findings.push(node);
  };
  const equalityOperators = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ]);
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && equalityOperators.has(node.operatorToken.kind)) {
      const left = trackedExpression(node.left);
      const right = trackedExpression(node.right);
      if (left !== right) add(node);
    }
    if (ts.isSwitchStatement(node) && trackedExpression(node.expression)) add(node);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      if (receiverClassificationMethods.has(method) && trackedExpression(receiver)) add(node);
      if ((method === 'test' || method === 'includes')
        && node.arguments.some(argument => trackedExpression(argument))) add(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function enclosingInterfaceName(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isInterfaceDeclaration(current) || ts.isClassDeclaration(current)) return current.name?.text;
  }
  return undefined;
}

function isRuntimeMessageAccess(checker: ts.TypeChecker, node: ts.Expression): boolean {
  const isErrorValue=(value:ts.Expression):boolean=>{
    const symbol=checker.getSymbolAtLocation(value);
    if(symbol?.declarations?.some(declaration=>ts.isVariableDeclaration(declaration)&&ts.isCatchClause(declaration.parent)))return true;
    const type=checker.getTypeAtLocation(value);
    return !!type.getProperty('message')&&!!type.getProperty('name')&&!!type.getProperty('stack');
  };
  if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='String')return node.arguments.some(isErrorValue);
  if(ts.isTemplateExpression(node))return node.templateSpans.some(span=>isErrorValue(span.expression)||isRuntimeMessageAccess(checker,span.expression));
  if (!ts.isPropertyAccessExpression(node) || !['message','error'].includes(node.name.text)) return false;
  const property = checker.getTypeAtLocation(node.expression).getProperty(node.name.text)
    ?? checker.getSymbolAtLocation(node.name);
  return !!property?.declarations?.some(declaration => {
    const file = declaration.getSourceFile().fileName.replaceAll('\\', '/');
    const owner = enclosingInterfaceName(declaration);
    if (/\/typescript\/lib\/lib\.(?:es5|es\d+)\.d\.ts$/.test(file) && owner === 'Error') return true;
    return file.endsWith('/src/shared/types.ts') && ['Task','TaskHistoryEntry','ExecutionResult','Site'].includes(owner??'');
  });
}

function enclosingFunctionName(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current.name?.text;
    if ((ts.isFunctionExpression(current) || ts.isArrowFunction(current))
      && ts.isVariableDeclaration(current.parent)
      && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
  }
  return undefined;
}

function isLegacyMigrationParser(sourceFile: ts.SourceFile, node: ts.Node): boolean {
  const file = sourceFile.fileName.replaceAll('\\', '/');
  return file.endsWith('/src/main/task-reason-migration.ts')
    && enclosingFunctionName(node) === 'inferLegacyTaskReasonCode';
}

test('business logic does not classify native errors or task failures by display message', () => {
  const configPath = path.resolve('tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined, config.error ? ts.flattenDiagnosticMessageText(config.error.messageText, '\n') : '');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const roots = ['/src/main/', '/src/shared/', '/src/integrations/', '/src/ui/'];
  const migration = 'inferLegacyTaskReasonCode in /src/main/task-reason-migration.ts';
  const findings: string[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    const file = sourceFile.fileName.replaceAll('\\', '/');
    if (!roots.some(root => file.includes(root))) continue;
    for (const node of collectForbiddenClassifications(sourceFile, checker, expression => isRuntimeMessageAccess(checker, expression))) {
      if (isLegacyMigrationParser(sourceFile, node)) continue;
      const {line, character} = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      findings.push(`${path.relative(process.cwd(), sourceFile.fileName)}:${line + 1}:${character + 1} ${node.getText(sourceFile).slice(0, 180)}`);
    }
  }
  assert.deepEqual(findings, [], `message-based failure classification is forbidden outside ${migration}:\n${findings.join('\n')}`);
});

test('message classification guard follows local aliases and normalization', () => {
  const fixture = ts.createSourceFile('fixture.ts', `
    declare const error: Error;
    const detail = error.message;
    const normalized = detail.trim().toLowerCase();
    /quota/i.test(normalized);
    normalized.includes('quota');
    normalized === 'quota';
    const shown = error.message;
    console.log(shown);
  `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings = collectForbiddenClassifications(
    fixture,
    undefined,
    expression => ts.isPropertyAccessExpression(expression) && expression.name.text === 'message',
  );
  assert.equal(findings.length, 3);
});

test('only the legacy migration parser is exempt inside the migration module', () => {
  const fixture = ts.createSourceFile('/workspace/src/main/task-reason-migration.ts', `
    declare const error: Error;
    function inferLegacyTaskReasonCode() {
      const legacy = error.message;
      return legacy.includes('旧中文原因');
    }
    function runtimeClassifier() {
      const current = error.message;
      return current.includes('新中文原因');
    }
  `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings = collectForbiddenClassifications(
    fixture,
    undefined,
    expression => ts.isPropertyAccessExpression(expression) && expression.name.text === 'message',
  ).filter(node => !isLegacyMigrationParser(fixture, node));
  assert.equal(findings.length, 1);
  assert.match(findings[0].getText(fixture), /新中文原因/);
});

test('guard detects String errors, template errors, site errors and execution messages',()=>{
  const file='/virtual/src/shared/types.ts';
  const source=ts.createSourceFile(file,[
    'interface Site {error?:string}',
    'interface ExecutionResult {message:string}',
    'declare const error: Error; declare const site: Site; declare const result: ExecutionResult;',
    "String(error).includes('账号');",
    "`${error}`.includes('额度');",
    "site.error?.includes('不足');",
    "result.message === '失败';",
    "try {} catch (caught) { const text = String(caught); /账号/.test(text); }",
    'console.log(result.message, site.error, String(error));',
  ].join('\n'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const host=ts.createCompilerHost({target:ts.ScriptTarget.ESNext}),original=host.getSourceFile;
  host.getSourceFile=(name,...args)=>name===file?source:original(name,...args);
  const program=ts.createProgram([file],{target:ts.ScriptTarget.ESNext},host),checker=program.getTypeChecker();
  assert.equal(collectForbiddenClassifications(source,checker,node=>isRuntimeMessageAccess(checker,node)).length,5);
});
