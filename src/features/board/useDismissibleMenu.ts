import { useEffect, useRef } from "react";

export function useDismissibleMenu<T extends HTMLElement>(
  open: boolean,
  setOpen: (open: boolean) => void,
) {
  const containerRef = useRef<T>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    // Capture also handles timeline controls that stop pointer event bubbling.
    // The container includes both the trigger and the menu to preserve toggling.
    document.addEventListener("pointerdown", dismissOutside, true);
    return () => document.removeEventListener("pointerdown", dismissOutside, true);
  }, [open, setOpen]);

  return containerRef;
}
