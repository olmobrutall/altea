
export type Quoted<T extends Function> = T & {
    __quoted?: () => ExLambda;
};

export type QuotedEx =
    ExConstant |
    ExUnary |
    ExBinary |
    ExConditional |
    ExProperty |
    ExCall |
    ExParam |
    ExLambda |
    ExObject |
    ExArray |
    ExNew |
    ExAs;


export type ExConstant = ["c", unknown];
export type ExUnary = [OpUnary, QuotedEx];
export type ExBinary = [OpBinary, QuotedEx, QuotedEx];
export type ExConditional = ["?:", QuotedEx, QuotedEx, QuotedEx];
export type ExProperty = ["." | "?.", QuotedEx, string];
export type ExCall = ["()" | "?.()", QuotedEx, QuotedEx[]];
export type ExParam = ["p", string];
export type ExLambda = ["=>", ExParam[], QuotedEx]
export type ExObject = ["{}", { [name: string]: QuotedEx }];
export type ExArray = ["[]", QuotedEx[]];
export type ExNew = ["new", Function, QuotedEx[]];
export type ExQuote = ["q", QuotedEx];
// `x as T` — the target type carried as a name string (primitive keyword like
// "number"/"string"/"boolean", or an entity/embedded type name resolved via the
// type registry). Consistent with @field's "type is a name string" decision.
export type ExAs = ["as", QuotedEx, string];

export type OpUnary = "+u" | "-u" | "~" | "!";
export type OpBinary =
    "**" |
    "*" | "/" | "%" |
    "+" | "-" |
    "<<" | ">>" | ">>>" |
    "<" | "<=" | ">" | ">=" | "instanceof" |
    "==" | "!=" | "===" | "!==" |
    "&" | "|" | "^" |
    "&&" | "||" |
    "??";
