// STUB (SearchControl port). Signum's MessageModal is the generic alert/confirm dialog. altea hasn't
// ported it yet; SearchModal uses it once (the "return the newly-created entity?" prompt). The stub
// resolves `undefined` (no button clicked) so callers take their default/else branch. TODO(port): the
// full MessageModal (buttons yes/no/ok/cancel, icons, styles) once the modal chrome layer lands.
import * as React from 'react';

export type MessageModalButtons = "ok" | "cancel" | "ok_cancel" | "yes_no" | "yes_no_cancel";
export type MessageModalResult = "ok" | "cancel" | "yes" | "no";

export interface MessageModalOptions {
  title: React.ReactNode;
  message: React.ReactNode;
  buttons?: MessageModalButtons;
  style?: string;
  customIcon?: unknown;
  [key: string]: unknown;
}

const MessageModal = {
  show(_options: MessageModalOptions): Promise<MessageModalResult | undefined> {
    return Promise.resolve(undefined);
  },
};

export default MessageModal;
