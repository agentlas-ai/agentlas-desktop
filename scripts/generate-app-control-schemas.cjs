"use strict";
// Build JSON argument documentation from the same TypeScript API that the app uses, including imported interfaces.
const fs = require("node:fs"), path = require("node:path"), ts = require("typescript");

function generateAppControlSchemas({ root, operations, check, outputDirectory = path.join(root, "electron/app-control") }) {
  const hostSources = fs.readdirSync(path.join(root, "electron/science-host"))
    .filter(name => name.endsWith("-ipc.ts")).sort()
    .map(name => path.join(root, "electron/science-host", name));
  const program = ts.createProgram([path.join(root, "shared/types.ts"), path.join(root, "shared/app-ui-preferences.ts"), path.join(root, "electron/preload.ts"), path.join(root, "electron/science-preload.ts"), path.join(root, "electron/main.ts"),
    path.join(root, "electron/daemon/science-service.ts"), path.join(root, "electron/science-host/daemon-ipc.ts"),
    path.join(root, "electron/science-host/publication-ipc.ts"), path.join(root, "electron/science-host/style-library-ipc.ts"),
    path.join(root, "electron/science-host/math-ipc.ts"), ...hostSources], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10,
    skipLibCheck: true, esModuleInterop: true, strict: true,
  });
  const checker = program.getTypeChecker();
  const shared = program.getSourceFile(path.join(root, "shared/types.ts"));
  const ipc = shared.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === "AgentlasIpc");
  const ipcType = checker.getTypeAtLocation(ipc);
  const science = program.getSourceFile(path.join(root, "electron/science-preload.ts"));
  let scienceRoot;
  const findScience = node => {
    if (ts.isCallExpression(node) && /exposeInMainWorld$/.test(node.expression.getText(science)) && node.arguments[0]?.text === "agentlasScience") {
      let arg = node.arguments[1];
      if (ts.isCallExpression(arg) && arg.expression.getText(science) === "Object.freeze") arg = arg.arguments[0];
      scienceRoot = checker.getTypeAtLocation(arg);
    }
    ts.forEachChild(node, findScience);
  };
  findScience(science);
  const flags = ts.TypeFlags;
  const describe = type => checker.typeToString(type).replace(/import\("[^\"]*"\)\./g, "").slice(0, 160);
  // Owner-local labels (the experience map's local titles) never reach an agent-facing schema; see relation-index.ts.
  const OWNER_LOCAL_FIELDS = new Set(["localLabel"]);
  function withoutOwnerLocalFields(node) {
    if (Array.isArray(node)) return node.map(withoutOwnerLocalFields);
    if (!node || typeof node !== "object") return node;
    const copy = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
        copy[key] = Object.fromEntries(Object.entries(value).filter(([name]) => !OWNER_LOCAL_FIELDS.has(name)).map(([name, field]) => [name, withoutOwnerLocalFields(field)]));
      } else if (key === "required" && Array.isArray(value)) copy[key] = value.filter((name) => !OWNER_LOCAL_FIELDS.has(name));
      else copy[key] = withoutOwnerLocalFields(value);
    }
    return copy;
  }
  function schema(type, depth = 0, seen = new Set()) {
    if (!type) return {};
    if (type.flags & (flags.Any | flags.Unknown)) return { description: "Host validates this JSON value." };
    if (type.isUnion()) {
      const parts = type.types.filter(t => !(t.flags & (flags.Undefined | flags.Never)));
      if (!parts.length) return {};
      const literals = parts.map(t => t.flags & flags.StringLiteral ? t.value : t.flags & flags.NumberLiteral ? t.value : t.flags & flags.BooleanLiteral ? t.intrinsicName === "true" : t.flags & flags.Null ? null : undefined);
      if (literals.every(v => v !== undefined)) return { enum: [...new Set(literals)] };
      const variants = [...new Map(parts.map(t => { const value = schema(t, depth, seen); return [JSON.stringify(value), value]; })).values()];
      return variants.length === 1 ? variants[0] : { anyOf: variants };
    }
    if (type.flags & flags.StringLiteral) return { enum: [type.value] };
    if (type.flags & flags.NumberLiteral) return { enum: [type.value] };
    if (type.flags & flags.BooleanLiteral) return { enum: [type.intrinsicName === "true"] };
    if (type.flags & flags.StringLike) return { type: "string" };
    if (type.flags & flags.NumberLike) return { type: "number" };
    if (type.flags & flags.BooleanLike) return { type: "boolean" };
    if (type.flags & flags.Null) return { type: "null" };
    const binaryName = type.getSymbol()?.getName();
    if (["Uint8Array", "Buffer", "ArrayBuffer"].includes(binaryName)) return {
      oneOf: [
        { type: "array", items: { type: "integer", minimum: 0, maximum: 255 } },
        { type: "object", properties: { base64: { type: "string" } }, required: ["base64"], additionalProperties: false },
      ],
      "x-agentlas-binary": binaryName === "ArrayBuffer" ? "ArrayBuffer" : "Uint8Array",
    };
    if (depth >= 4 || seen.has(type)) return { description: describe(type) };
    const nextSeen = new Set(seen); nextSeen.add(type);
    if (checker.isTupleType(type)) {
      const items = checker.getTypeArguments(type), target = type.target;
      const rest = target.elementFlags.findIndex(flag => flag & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic));
      return { type: "array", items: items.slice(0, rest < 0 ? items.length : rest).map(item => schema(item, depth + 1, nextSeen)),
        minItems: target.minLength, ...(rest < 0 ? { maxItems: target.fixedLength, additionalItems: false }
          : { additionalItems: schema(items[rest], depth + 1, nextSeen) }) };
    }
    if (checker.isArrayType(type)) {
      const items = checker.getTypeArguments(type);
      return { type: "array", items: items.length === 1 ? schema(items[0], depth + 1, nextSeen) : {} };
    }
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length) return { description: "A callback cannot be supplied as JSON." };
    const fields = checker.getPropertiesOfType(type);
    const properties = {}, required = [];
    for (const field of fields.slice(0, 80)) {
      const declaration = field.valueDeclaration ?? field.declarations?.[0] ?? ipc;
      properties[field.name] = schema(checker.getTypeOfSymbolAtLocation(field, declaration), depth + 1, nextSeen);
      if (!(field.flags & ts.SymbolFlags.Optional)) required.push(field.name);
    }
    const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    return { type: "object", properties, ...(required.length ? { required } : {}),
      additionalProperties: index ? schema(index, depth + 1, nextSeen) : fields.length > 80,
      ...(fields.length > 80 ? { description: `${describe(type)}; additional fields are checked by the host.` } : {}) };
  }
  function operationType(operation) {
    let type = operation.surface === "science" ? scienceRoot : ipcType;
    const segments = operation.path.split(".").slice(operation.surface === "science" ? 1 : 0);
    for (const segment of segments) {
      const field = checker.getPropertyOfType(checker.getNonNullableType(type), segment);
      if (!field) return null;
      type = checker.getTypeOfSymbolAtLocation(field, field.valueDeclaration ?? field.declarations?.[0] ?? ipc);
    }
    return checker.getNonNullableType(type);
  }
  // Preload intentionally treats Science inputs as untrusted unknown. Resolve
  // their documentation from the native executor's discriminated command types.
  const nativeInputs = new Map();
  const fieldType = (type, name) => {
    const field = checker.getPropertyOfType(type, name);
    return field && checker.getTypeOfSymbolAtLocation(field, field.valueDeclaration ?? field.declarations?.[0] ?? ipc);
  };
  const strings = type => !type ? [] : type.isUnion() ? type.types.flatMap(strings)
    : type.flags & flags.StringLiteral ? [type.value] : [];
  const commandSource = program.getSourceFile(path.join(root, "electron/daemon/science-service.ts"));
  const command = commandSource.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === "DaemonScienceCommand");
  const commandType = checker.getTypeAtLocation(command);
  for (const variant of commandType.isUnion() ? commandType.types : [commandType]) {
    const input = fieldType(variant, "input");
    for (const op of strings(fieldType(variant, "op"))) if (input) nativeInputs.set(op, input);
  }
  const unwrap = node => {
    while (node && (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))) node = node.expression;
    return node;
  };
  function constant(node, bindings) {
    node = unwrap(node);
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) return bindings.get(node.text);
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(element => constant(element, bindings));
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        const part = constant(span.expression, bindings);
        if (typeof part !== "string") return undefined;
        value += part + span.literal.text;
      }
      return value;
    }
    return undefined;
  }
  function bind(name, value, bindings) {
    if (ts.isIdentifier(name)) bindings.set(name.text, value);
    else if (ts.isArrayBindingPattern(name) && Array.isArray(value)) {
      name.elements.forEach((element, index) => { if (ts.isBindingElement(element)) bind(element.name, value[index], bindings); });
    }
  }
  const nativeChannels = new Map(), staticInputs = new Map(), normalizedInputs = new Map();
  function truth(node, bindings) {
    if (ts.isBinaryExpression(node)) {
      const left = constant(node.left, bindings), right = constant(node.right, bindings);
      if (left !== undefined && right !== undefined) {
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return left === right;
        if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return left !== right;
      }
    }
    return undefined;
  }
  function children(node, bindings, visit) {
    if (ts.isConditionalExpression(node)) {
      const value = truth(node.condition, bindings);
      if (value !== undefined) { visit(value ? node.whenTrue : node.whenFalse); return; }
    }
    ts.forEachChild(node, visit);
  }
  // Follow raw input aliases, never values returned by a store or filesystem call.
  // This also recognizes host envelopes named raw/value instead of input.
  function rawAliases(handler) {
    const aliases = new Set();
    for (const parameter of handler.parameters ?? []) if (parameter.name.getText() === "input") aliases.add(checker.getSymbolAtLocation(parameter.name));
    const raw = node => {
      node = unwrap(node);
      if (!node) return false;
      if (ts.isIdentifier(node)) return aliases.has(checker.getSymbolAtLocation(node));
      if (ts.isPropertyAccessExpression(node)) return node.name.text === "input";
      if (ts.isConditionalExpression(node)) return raw(node.whenTrue) || raw(node.whenFalse);
      return false;
    };
    const visit = node => {
      const extractsField = expression => {
        let found = false;
        const inspect = part => {
          if (ts.isPropertyAccessExpression(part) && part.name.text !== "input" && raw(part.expression)) found = true;
          ts.forEachChild(part, inspect);
        };
        inspect(expression);
        return found;
      };
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && (!extractsField(node.initializer) && raw(node.initializer) || ts.isCallExpression(node.initializer)
          && node.initializer.arguments.some(argument => argument.getText() === "envelope")
          && /Record<string, unknown>/.test(checker.typeToString(checker.getTypeAtLocation(node.initializer))))) {
        aliases.add(checker.getSymbolAtLocation(node.name));
      }
      ts.forEachChild(node, visit);
    };
    visit(handler);
    return { aliases, raw };
  }
  function commandOps(handler, bindings) {
    const found = new Set();
    const visit = node => {
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText();
        if (name === "dispatch") {
          const op = constant(node.arguments[0], bindings);
          if (typeof op === "string") found.add(op);
        } else if (/\.command(?:Observed)?$/.test(name)) {
          const object = unwrap(node.arguments[0]);
          if (object && ts.isIdentifier(object)) {
            for (const op of strings(fieldType(checker.getTypeAtLocation(object), "op"))) found.add(op);
          } else if (object && ts.isObjectLiteralExpression(object)) {
            const member = object.properties.find(property => property.name?.getText() === "op");
            const op = member && constant(ts.isShorthandPropertyAssignment(member) ? member.name : member.initializer, bindings);
            if (typeof op === "string") found.add(op);
          }
        } else {
          const signature = checker.getResolvedSignature(node), declaration = signature?.declaration;
          if (declaration?.body && declaration.getSourceFile().fileName.endsWith("/electron/science-host/daemon-client.ts")) visit(declaration.body);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(handler);
    return [...found].filter(op => nativeInputs.has(op));
  }
  function sdkInput(handler, bindings) {
    const { raw } = rawAliases(handler);
    const candidates = [], asserted = [];
    const visit = node => {
      if (ts.isAsExpression(node) && (ts.isTypeReferenceNode(node.type) || ts.isImportTypeNode(node.type)) && raw(node.expression)) {
        const type = checker.getTypeFromTypeNode(node.type);
        if (checker.getPropertiesOfType(type).length) asserted.push(type);
      }
      if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        node.arguments.forEach((argument, index) => {
          argument = unwrap(argument);
          // Prefer the SDK's accepted parameter over a widened untrusted cast.
          const predicate = signature && checker.getTypePredicateOfSignature(signature);
          if (raw(argument) && predicate?.type && /\/(?:electron|shared)\/|\/node_modules\/agentlas-science\//.test(signature.declaration?.getSourceFile().fileName ?? "")) candidates.push(predicate.type);
          const parameter = signature?.parameters[index];
          const declaration = parameter?.valueDeclaration ?? parameter?.declarations?.[0];
          const source = declaration?.getSourceFile().fileName ?? "";
          if (source.includes("/node_modules/agentlas-science/") && raw(argument)) {
            const parameterType = checker.getTypeOfSymbolAtLocation(parameter, declaration);
            const returned = checker.getReturnTypeOfSignature(signature);
            if (parameterType.flags & (flags.Any | flags.Unknown) && checker.getPropertiesOfType(returned).length) candidates.push(returned);
          }
          const acceptedType = parameter && checker.getTypeOfSymbolAtLocation(parameter, declaration ?? ipc);
          const daemonClientInput = source.endsWith("/electron/science-host/daemon-client.ts")
            && argument && ts.isObjectLiteralExpression(argument) && acceptedType && !fieldType(acceptedType, "op");
          if (!daemonClientInput && (!argument || !ts.isIdentifier(argument) || !raw(argument))) return;
          if (source.includes("/node_modules/agentlas-science/") || daemonClientInput) {
            const type = checker.getTypeOfSymbolAtLocation(parameter, declaration);
            if (checker.getPropertiesOfType(type).length) candidates.push(type);
          }
        });
      }
      children(node, bindings, visit);
    };
    visit(handler);
    return candidates[0] ?? asserted[0];
  }
  // For hosts that normalize individual fields before calling the SDK, recover
  // the caller's names through those expressions. Contextual SDK parameter types
  // and local normalizer return types supply the schemas; no domain field table.
  function normalizedSchema(handler, bindings, active = new Set()) {
    if (active.has(handler)) return null;
    active = new Set(active); active.add(handler);
    const { aliases, raw } = rawAliases(handler);
    const properties = {}, required = new Set(), scalarAlternatives = new Map();
    const meaningful = value => value && (value.type || value.enum || value.anyOf || value.oneOf);
    const optional = type => type?.isUnion() && type.types.some(part => part.flags & flags.Undefined);
    const add = (name, value, needed = false) => {
      if (!name) return;
      const old = properties[name];
      // A narrowed enum is more useful than its primitive/contextual superset.
      const weight = candidate => !meaningful(candidate) ? 0 : candidate.enum || candidate.anyOf || candidate.oneOf ? 3
        : ["object", "array"].includes(candidate.type) ? 2 + Object.values(candidate.properties ?? {})
          .filter(field => meaningful(field)).length / 100 : 1;
      if (!old || weight(value) > weight(old) || value?.enum && old.enum && value.enum.length < old.enum.length) properties[name] = value;
      if (needed) required.add(name);
    };
    const primitive = type => {
      const value = schema(type);
      return value.enum || ["string", "number", "boolean", "null"].includes(value.type)
        || value.anyOf?.every(part => primitiveSchema(part)) ? value : null;
    };
    const primitiveSchema = value => value.enum || ["string", "number", "boolean", "null"].includes(value.type);
    const refs = (node, seen = new Set()) => {
      node = unwrap(node);
      if (!node || seen.has(node)) return [];
      seen = new Set(seen); seen.add(node);
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(unwrap(node.expression))
        && aliases.has(checker.getSymbolAtLocation(unwrap(node.expression)))) return [node.name.text];
      // A nested field is not the whole caller value (selection.sheetOrdinal,
      // rendered.dpi, etc.). Do not collapse a child's scalar type onto its parent.
      if (ts.isPropertyAccessExpression(node)) return [];
      if (ts.isIdentifier(node)) {
        const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
          && primitive(checker.getTypeAtLocation(node))) return refs(declaration.initializer, seen);
        return [];
      }
      const found = [];
      // A call's result may be a record loaded from the store. Only propagate
      // primitive normalizations, not the inputs that produced another entity.
      if (ts.isCallExpression(node)) {
        if (!primitive(checker.getTypeAtLocation(node))) return [];
        if (ts.isPropertyAccessExpression(node.expression)
          && checker.typeToString(checker.getTypeAtLocation(node.expression.expression)) === checker.typeToString(checker.getTypeAtLocation(node))) {
          found.push(...refs(node.expression.expression, seen));
        }
      }
      children(node, bindings, child => { found.push(...refs(child, seen)); });
      return [...new Set(found)];
    };
    const acceptsMissing = (declaration, parameterIndex) => {
      const parameter = declaration?.parameters?.[parameterIndex];
      if (!parameter || !declaration.body) return false;
      let found = false;
      const visit = node => {
        if (ts.isIfStatement(node) && node.expression.getText().includes(parameter.name.getText())
          && /(?:undefined|null)/.test(node.expression.getText())) {
          const returned = ts.isReturnStatement(node.thenStatement) || ts.isBlock(node.thenStatement)
            && node.thenStatement.statements.some(statement => ts.isReturnStatement(statement));
          if (returned) found = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(declaration.body);
      return found;
    };
    const hasDefault = (expression, seen = new Set()) => {
      expression = unwrap(expression);
      if (!expression || seen.has(expression)) return false;
      seen = new Set(seen); seen.add(expression);
      if (ts.isIdentifier(expression)) {
        const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
        return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && hasDefault(declaration.initializer, seen);
      }
      if (ts.isConditionalExpression(expression)) return [expression.whenTrue, expression.whenFalse]
        .some(branch => branch.kind === ts.SyntaxKind.UndefinedKeyword || branch.getText() === "undefined"
          || !refs(branch).length && ts.isPropertyAccessExpression(unwrap(branch)));
      if (ts.isCallExpression(expression)) {
        const signature = checker.getResolvedSignature(expression);
        return expression.arguments.some((argument, index) => refs(argument).length && acceptsMissing(signature?.declaration, index));
      }
      return false;
    };
    const merge = value => {
      if (value?.type !== "object") return;
      for (const [name, field] of Object.entries(value.properties ?? {})) add(name, field, value.required?.includes(name));
    };
    const visit = node => {
      if (ts.isPropertyAccessExpression(node) || ts.isIdentifier(node)) {
        const names = refs(node);
        const type = checker.getTypeAtLocation(node), value = schema(type);
        if (names.length === 1) add(names[0], value["x-agentlas-binary"] ? value : primitive(type) ?? { description: "Host validates this JSON value." });
        else if (ts.isIdentifier(node) && aliases.has(checker.getSymbolAtLocation(node))) {
          const scalar = primitive(type);
          if (scalar) scalarAlternatives.set(JSON.stringify(scalar), scalar);
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
        const names = refs(node.left), constructor = checker.getTypeAtLocation(node.right);
        const instance = checker.getSignaturesOfType(constructor, ts.SignatureKind.Construct)[0];
        const value = instance && schema(checker.getReturnTypeOfSignature(instance));
        if (names.length === 1 && value?.["x-agentlas-binary"]) add(names[0], value, true);
      }
      if (ts.isAsExpression(node)) {
        const names = refs(node.expression);
        if (names.length === 1) add(names[0], schema(checker.getTypeFromTypeNode(node.type)));
      }
      if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        const declaration = signature?.declaration;
        const returnType = signature && checker.getReturnTypeOfSignature(signature);
        node.arguments.forEach((argument, index) => {
          const parameter = signature?.parameters[index];
          const parameterDeclaration = parameter?.valueDeclaration ?? parameter?.declarations?.[0];
          const parameterType = parameter && checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration ?? ipc);
          const object = unwrap(argument);
          if (object && ts.isObjectLiteralExpression(object)) {
            const target = checker.getContextualType(object) ?? parameterType;
            for (const member of object.properties) {
              if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) continue;
              const expression = ts.isShorthandPropertyAssignment(member) ? member.name : member.initializer;
              const names = refs(expression);
              if (names.length !== 1) continue;
              const field = target && checker.getPropertyOfType(target, member.name.getText().replace(/^["']|["']$/g, ""));
              const type = field && checker.getTypeOfSymbolAtLocation(field, field.valueDeclaration ?? field.declarations?.[0] ?? ipc);
              const narrowed = primitive(checker.getTypeAtLocation(expression));
              const fallback = hasDefault(expression);
              add(names[0], narrowed?.enum ? narrowed : schema(type ?? checker.getTypeAtLocation(expression)), !fallback && field && !(field.flags & ts.SymbolFlags.Optional));
            }
          } else {
            const names = refs(argument);
            if (names.length === 1) {
              const parameterSchema = schema(parameterType);
              const accepted = parameterSchema["x-agentlas-binary"] ? parameterSchema : primitive(parameterType);
              // SDK validators may return an exact typed version of an unknown
              // incoming value under the same field name (e.g. rendered bytes).
              if (parameterType?.flags & (flags.Any | flags.Unknown)
                && parameterDeclaration?.getSourceFile().fileName.includes("/node_modules/agentlas-science/")) {
                const awaited = checker.getAwaitedType(returnType) ?? returnType;
                const output = fieldType(awaited, names[0]);
                if (output) add(names[0], schema(output));
              }
              const localNormalizer = declaration?.body && declaration.getSourceFile().fileName.includes("/electron/science-host/")
                && !checker.getTypePredicateOfSignature(signature);
              const conversion = ["String", "Number"].includes(node.expression.getText());
              const normalized = localNormalizer || conversion ? primitive(returnType) : null;
              const value = accepted ?? normalized;
              if (value) add(names[0], value, !hasDefault(argument) && !acceptsMissing(declaration, index)
                && (accepted ? !optional(parameterType) : localNormalizer && !optional(returnType)));
            }
          }
          // A local input normalizer (e.g. candidateRef) may validate a nested
          // bundle and return its exact typed shape.
          if (raw(argument) && declaration?.body && declaration.getSourceFile().fileName.includes("/electron/science-host/")) {
            const value = schema(returnType);
            if (value.type === "object" && Object.keys(value.properties ?? {}).length) merge(value);
          }
        });
        // Tiny wrappers delegate envelope validation to a local helper. Trace
        // that implementation rather than documenting its output as input.
        if (declaration?.body && declaration.getSourceFile() === handler.getSourceFile()
          && declaration.parameters.some(parameter => parameter.name.getText() === "envelope")
          && rawAliases(declaration).aliases.size
          && node.arguments.some(argument => argument.getText() === "envelope")) {
          merge(normalizedSchema(declaration, bindings, active));
        }
      }
      children(node, bindings, visit);
    };
    visit(handler);
    if (!Object.keys(properties).length) return null;
    const object = { type: "object", properties, ...(required.size ? { required: [...required] } : {}), additionalProperties: false };
    return scalarAlternatives.size ? { anyOf: [...scalarAlternatives.values(), object] } : object;
  }
  // Expand only source-literal registry arrays and template strings. Dynamic
  // renderer values never select a daemon operation or invent a schema.
  function registry(source, allowSdk = false) {
    const visit = (node, bindings) => {
      if (ts.isVariableDeclaration(node) && node.initializer) bind(node.name, constant(node.initializer, bindings), bindings);
      if (ts.isForOfStatement(node)) {
        const values = constant(node.expression, bindings);
        const declaration = ts.isVariableDeclarationList(node.initializer) && node.initializer.declarations[0];
        if (Array.isArray(values) && declaration) {
          for (const value of values) { const iteration = new Map(bindings); bind(declaration.name, value, iteration); visit(node.statement, iteration); }
          return;
        }
      }
      if (ts.isCallExpression(node) && (["register", "handle", "registerAppControlDomainIpc"].includes(node.expression.getText()) || /\.handle$/.test(node.expression.getText()))) {
        const offset = node.expression.getText() === "registerAppControlDomainIpc" ? 1 : 0;
        const channel = constant(node.arguments[offset], bindings), handler = node.arguments[offset + 1];
        if (typeof channel === "string" && channel.startsWith("science:") && handler) {
          const op = constant(handler, bindings);
          const ops = typeof op === "string" && nativeInputs.has(op) ? [op] : commandOps(handler, bindings);
          if (ops.length === 1) nativeChannels.set(channel, ops[0]);
          if (allowSdk) {
            const input = sdkInput(handler, bindings);
            if (input) staticInputs.set(channel, input);
            const normalized = normalizedSchema(handler, bindings);
            if (normalized) normalizedInputs.set(channel, normalized);
          }
        }
      }
      ts.forEachChild(node, child => visit(child, bindings));
    };
    visit(source, new Map());
  }
  registry(program.getSourceFile(path.join(root, "electron/science-host/daemon-ipc.ts")));
  registry(program.getSourceFile(path.join(root, "electron/science-host/publication-ipc.ts")));
  registry(program.getSourceFile(path.join(root, "electron/main.ts")), true);
  registry(program.getSourceFile(path.join(root, "electron/science-host/style-library-ipc.ts")));
  registry(program.getSourceFile(path.join(root, "electron/science-host/math-ipc.ts")), true);
  for (const file of hostSources) registry(program.getSourceFile(file), true);
  function nativeInput(operation) {
    const op = nativeChannels.get(operation.channel);
    return staticInputs.get(operation.channel) ?? (op && nativeInputs.get(op));
  }
  const docs = {};
  for (const operation of operations) {
    const type = operationType(operation);
    const signatures = type ? checker.getSignaturesOfType(type, ts.SignatureKind.Call) : [];
    const properties = {}, required = [];
    operation.params.forEach((name, index) => {
      const parameters = signatures.map(signature => signature.parameters.find(p => p.name === name) ?? signature.parameters[index]);
      const variants = parameters.filter(Boolean).map(parameter => {
        const declaration = parameter?.valueDeclaration ?? parameter?.declarations?.[0];
        const parameterType = parameter && checker.getTypeOfSymbolAtLocation(parameter, declaration ?? ipc);
        const native = operation.surface === "science" && name === "input"
          && (!parameterType || parameterType.flags & (flags.Any | flags.Unknown)) ? nativeInput(operation) : null;
        return native ? schema(native) : operation.surface === "science" && name === "input"
          && (!parameterType || parameterType.flags & (flags.Any | flags.Unknown))
          ? normalizedInputs.get(operation.channel) ?? schema(parameterType) : schema(parameterType);
      });
      const unique = [...new Map(variants.map(value => [JSON.stringify(value), value])).values()];
      properties[name] = unique.length > 1 ? { anyOf: unique } : unique[0] ?? {};
      // An optional callable is still callable. An overload that permits omission makes this named argument optional.
      if (parameters.length && parameters.every(parameter => {
        const declaration = parameter?.valueDeclaration ?? parameter?.declarations?.[0];
        return !!declaration && !declaration.questionToken && !declaration.initializer;
      })) required.push(name);
    });
    docs[operation.path] = { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
  }
  const preferenceSource = program.getSourceFile(path.join(root, "shared/app-ui-preferences.ts"));
  const preferenceInterface = preferenceSource.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === "AppUiPreferences");
  if (!preferenceInterface) throw new Error("AppUiPreferences interface was not found");
  const preferenceType = checker.getTypeAtLocation(preferenceInterface);
  const preferenceSchemas = {};
  for (const field of checker.getPropertiesOfType(preferenceType)) {
    const declaration = field.valueDeclaration ?? field.declarations?.[0] ?? preferenceInterface;
    preferenceSchemas[field.name] = schema(checker.getTypeOfSymbolAtLocation(field, declaration));
  }
  // ── operation contracts (native-harness NH19, doc 14 §6) ────────────────────────────────────────────────────────
  // What each operation returns, which Main entry runs it, and the push channels the bridges subscribe to, all read
  // from the TypeScript the app runs: the bridge's declared return type; for the Science bridge (which answers `any`)
  // the registered Main handler's return type, then the daemon command's own return statements; and the registration
  // call itself. Nothing is inferred from words in a name; a result no source types stays "untyped" with the reason.
  const untypedType = type => !type || !!(type.flags & (flags.Any | flags.Unknown));
  const awaitedOf = type => type ? checker.getAwaitedType(type) ?? type : type;
  const resultSchema = type => {
    const value = awaitedOf(type);
    if (value.flags & (flags.Void | flags.Undefined)) return { type: "null", description: "Returns nothing (JSON null)." };
    return schema(value, 1);
  };
  const registrations = new Map(), prefixRegistrations = new Map();
  const electronDirectory = path.join(root, "electron") + path.sep;
  function scanRegistrations(source) {
    if (!/registerAppControlDomainIpc\(|\.handle\(|\bhandle\(|\bregister\(/.test(source.text)) return;
    const visit = (node, bindings) => {
      if (ts.isVariableDeclaration(node) && node.initializer) bind(node.name, constant(node.initializer, bindings), bindings);
      if (ts.isForOfStatement(node)) {
        const values = constant(node.expression, bindings);
        const declaration = ts.isVariableDeclarationList(node.initializer) && node.initializer.declarations[0];
        if (Array.isArray(values) && declaration) {
          for (const value of values) { const iteration = new Map(bindings); bind(declaration.name, value, iteration); visit(node.statement, iteration); }
          return;
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(source);
        const domain = callee === "registerAppControlDomainIpc";
        if (domain || callee === "register" || callee === "handle" || /\.handle$/.test(callee)) {
          const offset = domain ? 1 : 0;
          const argument = unwrap(node.arguments[offset]);
          // A literal, a folded loop constant, or a const-asserted table member (CH.status) the checker types exactly.
          let channel = constant(argument, bindings);
          if (typeof channel !== "string" && argument) { const literal = checker.getTypeAtLocation(argument); if (literal.isStringLiteral()) channel = literal.value; }
          const entry = { file: path.relative(root, source.fileName), domain, handler: node.arguments[offset + 1], shared: false };
          if (typeof channel === "string" && channel.includes(":")) {
            const prior = registrations.get(channel);
            if (!prior || domain && !prior.domain) registrations.set(channel, entry);
          } else if (argument && ts.isTemplateExpression(argument) && argument.head.text.endsWith(":")) {
            // `prefix:${method}` over a runtime table: every channel under that prefix is registered by this call.
            const prior = prefixRegistrations.get(argument.head.text);
            if (!prior || domain && !prior.domain) prefixRegistrations.set(argument.head.text, { ...entry, shared: true });
          }
        }
      }
      ts.forEachChild(node, child => visit(child, bindings));
    };
    visit(source, new Map());
  }
  for (const source of [...program.getSourceFiles()].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    if (source.fileName.startsWith(electronDirectory) && !source.isDeclarationFile) scanRegistrations(source);
  }
  function handlerReturn(registration) {
    const handler = registration && unwrap(registration.handler);
    if (!handler) return null;
    if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
      const signature = checker.getSignatureFromDeclaration(handler);
      return signature ? checker.getReturnTypeOfSignature(signature) : null;
    }
    if (ts.isIdentifier(handler) || ts.isPropertyAccessExpression(handler)) {
      const signature = checker.getSignaturesOfType(checker.getTypeAtLocation(handler), ts.SignatureKind.Call)[0];
      return signature ? checker.getReturnTypeOfSignature(signature) : null;
    }
    return null;
  }
  // The daemon runs Science commands in runCommand: each `case "op":` group (and an `if (command.op === "op")` block)
  // returns the command's result. Their return expressions are the typed output; nested callbacks are not. A group that
  // only hands the command to another dispatcher (dispatchSciencePublicationCommand) is read through that dispatcher.
  const commandOutputCache = new Map();
  function commandOutputs(fn) {
    if (commandOutputCache.has(fn)) return commandOutputCache.get(fn);
    const outputs = new Map();
    commandOutputCache.set(fn, outputs);
    const file = fn.getSourceFile();
    const returnsOf = statements => {
      const found = [];
      const visit = node => { if (ts.isFunctionLike(node)) return; if (ts.isReturnStatement(node) && node.expression) found.push(node.expression); ts.forEachChild(node, visit); };
      statements.forEach(visit);
      return found;
    };
    const delegateOf = expression => {
      let call = unwrap(expression);
      if (call && ts.isAwaitExpression(call)) call = unwrap(call.expression);
      if (!call || !ts.isCallExpression(call) || !call.arguments.some(argument => argument.getText(file) === "command")) return null;
      const declaration = checker.getResolvedSignature(call)?.declaration;
      return declaration && ts.isFunctionDeclaration(declaration) && declaration.body && declaration !== fn
        && declaration.getSourceFile().fileName.startsWith(electronDirectory) ? declaration : null;
    };
    const record = (ops, statements) => {
      const expressions = returnsOf(statements);
      const delegate = expressions.length === 1 ? delegateOf(expressions[0]) : null;
      const delegated = delegate ? commandOutputs(delegate) : null;
      for (const op of ops) {
        if (outputs.has(op)) continue;
        outputs.set(op, delegated?.get(op) ?? expressions.map(expression => checker.getTypeAtLocation(expression)));
      }
    };
    const visit = node => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isIfStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        && node.expression.left.getText(file) === "command.op" && ts.isStringLiteralLike(node.expression.right)) {
        record([node.expression.right.text], [node.thenStatement]);
      }
      if (ts.isSwitchStatement(node) && node.expression.getText(file) === "command.op") {
        let pending = [];
        for (const clause of node.caseBlock.clauses) {
          if (ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression)) pending.push(clause.expression.text);
          if (clause.statements.length) { if (pending.length) record(pending, clause.statements); pending = []; }
        }
      }
      ts.forEachChild(node, visit);
    };
    fn.body.statements.forEach(visit);
    return outputs;
  }
  let runCommand = null;
  const findRun = node => { if (!runCommand && ts.isFunctionDeclaration(node) && node.name?.text === "runCommand") runCommand = node; else ts.forEachChild(node, findRun); };
  findRun(commandSource);
  const daemonOutputs = runCommand?.body ? commandOutputs(runCommand) : new Map();
  const contracts = {};
  for (const operation of operations) {
    const registration = registrations.get(operation.channel)
      ?? [...prefixRegistrations].find(([prefix]) => operation.channel.startsWith(prefix) && !operation.channel.slice(prefix.length).includes(":"))?.[1];
    const daemonCommand = operation.surface === "science" ? nativeChannels.get(operation.channel) : undefined;
    const type = operationType(operation);
    const signature = type && checker.getSignaturesOfType(type, ts.SignatureKind.Call)[0];
    const bridge = signature ? checker.getReturnTypeOfSignature(signature) : null;
    let output, basis, untypedReason, handlerAgreement;
    const daemonTypes = daemonCommand ? daemonOutputs.get(daemonCommand) ?? [] : [];
    // The registered Main handler's return type is what the call actually sends back, so it leads. A `prefix:${method}`
    // table registration shares one handler across methods, so its type says nothing about one operation.
    const handled = registration && !registration.shared ? handlerReturn(registration) : null;
    const isVoid = value => !!(awaitedOf(value).flags & (flags.Void | flags.Undefined));
    if (!untypedType(awaitedOf(handled))) {
      output = resultSchema(handled); basis = isVoid(handled) ? "void" : "main-handler-type";
      // Where the renderer's bridge also declares a type, record whether the handler's result is assignable to it.
      handlerAgreement = untypedType(awaitedOf(bridge)) ? "bridge-untyped" : checker.isTypeAssignableTo(awaitedOf(handled), awaitedOf(bridge)) ? "assignable" : "mismatch";
    } else if (!untypedType(awaitedOf(bridge))) {
      output = resultSchema(bridge); basis = isVoid(bridge) ? "void" : "bridge-type";
      handlerAgreement = registration?.shared ? "shared-table-handler" : "handler-untyped";
    } else if (daemonTypes.length && daemonTypes.every(item => !untypedType(awaitedOf(item)))) {
      const variants = [...new Map(daemonTypes.map(item => { const value = resultSchema(item); return [JSON.stringify(value), value]; })).values()];
      output = variants.length === 1 ? variants[0] : { anyOf: variants }; basis = "daemon-command-type";
    } else {
      untypedReason = !registration ? "handler-not-found-statically" : daemonCommand ? (daemonTypes.length ? "daemon-command-returns-untyped" : "daemon-command-has-no-return") : "handler-returns-untyped";
      output = { description: "The handler returns an untyped JSON value; read it as data." }; basis = "untyped";
    }
    // app.call strips owner-local map titles before an agent sees the result (relation-index.ts withoutOwnerLocalLabels),
    // so the agent-facing contract does not list them either.
    output = withoutOwnerLocalFields(output);
    contracts[operation.path] = { output, outputBasis: basis, ...(untypedReason ? { untypedReason } : {}), ...(handlerAgreement ? { handlerAgreement } : {}),
      execution: registration?.domain ? "domain-service" : "owner-interaction",
      registration: registration ? registration.file : "not-found-statically", ...(daemonCommand ? { daemonCommand } : {}) };
  }
  // Push channels: a member of an exposed bridge whose body subscribes with ipcRenderer.on("<channel>"), or a generic
  // `on(channel, handler)` member that admits channels by prefix (channel.startsWith("invoke:event:")) — each prefix is a
  // per-id stream. The payload is the first parameter of the callback the member takes, typed by the preload itself.
  // app.call is request/response, so no push channel is callable through it.
  const events = [];
  const bridgeObjects = [];
  for (const [file, surface] of [["electron/preload.ts", "desktop"], ["electron/science-preload.ts", "science"]]) {
    const source = program.getSourceFile(path.join(root, file));
    const objectOf = node => {
      node = unwrap(node);
      if (node && ts.isCallExpression(node) && node.expression.getText(source) === "Object.freeze") node = unwrap(node.arguments[0]);
      if (node && ts.isIdentifier(node)) {
        const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return objectOf(declaration.initializer);
      }
      return node && ts.isObjectLiteralExpression(node) ? node : null;
    };
    const find = node => {
      if (ts.isCallExpression(node) && /exposeInMainWorld$/.test(node.expression.getText(source)) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const name = node.arguments[0].text;
        // `agentlas` exposes `api` (or its One-window subset); the members are api's.
        let object = name === "agentlas" ? null : objectOf(node.arguments[1]);
        if (name === "agentlas") {
          const visitApi = child => { if (!object && ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.name.text === "api" && child.initializer) object = objectOf(child.initializer); ts.forEachChild(child, visitApi); };
          visitApi(source);
        }
        if (object && !bridgeObjects.some(entry => entry.object === object)) bridgeObjects.push({ name, object, source, surface });
      }
      ts.forEachChild(node, find);
    };
    find(source);
  }
  const payloadOf = fn => {
    const signature = checker.getSignaturesOfType(checker.getTypeAtLocation(fn), ts.SignatureKind.Call)[0];
    const callback = signature?.parameters.find(parameter => {
      const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
      return declaration && checker.getSignaturesOfType(checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(parameter, declaration)), ts.SignatureKind.Call).length;
    });
    const callbackDeclaration = callback && (callback.valueDeclaration ?? callback.declarations?.[0]);
    const callbackSignature = callbackDeclaration && checker.getSignaturesOfType(checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(callback, callbackDeclaration)), ts.SignatureKind.Call)[0];
    const payload = callbackSignature?.parameters[0];
    const payloadDeclaration = payload && (payload.valueDeclaration ?? payload.declarations?.[0]);
    const payloadType = payloadDeclaration && checker.getTypeOfSymbolAtLocation(payload, payloadDeclaration);
    if (!callbackSignature) return { payloadSchema: { description: "The member's callback is untyped." }, payloadBasis: "untyped" };
    if (!payload) return { payloadSchema: { type: "null", description: "The callback takes no payload." }, payloadBasis: "none" };
    if (untypedType(payloadType)) return { payloadSchema: { description: "The callback payload is untyped; read it as data." }, payloadBasis: "untyped" };
    return { payloadSchema: schema(payloadType, 1), payloadBasis: "bridge-type" };
  };
  for (const { name, object, source, surface } of bridgeObjects) {
    const root = name === "agentlas" ? "" : name === "agentlasScience" ? "science" : name;
    const walk = (literal, prefix) => {
      for (const property of literal.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) continue;
        const key = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null;
        if (!key) continue;
        const at = prefix ? `${prefix}.${key}` : key;
        let value = ts.isPropertyAssignment(property) ? unwrap(property.initializer) : property;
        if (ts.isCallExpression(value) && value.expression.getText(source) === "Object.freeze") value = unwrap(value.arguments[0]);
        if (ts.isObjectLiteralExpression(value)) { walk(value, at); continue; }
        if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value) && !ts.isMethodDeclaration(value) || !value.body) continue;
        const channels = new Set(), prefixes = new Set();
        let dynamic = false;
        const visit = node => {
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "on"
            && /ipcRenderer$/.test(node.expression.expression.getText(source)) && node.arguments[0]) {
            if (ts.isStringLiteralLike(node.arguments[0])) channels.add(node.arguments[0].text); else dynamic = true;
          }
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "startsWith"
            && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text.endsWith(":")) prefixes.add(node.arguments[0].text);
          ts.forEachChild(node, visit);
        };
        visit(value.body);
        const member = root ? `${root}.${at}` : at;
        if (channels.size === 1 && !dynamic) events.push({ member, surface, channel: [...channels][0], ...payloadOf(value) });
        else if (dynamic && !channels.size) for (const streamPrefix of [...prefixes].sort()) events.push({ member, surface, channel: `${streamPrefix}<id>`, ...payloadOf(value) });
      }
    };
    walk(object, "");
  }
  events.sort((a, b) => a.member.localeCompare(b.member));
  // Result types repeat (the same chat, project or manuscript record under many operations). A sub-schema of 200+
  // characters that occurs more than once is stored once under $defs and referenced; descriptors attach the $defs an
  // operation uses, so each output schema stays a complete JSON Schema.
  // Only schema positions are shared (a property's schema, items, anyOf/oneOf members, additional*): keyword containers
  // such as a `properties` map stay in place, so every reference still sits where a schema belongs.
  const schemaChildren = (node, visit) => {
    const copy = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) copy[key] = Object.fromEntries(Object.entries(value).map(([name, field]) => [name, visit(field)]));
      else if ((key === "anyOf" || key === "oneOf") && Array.isArray(value)) copy[key] = value.map(visit);
      else if (key === "items") copy[key] = Array.isArray(value) ? value.map(visit) : visit(value);
      else if ((key === "additionalProperties" || key === "additionalItems") && value && typeof value === "object") copy[key] = visit(value);
      else copy[key] = value;
    }
    return copy;
  };
  const occurrences = new Map();
  const count = node => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    const text = JSON.stringify(node);
    if (text.length >= 200) occurrences.set(text, (occurrences.get(text) ?? 0) + 1);
    schemaChildren(node, count);
    return node;
  };
  for (const key of Object.keys(contracts).sort()) count(contracts[key].output);
  for (const event of events) count(event.payloadSchema);
  const defs = {};
  const intern = (node, top = false) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    const text = JSON.stringify(node);
    const copy = schemaChildren(node, child => intern(child));
    if (!top && text.length >= 200 && (occurrences.get(text) ?? 0) > 1) {
      const id = `d${require("node:crypto").createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
      defs[id] ??= copy;
      return { $ref: `#/$defs/${id}` };
    }
    return copy;
  };
  for (const key of Object.keys(contracts)) contracts[key].output = intern(contracts[key].output, true);
  for (const event of events) event.payloadSchema = intern(event.payloadSchema, true);
  const contractOutput = path.join(outputDirectory, "operation-contracts.generated.ts");
  const contractBody = "// Generated from the app's TypeScript bridges, Main handlers and the Science daemon by scripts/generate-app-control-catalog.cjs. Do not edit.\n"
    + "export type AppControlOutputBasis = \"bridge-type\" | \"void\" | \"main-handler-type\" | \"daemon-command-type\" | \"untyped\";\n"
    + "export interface AppControlGeneratedContract { output: Record<string, unknown>; outputBasis: AppControlOutputBasis; untypedReason?: string; /** Main handler result vs the renderer bridge's declared type. */ handlerAgreement?: \"assignable\" | \"mismatch\" | \"bridge-untyped\" | \"handler-untyped\" | \"shared-table-handler\"; execution: \"domain-service\" | \"owner-interaction\"; registration: string; daemonCommand?: string }\n"
    + "export interface AppControlEventChannel { member: string; surface: \"desktop\" | \"science\"; /** Exact channel, or \"<prefix>:<id>\" for a per-id stream. */ channel: string; payloadSchema: Record<string, unknown>; payloadBasis: \"bridge-type\" | \"none\" | \"untyped\" }\n"
    + "export const APP_CONTROL_OPERATION_CONTRACTS: Readonly<Record<string, AppControlGeneratedContract>> = {\n"
    + Object.keys(contracts).sort().map(key => `${JSON.stringify(key)}:${JSON.stringify(contracts[key])}`).join(",\n") + "};\n"
    + "export const APP_CONTROL_EVENT_CHANNELS: readonly AppControlEventChannel[] = [\n"
    + events.map(event => JSON.stringify(event)).join(",\n") + "];\n"
    + "/** Shared result sub-schemas referenced as {\"$ref\":\"#/$defs/<id>\"}. */\n"
    + "export const APP_CONTROL_OUTPUT_DEFS: Readonly<Record<string, Record<string, unknown>>> = {\n"
    + Object.keys(defs).sort().map(key => `${JSON.stringify(key)}:${JSON.stringify(defs[key])}`).join(",\n") + "};\n";
  const output = path.join(outputDirectory, "argument-schemas.generated.ts");
  const body = "// Generated from the app's TypeScript bridges by scripts/generate-app-control-catalog.cjs.\n"
    + "export const APP_CONTROL_ARGUMENT_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = "
    + JSON.stringify(docs, null, 0).replace(/\},\"([^\"]+)\":\{\"type\":\"object\",\"properties\"/g, "},\n\"$1\":{\"type\":\"object\",\"properties\"") + ";\n"
    + "export const APP_UI_PREFERENCE_VALUE_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = "
    + JSON.stringify(preferenceSchemas, null, 0) + ";\n";
  if (check) {
    if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== body) throw new Error("app-control argument schemas are stale: run node scripts/generate-app-control-catalog.cjs");
    if (!fs.existsSync(contractOutput) || fs.readFileSync(contractOutput, "utf8") !== contractBody) throw new Error("app-control operation contracts are stale: run node scripts/generate-app-control-catalog.cjs");
  } else {
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, body); fs.writeFileSync(contractOutput, contractBody);
  }
  return Object.keys(docs).length;
}

module.exports = { generateAppControlSchemas };
