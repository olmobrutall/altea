// Query metadata for the decimal.js `Decimal` static arithmetic methods (Signum's decimal operators).
//
// A @quoted body computes money with `Decimal.add/sub/mul/div/…` instead of the `+ - * /` operators, so
// the SAME body is BOTH exact in-memory (real decimal.js) AND translatable to SQL:
//   - the quote front-end reads `__resultType` (attached here) to type each call as LiteralType.decimal;
//   - DbExpressionNominator lowers `Decimal.add(a,b)` → the SQL numeric operator / function (see
//     `decimalStaticCall` there — it keys off the SAME `Decimal` class + method name).
//
// Importing this module (side effect, via server/index.ts) installs the metadata. The mutation is on the
// shared decimal.js static methods — a server (LINQ-provider) concern, like the Entity/Number metadata in
// server/index.ts — so it lives in server/, never in the RuntimeType-free entities/ layer.

import { Decimal } from "../data/basics";
import { quotedFunction, LiteralType } from "./runtimeTypes";

// name → result type. Every arithmetic/rounding result is a Decimal; `sign` is an integer.
export const DECIMAL_RESULT_METHODS: readonly string[] = [
    "add", "sub", "mul", "div", "mod",              // binary operators
    "abs", "sqrt", "pow", "floor", "ceil", "round", "trunc", "max", "min", // SQL functions
];

const D = Decimal as unknown as Record<string, unknown>;

for (const name of DECIMAL_RESULT_METHODS)
    if (typeof D[name] === "function")
        quotedFunction(D[name] as Function).__resultType = () => LiteralType.decimal;

if (typeof D["sign"] === "function")
    quotedFunction(D["sign"] as Function).__resultType = () => LiteralType.number;
