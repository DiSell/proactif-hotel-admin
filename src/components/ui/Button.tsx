import { type AnchorHTMLAttributes, type ButtonHTMLAttributes, forwardRef } from "react";
import Link from "next/link";
import clsx from "clsx";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg"; // 36 / 40 / 44px

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium text-xs whitespace-nowrap transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30";

const variants: Record<Variant, string> = {
  primary: "bg-ink text-canvas hover:brightness-110",
  secondary: "bg-surface text-ink border border-border hover:border-border-hover",
  ghost: "bg-transparent text-body hover:text-ink",
  danger: "bg-transparent text-danger hover:opacity-75",
};

const sizes: Record<Size, string> = {
  sm: "h-9 px-3.5",
  md: "h-10 px-4",
  lg: "h-11 px-5",
};

interface CommonProps {
  variant?: Variant;
  size?: Size;
  className?: string;
}

type ButtonAsButton = CommonProps &
  ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined };

type ButtonAsLink = CommonProps &
  AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

type ButtonProps = ButtonAsButton | ButtonAsLink;

export const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, ...props },
  ref
) {
  const classes = clsx(base, variants[variant], sizes[size], className);

  if ("href" in props && props.href !== undefined) {
    const { href, ...anchorProps } = props;
    return <Link ref={ref as never} href={href} className={classes} {...anchorProps} />;
  }

  return <button ref={ref as never} className={classes} {...(props as ButtonAsButton)} />;
});
