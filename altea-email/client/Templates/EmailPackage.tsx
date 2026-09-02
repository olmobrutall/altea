import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { EmailMessageEntity } from "../../data/EmailMessage";
import { EmailMessagePackageMixin, type EmailPackageEntity } from "../../data/EmailPackage";

// Port of Signum.Mailing/Package/EmailPackage.tsx — the package plus the messages it holds. The membership
// lives on the MESSAGE (through the mixin), so this is a filtered search rather than a nested list, which
// is also what keeps a package of 100k messages openable.
export default function EmailPackage(p: { ctx: TypeContext<EmailPackageEntity> }): React.JSX.Element {
    return (
        <div>
            <AutoLine ctx={p.ctx.subCtx(a => a.name)} readOnly={true} />
            <fieldset>
                <legend>{EmailMessageEntity.nicePluralName()}</legend>
                <SearchControl findOptions={EmailMessageEntity.findOptions(token => ({
                    filterOptions: [{ token: token(a => a.mixin(EmailMessagePackageMixin).package), value: p.ctx.value }],
                }))} />
            </fieldset>
        </div>
    );
}
