import type { Difficulty } from "../api/types";

const STYLES: Record<Difficulty, string> = {
  EASY: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  MEDIUM: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  HARD: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
};

const LABELS: Record<Difficulty, string> = { EASY: "Easy", MEDIUM: "Medium", HARD: "Hard" };

export default function DifficultyBadge({ difficulty }: { difficulty: Difficulty }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${STYLES[difficulty]}`}
    >
      {LABELS[difficulty]}
    </span>
  );
}
