import "@altea/altea/server";
import "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { table as tableQuery } from "@altea/altea/server/table";
import * as Database from "@altea/altea/server/Database";
import { DirectedGraph } from "@altea/altea/server/directedGraph";
import "@altea/altea/data/globals";
import {
    AgentOperation, AgentSymbol, DefaultAgent, SkillCodeEntity,
    SkillCustomizationEntity, SkillCustomizationEntity_Property, SkillCustomizationEntity_SubSkill,
    SkillCustomizationOperation,
} from "../data/SkillCustomization";
import { SkillCode } from "./SkillCode";
import { SkillCodeLogic } from "./SkillCodeLogic";
import { IntroductionSkill } from "./Skills/IntroductionSkill";
import { AutocompleteSkill } from "./Skills/AutocompleteSkill";
import { SearchSkill } from "./Skills/SearchSkill";
import { RetrieveSkill } from "./Skills/RetrieveSkill";
import { OperationSkill } from "./Skills/OperationSkill";
import { CurrentServerContextSkill } from "./Skills/CurrentServerContextSkill";
import { EntityUrlSkill } from "./Skills/EntityUrlSkill";
import { GetUIContextSkill } from "./Skills/GetUIContextSkill";
import { ConfirmUISkill } from "./Skills/ConfirmUISkill";
import { ChartSkill } from "./Skills/ChartSkill";
import { ConversationSumarizerSkill } from "./Skills/ConversationSumarizerSkill";
import { QuestionSumarizerSkill } from "./Skills/QuestionSumarizerSkill";

// Port of Signum.Agent's AgentLogic.cs — the AGENT registry: which agents exist, what skill tree each one
// runs, and how a database overlay turns back into that tree.
//
// altea divergences, documented inline:
//  - `SemiSymbolLogic<AgentSymbol>` → `SymbolLogic.start` (see data/SkillCustomization.ts for why
//    AgentSymbol is a plain Symbol), and `AgentOperation.Save` is registered without `CanBeNew`.
//  - `RegisteredAgents` is keyed by the symbol's KEY, not the symbol OBJECT: a symbol read back from the
//    database is a different instance, so an identity-keyed Map misses on every row-sourced lookup (the
//    bug the scheduler port hit and fixed).
//  - Signum wraps each factory call in `SkillCodeLogic.AutoRegister()` so the `SkillCode` base constructor
//    self-registers whatever the factory built. Here `registerAgent` instead WALKS the produced tree and
//    asserts every class in it is registered — same guarantee at the same moment, and the error names the
//    missing class instead of silently accepting it.
//  - `ValidateNoCircularReferences` keeps Signum's shape (build the graph of customizations, take the
//    feedback edge set) over altea's own `DirectedGraph`; `EntityCache.AddFullGraph` has no counterpart, so
//    the entity being saved is substituted into the graph explicitly (which is what Signum's `e.Is(entity)`
//    branch does anyway).
//  - the `WithSignumSkill` MCP builder extension moves to its own file (AgentMcpServer.server.ts).
export namespace AgentLogic {

    /** Signum's `RegisteredAgents` (keyed by symbol key — see the header note). */
    const registeredAgents = new Map<string, () => SkillCode>();
    const declaredAgents: AgentSymbol[] = [];

    let skillCodeByAgent: ResetLazy<Map<string, SkillCode>> | undefined;

    /** Signum's `RegisterAgent(agent, factory)`. Call BEFORE start — the symbol table is seeded from these. */
    export function registerAgent(agent: AgentSymbol, factory: () => SkillCode): void {
        if (agent == null)
            throw new Error("AgentLogic.registerAgent: the symbol is null — is it declared with init() inside a namespace?");

        // Signum builds the tree once at registration to prove the factory works; altea additionally
        // checks that every class in it is registered, which is what its AutoRegister scope achieved.
        const root = factory();
        for (const skill of root.getSkillsRecursive()) {
            const skillClass = skill.constructor as SkillCodeLogic.SkillCodeClass;
            if (!SkillCodeLogic.isRegistered(skillClass))
                throw new Error(`Agent '${agent.key}' uses skill '${skillClass.name}', which is not registered — call SkillCodeLogic.register(${skillClass.name}) first.`);

            // Touch the instructions so a MISSING `.md` fails at boot, naming the skill, instead of on the
            // first chat turn (where it surfaces as an opaque ENOENT mid-stream). They are read lazily and
            // cached, so this costs one file read per skill, once.
            void skill.originalInstructions;
        }

        if (!registeredAgents.has(agent.key))
            declaredAgents.push(agent);
        registeredAgents.set(agent.key, factory);
    }

    export function registeredAgentKeys(): string[] {
        return [...registeredAgents.keys()];
    }

    export function factoryFor(agentKey: string): (() => SkillCode) | undefined {
        return registeredAgents.get(agentKey);
    }

    /** Signum's `AgentLogic.Start(sb, getChatBot)`. */
    export function start(sb: SchemaBuilder, getChatBot?: () => SkillCode): void {
        if (sb.alreadyDefined(start))
            return;

        SkillCodeLogic.start(sb);

        // Every skill the MODULE ships. Signum has no such list: its `SkillCode` base constructor
        // auto-registers the concrete type (SkillCode.cs), so merely newing one up in the app's tree is
        // enough. altea cannot do that — a class that is never instantiated is never seen, and the SkillCode
        // TABLE is seeded from this registry BEFORE any tree is built — so the module registers what it
        // owns, and an application only registers a skill of its OWN.
        SkillCodeLogic.register(IntroductionSkill);
        SkillCodeLogic.register(AutocompleteSkill);
        SkillCodeLogic.register(SearchSkill);
        SkillCodeLogic.register(RetrieveSkill);
        SkillCodeLogic.register(OperationSkill);
        SkillCodeLogic.register(CurrentServerContextSkill);
        SkillCodeLogic.register(EntityUrlSkill);
        SkillCodeLogic.register(GetUIContextSkill);
        SkillCodeLogic.register(ConfirmUISkill);
        SkillCodeLogic.register(ChartSkill);
        SkillCodeLogic.register(ConversationSumarizerSkill);
        SkillCodeLogic.register(QuestionSumarizerSkill);

        if (getChatBot != undefined)
            registerAgent(DefaultAgent.Chatbot, getChatBot);

        registerAgent(DefaultAgent.QuestionSummarizer, () => new QuestionSumarizerSkill());
        registerAgent(DefaultAgent.ConversationSumarizer, () => new ConversationSumarizerSkill());

        SymbolLogic.start(sb, AgentSymbol, () => declaredAgents);

        sb.include(AgentSymbol)
            // No `canBeNew`: altea's AgentSymbol is a plain Symbol, so every row is code-seeded and Save
            // only ever persists a changed `skillCustomization` (Signum's Execute body is empty too).
            .withExecute(AgentOperation.Save, { canBeModified: true, execute: () => { } })
            .withQuery();

        sb.include(SkillCustomizationEntity)
            .withConstructFrom(AgentSymbol, SkillCustomizationOperation.CreateFromAgent, {
                construct: async (agentSymbol: AgentSymbol) => {
                    const factory = registeredAgents.get(agentSymbol.key);
                    if (factory == undefined)
                        return SkillCustomizationEntity.create({});
                    return await toCustomizationEntity(factory());
                },
            })
            .withSave(SkillCustomizationOperation.Save)
            .withDelete(SkillCustomizationOperation.Delete)
            .withQuery();

        sb.include(SkillCustomizationEntity_Property).withQuery();
        sb.include(SkillCustomizationEntity_SubSkill).withQuery();

        sb.schema.entityEvents(SkillCustomizationEntity).saving.push(entity => {
            // Signum guards on `SubSkills.IsGraphModified`; altea's snapshot diffing exposes the same
            // question as isDirty on the owner, and the check is cheap next to a save.
            if (!entity.isNew)
                void validateNoCircularReferences(entity);
        });

        skillCodeByAgent = sb.globalLazy(async () => {
            const agents = await ExecutionMode.global(() => tableQuery(AgentSymbol).toArray());
            const result = new Map<string, SkillCode>();

            for (const agent of agents) {
                if (agent.skillCustomization != null) {
                    const customization = await Database.retrieve(SkillCustomizationEntity, agent.skillCustomization.id);
                    result.set(agent.key, await toSkillCode(customization));
                } else {
                    const factory = registeredAgents.get(agent.key);
                    if (factory != undefined)
                        result.set(agent.key, factory());
                }
            }

            return result;
        }, { invalidateWith: [SkillCustomizationEntity, AgentSymbol] });
    }

    /** Signum's `GetEffectiveSkillCode(agentSymbol)` — the tree this agent actually runs. */
    export async function getEffectiveSkillCode(agent: AgentSymbol): Promise<SkillCode> {
        if (skillCodeByAgent == undefined)
            throw new Error("AgentLogic.start was not called");

        const map = await skillCodeByAgent.value();
        const code = map.get(agent.key);
        if (code == undefined)
            throw new Error(`No skill tree for agent '${agent.key}' — is it registered, and has the schema been synchronized?`);
        return code;
    }

    /** Signum's `ToSkillCode(entity)` — a DB overlay back into a live tree. */
    export async function toSkillCode(entity: SkillCustomizationEntity): Promise<SkillCode> {
        const code = SkillCodeLogic.create(entity.skillCode.className);
        code.customization = entity;

        if (entity.shortDescription != null)
            code.shortDescription = entity.shortDescription;
        if (entity.instructions != null)
            code.originalInstructions = entity.instructions;

        code.applyPropertyOverrides(entity);

        for (const row of entity.subSkills) {
            const sub = row.skill instanceof SkillCustomizationEntity
                ? await toSkillCode(row.skill)
                : row.skill instanceof SkillCodeEntity
                    ? SkillCodeLogic.create(row.skill.className)
                    : (() => { throw new Error(`Unexpected sub-skill target: ${row.skill?.constructor.name}`); })();

            code.withSubSkill(row.activation, sub);
        }

        return code;
    }

    /** Signum's `ToCustomizationEntity(code)` — a live tree captured as an editable overlay. */
    export async function toCustomizationEntity(code: SkillCode): Promise<SkillCustomizationEntity> {
        const entity = SkillCustomizationEntity.create({
            skillCode: await SkillCodeLogic.toSkillCodeEntity(code.name),
            shortDescription: code.shortDescription,
            instructions: code.originalInstructions,
            properties: code.properties.map(p => SkillCustomizationEntity_Property.create({
                propertyName: p.name,
                value: p.getAsString(),
            })),
            subSkills: [],
        });

        for (const { code: sub, activation } of code.subSkills) {
            entity.subSkills.push(SkillCustomizationEntity_SubSkill.create({
                skill: sub.isDefault()
                    ? await SkillCodeLogic.toSkillCodeEntity(sub.name)
                    : await toCustomizationEntity(sub),
                activation,
            }));
        }

        return entity;
    }

    /** Signum's ValidateNoCircularReferences — a customization tree must be a DAG. */
    async function validateNoCircularReferences(entity: SkillCustomizationEntity): Promise<void> {
        const all = await ExecutionMode.global(() => tableQuery(SkillCustomizationEntity).toArray());

        // The entity BEING SAVED is not what the database holds yet, so substitute it (Signum reaches the
        // same state with EntityCache.AddFullGraph + its `e.Is(entity)` branch).
        const nodes = all.map(e => e.id != null && e.id === entity.id ? entity : e);

        const graphOfSkills = DirectedGraph.generate(nodes, e =>
            e.subSkills
                .map(s => s.skill)
                .filter((s): s is SkillCustomizationEntity => s instanceof SkillCustomizationEntity)
                .map(s => nodes.find(n => n.id != null && n.id === s.id) ?? s));

        const problems = graphOfSkills.feedbackEdgeSet().edges;
        if (problems.length > 0)
            throw new Error(`${problems.length} cycle(s) found in the skill graph:\n`
                + problems.map(e => `  ${e.from} → ${e.to}`).join("\n"));
    }

}