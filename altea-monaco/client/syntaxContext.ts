// What the TypeScript worker answers about the code under a cursor (`alteaSyntaxContext`, see altea.worker):
// the class and the member it is in, with every SPAN an editing tool needs to change them as text. Pure
// syntax, offsets into the model's full text — what a "recipe" UI needs to edit source without parsing it.

export interface Span {
    start: number;
    end: number;
}

export interface DecoratorInfo extends Span {
    /** `stringLengthValidator` for `@stringLengthValidator({ max: 20 })`. */
    name: string;
    /** The text between the parentheses, or undefined for a bare `@part`. */
    argsText?: string;
    /** Where that text sits, when there are parentheses. */
    argsSpan?: Span;
}

/** A member's type annotation, taken apart where it has the usual shape: `Lite<X>[] | null`. */
export interface TypeShape {
    base: string;
    lite: boolean;
    array: boolean;
    nullable: boolean;
}

export interface MemberInfo extends Span {
    kind: "property" | "method" | "getter" | "setter" | "constructor" | "other";
    name: string;
    nameSpan: Span;
    /** Where the declaration's first line starts (its first decorator, or its name), for inserting above it. */
    lineStart: number;
    indent: string;
    accessor: boolean;
    /** The `accessor` keyword, when there is one. */
    accessorSpan?: Span;
    decorators: DecoratorInfo[];
    typeText?: string;
    typeSpan?: Span;
    /** Undefined when the annotation has some other shape (a union of two types, a function type). */
    typeShape?: TypeShape;
    initializerSpan?: Span;
    initializerText?: string;
}

export interface ClassInfo extends Span {
    name: string;
    nameSpan: Span;
    exported: boolean;
    /** `Entity` in `extends Entity`. */
    baseText?: string;
    decorators: DecoratorInfo[];
    /** Just after `{`, and the position of the closing `}`. */
    bodyStart: number;
    bodyEnd: number;
    members: MemberInfo[];
}

/** A function or a namespace member inside a top-level namespace. */
export interface NamespaceMemberInfo extends Span {
    kind: "const" | "function" | "other";
    name: string;
    /** `ExecuteSymbol<OrderEntity>` in `export const Save: ExecuteSymbol<OrderEntity> = init();`. */
    typeText?: string;
    /** For a function: just after its `{`, and the start of the line its closing `}` is on. */
    bodyStart?: number;
    closeLineStart?: number;
    indent: string;
}

/** A top-level `namespace` — where a type's operation symbols and its logic live. */
export interface NamespaceInfo extends Span {
    name: string;
    exported: boolean;
    indent: string;
    /** Just after `{`, and the start of the line its closing `}` is on. */
    bodyStart: number;
    closeLineStart: number;
    members: NamespaceMemberInfo[];
}

export interface SyntaxContext {
    /** The class the offset is in, if any. */
    class?: ClassInfo;
    /** The member of that class the offset is in, if any. */
    member?: MemberInfo;
    /** Every top-level class of the file, for tools that look across them (the part rows of an entity). */
    classes: ClassInfo[];
    namespaces: NamespaceInfo[];
}

/** Ask the worker (altea.worker) about the code at `offset` in `model`. */
export async function syntaxContextAt(monaco: typeof import("monaco-editor"), model: import("monaco-editor").editor.ITextModel,
    offset: number): Promise<SyntaxContext | null> {
    const worker = await monaco.languages.typescript.getTypeScriptWorker();
    const client = await worker(model.uri) as unknown as {
        alteaSyntaxContext(fileName: string, offset: number): Promise<SyntaxContext | null>;
    };
    return client.alteaSyntaxContext(model.uri.toString(), offset);
}
