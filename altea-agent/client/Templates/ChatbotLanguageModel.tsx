import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { EnumLine } from "@altea/altea/client/Lines/EnumLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useAPI, useForceUpdate } from "@altea/altea/client/Hooks";
import { ChatbotLanguageModelEntity } from "../../data/LanguageModel";
import { LanguageModelClient } from "../LanguageModelClient";

// Port of Signum.Agent's Templates/ChatbotLanguageModel.tsx — the chat-model editor. The MODEL field is an
// EnumLine over the names the provider's catalogue returns, so it stays a free string in the database while
// being a picker in the UI (as in Signum).
export default function ChatbotLanguageModel(p: { ctx: TypeContext<ChatbotLanguageModelEntity> }): React.JSX.Element {
    const ctx = p.ctx;
    const ctx4 = ctx.subCtx({ labelColumns: { sm: 4 } });
    const ctx6 = ctx.subCtx({ labelColumns: { sm: 5 } });
    const forceUpdate = useForceUpdate();
    const provider = ctx.value.provider;

    const models = useAPI(() => provider ? LanguageModelClient.API.getModels(provider) : Promise.resolve(undefined), [provider]);

    return (
        <div>
            <div className="row">
                <div className="col-sm-6">
                    <AutoLine ctx={ctx4.subCtx(n => n.isDefault)} />
                    <EntityCombo ctx={ctx4.subCtx(n => n.provider)} onChange={() => {
                        ctx.value.model = null!;
                        ctx.value.pricePerInputToken = null;
                        ctx.value.pricePerCachedInputToken = null;
                        ctx.value.pricePerOutputToken = null;
                        ctx.value.pricePerReasoningOutputToken = null;
                        forceUpdate();
                    }} />
                    <EnumLine ctx={ctx4.subCtx(n => n.model)} readOnly={models == undefined} optionItems={models ?? []} />

                    <AutoLine ctx={ctx4.subCtx(n => n.temperature)} />
                    <AutoLine ctx={ctx4.subCtx(n => n.maxTokens)} />
                </div>
                <div className="col-sm-6">
                    <fieldset className="mt-0">
                        <legend className="fs-6 fw-semibold">Pricing</legend>
                        <AutoLine ctx={ctx6.subCtx(n => n.pricePerInputToken)} />
                        <AutoLine ctx={ctx6.subCtx(n => n.pricePerCachedInputToken)} />
                        <AutoLine ctx={ctx6.subCtx(n => n.pricePerOutputToken)} />
                        <AutoLine ctx={ctx6.subCtx(n => n.pricePerReasoningOutputToken)} />
                    </fieldset>
                </div>
            </div>
        </div>
    );
}
