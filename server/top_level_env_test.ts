// Issue #15 — a module-top-level `Deno.env` read anywhere in the boot graph crashes the
// isolated container. The tee-daemon boots this repo with `--deny-env` (env arrives per
// request via ctx.env, or argv), so any `Deno.env.get(...)` that executes during MODULE
// EVALUATION throws `NotCapable: Requires env access` at import and the container never
// starts — every route 500s. The 2026-06-25 outage was exactly this in server/plugins/otter.ts.
//
// This is the static, always-on guard: `deno task test` fails naming the offending file:line.
// (The sibling server/boot_deny_env_test.ts covers the #49 rettiwt/debug import variant and
// carries a live `--deny-env` boot probe that needs --allow-run; this guard needs no extra
// permissions and catches ANY top-level Deno.env call.)
//
// Scope, deliberately:
//   - Walks the STATIC import graph of server/handler.ts — the graph the container loads.
//     Dynamic `await import()` inside a function is deferred past boot (#49 fix 0a1d641), so
//     it is not walked; a dynamic import at module top level WOULD run at boot and is walked.
//   - Does NOT scan *_test.ts files (the test task grants --allow-env — top-level env reads
//     there are legal) or server/main.ts (the local `--allow-env` dev entry, never booted by
//     the container; it is not in handler.ts's graph).
//   - Flags `Deno.env.<member>(...)` / `Deno.env["KEY"](...)` call expressions that execute
//     at module evaluation: outside every function-like body and outside per-instance class
//     field initializers (those run at construction, not at import).
//   - Does NOT flag `Deno.env` inside function bodies, `ctx.env` (the sanctioned per-request
//     channel), or `Deno.env` references that are not called at eval time.
//
// Evidence tier 0: lint/test only, zero runtime behavior change.

import ts from "npm:typescript@5.9.3";
import { assert, assertEquals } from "jsr:@std/assert";

const SERVER_ROOT = new URL("./", import.meta.url);
const ENTRY = new URL("./handler.ts", import.meta.url);

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

// Nodes whose subtree executes DEFERRED (on call / on construction), not at module eval.
const FUNCTION_LIKE = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

function isDenoEnvReceiver(e: ts.Node): boolean {
  return ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) && e.expression.text === "Deno" && e.name.text === "env";
}

function isDenoEnvCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  // Deno.env.get("X") / Deno.env.toObject() / Deno.env.has(...) …
  if (ts.isPropertyAccessExpression(callee) && isDenoEnvReceiver(callee.expression)) return true;
  // Deno.env["X"]() — element-access form.
  if (ts.isElementAccessExpression(callee) && isDenoEnvReceiver(callee.expression)) return true;
  return false;
}

function isStaticField(node: ts.Node): boolean {
  return ts.isPropertyDeclaration(node) &&
    (node.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
}

/** Parse `text` and return every Deno.env call that executes during module evaluation. */
function topLevelEnvCalls(fileName: string, text: string): Violation[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Violation[] = [];
  const visit = (node: ts.Node, deferred: boolean) => {
    const inDeferred = deferred || FUNCTION_LIKE.has(node.kind) ||
      // non-static class fields initialize per instance, not at class definition
      (ts.isPropertyDeclaration(node) && !isStaticField(node));
    if (!inDeferred && isDenoEnvCall(node)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push({ file: fileName, line: line + 1, snippet: node.getText(sf).slice(0, 90) });
    }
    ts.forEachChild(node, (child) => visit(child, inDeferred));
  };
  visit(sf, false);
  return out;
}

function importSpecifiers(sf: ts.SourceFile): { spec: string; dynamic: boolean }[] {
  const specs: { spec: string; dynamic: boolean }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push({ spec: node.moduleSpecifier.text, dynamic: false });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const m = node.moduleSpecifier;
      if (ts.isStringLiteral(m)) specs.push({ spec: m.text, dynamic: false });
    } else if (
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === "import" && node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push({ spec: (node.arguments[0] as ts.StringLiteral).text, dynamic: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

/** Follow a specifier to a repo-local file URL; returns null for external (npm:/jsr:/bare). */
function resolveLocal(spec: string, importer: URL): URL | null {
  if (!spec.startsWith(".")) return null; // npm:, jsr:, https:, or bare — external to this repo
  const u = new URL(spec, importer);
  if (!u.pathname.startsWith(SERVER_ROOT.pathname)) return null; // outside server/
  return u;
}

function relName(url: URL): string {
  return url.pathname.replace(SERVER_ROOT.pathname, "");
}

function fmt(v: Violation[]): string {
  return v.map((x) => `  ${relName(new URL("file://" + x.file))}:${x.line}  ${x.snippet}`).join(
    "\n",
  );
}

Deno.test({
  name:
    "#15: no module-top-level Deno.env read in handler.ts's static graph (crashes the --deny-env container)",
  fn() {
    const seen = new Set<string>();
    const queue: URL[] = [ENTRY];
    const violations: Violation[] = [];
    const walked: string[] = [];

    while (queue.length) {
      const url = queue.shift()!;
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      const text = Deno.readTextFileSync(url);
      walked.push(relName(url));
      const sf = ts.createSourceFile(
        url.pathname,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      violations.push(...topLevelEnvCalls(url.pathname, text));
      for (const { spec, dynamic } of importSpecifiers(sf)) {
        const target = resolveLocal(spec, url);
        // A dynamic import inside module-eval code runs at boot, so follow it; one inside a
        // function is deferred past boot (#49) — skip. (All dynamic targets here are npm:.)
        if (target && (!dynamic || dynamicAtEval(url))) queue.push(target);
      }
    }

    // The walk must reach the file that caused the 2026-06-25 outage, and be a real graph.
    assert(
      walked.some((f) => f === "plugins/otter.ts"),
      "graph walk must reach plugins/otter.ts (it is statically imported via plugins/registry.ts)",
    );
    assert(walked.length > 20, `graph walk looked wrong — only ${walked.length} files`);

    console.log(
      `#15: walked ${walked.length} files of handler.ts's boot graph — ` +
        (violations.length ? `${violations.length} violation(s)` : "clean"),
    );
    if (violations.length) {
      throw new Error(
        `Module-top-level Deno.env read(s) — these execute at import and CRASH the --deny-env ` +
          `isolated container at boot (issue #15; the 2026-06-25 outage was plugins/otter.ts).\n` +
          `Move the read inside a function (deferred past boot) or use ctx.env (env arrives ` +
          `per-request):\n${fmt(violations)}`,
      );
    }
  },
});

// Lock the semantics the acceptance demands: what counts (module-eval reads) and what must
// NOT be flagged (function bodies, ctx.env, per-instance class fields).
Deno.test({
  name: "#15: guard semantics — flags module-eval reads only, not function bodies / ctx.env",
  fn() {
    const cases: [name: string, src: string, expectedLines: number[]][] = [
      ["top-level read", `const X = Deno.env.get("FOO");`, [1]],
      [
        "top-level in if",
        `if (true) {\n  const y = Deno.env.toObject();\n}`,
        [2],
      ],
      [
        "static class field (runs at class definition)",
        `class A {\n  static k = Deno.env.get("K");\n}`,
        [2],
      ],
      ["function body", `function f() {\n  return Deno.env.get("FOO");\n}`, []],
      ["arrow body", `const g = () => Deno.env.get("FOO");`, []],
      ["method body", `class B {\n  m() {\n    return Deno.env.has("X");\n  }\n}`, []],
      [
        "instance class field (runs at construction)",
        `class C {\n  v = Deno.env.get("K");\n}`,
        [],
      ],
      ["ctx.env at top level", `const z = ctx.env.get("FOO");`, []],
      ["element-access form at top level", `const w = Deno.env["FOO"]();`, [1]],
      ["bare reference, no call", `const e = Deno.env;\nconst h = e.get("X");`, []],
    ];
    for (const [name, src, expected] of cases) {
      const got = topLevelEnvCalls("synthetic.ts", src).map((v) => v.line);
      assertEquals(got, expected, `case "${name}" flagged lines [${got}], expected [${expected}]`);
    }
  },
});

// Helper used above: whether a module contains a dynamic import() that executes at eval.
// Kept conservative (any dynamic import at top level counts) — following extra edges can
// only surface violations, never hide them.
function dynamicAtEval(importer: URL): boolean {
  const text = Deno.readTextFileSync(importer);
  const sf = ts.createSourceFile(
    importer.pathname,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node: ts.Node, deferred: boolean) => {
    const inDeferred = deferred || FUNCTION_LIKE.has(node.kind) ||
      (ts.isPropertyDeclaration(node) && !isStaticField(node));
    if (
      !inDeferred && ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === "import"
    ) found = true;
    ts.forEachChild(node, (child) => visit(child, inDeferred));
  };
  visit(sf, false);
  return found;
}
