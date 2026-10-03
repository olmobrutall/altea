import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";

// The module's WIRE DTOs — the shapes that cross /api/eval/* but are not entities — declared once, for the
// routes and the client both.

/** One failing script: the entity, the error, and which registered source it came from. */
export interface EvalEntityError {
    source: string;
    lite: Lite<Entity>;
    error: string;
}

/** One `.d.ts` the editor needs, at the path the editor must serve it from. */
export interface DeclarationFile { path: string; content: string }

export interface ClientConfiguration {
    /** The import lines every script gets, which the editor must show above the author's own text. */
    eagerLines: readonly string[];
    /** Identifier -> module, so the editor can write the same implicit import the compiler would. */
    names: readonly (readonly [string, string])[];
}

/** What the editor is handed before it can check anything. */
export interface IntelliSenseResponse extends ClientConfiguration {
    /** The directory the editor must pretend the script lives in, so relative imports resolve. */
    root: string;
    declarations: DeclarationFile[];
}

export interface DeclarationsRequest {
    specifiers: string[];
    /** Declaration paths the editor already holds, so a second module costs only what it adds. */
    have: string[];
}
