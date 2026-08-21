import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { EnumLine } from "@altea/altea/client/Lines/EnumLine";
import { NumberLine } from "@altea/altea/client/Lines/NumberLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useAPI, useForceUpdate } from "@altea/altea/client/Hooks";
import { EmbeddingsLanguageModelEntity } from "../../data/LanguageModel";
import { LanguageModelClient } from "../LanguageModelClient";

// Port of Signum.Agent's Templates/EmbeddingsLanguageModel.tsx.
export default function EmbeddingsLanguageModel(p: { ctx: TypeContext<EmbeddingsLanguageModelEntity> }): React.JSX.Element {
    const ctx = p.ctx;
    const ctx4 = ctx.subCtx({ labelColumns: { sm: 2 } });
    const forceUpdate = useForceUpdate();
    const provider = ctx.value.provider;

    const models = useAPI(() => provider ? LanguageModelClient.API.getEmbeddingModels(provider) : Promise.resolve(undefined), [provider]);

    return (
        <div>
            <AutoLine ctx={ctx4.subCtx(n => n.isDefault)} />
            <EntityCombo ctx={ctx4.subCtx(n => n.provider)} onChange={() => {
                ctx.value.model = null!;
                forceUpdate();
            }} />
            <EnumLine ctx={ctx4.subCtx(n => n.model)} readOnly={models == undefined} optionItems={models ?? []} />
            <NumberLine ctx={ctx4.subCtx(n => n.dimensions)} datalist={[768, 1536, 3072]} />
        </div>
    );
}
