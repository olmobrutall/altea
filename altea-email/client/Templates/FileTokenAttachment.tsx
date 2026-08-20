import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import { ValidationMessage } from "@altea/altea/data/validators";
import QueryTokenEmbeddedBuilder from "@altea/altea-user-assets/client/Templates/QueryTokenEmbeddedBuilder";
import { EmailTemplateEntity, type FileTokenAttachmentEntity } from "../../data/EmailTemplate";

// Port of Signum.Mailing's Templates/FileTokenAttachment.tsx — attach whatever FILE the rendered rows'
// token points at.
//
// altea divergence: Signum reached the owning template with `ctx.findParent(EmailTemplateEntity)`; altea's
// TypeContext exposes the same walk, and the query is read off it to seed the token builder.
export default function FileTokenAttachment(p: { ctx: TypeContext<FileTokenAttachmentEntity> }): React.JSX.Element {
    const sc = p.ctx.subCtx({ formGroupStyle: "Basic" });
    const template = p.ctx.findParent(EmailTemplateEntity);

    return (
        <div className="row">
            <div className="col-sm-6">
                <AutoLine ctx={sc.subCtx(c => c.type)} />
                <AutoLine ctx={sc.subCtx(c => c.contentId)} />
            </div>
            <div className="col-sm-6">
                {template?.query == null
                    ? <p className="text-danger">{ValidationMessage._0IsNotSet.niceToString(nicePropertyNameOf("query"))}</p>
                    : <QueryTokenEmbeddedBuilder
                        ctx={sc.subCtx(a => a.fileToken)}
                        queryKey={template.query.key}
                        subTokenOptions={SubTokensOptions.CanElement}
                        helpText="An expression pointing at a file" />}
                <AutoLine ctx={sc.subCtx(c => c.fileName)} />
            </div>
        </div>
    );
}

/** The localized label of an EmailTemplate property (altea has no `nicePropertyName` static: the label comes
 *  from the reflection registry's member descriptions, with the de-camelCased name as the fallback). */
function nicePropertyNameOf(member: "query" | "from"): string {
    return EmailTemplateEntity.nicePropertyName(member);
}
