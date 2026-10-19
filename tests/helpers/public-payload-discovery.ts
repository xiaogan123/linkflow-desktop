import ts from 'typescript';

/** Auth-only requests carry no public author, page, or publication content. */
const PRIVATE_TRANSPORT = new Set([
  'berrry.ts:berrrySolveRequest',
  'berrry.ts:berrrySignInRequest',
  'berrry.ts:berrryRegistrationRequest',
  'colony.ts:colonyConfirmRequest',
  'colony.ts:colonyTokenRequest',
  'batch5-connected.ts:connectedRequest',
]);
const PUBLIC_NAME = /(?:Request|Payload)$|^render[A-Z].*Article$|^approved[A-Z].*Article$|^articleToTelegraphNodes$|^(?:publication|vibeDropContent)Identity$/;
const NON_BUILDER = /^(?:is|has|valid|parse|read|verify|inspect|match|find|list|reconcile|recover)[A-Z]/;
const NON_PUBLIC_RESULT = /(?:TaskIdentity|PublicationIdentity|DraftIdentity|HostedDocument|ReviewPayload)$|^(?:fetch|prepare|gscDiscoveryNotice|writeFreelyPost$)/;
const NON_PUBLISHER_MODULE = new Set(['web.ts','search-reports.ts','notion-content.ts']);
const TESTING_BUILDER = /^(?:article|approved(?:Prose)?Article|approvedPost|approvedReadme|buildArticle|publicBody|pageBody|requestBody)$/;

function exported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function propertyName(node: ts.PropertyName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
}

function publicObject(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return publicObject(expression.expression);
  }
  return ts.isObjectLiteralExpression(expression) && expression.properties.some(property =>
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
    /^(?:body|html|content|record|payload)$/.test(propertyName(property.name) ?? '')
  );
}

function hasPublicReturn(body: ts.ConciseBody | undefined): boolean {
  if (!body) return false;
  if (!ts.isBlock(body)) return publicObject(body);
  const publicVariables = new Set<string>();
  const visit = (node: ts.Node): boolean => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && publicObject(node.initializer)) {
      publicVariables.add(node.name.text);
    }
    if (ts.isReturnStatement(node) && node.expression &&
      (publicObject(node.expression) || (ts.isIdentifier(node.expression) && publicVariables.has(node.expression.text)))) return true;
    return ts.forEachChild(node, visit) ?? false;
  };
  // Variables and return statements are visited in source order.
  return visit(body);
}

function eligible(name: string, key: string, body: ts.ConciseBody | undefined): boolean {
  return !PRIVATE_TRANSPORT.has(key) && !NON_BUILDER.test(name) && !NON_PUBLIC_RESULT.test(name) &&
    (PUBLIC_NAME.test(name) || hasPublicReturn(body));
}

/** The inventory comes from integration exports, so new builders need a fixture. */
export function discoverPublicPayloadBuilders(file: string, source: string): string[] {
  if (NON_PUBLISHER_MODULE.has(file)) return [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const declarations = new Map<string, ts.FunctionLikeDeclaration>();
  for (const node of ast.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node);
    if (!ts.isVariableStatement(node)) continue;
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const initializer = declaration.initializer;
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) declarations.set(declaration.name.text, initializer);
    }
  }
  for (const node of ast.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && exported(node)) {
      const name = node.name.text, key = `${file}:${name}`;
      if (eligible(name, key, node.body)) names.add(key);
    }
    if (!ts.isVariableStatement(node) || !exported(node)) continue;
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const name = declaration.name.text, initializer = declaration.initializer, key = `${file}:${name}`;
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        if (eligible(name, key, initializer.body)) names.add(key);
      }
      if (!name.endsWith('Testing') || !ts.isObjectLiteralExpression(initializer)) continue;
      for (const property of initializer.properties) {
        if (!ts.isShorthandPropertyAssignment(property) && !ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) continue;
        const member = propertyName(property.name);
        if (!member || NON_BUILDER.test(member) || /From$/.test(member)) continue;
        const functionNode = ts.isShorthandPropertyAssignment(property) ? declarations.get(member) :
          ts.isMethodDeclaration(property) ? property :
          ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer) ? property.initializer :
          ts.isIdentifier(property.initializer) ? declarations.get(property.initializer.text) : undefined;
        if (TESTING_BUILDER.test(member) || (functionNode && hasPublicReturn(functionNode.body))) names.add(`${file}:${name}.${member}`);
      }
    }
  }
  return [...names];
}

export function missingPublicPayloadFixtures(discovered: readonly string[], fixtures: Readonly<Record<string, unknown>>): string[] {
  return discovered.filter(key => !Object.hasOwn(fixtures, key));
}

export function publicPayloadBrandMarkers(output: unknown): string[] {
  const serialized = typeof output === 'string' ? output : JSON.stringify(output);
  if (!serialized || serialized === '{}') throw Error('公开载荷夹具没有生成可扫描内容');
  const markers: string[] = [];
  if (/linkflow/i.test(serialized)) markers.push('brand');
  if (/data-(?:linkflow|publication)-/i.test(serialized)) markers.push('data_attribute');
  if (/"slug"\s*:\s*"lf-/i.test(serialized)) markers.push('slug');
  return markers;
}
