import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-md border border-border bg-surface-2 px-3 text-sm text-fg shadow-none transition-colors duration-150",
          "placeholder:text-subtle file:border-0 file:bg-transparent file:text-sm file:font-medium",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
          "disabled:cursor-not-allowed disabled:opacity-40",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
