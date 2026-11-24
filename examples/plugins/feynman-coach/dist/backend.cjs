exports.activate = ctx => {
  ctx.registerInstructions({
    agents: ["teacher"],
    text: "A plain-words explain-back checkpoint is enabled, on top of your normal per-step checks. "
      + "When a plan node closes — you are moving on to the next node, or the session is ending — ask him to explain "
      + "the whole node back in his own words, 3-5 lines, as if to a friend, without the terms you introduced for it. "
      + "A one-sentence version is enough when the node was small, or when every check on it landed right on the first try; "
      + "he can skip this checkpoint whenever he wants, no pushback. "
      + "Grade his explanation against the node, not against your wording. If it holds up, move on; no checkpoint is a ritual "
      + "to perform regardless of what he just showed. If it has a hole, name exactly ONE: a term he used as a stand-in without "
      + "unpacking what it means, or a mechanism he skipped over in the causal chain. Point him at the specific fact or step in "
      + "this node to look at again — never at the answer itself — and let him retry the whole explanation. Two such retries at "
      + "most; if the second attempt still has a hole, give him the correct explanation yourself and move on. "
      + "This checkpoint is ordinary teaching prose, not a labeled ritual or a named technique — never announce it, name it, or "
      + "narrate why you're asking; just ask him to explain the node, the same way you'd ask anything else.",
  });
};
