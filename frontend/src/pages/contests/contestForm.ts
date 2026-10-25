import { ApiError } from "../../api/client";
import type { ContestFormat } from "../../api/types";

export const FORMATS: ContestFormat[] = ["CODEFORCES", "ICPC", "ATCODER", "IOI"];
export const DURATIONS = [60, 90, 120, 150, 180, 240, 300];

/** `2026-01-02T18:00` in local time, as a datetime-local input wants it. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function defaultStart(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(18, 0, 0, 0);
  return d.toISOString();
}

export function message(e: unknown) {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}
