import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { TextBoxLine } from "@altea/altea/client/Lines/TextBoxLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { AzureADConfigurationEmbedded, AzureADType } from "../data/AzureAD";

// Port of Signum.Authorization.AzureAD's AzureADConfiguration.tsx — the configuration editor. Which fields
// are shown depends on the Azure product, mirroring the StateValidator matrix on the entity.
//
// altea divergence: `ctx.value.type == "AzureAD"` (Signum compares the wire STRING of its enum) becomes a
// comparison against the numeric `AzureADType` member — altea's entity enums are numeric in memory (see
// CLAUDE.md; the string form is the reflected-enum wire value, which this field is not).

export default function AzureADConfiguration(p: { ctx: TypeContext<AzureADConfigurationEmbedded> }): React.JSX.Element {
    const ctx = p.ctx;
    const forceUpdate = useForceUpdate();

    return (
        <div>
            <div className="row">
                <div className="col-sm-10 offset-sm-2">
                    <CheckboxLine ctx={ctx.subCtx(n => n.enabled)} inlineCheckbox="block" onChange={forceUpdate} />
                </div>
            </div>

            <AutoLine ctx={ctx.subCtx(n => n.type)} onChange={() => {
                // Clearing the flows on a product change is what keeps the entity valid: each product
                // FORBIDS the fields the others require (see the matrix in data/AzureAD.ts).
                if (ctx.value.type === AzureADType.AzureAD) {
                    ctx.value.tenantName = null;
                    ctx.value.signInSignUp_UserFlow = null;
                }
                ctx.value.signIn_UserFlow = null;
                ctx.value.signUp_UserFlow = null;
                ctx.value.editProfile_UserFlow = null;
                ctx.value.resetPassword_UserFlow = null;
                forceUpdate();
            }} />

            <AutoLine ctx={ctx.subCtx(n => n.applicationID)} />
            <AutoLine ctx={ctx.subCtx(n => n.directoryID)} />

            {ctx.value.type === AzureADType.ExternalID && <div>
                <TextBoxLine ctx={ctx.subCtx(n => n.tenantName)} mandatory
                    valueHtmlAttributes={{ placeholder: "southwind.ciamlogin.com" }} />
                <TextBoxLine ctx={ctx.subCtx(n => n.signInSignUp_UserFlow)} mandatory
                    valueHtmlAttributes={{ placeholder: "https://southwind.ciamlogin.com/southwind.onmicrosoft.com" }} />
            </div>}

            {ctx.value.type === AzureADType.B2C && <div>
                <TextBoxLine ctx={ctx.subCtx(n => n.tenantName)} mandatory />
                <TextBoxLine ctx={ctx.subCtx(n => n.signInSignUp_UserFlow)}
                    mandatory={ctx.value.signIn_UserFlow ? undefined : "warning"} onChange={forceUpdate} />
                <TextBoxLine ctx={ctx.subCtx(n => n.signIn_UserFlow)}
                    mandatory={ctx.value.signInSignUp_UserFlow ? undefined : "warning"} onChange={forceUpdate} />
                <TextBoxLine ctx={ctx.subCtx(n => n.signUp_UserFlow)} />
                <TextBoxLine ctx={ctx.subCtx(n => n.editProfile_UserFlow)} />
                <TextBoxLine ctx={ctx.subCtx(n => n.resetPassword_UserFlow)} />
            </div>}

            <AutoLine ctx={ctx.subCtx(n => n.clientSecret)}
                helpText="Required for Microsoft Graph, not for Azure Log-in" />

            <div className="row my-2">
                <div className="col-sm-6">
                    <CheckboxLine ctx={ctx.subCtx(n => n.allowMatchUsersBySimpleUserName)} inlineCheckbox="block" />
                </div>
                <div className="col-sm-6">
                    <CheckboxLine ctx={ctx.subCtx(n => n.useDelegatedPermission)} inlineCheckbox="block"
                        helpText="Request the current user's groups from Azure with their own access token" />
                </div>
            </div>

            <div className="row my-2">
                <div className="col-sm-6">
                    <CheckboxLine ctx={ctx.subCtx(n => n.autoUpdateUsers)} inlineCheckbox="block" onChange={forceUpdate} />
                </div>
                <div className="col-sm-6">
                    <CheckboxLine ctx={ctx.subCtx(n => n.autoCreateUsers)} inlineCheckbox="block" onChange={forceUpdate} />
                </div>
            </div>

            {(ctx.value.autoCreateUsers || ctx.value.autoUpdateUsers) && <div>
                <div className="row">
                    <div className="col-sm-10 offset-sm-2">
                        <EntityTable ctx={ctx.subCtx(n => n.roleMapping)} avoidFieldSet="h3" />
                    </div>
                </div>
                <EntityLine ctx={ctx.subCtx(n => n.defaultRole)} />
            </div>}
        </div>
    );
}
