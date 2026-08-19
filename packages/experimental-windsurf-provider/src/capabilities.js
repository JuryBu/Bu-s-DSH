const imageAttachmentModelPatterns = [
  /^claude-(?:3|4|opus|sonnet|haiku|fable)-/iu,
  /^MODEL_CLAUDE_/u,
  /^gpt-(?:4|5)(?:-|$)/iu,
  /^MODEL_CHAT_GPT/u,
  /^o[34](?:-|$)/iu,
  /^MODEL_CHAT_O[34]/u,
  /^gemini-/iu,
  /^MODEL_GOOGLE_GEMINI_/u,
  /^kimi-k2-(?:5|6|7)(?:-|$)/iu,
  /^swe-1(?:-|$)/iu
];

export function isWindsurfImageAttachmentModel(modelUid) {
  return typeof modelUid === "string"
    && imageAttachmentModelPatterns.some(pattern => pattern.test(modelUid));
}
