import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

export function ImagePreview({
  src,
  alt,
  imageClassName,
  buttonClassName = "",
  loading,
  onError,
}: {
  src: string;
  alt: string;
  imageClassName: string;
  buttonClassName?: string;
  loading?: "eager" | "lazy";
  onError?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const dialogTitleId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  return (
    <>
      <button
        aria-label={`放大${alt}`}
        className={`block overflow-hidden ${buttonClassName}`}
        onClick={() => setOpen(true)}
        type="button"
      >
        <img alt={alt} className={imageClassName} loading={loading} onError={onError} src={src} />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <button
              aria-labelledby={dialogTitleId}
              aria-modal="true"
              className="fixed inset-0 z-[100] grid h-full w-full cursor-zoom-out place-items-center bg-black/80 p-4"
              onClick={() => setOpen(false)}
              role="dialog"
              type="button"
            >
              <span className="sr-only" id={dialogTitleId}>{alt}</span>
              <img alt={alt} className="max-h-full max-w-full object-contain" src={src} />
            </button>,
            document.body,
          )
        : null}
    </>
  );
}
