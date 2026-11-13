// Writing into an input through React's own path, as typing would.

/** Sets `value` on `input` as typing would: the realm's native setter keeps React's value tracker in step, and the bubbling input event reaches whatever the input binds. */
export function setInputValue(input: HTMLInputElement, value: string): void {
  const win = input.ownerDocument.defaultView;
  if (!win) return;
  const setter = Object.getOwnPropertyDescriptor(
    win.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
}
