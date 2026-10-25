import { adminApi, studioApi, type ProblemAuthoringApi } from "../../api/endpoints";

/**
 * The problem editor serves two audiences with the same screens: admins
 * (/admin/problems, every problem) and any author (/studio/problems, their
 * own problems and their contests'). The API enforces the difference.
 */
export type AuthoringScope = "admin" | "studio";

export function authoring(scope: AuthoringScope): { api: ProblemAuthoringApi; base: string } {
  return scope === "studio"
    ? { api: studioApi, base: "/studio/problems" }
    : { api: adminApi, base: "/admin/problems" };
}
