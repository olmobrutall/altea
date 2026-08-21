import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SkillActivationEnum, type SkillCustomizationEntity } from "../data/SkillCustomization";
import type { AIToolDefinition, JsonSchema } from "./ChatClient";

// Port of Signum.Agent's SkillCode.cs — a SKILL is a named unit of "instructions + tools", composable into
// a tree (`withSubSkill`), overridable from the database (`applyPropertyOverrides`), and rendered into one
// system prompt (`getInstruction`).
//
// TWO divergences shape this file, and every skill built on it:
//
// 1. **Tools are declared, not reflected.** Signum marks a C# METHOD `[McpServerTool]` and lets
//    `AIFunctionFactory.Create(delegate)` reflect its signature into a JSON Schema and bind the call.
//    TypeScript erases parameter types at runtime — there is no signature to read — so a tool declares its
//    schema and its handler explicitly through `registerTool`. The tool NAMES, descriptions and argument
//    names are kept identical to Signum's, because they are part of the prompt the model reads. A `[UITool]`
//    is `isUITool: true` with no `invoke` (Signum expresses the same thing as a method whose body throws).
//
// 2. **Properties are declared, not reflected.** Signum's `[SkillProperty]` / `[SkillProperty_QueryList]`
//    attributes let `SkillCodeLogic` enumerate a skill's configurable properties, convert them to and from
//    the string a `SkillCustomizationEntity_Property` row stores, and validate them. Property decorators
//    could carry the metadata, but not the CONVERSION and VALIDATION per kind, so a skill declares each
//    configurable property with `registerProperty` — which keeps `attributeName` (the key the client's
//    `AgentClient.registerPropertyValueControl` registry is keyed by) as an explicit string.
//
// Smaller ones:
//  - `SkillCode.SkillsDirectory` resolves relative to THIS module's own directory (`import.meta.url`),
//    since there is no assembly location. The `.md` files ship next to the compiled `.js`.
//  - `GetMcpServerTools()` / `GetJsonSerializerOptions()` collapse into `getToolsRecursive()`: an
//    AIToolDefinition already IS the protocol shape, so there is nothing to convert (see AgentMcpServer).
//  - `IsDefault()` compares against a freshly constructed instance, as Signum does, but through the
//    declared property descriptors rather than reflection.

/** How a skill property's value is edited and converted (Signum's SkillPropertyAttribute subclasses). */
export interface SkillPropertyDescriptor {
    readonly name: string;
    /** The key the client's property-editor registry is keyed by (Signum: the attribute class name). */
    readonly attributeName: string;
    /** Display-only: what the value means (Signum reflects the C# property type). */
    readonly propertyType: string;
    readonly valueHint?: string;
    /** Read the live value as the string a `SkillCustomizationEntity_Property` row stores. */
    readonly getAsString: () => string | null;
    /** Write a stored string back onto the skill. */
    readonly setFromString: (value: string | null) => void;
    /** Signum's `ValidateValue` — null when the string is acceptable. */
    readonly validate?: (value: string | null) => string | null;
}

export abstract class SkillCode {

    /**
     * Where the `.md` instruction files live (Signum's `SkillCode.SkillsDirectory`, which reads the
     * assembly location and relies on `CopyToOutputDirectory` in the csproj).
     *
     * `tsc` copies no assets, so the compiled `dist/server/Skills` has the `.js` but not the `.md`. Rather
     * than add a build step, the SOURCE directory is used as a fallback — the same `dist/` → source
     * mapping eastwind's vite config applies to co-located CSS. Set this to point somewhere else.
     */
    static skillsDirectory: string = join(dirname(fileURLToPath(import.meta.url)), "Skills");

    /** Signum's `Name` — the class name, which is also the registry key and what `describe` takes. */
    get name(): string {
        return this.constructor.name;
    }

    /** Set when this instance came from a database overlay (Signum's `Customization`). */
    customization: SkillCustomizationEntity | null = null;

    shortDescription = "";

    /** Signum's `IsAllowed` — a gate the app can tighten (e.g. on a permission). */
    isAllowed: () => boolean = () => true;

    /**
     * Signum's `Replacements` — placeholder → value, applied to the instruction text. The value is a
     * function of the CONTEXT the instruction is rendered for (a conversation, a string to summarize, …).
     */
    replacements?: Record<string, (context: unknown) => string>;

    /** Signum's `SubSkills` — filled from code (`withSubSkill`) or from a DB overlay. */
    readonly subSkills: { code: SkillCode; activation: SkillActivationEnum }[] = [];

    private readonly toolList: AIToolDefinition[] = [];
    private readonly propertyList: SkillPropertyDescriptor[] = [];
    private originalInstructionsOverride: string | undefined;
    private originalInstructionsCache: string | undefined;

    // ---- instructions --------------------------------------------------------------------------

    /**
     * Signum's `OriginalInstructions` — the skill's own `.md`, or the overlay's text when one is set.
     * The file is `<ClassName minus "Skill">.md`, exactly as in Signum.
     */
    get originalInstructions(): string {
        if (this.originalInstructionsOverride != undefined)
            return this.originalInstructionsOverride;

        return this.originalInstructionsCache ??= readInstructionFile(`${stripSkillSuffix(this.name)}.md`);
    }

    set originalInstructions(value: string) {
        this.originalInstructionsOverride = value;
    }

    /** Signum's `GetInstruction(context)` — the text plus one section per sub-skill. */
    getInstruction(context: unknown): string {
        let text = this.originalInstructions;

        if (this.replacements != undefined) {
            for (const [placeholder, resolve] of Object.entries(this.replacements))
                text = text.split(placeholder).join(resolve(context));
        }

        if (this.subSkills.length === 0)
            return text;

        const parts = [text];
        for (const { code, activation } of this.subSkills) {
            parts.push(`# Skill ${code.name}`);
            parts.push(`**Summary**: ${code.shortDescription}`);
            parts.push("");
            parts.push(activation === SkillActivationEnum.Eager
                ? code.getInstruction(null)
                : "Use the tool 'describe' to get more information about this skill and discover additional tools.");
        }
        return parts.join("\n");
    }

    // ---- composition ---------------------------------------------------------------------------

    /** Signum's `WithSubSkill(activation, sub)`. */
    withSubSkill(activation: SkillActivationEnum, sub: SkillCode): this {
        this.subSkills.push({ code: sub, activation });
        return this;
    }

    /** Signum's `FindSkill(name)` — this skill or any descendant. */
    findSkill(name: string): SkillCode | undefined {
        if (this.name === name)
            return this;
        for (const { code } of this.subSkills) {
            const found = code.findSkill(name);
            if (found != undefined)
                return found;
        }
        return undefined;
    }

    /** Signum's `FindTool(toolName)` — case-insensitive, across the whole tree. */
    findTool(toolName: string): AIToolDefinition | undefined {
        const tool = this.toolList.find(t => t.name.toLowerCase() === toolName.toLowerCase());
        if (tool != undefined)
            return tool;
        for (const { code } of this.subSkills) {
            const found = code.findTool(toolName);
            if (found != undefined)
                return found;
        }
        return undefined;
    }

    /** Signum's `GetSkillsRecursive()`. */
    *getSkillsRecursive(): Generator<SkillCode> {
        yield this;
        for (const { code } of this.subSkills)
            yield* code.getSkillsRecursive();
    }

    /** Signum's `GetEagerSkillsRecursive()` — what is active before any `describe` call. */
    *getEagerSkillsRecursive(): Generator<SkillCode> {
        yield this;
        for (const { code, activation } of this.subSkills)
            if (activation === SkillActivationEnum.Eager)
                yield* code.getEagerSkillsRecursive();
    }

    /** Signum's `GetTools()` — this skill's own tools. */
    getTools(): AIToolDefinition[] {
        return this.toolList;
    }

    /** Signum's `GetToolsRecursive()` — own tools plus every EAGER descendant's. */
    getToolsRecursive(): AIToolDefinition[] {
        const list = [...this.toolList];
        for (const { code, activation } of this.subSkills)
            if (activation === SkillActivationEnum.Eager)
                list.push(...code.getToolsRecursive());
        return list;
    }

    // ---- declaration (the two divergences) -----------------------------------------------------

    /** Declare one tool. Call from the constructor (Signum's `[McpServerTool]` on a method). */
    protected registerTool(tool: AIToolDefinition): void {
        if (this.toolList.some(t => t.name === tool.name))
            throw new Error(`Skill '${this.name}' already declares a tool named '${tool.name}'`);
        if (!tool.isUITool && tool.invoke == undefined)
            throw new Error(`Tool '${tool.name}' of skill '${this.name}' needs an invoke (or isUITool: true)`);
        this.toolList.push(tool);
    }

    /** Declare one configurable property (Signum's `[SkillProperty]`). */
    protected registerProperty(descriptor: SkillPropertyDescriptor): void {
        this.propertyList.push(descriptor);
    }

    get properties(): readonly SkillPropertyDescriptor[] {
        return this.propertyList;
    }

    /** Signum's `ApplyPropertyOverrides(entity)` — write the stored strings back onto this instance. */
    applyPropertyOverrides(entity: SkillCustomizationEntity): void {
        for (const row of entity.properties) {
            const descriptor = this.propertyList.find(p => p.name === row.propertyName);
            if (descriptor == undefined)
                continue;
            descriptor.setFromString(row.value);
        }
    }

    /**
     * Signum's `IsDefault()` — is this instance indistinguishable from a freshly constructed one? Decides
     * whether a sub-skill needs its own customization row or can point straight at the code row.
     */
    isDefault(): boolean {
        if (this.subSkills.length > 0)
            return false;

        const fresh = new (this.constructor as new () => SkillCode)();
        if (this.shortDescription !== fresh.shortDescription)
            return false;
        if (this.originalInstructions !== fresh.originalInstructions)
            return false;

        for (const descriptor of this.propertyList) {
            const other = fresh.properties.find(p => p.name === descriptor.name);
            if (other == undefined || descriptor.getAsString() !== other.getAsString())
                return false;
        }

        return true;
    }
}

/** Reads an instruction file from `SkillCode.skillsDirectory`, falling back to the source tree. */
function readInstructionFile(fileName: string): string {
    const primary = join(SkillCode.skillsDirectory, fileName);
    try {
        return readFileSync(primary, "utf8");
    } catch {
        const fromSource = primary.replace(/([\\/])dist\1/, "$1");
        if (fromSource !== primary) {
            try {
                return readFileSync(fromSource, "utf8");
            } catch { /* fall through to the message below, which names BOTH paths */ }
        }
        // Naming only the dist path would send the reader looking for a file that is not supposed to be
        // there — the source copy is the one a developer is missing.
        throw new Error(`Instruction file '${fileName}' not found. Looked in '${primary}'`
            + (fromSource !== primary ? ` and '${fromSource}'` : ""));
    }
}

/** `SearchSkill` → `Search`, so the `.md` file name matches Signum's convention. */
export function stripSkillSuffix(className: string): string {
    return className.endsWith("Skill") ? className.slice(0, -"Skill".length) : className;
}

// ---- schema helpers ----------------------------------------------------------------------------
//
// The schema literals a tool declares are what Signum's reflection produced from a method signature.
// These keep the declarations short and consistent (and are the one place a vendor quirk could be
// centralised, as `toGeminiSchema` does on the way out).

export const Schema = {
    string(description?: string): JsonSchema {
        return { type: "string", ...(description != undefined ? { description } : {}) };
    },
    number(description?: string): JsonSchema {
        return { type: "number", ...(description != undefined ? { description } : {}) };
    },
    boolean(description?: string): JsonSchema {
        return { type: "boolean", ...(description != undefined ? { description } : {}) };
    },
    array(items: JsonSchema, description?: string): JsonSchema {
        return { type: "array", items, ...(description != undefined ? { description } : {}) };
    },
    /** A free-form JSON value (Signum's `JsonObject` / `object` parameters). */
    any(description?: string): JsonSchema {
        return { type: "object", additionalProperties: true, ...(description != undefined ? { description } : {}) };
    },
    object(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
        return { type: "object", properties, required, additionalProperties: false };
    },
    /** The common case: a tool whose arguments are all required. */
    args(properties: Record<string, JsonSchema>, required?: string[]): JsonSchema {
        return Schema.object(properties, required ?? Object.keys(properties));
    },
};

/** Signum's `DefaultToolParameter` list, derived from a declared schema (for the SkillCode editors). */
export function describeParameters(schema: JsonSchema): { name: string; type: string; isRequired: boolean; description: string | null }[] {
    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties ?? {}).map(([name, prop]) => ({
        name,
        type: Array.isArray(prop.type) ? prop.type.join(" | ") : (prop.type ?? "any"),
        isRequired: required.has(name),
        description: prop.description ?? null,
    }));
}
