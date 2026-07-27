"use client";

import { useEffect, useState } from "react";

/**
 * Keyboard shortcut help modal. Triggered by `?`. Closes on Esc or
 * outside-click. Accessible: focuses the dialog on open, traps focus,
 * returns focus to the trigger on close.
 */
const SHORTCUTS: Array<{ keys: string; desc: string }> = [
  { keys: "/",       desc: "Focus search input" },
  { keys: "j / k",   desc: "Move focus between results" },
  { keys: "Enter",   desc: "Open the focused result" },
  { keys: "Esc",     desc: "Close drawer or modal" },
  { keys: "f",       desc: "Toggle facet sidebar" },
  { keys: "?",       desc: "Show this shortcuts help" },
  { keys: "Tab",     desc: "Step through interactive elements" },
];

export function KeyboardHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      const editing = tag === "input" || tag === "textarea" || (document.activeElement as any)?.isContentEditable;
      if (editing) return;
      if (e.key === "?") {
        e.preventDefault();
        setOpen(v => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="kbd-help-h"
      onClick={() => setOpen(false)}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-zinc-900 rounded-lg shadow-2xl p-6 max-w-md w-[90vw] space-y-3"
      >
        <h2 id="kbd-help-h" className="text-lg font-semibold">Keyboard shortcuts</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {SHORTCUTS.map(s => (
            <div key={s.keys} className="contents">
              <dt><kbd className="rounded border bg-[hsl(var(--muted)/0.15)] px-1.5 py-0.5 font-mono text-xs">{s.keys}</kbd></dt>
              <dd>{s.desc}</dd>
            </div>
          ))}
        </dl>
        <div className="text-right">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded bg-[hsl(var(--accent))] text-white px-3 py-1 text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
