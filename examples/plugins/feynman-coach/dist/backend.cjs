const CONFIDENCE_STOPS = [0, 30, 50, 70, 90, 100];

const QUESTION_TYPE_ID = "feynman-explain";

exports.QUESTION_TYPE_ID = QUESTION_TYPE_ID;
exports.CONFIDENCE_STOPS = CONFIDENCE_STOPS;

exports.questionDefinition = {
  id: QUESTION_TYPE_ID,
  label: "Feynman explain-back",
  contractVersion: 1,
  showThinking: false,
  questionSchema: {
    type: "object",
    properties: { mode: { type: "string", enum: ["short", "full"] } },
    required: ["mode"],
    additionalProperties: false,
  },
  answerSchema: {
    anyOf: [
      {
        type: "object",
        properties: {
          explanation: { type: "string", minLength: 1, maxLength: 2000 },
          confidence: { type: "number", enum: CONFIDENCE_STOPS },
        },
        required: ["explanation", "confidence"],
        additionalProperties: false,
      },
      {
        // The "I don't know" path: a genuine decline, not an explanation that
        // happens to be short. Its own branch, not a loosened minLength on the
        // one above, so a decline can never silently carry a stale explanation
        // or confidence through re-validation.
        type: "object",
        properties: { dontKnow: { type: "boolean", enum: [true] } },
        required: ["dontKnow"],
        additionalProperties: false,
      },
    ],
  },
  teach: {
    toolName: "feynman_explain",
    description: "Pose the Feynman-style explain-back checkpoint for the plan node that just closed. "
      + "`payload.mode` is \"full\" for the normal 3-5 line explain-back or \"short\" for the one-sentence version. "
      + "The learner answers in plain words, without the terms you introduced for this node, and picks a confidence "
      + "(0, 30, 50, 70, 90 or 100 — 50 is a genuine coin flip) — or says he doesn't know. Re-pose the same tool, same "
      + "mode, for a retry round.",
  },
  validateAnswer(context) {
    const answer = context.answer;
    if (answer && answer.dontKnow === true) return undefined;
    const explanation = answer && answer.explanation;
    if (typeof explanation !== "string" || !explanation.trim()) return ["explanation must contain nonwhitespace text"];
    return undefined;
  },
};

exports.activate = ctx => {
  const unregisterQuestion = ctx.registerQuestionType(exports.questionDefinition);
  const unregisterInstructions = ctx.registerInstructions({
    agents: ["teacher"],
    text: "A dedicated Feynman explain-back box is enabled, on top of your normal per-step `quiz`/`explain` checks. "
      + "A node closes when you move on to a different node, or the session is ending — at EVERY close, ask in ordinary "
      + "prose whether he wants to explain the whole node back in his own words, or skip it; only if he wants to, call "
      + "`feynman_explain` for that node with `payload.mode: \"full\"`. A close is tentative, not a verdict: nodes are never "
      + "marked finished, so if you come back to a node you'd already closed — a detour, a rewritten plan, a correction — "
      + "its earlier close no longer counts; treat the next move-on from it as a fresh close and offer again. Use "
      + "`payload.mode: \"short\"` instead when the node was small, or when every check on it landed right on the first "
      + "try — a one-sentence explain-back is enough then. "
      + "The box's own question text is whatever you write for `question`: ask him to explain it as if to a friend, 3-5 lines "
      + "(or one sentence in short mode), without the terms you introduced, and to pick how sure he is — or say he doesn't "
      + "know it. "
      + "If the saved answer has `dontKnow: true`, that's a genuine gap, never a wrong answer and never a retry occasion: "
      + "skip straight to giving him the correct explanation yourself in prose, then move on — don't spend one of the two "
      + "retries on a decline. "
      + "Otherwise, grade the saved `explanation` strictly against the node, not against your wording — exactly like any "
      + "other free-recall answer: never mark it right to be kind, a near-miss is partial understanding. Read `confidence` "
      + "alongside the verdict (50 is a coin flip, 90-100 claims certainty, 0-30 claims real doubt): a CONFIDENT explanation "
      + "with a gap is exactly the case that must not be waved through as a small tightening — high confidence raises your "
      + "scrutiny, it never lowers it. Only an explanation that genuinely holds up lets you move on; no checkpoint is a "
      + "ritual to perform regardless of what he just showed. If it has a hole — however small, however confidently stated — "
      + "name exactly ONE in prose: a term he used as a stand-in without unpacking what it means, or a mechanism he skipped "
      + "over in the causal chain. Point him at the specific fact or step in this node to look at again — never at the "
      + "answer itself — then re-pose `feynman_explain` for the same node and mode so he can retry the whole explanation. "
      + "Two such retries at most; if the second attempt still has a hole, give him the correct explanation yourself in "
      + "prose and move on. "
      + "This checkpoint is an ordinary part of teaching, not a labeled ritual or a named technique — never announce it, name "
      + "it, or narrate why you're asking in your own words; the box itself is just where he types the answer.",
  });
  return () => { unregisterInstructions(); unregisterQuestion(); };
};
