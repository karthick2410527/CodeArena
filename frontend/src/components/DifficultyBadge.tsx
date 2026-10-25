import type { Difficulty } from "../api/types";

const STYLES: Record<Difficulty, string> = {
  EASY: "bg-good/15 text-good ring-good/30",
  MEDIUM: "bg-warn/15 text-warn ring-warn/30",
  HARD: "bg-bad/15 text-bad ring-bad/30",
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
