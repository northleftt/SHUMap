import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useBreakpoint } from "../../lib/hooks/useBreakpoint";
import { SheetModal } from "../ui/SheetModal";

/** Native desktop dialog traps focus and restores it to the rating entry on close. */
export function FeedbackDialog({ open, onClose, title, height, children }: {
  open: boolean; onClose: () => void; title: string; height: number; children: ReactNode;
}) {
  const mobile = useBreakpoint() === "mobile";
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (mobile || !element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
    return () => { if (element.open) element.close(); };
  }, [open, mobile]);
  if (mobile) return <SheetModal open={open} onClose={onClose} initialHeight={height}>{children}</SheetModal>;
  return createPortal(
    <dialog ref={dialog} aria-label={title}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-3rem)] w-[480px] max-w-[calc(100vw-3rem)] overflow-y-auto rounded-3xl border-0 bg-surface p-0 text-ink shadow-floating backdrop:bg-ink/40"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose(); } }}>
      <div className="flex justify-end px-4 pt-4"><button type="button" aria-label="关闭评价" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-full bg-page text-sub hover:bg-line"><X size={16} /></button></div>
      {children}
    </dialog>, document.body,
  );
}
