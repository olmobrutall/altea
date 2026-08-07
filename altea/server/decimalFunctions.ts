// Query metadata for the decimal.js `Decimal` arithmetic methods (Signum's decimal operators).
//
// A @quoted body computes money with `Decimal.*` — as STATIC calls (`Decimal.add(a, b)`) OR INSTANCE
// calls (`a.plus(b)`) — instead of the `+ - * /` operators, so the SAME body is BOTH exact in-memory
// (real decimal.js) AND translatable to SQL:
//   - the quote front-end reads `__resultType` (attached here, on both the static method and the
//     prototype method) to type each call as LiteralType.decimal;
//   - DbExpressionNominator lowers the call → the SQL numeric operator / function (see `decimalCall`
//     there — it keys off the SAME method names, whether the receiver is the `Decimal` class (static)
//     or a decimal-typed expression (instance)).
//
// Importing this module (side effect, via server/index.ts) installs the metadata. The mutation is on
// the shared decimal.js methods — a server (LINQ-provider) concern, like the Entity/Number metadata in
// server/index.ts — so it lives in server/, never in the RuntimeType-free entities/ layer.

import { Decimal } from "../data/basics";
import { quotedFunction, LiteralType } from "./runtimeTypes";

// Method names the nominator can lower to SQL (canonical + decimal.js aliases). Shared with
// DbExpressionNominator.decimalCall so the two never drift. All yield a Decimal except `sign` (→ number).
export const DECIMAL_METHODS: readonly string[] = [
    "add", "plus",                 // +
    "sub", "minus",                // -
    "mul", "times",                // *
    "div", "dividedBy",            // /
    "mod", "modulo",               // %
    "abs", "absoluteValue",        // ABS
    "sqrt", "squareRoot",          // SQRT
    "pow", "toPower",              // POWER
    "neg", "negated",              // 0 - x
    "floor", "ceil", "round", "trunc", "max", "min",
];
const DECIMAL_NUMBER_METHODS: readonly string[] = ["sign"]; // return an integer, not a Decimal

const asStatic = Decimal as unknown as Record<string, unknown>;
const asProto = Decimal.prototype as unknown as Record<string, unknown>;

// Attach on BOTH the static method and the prototype (instance) method, when they exist — decimal.js
// exposes most operators in both forms (Decimal.add / x.plus), and floor/ceil/round/max/min statically.
function setResult(name: string, resultType: () => LiteralType): void {
    if (typeof asStatic[name] === "function") quotedFunction(asStatic[name] as Function).__resultType = resultType;
    if (typeof asProto[name] === "function") quotedFunction(asProto[name] as Function).__resultType = resultType;
}

for (const name of DECIMAL_METHODS) setResult(name, () => LiteralType.decimal);
for (const name of DECIMAL_NUMBER_METHODS) setResult(name, () => LiteralType.number);
