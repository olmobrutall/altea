// `QueryTokenString` moved to the DATA layer (data/dynamicQuery/queryTokenString) — naming a query column
// is not a UI concern, and the server and the test suites need the same builder. Re-exported here because
// this is the path the client half of altea (and every application's client code) imports it from.
export * from '../data/dynamicQuery/queryTokenString';
