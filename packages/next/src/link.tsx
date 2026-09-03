"use client";

import React, { AnchorHTMLAttributes, MouseEvent } from "react";
import { useRouter } from "./hooks.js";

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  prefetch?: "hover" | false;
  replace?: boolean;
  preserveScroll?: boolean;
}

export function resolveInternalDestination(
  href: string,
  currentUrl?: string
): string | null {
  if (href.startsWith("#")) return null;
  const base = currentUrl ?? (
    typeof window !== "undefined" ? window.location.href : undefined
  );
  if (!base) return href.startsWith("/") ? href : null;
  try {
    const destination = new URL(href, base);
    if (destination.origin !== new URL(base).origin) return null;
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return null;
  }
}

export function Link({
  href,
  prefetch = "hover",
  replace = false,
  preserveScroll = false,
  onClick,
  onMouseEnter,
  children,
  ...props
}: LinkProps) {
  const router = useRouter();

  const getInternalDestination = (): string | null => {
    return resolveInternalDestination(href);
  };

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (onClick) {
      onClick(e);
    }

    // Allow browser default for external links or modified clicks (ctrl/cmd/shift/middle click)
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      e.shiftKey ||
      props.download !== undefined ||
      (props.target !== undefined && props.target !== "_self")
    ) {
      return;
    }

    const destination = getInternalDestination();
    if (!destination) return;

    e.preventDefault();
    router.visit(destination, { replace, preserveScroll }).catch(err => {
      console.error("[fluxfast] Link navigation failed:", err);
    });
  };

  const handleMouseEnter = (e: MouseEvent<HTMLAnchorElement>) => {
    if (onMouseEnter) {
      onMouseEnter(e);
    }

    const destination = getInternalDestination();
    if (prefetch === "hover" && destination) {
      router.prefetch(destination).catch(err => {
        console.debug("[fluxfast] Prefetch failed:", err);
      });
    }
  };

  return (
    <a
      href={href}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      {...props}
    >
      {children}
    </a>
  );
}
