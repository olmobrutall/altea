import * as React from "react";
import { TextBoxLine } from "@altea/altea/client/Lines/TextBoxLine";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { EnumLine } from "@altea/altea/client/Lines/EnumLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useAPI, useForceUpdate } from "@altea/altea/client/Hooks";
import { Navigator } from "@altea/altea/client/Navigator";
import { MarkdownLine } from "@altea/altea-markdown/client/MarkdownLine";
import { DiffDocument } from "@altea/altea-diff-log/client/Templates/DiffDocument";
import type { SkillPropertyMeta } from "../../data/ChatbotProtocol";
import {
    SkillCodeEntity, SkillCustomizationEntity, SkillCustomizationEntity_SubSkill,
} from "../../data/SkillCustomization";
import { AgentClient } from "../AgentClient";
import { ToolsView } from "./SkillCode";

// Port of Signum.Agent's Templates/SkillCustomization.tsx — the editor for a DB overlay over a code skill.
//
// altea divergences:
//  - the "Show Diff" toggle is Signum's, over the same `DiffDocument` (@altea/altea-diff-log). The extra
//    "Reset to default" button is an altea addition: seeing what changed is only half of what you want from
//    a diff against a default, and putting it back was two clicks of manual copying in Signum.
//  - `LinkButton` → a plain bootstrap link button; `FontAwesomeIcon` comes from the package directly.
export default function SkillCustomization(p: { ctx: TypeContext<SkillCustomizationEntity> }): React.JSX.Element {
    const ctx = p.ctx;
    const ctx4 = ctx.subCtx({ labelColumns: { sm: 4 } });
    const forceUpdate = useForceUpdate();

    const skillCode = ctx.value.skillCode;

    const skillCodeInfo = useAPI(() => skillCode
        ? AgentClient.API.getSkillCodeInfo(skillCode.className)
        : Promise.resolve(undefined), [skillCode?.className]);

    async function handleConvertToSkillCustomization(ectx: TypeContext<SkillCustomizationEntity_SubSkill>): Promise<void> {
        const skill = ectx.value.skill;
        if (!(skill instanceof SkillCodeEntity))
            return;

        const info = await AgentClient.API.getSkillCodeInfo(skill.className);
        const newEntity = SkillCustomizationEntity.create({
            skillCode: skill,
            shortDescription: info.defaultShortDescription,
            instructions: info.defaultInstructions,
        });

        const saved = await Navigator.view(newEntity);
        if (saved) {
            ectx.value.skill = saved;
            forceUpdate();
        }
    }

    return (
        <div>
            <div className="row">
                <div className="col-sm-6">
                    <EntityCombo ctx={ctx4.subCtx(e => e.skillCode)} onChange={() => {
                        ctx.value.shortDescription = null;
                        ctx.value.instructions = null;
                        ctx.value.properties = [];
                        forceUpdate();
                    }} />
                </div>
                <div className="col-sm-6">
                    <TextBoxLine ctx={ctx4.subCtx(e => e.shortDescription)}
                        helpText={skillCodeInfo && ctx.value.shortDescription == null
                            ? `Default: ${skillCodeInfo.defaultShortDescription}`
                            : undefined} />
                </div>
            </div>

            <InstructionsField ctx={ctx} info={skillCodeInfo} />

            <EntityTable ctx={ctx.subCtx(e => e.subSkills)} avoidFieldSet="h5" columns={[
                { property: e => e.activation, template: ectx => <EnumLine ctx={ectx.subCtx(e => e.activation)} /> },
                {
                    property: e => e.skill,
                    template: ectx => (
                        <div className="d-flex align-items-center gap-1">
                            <EntityLine ctx={ectx.subCtx(e => e.skill)} />
                            {ectx.value.skill instanceof SkillCodeEntity &&
                                <button type="button" className="btn btn-sm btn-link p-0"
                                    title={SkillCustomizationEntity.niceName()}
                                    onClick={() => void handleConvertToSkillCustomization(ectx)}>
                                    Customize
                                </button>}
                        </div>
                    ),
                },
            ]} />

            {skillCodeInfo && <ToolsView tools={skillCodeInfo.tools} />}

            {skillCodeInfo && skillCodeInfo.properties.length > 0 && (
                <EntityTable ctx={ctx.subCtx(e => e.properties)} avoidFieldSet="h5" columns={[
                    {
                        property: e => e.propertyName,
                        template: ectx => (
                            <EnumLine ctx={ectx.subCtx(e => e.propertyName)}
                                optionItems={skillCodeInfo.properties.map(m => m.propertyName)}
                                onChange={() => { ectx.value.value = null; forceUpdate(); }} />
                        ),
                    },
                    {
                        property: e => e.value,
                        template: ectx => <PropertyValueControl ctx={ectx.subCtx(e => e.value)}
                            properties={skillCodeInfo.properties}
                            propertyName={ectx.value.propertyName} />,
                    },
                ]} />
            )}
        </div>
    );
}

function InstructionsField(p: {
    ctx: TypeContext<SkillCustomizationEntity>;
    info: { defaultInstructions: string } | null | undefined;
}): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const [showDiff, setShowDiff] = React.useState(false);
    const ctx = p.ctx;

    return (
        <div className="mb-3">
            <div className="d-flex justify-content-between align-items-center">
                <strong className="small">{ctx.niceName(e => e.instructions)}</strong>
                <div>
                    {p.info &&
                        <button type="button" className="btn btn-sm btn-link"
                            title={showDiff ? "Show editor" : "Show diff with default"}
                            onClick={() => setShowDiff(v => !v)}>
                            {showDiff ? "Show Editor" : "Show Diff"}
                        </button>}
                    {p.info && !ctx.readOnly &&
                        <button type="button" className="btn btn-sm btn-link"
                            title="Replace the instructions with the skill's code default"
                            onClick={() => { ctx.value.instructions = p.info!.defaultInstructions; forceUpdate(); }}>
                            Reset to default
                        </button>}
                </div>
            </div>
            {showDiff && p.info
                ? <DiffDocument first={p.info.defaultInstructions} second={ctx.value.instructions ?? ""} />
                : <MarkdownLine ctx={ctx.subCtx(e => e.instructions)} onChange={forceUpdate} />}
        </div>
    );
}

function PropertyValueControl(p: {
    ctx: TypeContext<string | null>;
    properties: SkillPropertyMeta[];
    propertyName: string;
}): React.JSX.Element {
    const meta = p.properties.find(m => m.propertyName === p.propertyName);

    if (!meta)
        return <TextBoxLine ctx={p.ctx} />;

    const factory = AgentClient.getPropertyValueControl(meta.attributeName);
    if (factory)
        return factory(p.ctx, meta);

    const helpText = [
        meta.defaultValue != null ? `Default: ${meta.defaultValue}` : null,
        meta.valueHint,
    ].filter(Boolean).join(" — ") || undefined;

    return <TextBoxLine ctx={p.ctx} helpText={helpText} />;
}
