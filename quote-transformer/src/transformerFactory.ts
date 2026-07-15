import type * as ts from 'typescript';
import type { TransformerExtras, PluginConfig } from 'ts-patch';
import { QuoteError, getQuoteConverter } from './quoteConverter';

// Minimal Node fs/path surface. This package has no @types/node (it had no Node
// usage before) and runs under Node via ts-patch, so the bits we need are
// declared locally to avoid a type-only dependency + lockfile churn.
declare function require(id: string): any;
const fs: { existsSync(p: string): boolean; readFileSync(p: string, enc: string): string } = require('fs');
const path: {
  join(...parts: string[]): string;
  dirname(p: string): string;
  relative(from: string, to: string): string;
  resolve(...parts: string[]): string;
  sep: string;
} = require('path');

// The package + relative source path a reflected class/enum/object is defined
// in (the TS analogue of a .NET assembly + file). Emitted as the per-file
// `const __fileInfo = { module, fileName }` and passed to registerType /
// registerEnum / registerObject so runtime code can attribute a type to its
// owning npm package (e.g. for package→schema mapping) and report locations.
interface SourceLocation { packageName: string; fileName: string; }

// dir -> nearest package info (or null when none up the tree). Module-scoped so
// it persists across every file in a single build process. Keyed per directory;
// the whole walked chain is memoized on each lookup.
const packageInfoCache = new Map<string, { name: string; dir: string } | null>();

function findNearestPackage(startDir: string): { name: string; dir: string } | null {
  const chain: string[] = [];
  let dir = startDir;
  while (true) {
    const cached = packageInfoCache.get(dir);
    if (cached !== undefined) {
      for (const d of chain) packageInfoCache.set(d, cached);
      return cached;
    }
    chain.push(dir);

    let resolved: { name: string; dir: string } | null | undefined;
    const pkgPath = path.join(dir, 'package.json');
    try {
      if (fs.existsSync(pkgPath)) {
        const json = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        // Nearest package.json wins even if it lacks a "name" (→ no location).
        resolved = typeof json.name === 'string' ? { name: json.name, dir } : null;
      }
    } catch {
      resolved = null;
    }

    if (resolved !== undefined) {
      for (const d of chain) packageInfoCache.set(d, resolved);
      return resolved;
    }

    const parent = path.dirname(dir);
    if (parent === dir) { // filesystem root, no package.json found
      for (const d of chain) packageInfoCache.set(d, null);
      return null;
    }
    dir = parent;
  }
}

// Resolves a source file's owning package + path relative to that package
// (forward slashes, original .ts extension). null when no named package.json is
// found — callers then omit the location args.
function resolveSourceLocation(fileName: string): SourceLocation | null {
  if (!fileName) return null;
  const abs = path.resolve(fileName);
  const pkg = findNearestPackage(path.dirname(abs));
  if (pkg == null) return null;
  const rel = path.relative(pkg.dir, abs).split(path.sep).join('/');
  return { packageName: pkg.name, fileName: rel };
}

/** Changes string literal 'before' to 'after' */
export default function transformerFactory(program: ts.Program, pluginConfig: PluginConfig | undefined, { ts, addDiagnostic }: TransformerExtras) {

  function isQuoteOfT(type: ts.Type) {
    return type.aliasSymbol?.name == "Quoted" && type.aliasTypeArguments?.length == 1;
  }

  function isQuotedLikeType(type: ts.Type): boolean {
    if (isQuoteOfT(type))
      return true;

    const quotedProperty = type.getProperty("__quoted");
    return quotedProperty != null;
  }

  function isQuoteTypedLValue(node: ts.Expression, typeChecker: ts.TypeChecker): boolean {
    const symbol = typeChecker.getSymbolAtLocation(node);
    if (symbol?.declarations != null) {
      for (const declaration of symbol.declarations) {
        if (
          (ts.isVariableDeclaration(declaration) ||
            ts.isPropertyDeclaration(declaration) ||
            ts.isParameter(declaration) ||
            ts.isPropertySignature(declaration)) &&
          declaration.type != null
        ) {
          const declaredType = typeChecker.getTypeFromTypeNode(declaration.type);
          if (isQuoteOfT(declaredType))
            return true;
        }
      }
    }

    return isQuoteOfT(typeChecker.getTypeAtLocation(node));
  }

  function assignedToQuoteOfT(node: ts.ArrowFunction, typeChecker: ts.TypeChecker): boolean {

    if (node.parent == null)
      return false;

    if (ts.isCallExpression(node.parent)) {
      var index = node.parent.arguments.indexOf(node);

      if (index == -1)
        return false;

      var signature = typeChecker.getResolvedSignature(node.parent)
      if (signature == null)
        return false;

      var paramType = signature.getTypeParameterAtPosition(index);

      if (isQuotedLikeType(paramType))
        return true;

      const signatureDeclaration = signature.getDeclaration();
      const parameterDeclaration = signatureDeclaration?.parameters?.[index];
      if (parameterDeclaration?.type != null) {
        const declaredParamType = typeChecker.getTypeFromTypeNode(parameterDeclaration.type);
        if (isQuotedLikeType(declaredParamType))
          return true;
      }

      return false;
    }

    if (
      ts.isBinaryExpression(node.parent) &&
      node.parent.operatorToken.kind == ts.SyntaxKind.EqualsToken &&
      node.parent.right === node
    ) {
      return isQuoteTypedLValue(node.parent.left, typeChecker);
    }

    if (ts.isVariableDeclaration(node.parent) && node.parent.initializer === node) {
      const declaredType = node.parent.type != null
        ? typeChecker.getTypeFromTypeNode(node.parent.type)
        : typeChecker.getTypeAtLocation(node.parent.name);

      return isQuotedLikeType(declaredType);
    }

    if (ts.isPropertyDeclaration(node.parent) && node.parent.initializer === node && node.parent.type != null) {
      const declaredType = typeChecker.getTypeFromTypeNode(node.parent.type);
      return isQuotedLikeType(declaredType);
    }

    return false;
  }

  const typeChecker = program.getTypeChecker();

  const quoteExpression = getQuoteConverter(ts, typeChecker);

  const printer = ts.createPrinter();
  let generatedExParam = false;
  let needsFieldImport = false;
  // Source names of top-level @reflect/@entity/@partEntity classes in the
  // current file; each gets an explicit registerType(Class, "Class") appended so
  // name-based type resolution survives bundling (see registerType).
  let registerNames: string[] = [];
  // Names of module-level const objects whose msg() members were transformed;
  // each gets a registerObject(Name, "Name", __fileInfo) appended.
  let registerObjectNames: string[] = [];
  // Set when __fileInfo is referenced (so we declare/import it even when there are
  // no appended registrations — e.g. only a hand-written registerEnum call).
  let usedFileInfo = false;
  // Top-level enum declarations in this file, and enum type names referenced by a
  // reflected @field. Their intersection is auto-registered (same-file enums);
  // cross-file enums must be registered by hand.
  let declaredEnumNames: Set<string> = new Set();
  let referencedEnumNames: Set<string> = new Set();

  function addQuoteError(sourceFile: ts.SourceFile, quote: QuoteError): void {
    addDiagnostic({
      category: ts.DiagnosticCategory.Error,
      code: 9876,
      file: sourceFile,
      start: quote.node.getStart(),
      length: quote.node.getFullWidth(),
      messageText: quote.message
    });
  }

  function addNodeError(sourceFile: ts.SourceFile, node: ts.Node, messageText: string): void {
    addDiagnostic({
      category: ts.DiagnosticCategory.Error,
      code: 9876,
      file: sourceFile,
      start: node.getStart(),
      length: node.getFullWidth(),
      messageText,
    });
  }

  function ensureQuotedImportHasExParam(sourceFile: ts.SourceFile): ts.SourceFile {
    const quotedModule = "quote-transformer/quoted";

    function noImportPhaseModifier(): ts.ImportPhaseModifierSyntaxKind | undefined {
      return undefined;
    }

    function hasExParamNamedImport(named: ts.NamedImports): boolean {
      return named.elements.some(e => {
        const imported = e.propertyName?.text ?? e.name.text;
        return imported == "ExParam";
      });
    }

    function createExParamImportSpecifier(): ts.ImportSpecifier {
      return ts.factory.createImportSpecifier(false, undefined, ts.factory.createIdentifier("ExParam"));
    }

    for (let i = 0; i < sourceFile.statements.length; i++) {
      const statement = sourceFile.statements[i];
      if (!ts.isImportDeclaration(statement))
        continue;

      if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text != quotedModule)
        continue;

      const importClause = statement.importClause;
      if (importClause?.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
        if (hasExParamNamedImport(importClause.namedBindings))
          return sourceFile;

        const updatedNamedImports = ts.factory.updateNamedImports(importClause.namedBindings, [
          ...importClause.namedBindings.elements,
          createExParamImportSpecifier(),
        ]);

        const updatedClause = ts.factory.updateImportClause(
          importClause,
          importClause.phaseModifier,
          importClause.name,
          updatedNamedImports,
        );

        const updatedImport = ts.factory.updateImportDeclaration(
          statement,
          statement.modifiers,
          updatedClause,
          statement.moduleSpecifier,
          statement.attributes,
        );

        const updatedStatements = [...sourceFile.statements];
        updatedStatements[i] = updatedImport;
        return ts.factory.updateSourceFile(sourceFile, updatedStatements);
      }

      const exParamImport = ts.factory.createImportDeclaration(
        undefined,
        ts.factory.createImportClause(noImportPhaseModifier(), undefined, ts.factory.createNamedImports([createExParamImportSpecifier()])),
        ts.factory.createStringLiteral(quotedModule),
      );

      const updatedStatements = [...sourceFile.statements];
      updatedStatements.splice(i + 1, 0, exParamImport);
      return ts.factory.updateSourceFile(sourceFile, updatedStatements);
    }

    const exParamImport = ts.factory.createImportDeclaration(
      undefined,
      ts.factory.createImportClause(noImportPhaseModifier(), undefined, ts.factory.createNamedImports([createExParamImportSpecifier()])),
      ts.factory.createStringLiteral(quotedModule),
    );

    return ts.factory.updateSourceFile(sourceFile, [exParamImport, ...sourceFile.statements]);
  }

  function isMsgCall(node: ts.CallExpression): boolean {
    if (!ts.isIdentifier(node.expression) || node.expression.text !== 'msg')
      return false;
    if (node.arguments.length === 0)
      return true;
    if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]))
      return true;
    return false;
  }

  function transformMsgCall(call: ts.CallExpression, memberName: string, moduleName: string): ts.CallExpression {
    const firstArg = call.arguments.length === 0
      ? ts.factory.createIdentifier('undefined')
      : call.arguments[0];
    return ts.factory.updateCallExpression(
      call,
      call.expression,
      call.typeArguments,
      [firstArg, ts.factory.createStringLiteral(memberName), ts.factory.createStringLiteral(moduleName)],
    );
  }

  function isWithQuotedCall(node: ts.CallExpression): boolean {
    return ts.isIdentifier(node.expression) && node.expression.text == "withQuoted";
  }

  function isQuotedDecoratorNoArgs(modifier: ts.ModifierLike): boolean {
    return ts.isDecorator(modifier) && (
      (ts.isCallExpression(modifier.expression) && ts.isIdentifier(modifier.expression.expression) && modifier.expression.expression.text == "quoted" && modifier.expression.arguments.length == 0) ||
      (ts.isIdentifier(modifier.expression) && modifier.expression.text == "quoted")
    );
  }

  function isFieldDecorator(modifier: ts.ModifierLike): boolean {
    if (!ts.isDecorator(modifier)) return false;
    if (ts.isIdentifier(modifier.expression) && modifier.expression.text == "field") return true;
    if (ts.isCallExpression(modifier.expression) && ts.isIdentifier(modifier.expression.expression) && modifier.expression.expression.text == "field") {
      const args = modifier.expression.arguments;
      return !(args.length === 1 && args[0].kind === ts.SyntaxKind.FalseKeyword);
    }
    return false;
  }

  function isFieldFalseDecorator(modifier: ts.ModifierLike): boolean {
    if (!ts.isDecorator(modifier)) return false;
    if (!ts.isCallExpression(modifier.expression)) return false;
    if (!ts.isIdentifier(modifier.expression.expression) || modifier.expression.expression.text !== "field") return false;
    const args = modifier.expression.arguments;
    return args.length === 1 && args[0].kind === ts.SyntaxKind.FalseKeyword;
  }

  function isIgnoreDecorator(modifier: ts.ModifierLike): boolean {
    return ts.isDecorator(modifier) && (
      (ts.isIdentifier(modifier.expression) && modifier.expression.text == "ignore") ||
      (ts.isCallExpression(modifier.expression) && ts.isIdentifier(modifier.expression.expression) && modifier.expression.expression.text == "ignore")
    );
  }

  // Auto @field injection is triggered by @reflect (a generic, ORM-agnostic
  // marker in ./reflection) and by the entity decorators @entity / @partEntity,
  // so it applies to entities, part entities, models, DTOs, views, etc.
  const FIELD_INJECTING_DECORATORS = new Set(["reflect", "entity", "partEntity"]);
  function hasReflectionDecorator(node: ts.ClassDeclaration): boolean {
    return node.modifiers?.some(m =>
      ts.isDecorator(m) && (
        (ts.isIdentifier(m.expression) && FIELD_INJECTING_DECORATORS.has(m.expression.text)) ||
        (ts.isCallExpression(m.expression) && ts.isIdentifier(m.expression.expression) && FIELD_INJECTING_DECORATORS.has(m.expression.expression.text))
      )
    ) ?? false;
  }

  function hasThisReference(node: ts.Node): boolean {
    let found = false;
    const walk = (n: ts.Node) => {
      if (found)
        return;

      if (ts.isThisTypeNode(n) || n.kind == ts.SyntaxKind.ThisKeyword) {
        found = true;
        return;
      }

      ts.forEachChild(n, walk);
    };

    walk(node);
    return found;
  }

  function createQuotedArg(quote: ts.Expression): ts.ArrowFunction {
    // No return-type annotation: the post-transform AST is emitted to JS, never
    // re-type-checked, so the `: ExLambda` annotation (and the ExParam import it
    // would drag in) are pure dead weight that ESM bundlers choke on.
    return ts.factory.createArrowFunction(
      undefined,
      undefined,
      [],
      undefined,
      ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      quote,
    );
  }

  function transformWithQuotedCall(node: ts.CallExpression, sourceFile: ts.SourceFile): ts.CallExpression {
    if (!isWithQuotedCall(node) || node.arguments.length != 1)
      return node;

    const first = node.arguments[0];

    if (ts.isArrowFunction(first)) {
      const quote = quoteExpression(first, []);
      if (quote instanceof QuoteError) {
        addQuoteError(sourceFile, quote);
        return node;
      }

      const quotedArg = createQuotedArg(quote);

      return ts.factory.updateCallExpression(
        node,
        node.expression,
        node.typeArguments,
        [first, quotedArg]
      );
    }

    if (!ts.isFunctionExpression(first)) {
      addNodeError(sourceFile, first, "withQuoted expects a lambda or function expression");
      return node;
    }

    if (!ts.isBlock(first.body)) {
      addNodeError(sourceFile, first.body, "withQuoted function expression must have a block body with exactly one return statement");
      return node;
    }

    const returnStatements = first.body.statements.filter(s => ts.isReturnStatement(s));
    if (first.body.statements.length != 1 || returnStatements.length != 1 || returnStatements[0].expression == null) {
      addNodeError(sourceFile, first.body, "withQuoted function expression must have exactly one return statement");
      return node;
    }

    const thisParams = first.parameters.filter(p => ts.isIdentifier(p.name) && p.name.text == "this");
    if (thisParams.length > 1) {
      addNodeError(sourceFile, first, "withQuoted function expression can declare at most one this parameter");
      return node;
    }

    const declaredThis = thisParams.length == 1;
    const usesThis = hasThisReference(first.body);
    if (usesThis && !declaredThis) {
      addNodeError(sourceFile, first, "withQuoted function expression uses this but does not declare a this parameter");
      return node;
    }

    const parameters = first.parameters.filter(p => !(ts.isIdentifier(p.name) && p.name.text == "this"));
    const syntheticArrow = ts.factory.createArrowFunction(
      undefined,
      undefined,
      parameters,
      undefined,
      ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      returnStatements[0].expression,
    );

    const quote = quoteExpression(syntheticArrow, [], declaredThis);
    if (quote instanceof QuoteError) {
      addQuoteError(sourceFile, quote);
      return node;
    }

    const quotedArg = createQuotedArg(quote);

    return ts.factory.updateCallExpression(
      node,
      node.expression,
      node.typeArguments,
      [first, quotedArg]
    );
  }

  function methodSingleReturnExpression(node: ts.MethodDeclaration): ts.Expression | null {
    if (node.body == null)
      return null;

    const statements = node.body.statements;
    const returnStatements = statements.filter(s => ts.isReturnStatement(s));
    if (statements.length != 1 || returnStatements.length != 1 || returnStatements[0].expression == null)
      return null;

    return returnStatements[0].expression;
  }

  function transformQuotedMethod(node: ts.MethodDeclaration, sourceFile: ts.SourceFile): ts.MethodDeclaration {
    if (!node.modifiers?.some(isQuotedDecoratorNoArgs))
      return node;

    const returnExpression = methodSingleReturnExpression(node);
    if (returnExpression == null) {
      addNodeError(sourceFile, node, "@quoted methods must have exactly one return statement");
      return node;
    }

    const isStatic = node.modifiers?.some(m => m.kind == ts.SyntaxKind.StaticKeyword) ?? false;
    const syntheticArrow = ts.factory.createArrowFunction(
      undefined,
      undefined,
      node.parameters,
      undefined,
      ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      returnExpression,
    );

    const quote = quoteExpression(syntheticArrow, [], !isStatic);
    if (quote instanceof QuoteError) {
      addQuoteError(sourceFile, quote);
      return node;
    }

    const quotedArg = createQuotedArg(quote);

    const modifiers = node.modifiers.map(m => {
      if (!ts.isDecorator(m))
        return m;

      if (ts.isCallExpression(m.expression) && ts.isIdentifier(m.expression.expression) && m.expression.expression.text == "quoted" && m.expression.arguments.length == 0) {
        return ts.factory.createDecorator(ts.factory.createCallExpression(m.expression.expression, undefined, [quotedArg]));
      }

      if (ts.isIdentifier(m.expression) && m.expression.text == "quoted") {
        return ts.factory.createDecorator(ts.factory.createCallExpression(m.expression, undefined, [quotedArg]));
      }

      return m;
    });

    return ts.factory.updateMethodDeclaration(
      node,
      modifiers,
      node.asteriskToken,
      node.name,
      node.questionToken,
      node.typeParameters,
      node.parameters,
      node.type,
      node.body,
    );
  }

  // Adds 'field' to whatever import already brings in 'reflect'.
  // Both live in the same module (e.g. ./reflection), so field auto-injection
  // works for any reflective class (entities, models, DTOs, views, ...).
  function ensureFieldImport(sourceFile: ts.SourceFile): ts.SourceFile {
    // If 'field' is already imported anywhere, nothing to do
    const hasFieldImport = sourceFile.statements.some(stmt => {
      if (!ts.isImportDeclaration(stmt)) return false;
      const nb = stmt.importClause?.namedBindings;
      return nb != null && ts.isNamedImports(nb) && nb.elements.some(e => e.name.text === 'field');
    });
    if (hasFieldImport) return sourceFile;

    // Find the import that has 'reflect' and add 'field' alongside it. 'field' and
    // 'reflect' both live in the reflection module, so field auto-injection anchors on
    // the reflect import. Every reflected file (entity / partEntity / view) imports
    // 'reflect' for exactly this reason.
    let patched = false;
    const newStatements = sourceFile.statements.map(stmt => {
      if (patched || !ts.isImportDeclaration(stmt)) return stmt;
      const nb = stmt.importClause?.namedBindings;
      if (nb == null || !ts.isNamedImports(nb)) return stmt;
      if (!nb.elements.some(e => e.name.text === 'reflect')) return stmt;
      patched = true;
      const newEl = ts.factory.createImportSpecifier(false, undefined, ts.factory.createIdentifier('field'));
      const newNb = ts.factory.updateNamedImports(nb, [...nb.elements, newEl]);
      const clause = stmt.importClause!;
      const newClause = ts.factory.updateImportClause(clause, clause.phaseModifier, clause.name, newNb);
      return ts.factory.updateImportDeclaration(stmt, stmt.modifiers, newClause, stmt.moduleSpecifier, stmt.attributes);
    });
    return patched ? ts.factory.updateSourceFile(sourceFile, newStatements) : sourceFile;
  }

  const FILE_INFO_LOCAL = "__fileInfo";

  // Adds `importName` to the first existing import that brings in any of `anchors`
  // (no-op if already imported, or if no anchor import is present). Piggybacking on
  // an existing import means the transformer never needs to know the module path:
  // reflect / register* come from reflection, msg from localization — all of which
  // export the register* functions (localization re-exports them from the leaf).
  function ensureImported(sourceFile: ts.SourceFile, importName: string, anchors: ReadonlySet<string>): ts.SourceFile {
    const already = sourceFile.statements.some(stmt => {
      if (!ts.isImportDeclaration(stmt)) return false;
      const nb = stmt.importClause?.namedBindings;
      return nb != null && ts.isNamedImports(nb) && nb.elements.some(e => e.name.text === importName);
    });
    if (already) return sourceFile;

    let patched = false;
    const newStatements = sourceFile.statements.map(stmt => {
      if (patched || !ts.isImportDeclaration(stmt)) return stmt;
      const nb = stmt.importClause?.namedBindings;
      if (nb == null || !ts.isNamedImports(nb)) return stmt;
      if (!nb.elements.some(e => anchors.has(e.name.text))) return stmt;
      patched = true;
      const newEl = ts.factory.createImportSpecifier(false, undefined, ts.factory.createIdentifier(importName));
      const newNb = ts.factory.updateNamedImports(nb, [...nb.elements, newEl]);
      const clause = stmt.importClause!;
      const newClause = ts.factory.updateImportClause(clause, clause.phaseModifier, clause.name, newNb);
      return ts.factory.updateImportDeclaration(stmt, stmt.modifiers, newClause, stmt.moduleSpecifier, stmt.attributes);
    });
    return patched ? ts.factory.updateSourceFile(sourceFile, newStatements) : sourceFile;
  }

  const REFLECT_ANCHOR: ReadonlySet<string> = new Set(["reflect"]);
  const OBJECT_ANCHOR: ReadonlySet<string> = new Set(["msg", "reflect"]);

  // Augments a hand-written registerEnum(X) / registerObject(X) call: injects the
  // bundler-proof name literal (from the identifier arg) and, when a location is
  // resolved, the per-file __fileInfo object. Idempotent — a call that already
  // carries extra args is left untouched. Stays a free function call so it can be
  // written by hand (for enums/objects declared in another file).
  const LOCATION_REGISTRATION_CALLS = new Set(["registerEnum", "registerObject"]);
  function augmentRegistrationCall(node: ts.CallExpression, loc: SourceLocation | null): ts.CallExpression {
    if (!ts.isIdentifier(node.expression) || !LOCATION_REGISTRATION_CALLS.has(node.expression.text))
      return node;
    if (node.arguments.length !== 1)
      return node; // already augmented (or an unexpected shape) — don't touch
    const first = node.arguments[0];
    if (!ts.isIdentifier(first))
      return node; // need an identifier to derive the "Name" literal

    const args: ts.Expression[] = [first, ts.factory.createStringLiteral(first.text)];
    if (loc != null) {
      usedFileInfo = true;
      args.push(ts.factory.createIdentifier(FILE_INFO_LOCAL));
    }
    return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, args);
  }

  // Inserts `const __fileInfo = { module: "@pkg", fileName: "rel/file.ts" };` right
  // after the file's import section. A plain object literal (no FileInfo class, no
  // import), passed as the last arg of register* — so the package/file literals
  // aren't repeated per call, and manual registerEnum/registerObject calls can use it.
  function insertFileInfoDecl(sourceFile: ts.SourceFile, loc: SourceLocation): ts.SourceFile {
    let lastImport = -1;
    for (let i = 0; i < sourceFile.statements.length; i++)
      if (ts.isImportDeclaration(sourceFile.statements[i])) lastImport = i;

    const decl = ts.factory.createVariableStatement(
      undefined,
      ts.factory.createVariableDeclarationList(
        [ts.factory.createVariableDeclaration(
          FILE_INFO_LOCAL, undefined, undefined,
          ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment("packageName", ts.factory.createStringLiteral(loc.packageName)),
            ts.factory.createPropertyAssignment("fileName", ts.factory.createStringLiteral(loc.fileName)),
          ], false),
        )],
        ts.NodeFlags.Const,
      ),
    );

    const statements = [...sourceFile.statements];
    statements.splice(lastImport + 1, 0, decl);
    return ts.factory.updateSourceFile(sourceFile, statements);
  }

  // Appends registerType(Class, "Class", __fileInfo) / registerEnum(E, "E", __fileInfo)
  // / registerObject(Obj, "Obj", __fileInfo) at module scope. When loc is null
  // (no resolvable package) the __fileInfo arg is omitted.
  function appendRegistrations(sourceFile: ts.SourceFile, typeNames: string[], enumNames: string[], objectNames: string[], loc: SourceLocation | null): ts.SourceFile {
    const call = (fn: string, name: string) => {
      const args: ts.Expression[] = [ts.factory.createIdentifier(name), ts.factory.createStringLiteral(name)];
      if (loc != null) args.push(ts.factory.createIdentifier(FILE_INFO_LOCAL));
      return ts.factory.createExpressionStatement(
        ts.factory.createCallExpression(ts.factory.createIdentifier(fn), undefined, args),
      );
    };
    const stmts = [
      ...typeNames.map(n => call("registerType", n)),
      ...enumNames.map(n => call("registerEnum", n)),
      ...objectNames.map(n => call("registerObject", n)),
    ];
    return ts.factory.updateSourceFile(sourceFile, [...sourceFile.statements, ...stmts]);
  }

  // Computes the @field factory args from a type annotation node.
  // First arg is always the element/inner type; second arg is an options object when needed.
  // e.g. @field(() => Person, { array: true }) for Person[]
  //      @field(() => Person, { lite: true }) for Lite<Person>
  //      @field(() => Number, { name: "int", nullable: true, array: true }) for (int | null)[]
  // The container is described by boolean flags (lite / array) rather than a
  // runtime `() => Lite`/`() => Array` reference — so the transformer never emits
  // a value reference to the imported `Lite` type (which TS would elide).
  function buildFieldFactories(typeNode: ts.TypeNode): ts.Expression[] | null {
    const resolved = resolveElementType(typeNode, false);
    if (resolved == null) return null;

    const { typeName, name, nullable, lite, array, isEnum, thunkNode } = resolved;

    const props: ts.ObjectLiteralElementLike[] = [];
    if (thunkNode != null) {
      if (isTypeOnlyImported(thunkNode))
        throw new Error(
          `@field: '${thunkNode.text}' is used as a runtime type reference but is imported with 'import type'. ` +
          `Import it as a value (\`import { ${thunkNode.text} }\`) so the transformer can emit a ` +
          `\`() => ${thunkNode.text}\` reference (needed for registration under verbatimModuleSyntax).`,
        );
      // A value reference (entity/embedded class or enum): emit a lazy ctor thunk.
      // This makes the module graph mirror the entity reference graph — importing an
      // owner transitively loads and registers the referenced type — and gives
      // rename-/load-order-proof resolution. `typeName` is kept alongside it for
      // name-based consumers (schema/query) and clean-name (wire/URL) derivation.
      props.push(ts.factory.createPropertyAssignment("type",
        ts.factory.createArrowFunction(undefined, undefined, [], undefined,
          ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
          ts.factory.createIdentifier(thunkNode.text))));
    }
    props.push(ts.factory.createPropertyAssignment("typeName", ts.factory.createStringLiteral(typeName)));
    if (name != null)
      props.push(ts.factory.createPropertyAssignment("name", ts.factory.createStringLiteral(name)));
    if (nullable === true)
      props.push(ts.factory.createPropertyAssignment("nullable", ts.factory.createTrue()));
    if (lite === true)
      props.push(ts.factory.createPropertyAssignment("lite", ts.factory.createTrue()));
    if (array === true)
      props.push(ts.factory.createPropertyAssignment("array", ts.factory.createTrue()));
    if (isEnum === true)
      props.push(ts.factory.createPropertyAssignment("enum", ts.factory.createTrue()));

    return [ts.factory.createObjectLiteralExpression(props)];
  }

  interface ElementTypeResult {
    typeName: string;
    name?: string;
    nullable?: true;
    lite?: true;
    array?: true;
    isEnum?: true;
    // When the element type is a runtime *value* (an entity/embedded class or an
    // enum), the identifier to emit as a `type: () => X` thunk. Value types
    // (Number/String/Date/Decimal/Temporal.*/interfaces) leave it unset and keep
    // only the `typeName` string.
    thunkNode?: ts.Identifier;
  }

  // Type names that map to a value by NAME (in logic/schema/dbType), so they stay
  // plain `typeName` strings and never get a `() => X` thunk — even though Date /
  // Decimal are runtime classes. (Number/String/Boolean arrive as keywords, and
  // Temporal.* as qualified names, so they never reach the thunk check anyway; the
  // set makes the intent explicit and guards the direct-import edge cases.)
  const VALUE_TYPE_NAMES: ReadonlySet<string> = new Set([
    "Number", "String", "Boolean", "BigInt", "Date", "Decimal",
    "PlainDate", "PlainDateTime", "PlainTime", "Instant", "ZonedDateTime",
    "Duration", "PlainYearMonth", "PlainMonthDay",
  ]);

  // True when a type-reference identifier resolves to a runtime value — a class or a
  // (non-const) enum — i.e. something a `() => X` thunk can reference. Interfaces and
  // type aliases have no value declaration and return false (those stay name strings,
  // e.g. @implementedBy interface references).
  function resolvesToValue(name: ts.Identifier): boolean {
    let symbol = typeChecker.getSymbolAtLocation(name);
    if (symbol == null) return false;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      try { symbol = typeChecker.getAliasedSymbol(symbol); } catch { return false; }
    }
    if (symbol.flags & ts.SymbolFlags.ConstEnum) return false; // inlined, no runtime object
    return (symbol.flags & ts.SymbolFlags.Value) !== 0;
  }

  // True when the identifier is brought in by a type-only import (`import type { X }`
  // or a type-only specifier). Emitting `() => X` for such a reference would compile
  // but crash at runtime (the import is erased under verbatimModuleSyntax), so the
  // transformer refuses it with a clear error instead.
  function isTypeOnlyImported(name: ts.Identifier): boolean {
    const symbol = typeChecker.getSymbolAtLocation(name);
    if (symbol == null) return false;
    for (const decl of symbol.declarations ?? []) {
      if (ts.isImportSpecifier(decl)) {
        if (decl.isTypeOnly) return true;
        const clause = decl.parent.parent;
        if (ts.isImportClause(clause) && clause.isTypeOnly) return true;
      } else if (ts.isImportClause(decl) && decl.isTypeOnly) {
        return true;
      }
    }
    return false;
  }

  // Resolves the element/inner type to its runtime *name* plus container/nullable
  // metadata. The name is a string (never a `() => Type` reference), so an
  // imported type is never referenced at runtime and so never elided by TS.
  // insideContainer=true: a | null on this node sets nullable on the result.
  function resolveElementType(typeNode: ts.TypeNode, insideContainer: boolean): ElementTypeResult | null {
    // (T | null)[] has elementType = ParenthesizedTypeNode — unwrap before processing
    let type: ts.TypeNode = typeNode;
    while (ts.isParenthesizedTypeNode(type)) type = type.type;

    let elementNullable: true | undefined;

    const stripped = extractNull(type);
    if (stripped) {
      type = stripped.cleanType;
      while (ts.isParenthesizedTypeNode(type)) type = type.type;
      if (!ts.isArrayTypeNode(type))
        elementNullable = true;
    }

    // T[] — array shorthand. Preserves an inner `lite` flag (Lite<T>[]).
    if (ts.isArrayTypeNode(type)) {
      const inner = resolveElementType(type.elementType, true);
      if (inner == null) return null;
      return { ...inner, array: true };
    }

    // Generic<T> with exactly one type arg: only Lite<T> and Array<T> are
    // recognized containers (mapped to flags); other generics fall through to
    // be treated as a plain class reference.
    if (ts.isTypeReferenceNode(type) && type.typeArguments?.length == 1 && ts.isIdentifier(type.typeName)) {
      const outerName = type.typeName.text;
      if (outerName === "Lite" || outerName === "Array") {
        const inner = resolveElementType(type.typeArguments[0], true);
        if (inner == null) return null;
        const flag = outerName === "Lite" ? { lite: true as const } : { array: true as const };
        return { ...inner, ...flag, nullable: elementNullable ?? inner.nullable };
      }
    }

    if (ts.isTypeReferenceNode(type) && !type.typeArguments?.length && ts.isIdentifier(type.typeName)) {
      // Primitive alias: type int = number  →  @field({ typeName: "Number", name: "int" })
      const alias = resolvePrimitiveAlias(type);
      if (alias != null) {
        return {
          typeName: alias.constructorName,
          name: alias.aliasName,
          nullable: elementNullable,
        };
      }

      // Regular enum: Color  →  @field({ type: () => Color, typeName: "Color", enum: true }).
      // The thunk keeps the enum registered across files (import edge); typeName + enum
      // flag drive the existing enum handling.
      if (isEnumType(type)) {
        return {
          typeName: type.typeName.text,
          isEnum: true,
          nullable: elementNullable,
          thunkNode: type.typeName,
        };
      }
    }

    // Fallback: keyword (number, string, boolean) or a plain named type reference
    // (class, Date, Decimal, Temporal.*, entity, embedded).
    const typeName = typeNameOf(type);
    if (typeName == null) return null;
    const result: ElementTypeResult = { typeName, nullable: elementNullable };
    // Entity/embedded class reference (a runtime value that isn't a by-name value
    // type) → emit a `() => X` thunk. Interfaces (@implementedBy targets), Date,
    // Decimal, Temporal.* and keywords stay name-only.
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)
      && !VALUE_TYPE_NAMES.has(typeName) && resolvesToValue(type.typeName))
      result.thunkNode = type.typeName;
    return result;
  }

  // The runtime *name* of a type node: built-in keywords map to their wrapper
  // constructor name; a type reference uses its (rightmost) identifier, e.g.
  // `Temporal.PlainDate` → "PlainDate", `CustomerEntity` → "CustomerEntity".
  function typeNameOf(node: ts.TypeNode): string | null {
    if (node.kind == ts.SyntaxKind.BooleanKeyword) return "Boolean";
    if (node.kind == ts.SyntaxKind.NumberKeyword) return "Number";
    if (node.kind == ts.SyntaxKind.StringKeyword) return "String";
    if (ts.isTypeReferenceNode(node)) return cleanTypeName(node.typeName) ?? null;
    return null;
  }

  function resolvePrimitiveAlias(node: ts.TypeReferenceNode): { constructorName: string; aliasName: string } | null {
    let tsType = typeChecker.getTypeFromTypeNode(node);
    const aliasName = (node.typeName as ts.Identifier).text;

    // Branded aliases like `type int = number & { __brand }` are intersection
    // types — unwrap to the underlying primitive so `int`/`long` resolve to
    // Number (the alias name is carried through as the `name`/kind).
    if (tsType.flags & ts.TypeFlags.Intersection) {
      const primitive = (tsType as ts.IntersectionType).types.find(t =>
        t.flags & (ts.TypeFlags.Number | ts.TypeFlags.String | ts.TypeFlags.Boolean | ts.TypeFlags.BigInt));
      if (primitive != null) tsType = primitive;
    }

    if (tsType.flags & ts.TypeFlags.Number) return { constructorName: "Number", aliasName };
    if (tsType.flags & ts.TypeFlags.String) return { constructorName: "String", aliasName };
    if (tsType.flags & ts.TypeFlags.Boolean) return { constructorName: "Boolean", aliasName };
    if (tsType.flags & ts.TypeFlags.BigInt) return { constructorName: "BigInt", aliasName };

    return null;
  }

  function isEnumType(node: ts.TypeReferenceNode): boolean {
    const symbol = typeChecker.getSymbolAtLocation(node.typeName);
    return symbol != null && (symbol.flags & ts.SymbolFlags.RegularEnum) !== 0;
  }

  // Injects @field decorators for properties in a class decorated with @entity that are missing them.
  function injectMissingFieldDecorators(node: ts.ClassDeclaration, sourceFile: ts.SourceFile): ts.ClassDeclaration {
    const newMembers = node.members.map((member): ts.ClassElement => {
      if (!ts.isPropertyDeclaration(member))
        return member;

      const isStatic = member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
      if (isStatic) return member;

      // Record enum types referenced by this reflected class (whether the @field
      // is injected below or already explicit) so same-file enums auto-register.
      if (member.type != null) {
        const resolved = resolveElementType(member.type, false);
        if (resolved?.isEnum) referencedEnumNames.add(resolved.typeName);
      }

      const hasField = member.modifiers?.some(m => isFieldDecorator(m)) ?? false;
      const hasIgnore = member.modifiers?.some(m => isIgnoreDecorator(m)) ?? false;
      const hasFieldFalse = member.modifiers?.some(m => isFieldFalseDecorator(m)) ?? false;
      if (hasField || hasIgnore || hasFieldFalse || !member.type) return member;

      const factories = buildFieldFactories(member.type);
      if (factories == null) {
        addNodeError(sourceFile, member.type, "Unable to make run-time reference for auto-injected @field");
        return member;
      }

      needsFieldImport = true;
      const fieldCall = ts.factory.createCallExpression(
        ts.factory.createIdentifier("field"),
        undefined,
        factories,
      );
      const fieldDecorator = ts.factory.createDecorator(fieldCall);

      const newModifiers: ts.ModifierLike[] = [fieldDecorator, ...(member.modifiers ?? [])];
      return ts.factory.updatePropertyDeclaration(
        member,
        newModifiers,
        member.name,
        member.questionToken ?? member.exclamationToken,
        member.type,
        member.initializer,
      );
    });

    return ts.factory.updateClassDeclaration(
      node,
      node.modifiers,
      node.name,
      node.typeParameters,
      node.heritageClauses,
      newMembers,
    );
  }

  return function myTransformer(ctx: ts.TransformationContext): ts.Transformer<ts.SourceFile> {

    return (sourceFile: ts.SourceFile) => {
      generatedExParam = false;
      needsFieldImport = false;
      registerNames = [];
      registerObjectNames = [];
      usedFileInfo = false;
      declaredEnumNames = new Set();
      referencedEnumNames = new Set();
      const sourceLocation = resolveSourceLocation(sourceFile.fileName);
      let quotedContextDepth = 0;
      let msgModuleName: string | null = null;
      let msgMemberName: string | null = null;

      function visitWithQuotedContext<TNode extends ts.Node>(node: TNode): TNode {
        quotedContextDepth++;
        try {
          return ts.visitEachChild(node, visit, ctx) as TNode;
        } finally {
          quotedContextDepth--;
        }
      }

      function visit(node: ts.Node): ts.Node {

        // Record top-level enum declarations (for same-file auto-registration).
        if (ts.isEnumDeclaration(node) && ts.isSourceFile(node.parent))
          declaredEnumNames.add(node.name.text);

        // Track module name for msg() rewriting: module-level const X = { ... }
        if (ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer && ts.isObjectLiteralExpression(node.initializer) &&
          ts.isVariableDeclarationList(node.parent) &&
          (node.parent.flags & ts.NodeFlags.Const) !== 0 &&
          ts.isVariableStatement(node.parent.parent) &&
          ts.isSourceFile(node.parent.parent.parent)
        ) {
          const prev = msgModuleName;
          msgModuleName = node.name.text;
          const result = ts.visitEachChild(node, visit, ctx);
          msgModuleName = prev;
          return result;
        }

        // Track member name for msg() rewriting: property keys inside the object
        if (ts.isPropertyAssignment(node) && msgModuleName != null) {
          const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
          if (key != null) {
            const prev = msgMemberName;
            msgMemberName = key;
            const result = ts.visitEachChild(node, visit, ctx);
            msgMemberName = prev;
            return result;
          }
        }

        if (ts.isCallExpression(node)) {
          let visited: ts.CallExpression;

          if (isWithQuotedCall(node) && node.arguments.length > 0) {
            const expression = ts.visitNode(node.expression, visit) as ts.LeftHandSideExpression;
            const updatedArguments = node.arguments.map((arg, index) =>
              index == 0
                ? visitWithQuotedContext(arg)
                : ts.visitNode(arg, visit) as ts.Expression
            );

            visited = ts.factory.updateCallExpression(
              node,
              expression,
              node.typeArguments,
              updatedArguments,
            );
          } else {
            visited = ts.visitEachChild(node, visit, ctx) as ts.CallExpression;
          }

          const afterQuote = transformWithQuotedCall(visited, sourceFile);

          if (ts.isCallExpression(afterQuote) && isMsgCall(afterQuote) && msgModuleName != null && msgMemberName != null) {
            // A msg() container const: remember it so it gets registerObject'd.
            if (!registerObjectNames.includes(msgModuleName)) registerObjectNames.push(msgModuleName);
            return transformMsgCall(afterQuote, msgMemberName, msgModuleName);
          }

          if (ts.isCallExpression(afterQuote))
            return augmentRegistrationCall(afterQuote, sourceLocation);

          return afterQuote;
        }

        if (ts.isMethodDeclaration(node)) {
          const visited = node.modifiers?.some(isQuotedDecoratorNoArgs)
            ? visitWithQuotedContext(node)
            : ts.visitEachChild(node, visit, ctx) as ts.MethodDeclaration;

          return transformQuotedMethod(visited, sourceFile);
        }

        if (ts.isArrowFunction(node)) {
          const assignedToQuoted = assignedToQuoteOfT(node, typeChecker);
          const visited = assignedToQuoted
            ? visitWithQuotedContext(node)
            : ts.visitEachChild(node, visit, ctx) as ts.ArrowFunction;

          if (!(assignedToQuoted && quotedContextDepth == 0))
            return visited;

          var quote = quoteExpression(visited, []);

          if (quote instanceof QuoteError) {
            addQuoteError(sourceFile, quote);

            return visited;
          }
          else {
            const quotedArg = createQuotedArg(quote);

            return ts.factory.createCallExpression(
              ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("Object"), "assign"),
              undefined,
              [
                visited,
                ts.factory.createObjectLiteralExpression([
                  ts.factory.createPropertyAssignment("__quoted", quotedArg),
                ], true),
              ],
            );
          }
        }

        if (ts.isClassDeclaration(node)) {
          // Check BEFORE visiting children (type checker works on original AST)
          const isReflection = hasReflectionDecorator(node);
          const visited = ts.visitEachChild(node, visit, ctx) as ts.ClassDeclaration;

          if (!isReflection)
            return visited;

          // Record top-level reflection classes so a registerType(Class, "Class")
          // can be appended at module scope (where the binding is in scope).
          if (node.name != null && ts.isSourceFile(node.parent))
            registerNames.push(node.name.text);

          return injectMissingFieldDecorators(visited, sourceFile);
        }

        if (ts.isPropertyDeclaration(node)) {

          if (node.type && node.modifiers) {
            const hasFieldDec = node.modifiers.some(m => isFieldDecorator(m));

            if (!hasFieldDec)
              return ts.visitEachChild(node, visit, ctx);

            const factories = buildFieldFactories(node.type);
            if (factories == null) {
              addNodeError(sourceFile, node.type, "Unable to take make run-time reference for @field");
              return node;
            }

            const modifiers = node.modifiers.map(m => {
              if (!ts.isDecorator(m))
                return m;

              if (ts.isIdentifier(m.expression) && m.expression.text == "field") {
                return ts.factory.createDecorator(ts.factory.createCallExpression(m.expression, undefined, factories));
              }

              if (!ts.isCallExpression(m.expression) || !ts.isIdentifier(m.expression.expression) || m.expression.expression.text != "field")
                return m;

              if (m.expression.arguments.length == 0)
                return ts.factory.createDecorator(ts.factory.createCallExpression(m.expression.expression, undefined, factories));

              // @field(type) already provided explicitly — leave as-is
              return m;
            });

            const result = ts.factory.updatePropertyDeclaration(node, modifiers, node.name, node.questionToken ?? node.exclamationToken, node.type, node.initializer);
            return result;
          }
        }

        return ts.visitEachChild(node, visit, ctx);
      }

      const transformed = ts.visitNode(sourceFile, visit) as ts.SourceFile;
      const withExParam = generatedExParam ? ensureQuotedImportHasExParam(transformed) : transformed;
      let result = needsFieldImport ? ensureFieldImport(withExParam) : withExParam;

      // Enums declared in this file AND referenced by a reflected field get an
      // auto registerEnum; cross-file enums are registered by hand.
      const autoEnumNames = [...referencedEnumNames].filter(n => declaredEnumNames.has(n));
      const hasAppends = registerNames.length > 0 || autoEnumNames.length > 0 || registerObjectNames.length > 0;

      if (sourceLocation != null && (hasAppends || usedFileInfo)) {
        // Location resolved: declare one __fileInfo object literal and pass it to
        // every register* call, so the package/file literals aren't repeated.
        if (registerNames.length > 0) result = ensureImported(result, "registerType", REFLECT_ANCHOR);
        if (autoEnumNames.length > 0) result = ensureImported(result, "registerEnum", REFLECT_ANCHOR);
        if (registerObjectNames.length > 0) result = ensureImported(result, "registerObject", OBJECT_ANCHOR);
        result = insertFileInfoDecl(result, sourceLocation);
        result = appendRegistrations(result, registerNames, autoEnumNames, registerObjectNames, sourceLocation);
      } else if (hasAppends) {
        // No resolvable package: register without a __fileInfo argument.
        if (registerNames.length > 0) result = ensureImported(result, "registerType", REFLECT_ANCHOR);
        if (autoEnumNames.length > 0) result = ensureImported(result, "registerEnum", REFLECT_ANCHOR);
        if (registerObjectNames.length > 0) result = ensureImported(result, "registerObject", OBJECT_ANCHOR);
        result = appendRegistrations(result, registerNames, autoEnumNames, registerObjectNames, null);
      }
      return result;

    };
  };



  function extractNull(node: ts.TypeNode): { cleanType: ts.TypeNode } | null {
    if (ts.isUnionTypeNode(node)) {
      if (node.types.some(t => ts.isLiteralTypeNode(t) && t.literal.kind == ts.SyntaxKind.NullKeyword)) {
        var other = node.types.filter(t => !(ts.isLiteralTypeNode(t) && t.literal.kind == ts.SyntaxKind.NullKeyword));

        if (other.length == 1)
          return ({ cleanType: other[0] });
      }
    }

    return null;
  }

  function cleanTypeName(name: ts.EntityName): string | undefined {
    return ts.isQualifiedName(name) ? cleanTypeName(name.right) :
      ts.isIdentifier(name) ? name.text :
        undefined;
  }
}
