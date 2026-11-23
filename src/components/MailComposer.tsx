import { forwardRef, useImperativeHandle, useRef } from "react";

/**
 * A mail composer: formatted text with a small toolbar, like a mail client's.
 * Bold, italic, underline, lists, links and quotes; ⌘B / ⌘I / ⌘U work as usual and
 * ⌘↵ submits. The page reads it back as HTML (for the reply) or plain text (for an
 * internal comment, which Front stores as text).
 */
export type ComposerHandle = { html: () => string; text: () => string; clear: () => void; focus: () => void; isEmpty: () => boolean; setText: (text: string) => void };

const TOOLS: { cmd: string; label: string; title: string; arg?: () => string | null }[] = [
  { cmd: "bold", label: "B", title: "Bold (⌘B)" },
  { cmd: "italic", label: "I", title: "Italic (⌘I)" },
  { cmd: "underline", label: "U", title: "Underline (⌘U)" },
  { cmd: "insertUnorderedList", label: "• List", title: "Bulleted list" },
  { cmd: "insertOrderedList", label: "1. List", title: "Numbered list" },
  { cmd: "createLink", label: "Link", title: "Link the selected text", arg: () => window.prompt("Link to (https://…)") },
  { cmd: "formatBlock", label: "❝ Quote", title: "Quote", arg: () => "blockquote" },
  { cmd: "removeFormat", label: "Clear", title: "Clear formatting" },
];

export const MailComposer = forwardRef<ComposerHandle, { placeholder: string; disabled?: boolean; plain?: boolean; onSubmit: () => void; onChange?: (empty: boolean) => void }>(
  function MailComposer({ placeholder, disabled, plain, onSubmit, onChange }, ref) {
    const el = useRef<HTMLDivElement>(null);
    const isEmpty = () => !(el.current?.innerText ?? "").trim();
    useImperativeHandle(ref, () => ({
      html: () => el.current?.innerHTML ?? "",
      text: () => (el.current?.innerText ?? "").trim(),
      clear: () => {
        if (el.current) el.current.innerHTML = "";
        onChange?.(true);
      },
      focus: () => el.current?.focus(),
      isEmpty,
      /** Fill with plain text (a draft from Claude): paragraphs become <p>, single newlines <br>. */
      setText: (text: string) => {
        if (!el.current) return;
        const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        el.current.innerHTML = text
          .trim()
          .split(/\n{2,}/)
          .map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`)
          .join("");
        onChange?.(isEmpty());
        el.current.focus();
      },
    }));
    const exec = (cmd: string, arg?: () => string | null) => {
      el.current?.focus();
      const value = arg ? arg() : undefined;
      if (arg && !value) return;
      document.execCommand(cmd, false, value ?? undefined);
      onChange?.(isEmpty());
    };
    return (
      <div className={`mc ${disabled ? "disabled" : ""}`}>
        {!plain && (
          <div className="mc-tools" role="toolbar" aria-label="Formatting">
            {TOOLS.map((t) => (
              <button key={t.cmd} type="button" className={`mc-tool mc-${t.cmd}`} title={t.title} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => exec(t.cmd, t.arg)}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        <div
          ref={el}
          className="mc-body"
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          data-placeholder={placeholder}
          onInput={() => onChange?.(isEmpty())}
          onPaste={(e) => {
            if (!plain) return;
            e.preventDefault();
            document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      </div>
    );
  },
);
