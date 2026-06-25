"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "./ThemeToggle";

const LINKS = [
  { href: "/", label: "Inspector" },
  { href: "/scenes", label: "Scene Library" },
];

export default function NavBar() {
  const pathname = usePathname();
  return (
    <nav
      className="flex items-center gap-1 border-b border-slate-800 px-6 py-2.5 backdrop-blur"
      style={{ background: "var(--nav-bg)" }}
    >
      <span className="mr-4 text-sm font-semibold text-sky-400">Run_v2</span>
      {LINKS.map((l) => {
        const active = pathname === l.href;
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`rounded-md px-3 py-1.5 text-sm transition ${
              active
                ? "bg-slate-800 text-slate-100"
                : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
            }`}
          >
            {l.label}
          </Link>
        );
      })}
      <ThemeToggle />
    </nav>
  );
}
