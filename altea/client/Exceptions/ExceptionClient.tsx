import * as React from 'react'
import { Navigator } from '../Navigator'
import { EntitySettings } from '../EntitySettings'
import type { BaseEntity } from '../../data/entity'
import { TypeContext } from '../TypeContext'
import { ExceptionEntity } from '../../data/exception'
import { BigStringEmbedded } from '../../data/bigString'
import { AutoLine } from '../Lines/AutoLine'
import { TextAreaLine } from '../Lines/TextAreaLine'

// Ported from Signum.React/Exceptions/ExceptionClient.tsx — copy-and-fix. Registers the ExceptionEntity
// view + a global read-only editor for BigStringEmbedded.
//
// altea divergences:
//   - Signum's `start({ routes })` is called by the APP (MainAdmin); altea calls this from the framework
//     client init (ClientBuilder.startFramework) instead — the framework's own ErrorModal links to
//     `/view/exception/<id>`, so the exception view must ALWAYS be registered, not opt-in per app. It
//     pushes no routes (the view is reached through the standard /view/:type/:id FramePage route), so it
//     takes no args.
//   - Importing this module also registers ExceptionEntity's client TypeInfo (the transformer-emitted
//     registerType runs on import) — without it, `/view/exception/..` threw "No TypeInfo for 'exception'".
export namespace ExceptionClient {

  export function start(): void {
    // EntitySettings is invariant on its entity type, so EntitySettings<ExceptionEntity> isn't
    // structurally assignable to the registry's EntitySettings<BaseEntity> — same cast ClientBuilder.withView uses.
    Navigator.addSettings(new EntitySettings(ExceptionEntity, () => import('./Exception'), { allowWrapEntityLink: true }) as unknown as EntitySettings<BaseEntity>);

    // Signum registers a global read-only TextAreaLine editor for BigStringEmbedded (bound to `.text`),
    // so any AutoLine over a BigStringEmbedded field renders sensibly. Signum's `tr.isCollection` → `fi.array`.
    AutoLine.registerComponent(BigStringEmbedded.typeName, (fi) => {
      if (fi.array)
        return undefined;

      return (p) => {
        const { ctx, ...rest } = p;
        return <TextAreaLine ctx={(ctx as TypeContext<BigStringEmbedded>).subCtx(a => a.text)} {...rest as any} readOnly />;
      };
    });
  }
}
