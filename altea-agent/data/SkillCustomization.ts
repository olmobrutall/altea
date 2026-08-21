import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Symbol } from "@altea/altea/data/symbol";
import {
    backReference, entity, implementedBy, quoted, rowOrder, stringLengthValidator, uniqueIndex, valueField,
} from "@altea/altea/data/decorators";
import type { int } from "@altea/altea/data/basics";
import type { ConstructSymbol, DeleteSymbol, ExecuteSymbol, From } from "@altea/altea/data/operations";

// Port of Signum.Agent's SkillCustomizationEntity.cs — the DATABASE overlay over a skill that is declared
// in CODE. `SkillCodeEntity` is the registry row for a code class; `SkillCustomizationEntity` is "the same
// skill, with this description / these instructions / these property values / these sub-skills"; and an
// `AgentSymbol` names one agent and points at the root of its skill tree.
//
// altea divergences, documented inline:
//  - **AgentSymbol is a plain `Symbol`, not a `SemiSymbol`.** altea has no SemiSymbol (a symbol whose rows
//    may also be created in the database with a null `Key`). Every agent altea can reach is code-declared
//    — `AgentLogic.registeredAgents` is a code dictionary and `SymbolLogic` seeds the table from its keys —
//    so the DB-only half of SemiSymbol has no reachable use. Consequences: `AgentOperation.Save` is
//    registered with `canBeNew: false` (there is no new-agent flow), and Signum's PropertyValidation
//    ("either SkillCustomization or Key must be set") is dropped, since `Key` is now always set.
//  - `MList<SkillPropertyEmbedded>` / `MList<SubSkillEmbedded>` → the two @part rows below; `[BindParent]`
//    is implicit (a @part row is owned).
//  - `[TicksColumn(false)]` on SkillCodeEntity has no altea counterpart, so it keeps its ticks column.
//  - `ChildPropertyValidation` on SkillCustomizationEntity (which reflected over the skill class's C#
//    property attributes to validate a typed value) moves SERVER-side into `SkillCodeLogic`: the property
//    descriptors are declared in code by each skill (see server/SkillCode.ts — TypeScript cannot reflect
//    property attributes), and the isomorphic layer must not import the server registry.

/** Signum's SkillActivation — is a sub-skill's instruction inlined, or discovered through `describe`? */
export enum SkillActivationEnum {
    /** Instructions and tools are in the system prompt from the start. */
    Eager,
    /** Only a one-line summary is; the model must call `describe` to unlock it. */
    Lazy,
}

/** Signum's SkillCodeEntity — the registry row for one `SkillCode` subclass, keyed by its class name. */
@reflect
@entity("SystemString", "Master")
export class SkillCodeEntity extends Entity {

    @uniqueIndex
    @stringLengthValidator({ max: 200 })
    className: string;

    @quoted
    toString(): string {
        return this.className;
    }
}

/** Signum's AgentSymbol — names one agent (see the header note on SemiSymbol). */
@reflect
@entity("Main", "Master", { lowPopulation: true })
export class AgentSymbol extends Symbol {

    /** The DB overlay for this agent's root skill; null ⇒ the code default is used as-is. */
    skillCustomization: Lite<SkillCustomizationEntity> | null = null;
}

export namespace AgentOperation {
    export const Save: ExecuteSymbol<AgentSymbol> = init();
}

/** Signum's DefaultAgent — the three agents the module itself declares. */
export namespace DefaultAgent {
    export const Chatbot: AgentSymbol = init();
    export const QuestionSummarizer: AgentSymbol = init();
    export const ConversationSumarizer: AgentSymbol = init();
}

@reflect
@entity("Main", "Master")
export class SkillCustomizationEntity extends Entity {

    skillCode: SkillCodeEntity;

    @stringLengthValidator({ min: 1, max: 500 })
    shortDescription: string | null = null;

    @stringLengthValidator({ multiLine: true })
    instructions: string | null = null;

    properties: SkillCustomizationEntity_Property[];

    subSkills: SkillCustomizationEntity_SubSkill[];

    @quoted
    toString(): string {
        return this.skillCode?.className ?? `SkillCustomization ${this.id ?? "New"}`;
    }
}

/** Signum's `MList<SkillPropertyEmbedded> Properties`, as this owner's @part row. */
@reflect
@entity("Part", "Master")
export class SkillCustomizationEntity_Property extends Entity {
    @backReference skillCustomization: Lite<SkillCustomizationEntity>;
    @rowOrder order: int;

    @stringLengthValidator({ min: 1, max: 200 })
    propertyName: string;

    @stringLengthValidator({ multiLine: true })
    value: string | null = null;

    toString(): string {
        return `${this.propertyName} = ${this.value ?? ""}`;
    }
}

/**
 * Signum's `MList<SubSkillEmbedded> SubSkills`, as this owner's @part row. `skill` points at EITHER a
 * customization (this sub-skill is itself overridden) or the bare code row (use the code default) —
 * Signum's `[ImplementedBy(typeof(SkillCustomizationEntity), typeof(SkillCodeEntity))]`.
 */
@reflect
@entity("Part", "Master")
export class SkillCustomizationEntity_SubSkill extends Entity {
    @backReference skillCustomization: Lite<SkillCustomizationEntity>;
    @rowOrder order: int;

    @valueField @implementedBy(() => [SkillCustomizationEntity, SkillCodeEntity])
    skill: Entity;

    activation: SkillActivationEnum = SkillActivationEnum.Eager;

    toString(): string {
        return `${this.skill?.toString() ?? ""} (${SkillActivationEnum[this.activation]})`;
    }
}

export namespace SkillCustomizationOperation {
    export const Save: ExecuteSymbol<SkillCustomizationEntity> = init();
    export const Delete: DeleteSymbol<SkillCustomizationEntity> = init();
    export const CreateFromAgent: ConstructSymbol<SkillCustomizationEntity, From<AgentSymbol>> = init();
}
