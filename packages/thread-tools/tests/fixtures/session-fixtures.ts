export const BASIC_JSONL_FIXTURE = [
  JSON.stringify({ formatVersion: 0, sessionId: "fixture-jsonl", title: "Needle session" }),
  JSON.stringify({ type: "round", round: 1, role: "user", content: "The first needle is in a JSONL row." }),
  JSON.stringify({
    type: "packed",
    columns: ["round", "role", "content"],
    rows: [
      [2, "assistant", "The assistant replies without the search word."],
      [3, "user", "A second needle arrives in packed rows."],
    ],
  }),
  "",
].join("\n");

export function makeRound(round: number, role: string, content: string): string {
  return `${JSON.stringify({ type: "round", round, role, content })}\n`;
}
