import * as React from 'react'
import { TypeContext } from '../TypeContext'
import { ExceptionEntity } from '../../data/exception'
import { BigStringEmbedded } from '../../data/bigString'
import { AutoLine } from '../Lines/AutoLine'
import { TextAreaLine } from '../Lines/TextAreaLine'
import type { ClientBuilder } from '../ClientBuilder'

// Ported from Signum.React/Exceptions/ExceptionClient.tsx — copy-and-fix. Registers the ExceptionEntity
// view + a global read-only editor for BigStringEmbedded.
//
// altea divergences:
//   - Signum's `start({ routes })` is called by the APP (MainAdmin); altea calls this from the framework
//     client init (ClientBuilder.startFramework) instead — the framework's own ErrorModal links to
//     `/view/exception/<id>`, so the exception view must ALWAYS be registered, not opt-in per app. It
//     pushes no routes (the view is reached through the standard /view/:type/:id FramePage route); it
//     takes the ClientBuilder only to register the search page's default columns.
//   - Importing this module also registers ExceptionEntity's client TypeInfo (the transformer-emitted
//     registerType runs on import) — without it, `/view/exception/..` threw "No TypeInfo for 'exception'".
export namespace ExceptionClient {

  export function start(cb: ClientBuilder): void {
    cb.configure(ExceptionEntity)
      .withView(() => import('./Exception'), { allowWrapEntityLink: true })
      .withQuerySettings(token => ({
        defaultColumns: [
          token(e => e.id),
          token(e => e.creationDate),
          token(e => e.origin),
          token(e => e.user),
          token(e => e.exceptionType),
          token(e => e.exceptionMessage),
          token(e => e.stackTraceHash),
        ],
      }));

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
