"use client";

import { useEffect, useRef, useState } from "react";
import { Collapsible } from "@cloudflare/kumo";
import { CaretDownIcon } from "@phosphor-icons/react";

/**
 * A closed drawer (Kevin 2026-11-18: « concision / clarté… la data en tiroir »): one clear title on screen, its text,
 * table or chart one click away. A page or panel shows its conclusion first; everything else sits in drawers.
 * The content stays mounted while closed, so the browser's find-in-page and the tests still read it.
 */
export function Drawer({
  title,
  icon,
  defaultOpen = false,
  id,
  openOn = [],
  children,
}: {
  title: React.ReactNode;
  /** One icon per kind of drawer, so a reader finds it at a glance (Kevin 2026-11-18). */
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  /** An anchor: a link to `#<id>` opens this drawer and scrolls to it. */
  id?: string;
  /** Other anchors that open it too (a section opens when a link points at a drawer inside it). */
  openOn?: readonly string[];
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLDivElement>(null);
  const anchors = openOn.join(" ");
  useEffect(() => {
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (!hash || (hash !== id && !anchors.split(" ").includes(hash))) return;
    setOpen(true);
    if (hash === id)
      requestAnimationFrame(() =>
        ref.current?.scrollIntoView({ block: "start" }),
      );
  }, [id, anchors]);
  return (
    <div ref={ref} id={id} className="scroll-mt-20">
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger className="m-0 flex w-full items-start justify-between gap-4 border-none bg-transparent px-0 py-3.5 text-left text-base font-medium text-kumo-strong shadow-none transition-colors hover:text-kumo-link">
          <span className="flex min-w-0 items-start gap-3">
            {icon && (
              <span className="mt-1 shrink-0 text-kumo-subtle">{icon}</span>
            )}
            <span className="min-w-0">{title}</span>
          </span>
          <CaretDownIcon
            aria-hidden
            size={14}
            weight="bold"
            className="mt-1 shrink-0 text-kumo-subtle transition-transform duration-100 ease-out [[data-panel-open]_&]:rotate-180"
          />
        </Collapsible.Trigger>
        <Collapsible.Panel keepMounted className="[&[hidden]]:hidden">
          <div className="flex flex-col gap-4 pb-6">{children}</div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  );
}

/** A stack of drawers, a hairline between each. */
export function Drawers({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-kumo-hairline border-y border-kumo-hairline">
      {children}
    </div>
  );
}
