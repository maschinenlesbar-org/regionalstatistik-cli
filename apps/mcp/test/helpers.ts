// Test helpers of this server's own tests and the adapters of the conformance tests: a mock
// GENESIS on the API's own paths, with the answers of the client's test/recorded.ts, and the
// client's transport helpers. The generic harness (a connection, a config, a log recorder, the HTTP
// server) is harness.ts.

import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/regionalstatistik-client";
import { bodyOf, jsonResponse, makeMockTransport, rawResponse, type MockTransport } from "@maschinenlesbar.org/regionalstatistik-client/test/helpers";
import { DATA_12411_01_01_4, EMPTY_104, FFCSV_12411_01_01_4, FIND_TABLES, METADATA_12411_01_01_4, TABLES_12411, zipOf } from "@maschinenlesbar.org/regionalstatistik-client/test/recorded";

export * from "@maschinenlesbar.org/regionalstatistik-client/test/helpers";
export * from "@maschinenlesbar.org/regionalstatistik-client/test/recorded";

/** The test token: what the server's environment gives in these tests (harness.ts's TEST_ENV). */
export const TEST_TOKEN = "test-token-only-0123456789abcdef";

/** The environment the server sees in the tests: a GENESIS token, never a real one. */
export const TEST_ENV = { REGIONALSTATISTIK_API_TOKEN: TEST_TOKEN };

/** A client built in a test gets the test token (without one the client refuses every data call). */
export const TEST_CLIENT_OPTIONS = { token: TEST_TOKEN };

/** The endpoint of a request: the path after /genesisws/rest/2020/ (data/table, find/find). */
export function endpointOf(request: HttpRequest): string {
  return new URL(request.url).pathname.replace(/^.*\/genesisws\/rest\/2020\//, "");
}

/** What the mock GENESIS answers: per endpoint, a body or a function of the request. */
export type Answers = Record<string, Record<string, unknown> | ((request: HttpRequest) => HttpResponse)>;

/** The answers a mock GENESIS gives by default: the ones of test/recorded.ts for 12411-01-01-4 and "Bevölkerung". */
export const DEFAULT_ANSWERS: Answers = {
  "find/find": FIND_TABLES,
  "catalogue/tables": TABLES_12411,
  "metadata/table": (request: HttpRequest) => jsonResponse(bodyOf(request).get("name") === "12411-01-01-4" ? METADATA_12411_01_01_4 : EMPTY_104("metadata", "table")),
  "data/table": (request: HttpRequest) => jsonResponse(bodyOf(request).get("name") === "12411-01-01-4" ? DATA_12411_01_01_4 : EMPTY_104("data", "table")),
  "data/tablefile": (request: HttpRequest) =>
    bodyOf(request).get("name") === "12411-01-01-4" ? rawResponse(zipOf({ "12411-01-01-4_flat.csv": FFCSV_12411_01_01_4 }), "application/zip") : jsonResponse(EMPTY_104("data", "tablefile")),
};

/** A mock GENESIS: `answers` over the defaults; an unknown endpoint is GENESIS's flat 404. */
export function mockGenesis(answers: Answers = {}): MockTransport {
  const all = { ...DEFAULT_ANSWERS, ...answers };
  return makeMockTransport((request) => {
    const answer = all[endpointOf(request)];
    if (answer === undefined) return jsonResponse({ Code: 90, Content: "Der Service ist unbekannt.", Type: "ERROR" }, 404);
    return typeof answer === "function" ? (answer as (r: HttpRequest) => HttpResponse)(request) : jsonResponse(answer);
  });
}
