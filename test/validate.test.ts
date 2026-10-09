import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertRequestParams,
  assertValid,
  baseUrlProblem,
  credentialPairProblem,
  credentialProblem,
  credentialsRequiredProblem,
  headerNameProblem,
  headerValueProblem,
  intRangeProblem,
  nonBlankProblem,
  oneOfProblem,
  type Problem,
} from "../src/client/validate.js";
import {
  RegionalstatistikError,
  RegionalstatistikUsageError,
  RegionalstatistikValidationError,
} from "../src/client/errors.js";
import * as lib from "../src/index.js";
import { RequestEngine } from "../src/client/engine.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { RegionalstatistikClient } from "../src/client/client.js";
import { jsonResponse, parity, untimed } from "./helpers.js";
import * as fx from "./fixtures.js";

const evenProblem: Problem<number> = (n) => (n % 2 === 0 ? undefined : "Expected an even number.");

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("count", 4, evenProblem), 4);
});

test("assertValid throws RegionalstatistikValidationError with 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("count", 3, evenProblem),
    (err: unknown) => {
      assert.ok(err instanceof RegionalstatistikValidationError);
      assert.equal((err as Error).message, "Invalid count: Expected an even number.");
      return true;
    },
  );
});

test("RegionalstatistikValidationError extends RegionalstatistikUsageError and RegionalstatistikError", () => {
  const err = new RegionalstatistikValidationError("Invalid x: y");
  assert.ok(err instanceof RegionalstatistikUsageError);
  assert.ok(err instanceof RegionalstatistikError);
  assert.equal(err.name, "RegionalstatistikValidationError");
});

test("the package root exports the validation layer", () => {
  assert.equal(lib.RegionalstatistikValidationError, RegionalstatistikValidationError);
  assert.equal(lib.assertValid, assertValid);
});

function depsThrowing(err: unknown): { deps: CliDeps; out: string[]; errs: string[] } {
  const out: string[] = [];
  const errs: string[] = [];
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => errs.push(s),
      writeFile: () => undefined,
      fileExists: () => false,
      outBinary: () => undefined,
    },
    createClient: () => {
      throw err;
    },
    env: {},
  };
  return { deps, out, errs };
}

test("run maps a RegionalstatistikValidationError raised during an action to exit 2 and an ERROR record", async () => {
  const { deps, errs } = depsThrowing(
    new RegionalstatistikValidationError("Invalid thing: Expected a non-empty value."),
  );
  const code = await run(["hello"], deps);
  assert.equal(code, 2);
  assert.deepEqual(errs.map(untimed), ["ERROR [regstat.cli] Invalid thing: Expected a non-empty value."]);
});

test("parity() runs the CLI and the library on one recording transport", async () => {
  const p = await parity({
    argv: ["--compact", "hello"],
    lib: (transport) => new RegionalstatistikClient({ transport }).whoami(),
    responder: () => jsonResponse(fx.whoami),
  });
  assert.equal(p.cli.code, 0);
  assert.equal(p.cli.requests.length, 1);
  assert.ok(p.lib.ok);
  assert.equal(p.lib.requests.length, 1);
  assert.equal(p.cli.requests[0]!.url, p.lib.requests[0]!.url);
});

test("nonBlankProblem accepts text and rejects blank or non-string values", () => {
  assert.equal(nonBlankProblem("12411*"), undefined);
  assert.equal(nonBlankProblem(" x "), undefined);
  for (const v of ["", " ", "\t\n", undefined, null, 5]) {
    assert.equal(nonBlankProblem(v), "Expected a non-empty value.", JSON.stringify(v));
  }
});

test("assertRequestParams rejects a blank string, naming the parameter, and skips omitted ones", () => {
  assert.doesNotThrow(() => assertRequestParams({ a: "x", b: undefined, c: null, pagelength: 3, compress: true }));
  // A text parameter takes a string, a boolean one a boolean (P10).
  assert.throws(() => assertRequestParams({ startyear: 2020 }), /Invalid startyear: Expected a string\./);
  assert.throws(() => assertRequestParams({ compress: "yes" }), /Invalid compress: Expected true or false\./);
  assert.throws(
    () => assertRequestParams({ selection: "1*", regionalkey: " " }),
    (err: unknown) =>
      err instanceof RegionalstatistikValidationError &&
      err.message === "Invalid regionalkey: Expected a non-empty value.",
  );
});

test("the package root exports the blank-value rules", () => {
  assert.equal(lib.nonBlankProblem, nonBlankProblem);
  assert.equal(lib.assertRequestParams, assertRequestParams);
});

test("oneOfProblem accepts only the listed values, case-sensitively", () => {
  const problem = oneOfProblem(["de", "en"] as const);
  assert.equal(problem("de"), undefined);
  assert.equal(problem("en"), undefined);
  for (const v of ["fr", "EN", "", " en", undefined, 1, "constructor"]) {
    assert.equal(problem(v), "Allowed choices are de, en.", JSON.stringify(v));
  }
});

test("assertRequestParams checks language against LANGUAGES", () => {
  assert.doesNotThrow(() => assertRequestParams({ language: "en" }));
  assert.doesNotThrow(() => assertRequestParams({ language: undefined }));
  assert.throws(
    () => assertRequestParams({ language: "fr" }),
    (err: unknown) =>
      err instanceof RegionalstatistikValidationError && err.message === "Invalid language: Allowed choices are de, en.",
  );
  assert.throws(() => assertRequestParams({ language: "" }), /Invalid language: Allowed choices are de, en\./);
});

test("assertRequestParams checks category, the criteria and format against their lists", () => {
  assert.doesNotThrow(() =>
    assertRequestParams({ category: "time-series", searchcriterion: "Code", sortcriterion: "Content", format: "xlsx" }),
  );
  assert.throws(() => assertRequestParams({ category: "Tables" }), RegionalstatistikValidationError);
  assert.throws(() => assertRequestParams({ searchcriterion: "code" }), /Invalid searchcriterion: Allowed choices are Code, Content\./);
  assert.throws(() => assertRequestParams({ sortcriterion: "" }), /Invalid sortcriterion: Allowed choices are Code, Content\./);
  assert.throws(
    () => assertRequestParams({ format: "zip" }),
    /Invalid format: Allowed choices are datencsv, csv, ffcsv, xlsx, html, genml\./,
  );
});

test("intRangeProblem accepts safe integers in range and words its reasons like the CLI", () => {
  const problem = intRangeProblem(1, 25000);
  assert.equal(problem(1), undefined);
  assert.equal(problem(25000), undefined);
  assert.equal(problem(0), "Must be >= 1.");
  assert.equal(problem(25001), "Must be <= 25000.");
  for (const v of [-1, 1.5, NaN, Infinity, 1e20, "10", undefined]) {
    assert.equal(problem(v), "Expected a non-negative integer.", String(v));
  }
});

test("assertRequestParams checks pagelength", () => {
  assert.doesNotThrow(() => assertRequestParams({ pagelength: 25000 }));
  assert.throws(
    () => assertRequestParams({ pagelength: 0 }),
    /^RegionalstatistikValidationError: Invalid pagelength: Must be >= 1\.$/,
  );
  assert.throws(() => assertRequestParams({ pagelength: NaN }), /Invalid pagelength: Expected a non-negative integer\./);
});

test("assertRequestParams checks timeslices", () => {
  assert.doesNotThrow(() => assertRequestParams({ timeslices: 0 }));
  assert.doesNotThrow(() => assertRequestParams({ timeslices: Number.MAX_SAFE_INTEGER }));
  for (const v of [-1, 1.5, NaN, Infinity, 1e20]) {
    assert.throws(
      () => assertRequestParams({ timeslices: v }),
      /^RegionalstatistikValidationError: Invalid timeslices: Expected a non-negative integer\.$/,
      String(v),
    );
  }
});

test("headerValueProblem rejects blank, control and non-Latin-1 values and allows tab and Latin-1", () => {
  for (const ok of ["ua/1", "é", "a\tb", " padded "]) assert.equal(headerValueProblem(ok), undefined, JSON.stringify(ok));
  assert.equal(headerValueProblem(""), "Expected a non-empty value.");
  assert.equal(headerValueProblem("  "), "Expected a non-empty value.");
  for (const bad of ["a\r\nb", "a\x00b", "a\x7fb", "a\nb"]) {
    assert.equal(headerValueProblem(bad), "Value contains control characters.", JSON.stringify(bad));
  }
  assert.equal(headerValueProblem("€"), "Value contains characters outside Latin-1 (above U+00FF).");
});

test("credentialProblem adds the no-surrounding-whitespace rule", () => {
  assert.equal(credentialProblem("tok"), undefined);
  assert.equal(credentialProblem("pa\tss"), undefined);
  assert.equal(credentialProblem(" tok"), "Value has leading or trailing whitespace, which an HTTP header cannot carry.");
  assert.equal(credentialProblem("t\rk"), "Value contains control characters.");
});

test("headerNameProblem accepts only HTTP token characters", () => {
  assert.equal(headerNameProblem("X-Trace-Id"), undefined);
  for (const bad of ["", "a b", "a:b", "a\r\nb", "ü"]) assert.ok(headerNameProblem(bad), JSON.stringify(bad));
});

test("the engine validates userAgent and defaultHeaders at construction", () => {
  assert.throws(() => new RequestEngine({ userAgent: "  " }), /Invalid userAgent: Expected a non-empty value\./);
  assert.throws(
    () => new RequestEngine({ defaultHeaders: { "X-Trace": "a\r\nInjected: 1" } }),
    (err: unknown) =>
      err instanceof RegionalstatistikValidationError &&
      err.message === 'Invalid defaultHeaders["X-Trace"]: Value contains control characters.',
  );
  assert.throws(() => new RequestEngine({ defaultHeaders: { "Bad Name": "v" } }), RegionalstatistikValidationError);
  assert.doesNotThrow(() => new RequestEngine({ userAgent: "é", defaultHeaders: { "X-Trace": "a\tb" } }));
});

test("a credential message never echoes the value", () => {
  assert.throws(
    () => new RegionalstatistikClient({ password: " s3cret ", username: "u" }),
    (err: unknown) => err instanceof RegionalstatistikValidationError && !(err as Error).message.includes("s3cret"),
  );
});

test("baseUrlProblem accepts an http(s) URL and names each rejected shape", () => {
  assert.equal(baseUrlProblem("https://www.regionalstatistik.de"), undefined);
  assert.equal(baseUrlProblem("http://127.0.0.1:8080/prefix/"), undefined);
  assert.equal(baseUrlProblem(""), "Must be an absolute http(s) URL.");
  assert.equal(baseUrlProblem("not a url"), "Must be an absolute http(s) URL.");
  assert.equal(baseUrlProblem(42), "Must be an absolute http(s) URL.");
  assert.equal(baseUrlProblem("ftp://h.example"), 'Only "http:" and "https:" URLs are allowed.');
  assert.equal(baseUrlProblem("https://u:p@h.example"), "Must not embed credentials (user:pass@host).");
  assert.equal(baseUrlProblem("https://tok@h.example"), "Must not embed credentials (user:pass@host).");
  assert.equal(baseUrlProblem("https://h.example/?x=1"), "A base URL cannot have a query (?) or fragment (#).");
  assert.equal(baseUrlProblem("https://h.example/#f"), "A base URL cannot have a query (?) or fragment (#).");
  assert.equal(baseUrlProblem("https://h.example/ "), "A base URL cannot have surrounding whitespace.");
  assert.equal(baseUrlProblem(" https://h.example"), "A base URL cannot have surrounding whitespace.");
  assert.equal(baseUrlProblem("https://h.example/a b"), "A base URL cannot contain whitespace or control characters.");
  assert.equal(baseUrlProblem("https://h.example/a\x7fb"), "A base URL cannot contain whitespace or control characters.");
});

test("credentialPairProblem wants both or neither of username and password", () => {
  assert.equal(credentialPairProblem({}), undefined);
  assert.equal(credentialPairProblem({ username: "u", password: "p" }), undefined);
  assert.equal(credentialPairProblem({ username: "u" }), "Provide both username and password (or a token).");
  assert.equal(credentialPairProblem({ password: "p" }), "Provide both username and password (or a token).");
});

test("credentialsRequiredProblem wants a username (a token travels in it too)", () => {
  assert.equal(credentialsRequiredProblem({ username: "u" }), undefined);
  assert.equal(credentialsRequiredProblem({ username: "tok" , password: undefined }), undefined);
  assert.equal(
    credentialsRequiredProblem({}),
    "This endpoint needs an account (a token, or a username and password).",
  );
});
