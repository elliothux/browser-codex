import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-none border border-[var(--mesh-line)] bg-clip-padding font-mono font-bold whitespace-nowrap transition-[color,border-color,background-color] duration-180 outline-none select-none [transition-timing-function:var(--mesh-ease-out)] focus-visible:border-[var(--mesh-focus)] focus-visible:ring-3 focus-visible:ring-[var(--mesh-focus)]/40 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        danger:
          "border-destructive bg-destructive [color:white] hover:bg-destructive/80 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        default:
          "bg-black/58 [color:var(--mesh-white)] hover:border-[var(--mesh-line-strong)] hover:bg-white/[0.08]",
        ghost:
          "border-transparent bg-transparent [color:var(--mesh-muted)] hover:border-transparent hover:bg-white/[0.08] hover:[color:var(--mesh-white)]",
        white:
          "bg-[var(--mesh-white)] [color:var(--mesh-black)] hover:bg-[oklch(82%_0_0)]",
      },
      size: {
        default:
          "min-h-10 gap-2 px-3 text-sm has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3 [&_svg:not([class*='size-'])]:size-3.5",
        icon: "size-10",
        "icon-sm": "size-8",
        lg: "min-h-12 gap-2.5 px-[18px] text-[0.94rem] has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        sm: "min-h-10 gap-2 px-3 text-sm has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "min-h-8 gap-1.5 px-2.5 text-xs has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

type ButtonVariants = VariantProps<typeof buttonVariants>;

export { Button, buttonVariants, type ButtonVariants };
