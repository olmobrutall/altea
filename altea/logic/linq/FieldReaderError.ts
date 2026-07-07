// Port of Signum's FieldReaderException (Engine/Connection/FieldReader.cs). Wraps an
// error thrown while a projector materialises a query row, enriching it with the context
// that makes such failures debuggable: which row, the projector source, and the SQL command.
// In C# the throwing case is typically a DB NULL read into a non-nullable value type;
// TypeScript has no such constraint (a NULL is just `null`), so in altea the wrapped error is
// a genuine conversion failure — e.g. a temporal column whose driver value the Temporal
// parser rejects.
export class FieldReaderError extends Error {
    rowIndex?: number;
    sql?: string;
    projector?: string;

    constructor(public readonly inner: unknown) {
        super();
        this.name = "FieldReaderError";
        // Keep the original stack so the true failure site is visible.
        if (inner instanceof Error && inner.stack != null)
            this.stack = inner.stack;
        this.message = this.buildMessage();
    }

    // Add the row-loop context (row index, SQL command, projector source) as the error
    // unwinds out of the row that failed, then refresh the composed message.
    enrich(context: { rowIndex?: number; sql?: string; projector?: string }): this {
        if (context.rowIndex !== undefined) this.rowIndex = context.rowIndex;
        if (context.sql !== undefined) this.sql = context.sql;
        if (context.projector !== undefined) this.projector = context.projector;
        this.message = this.buildMessage();
        return this;
    }

    private buildMessage(): string {
        const innerMessage = this.inner instanceof Error ? this.inner.message : String(this.inner);
        let text = `${innerMessage}\nRow: ${this.rowIndex ?? ""}`;
        if (this.projector != null)
            text += `\nProjector:\n${indent(this.projector)}`;
        if (this.sql != null)
            text += `\nCommand:\n${indent(this.sql)}`;
        return text;
    }
}

function indent(text: string): string {
    return text.split("\n").map(l => "    " + l).join("\n");
}
