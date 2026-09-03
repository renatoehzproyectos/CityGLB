import * as SwitchPrimitives from "@radix-ui/react-switch";
import * as React from "react";
import { cn } from "@/lib/utils";

const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-border transition-colors duration-150",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
      "disabled:cursor-not-allowed disabled:opacity-40",
      "data-[state=checked]:bg-accent data-[state=unchecked]:bg-surface-2",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block size-4 rounded-full bg-fg shadow-sm ring-0 transition-transform duration-150",
        "data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-0.5",
        "data-[state=checked]:bg-accent-fg",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
