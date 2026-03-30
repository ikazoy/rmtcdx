import {
  autoUpdate,
  flip,
  offset,
  size,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions
} from "@floating-ui/react";
import type { Placement } from "@floating-ui/react";

type UseAnchoredMenuOptions = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placement?: Placement;
  gutter?: number;
  viewportPadding?: number;
};

export function useAnchoredMenu({
  open,
  onOpenChange,
  placement = "bottom-end",
  gutter = 9,
  viewportPadding = 16
}: UseAnchoredMenuOptions) {
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange,
    placement,
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(gutter),
      flip({
        padding: viewportPadding
      }),
      size({
        padding: viewportPadding,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(0, Math.floor(availableHeight))}px`;
        }
      }),
      shift({
        padding: viewportPadding,
        crossAxis: true
      })
    ]
  });

  const click = useClick(context);
  const dismiss = useDismiss(context, {
    outsidePressEvent: "pointerdown"
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss]);

  return {
    refs,
    floatingStyles,
    getReferenceProps,
    getFloatingProps
  };
}
