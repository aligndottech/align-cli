/**
 * One instruction both engines carry. The model asked align_ask three times for one question and
 * then went to grep and git log to re-derive what the first answer already said. align_ask
 * searches every connected source and returns the supersession chain, so a second call with new
 * wording finds the same decisions and costs the person the wait.
 */
export const ASK_ONCE_GUIDANCE =
  'Ask the decision graph once per question. If align_ask returns decisions, read any later_on_topic and successor on them. If a later entry could change the answer and its details are missing, read that decision with an available tool before answering; if the details remain unavailable, say so. Answer from the decisions, then carry on with whatever else the person asked for, such as an edit. Do not repeat align_ask with new wording, and do not read the code or git history to re-derive what it said unless you are about to change behaviour.';
