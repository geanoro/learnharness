// The look/behavior below is reimplemented, not imported: components/confidence-rail.tsx
// and the "Your answer" composer-twin field in components/question-dock.tsx are core-internal
// (not part of the public plugin SDK). But their classNames are ordinary Tailwind utility
// classes, already compiled into the app's global stylesheet because the host itself uses
// them verbatim in those files — so reusing the exact same strings here reproduces the exact
// same look without restyling from scratch or needing any plugin-exposed component.
const CONFIDENCE_STOPS = [0, 30, 50, 70, 90, 100];
const CONFIDENCE_COLORS = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e", "#10b981"];
const DEFAULT_CONFIDENCE_INDEX = 2;
const TICK_COLOR = "color-mix(in oklab, var(--foreground) 35%, transparent)";

const ANSWER_FIELD_WRAP = "rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50";
const ANSWER_FIELD_LABEL = "px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground";
const ANSWER_FIELD_INPUT = "field-sizing-content lh-input max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground";
const CONFIDENCE_ROW_PAD = "pt-1.5 pb-3.5";
const CONFIDENCE_ROW = "flex items-center gap-3";
const CONFIDENCE_LABEL = "shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground";
const CONFIDENCE_TRACK = "relative h-4 min-w-0 flex-1";
const CONFIDENCE_RAIL_OVERLAY = "pointer-events-none absolute top-1/2 left-2 right-2 h-1.5 -translate-y-1/2 rounded-full border border-border";
const CONFIDENCE_SLIDER = "absolute inset-0 h-4 w-full cursor-pointer appearance-none bg-transparent outline-none "
  + "[&::-webkit-slider-runnable-track]:h-4 [&::-webkit-slider-runnable-track]:bg-transparent "
  + "[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-current "
  + "[&::-moz-range-track]:h-4 [&::-moz-range-track]:bg-transparent "
  + "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-current";
const CONFIDENCE_VALUE = "w-[4ch] shrink-0 text-center font-mono text-sm tabular-nums";
const STATIC_RAIL = "h-1.5 w-full rounded-full border border-border min-w-0 flex-1";
const ANSWERED_ROW = "mt-3 flex items-center gap-3";
const ANSWERED_TEXT = "lh-prose mt-2 whitespace-pre-wrap";

function nearestStopIndex(value) {
  let best = 0;
  for (let i = 1; i < CONFIDENCE_STOPS.length; i++) if (Math.abs(CONFIDENCE_STOPS[i] - value) < Math.abs(CONFIDENCE_STOPS[best] - value)) best = i;
  return best;
}

/** Same paint as components/confidence-rail.tsx's confidenceRailStyle. */
function paintRail(element, value) {
  const color = CONFIDENCE_COLORS[CONFIDENCE_STOPS.indexOf(value)] ?? CONFIDENCE_COLORS[DEFAULT_CONFIDENCE_INDEX];
  element.style.backgroundColor = "var(--background)";
  element.style.backgroundImage = [
    `linear-gradient(90deg, ${color} 0%, ${color} ${value}%, transparent ${value}%, transparent 100%)`,
    ...[30, 50, 70, 90].map(() => `linear-gradient(90deg, ${TICK_COLOR}, ${TICK_COLOR})`),
  ].join(", ");
  element.style.backgroundSize = ["100% 100%", "1px 100%", "1px 100%", "1px 100%", "1px 100%"].join(", ");
  element.style.backgroundPosition = ["0 0", ...[30, 50, 70, 90].map(p => `${p}% 0`)].join(", ");
  element.style.backgroundRepeat = "no-repeat";
}

function readValue(answer) {
  if (answer && answer.status !== "empty" && answer.value && typeof answer.value === "object") return answer.value;
  return null;
}

export function activate(ctx) {
  ctx.registerQuestionRenderer({
    id: "feynman-explain",
    supportedContractVersions: [1],
    mountAnswerEditor(container, props) {
      const doc = container.ownerDocument;
      const initial = readValue(props.answer);
      let index = typeof initial?.confidence === "number" && CONFIDENCE_STOPS.includes(initial.confidence)
        ? CONFIDENCE_STOPS.indexOf(initial.confidence) : DEFAULT_CONFIDENCE_INDEX;

      const field = doc.createElement("div");
      field.setAttribute("data-testid", "answer-field");
      field.className = ANSWER_FIELD_WRAP;
      const label = doc.createElement("div");
      label.className = ANSWER_FIELD_LABEL;
      label.textContent = "Your answer";
      const textarea = doc.createElement("textarea");
      textarea.setAttribute("data-testid", "feynman-explanation-input");
      textarea.rows = 4;
      textarea.className = ANSWER_FIELD_INPUT;
      textarea.disabled = !props.active;
      textarea.value = typeof initial?.explanation === "string" ? initial.explanation : "";
      textarea.placeholder = props.input.payload && props.input.payload.mode === "short"
        ? "One sentence, in your own words, no terms the teacher used."
        : "3-5 lines, in your own words, as if to a friend — no terms the teacher used.";
      field.append(label, textarea);
      container.append(field);

      const confidenceRow = doc.createElement("div");
      confidenceRow.setAttribute("data-question-confidence", "");
      confidenceRow.className = CONFIDENCE_ROW_PAD;
      const inner = doc.createElement("div");
      inner.className = CONFIDENCE_ROW;
      const confidenceLabel = doc.createElement("span");
      confidenceLabel.className = CONFIDENCE_LABEL;
      confidenceLabel.textContent = "Confidence";
      const track = doc.createElement("div");
      track.className = CONFIDENCE_TRACK;
      track.setAttribute("data-testid", "confidence-track");
      const rail = doc.createElement("div");
      rail.setAttribute("aria-hidden", "true");
      rail.setAttribute("data-testid", "confidence-rail");
      rail.className = CONFIDENCE_RAIL_OVERLAY;
      const slider = doc.createElement("input");
      slider.type = "range";
      slider.min = "0"; slider.max = "100"; slider.step = "1";
      slider.disabled = !props.active;
      slider.setAttribute("aria-label", "Confidence — the probability your explanation holds up");
      slider.title = "How sure you are this explanation holds up — 50% is a coin flip.";
      slider.setAttribute("data-testid", "confidence-slider");
      slider.className = CONFIDENCE_SLIDER;
      const valueLabel = doc.createElement("span");
      valueLabel.setAttribute("data-testid", "confidence-value");
      valueLabel.className = CONFIDENCE_VALUE;
      const paint = () => {
        paintRail(rail, CONFIDENCE_STOPS[index]);
        slider.value = String(CONFIDENCE_STOPS[index]);
        slider.style.color = CONFIDENCE_COLORS[index];
        valueLabel.textContent = `${CONFIDENCE_STOPS[index]}%`;
      };
      track.append(rail, slider);
      inner.append(confidenceLabel, track, valueLabel);
      confidenceRow.append(inner);
      container.append(confidenceRow);
      paint();

      let disposed = false;
      const publish = () => {
        if (disposed) return;
        const explanation = textarea.value.trim();
        if (!explanation) { props.onChange({ status: "empty" }); return; }
        props.onChange({ status: "ready", value: { explanation: textarea.value, confidence: CONFIDENCE_STOPS[index] } });
      };
      const onSlide = () => { index = nearestStopIndex(Number(slider.value)); paint(); publish(); };
      textarea.addEventListener("input", publish);
      slider.addEventListener("input", onSlide);
      publish();

      return {
        update(next) {
          textarea.disabled = !next.active;
          slider.disabled = !next.active;
          const value = readValue(next.answer);
          if (value) {
            if (typeof value.explanation === "string" && value.explanation !== textarea.value) textarea.value = value.explanation;
            if (typeof value.confidence === "number" && CONFIDENCE_STOPS.includes(value.confidence) && CONFIDENCE_STOPS.indexOf(value.confidence) !== index) {
              index = CONFIDENCE_STOPS.indexOf(value.confidence);
              paint();
            }
          }
        },
        focus() { textarea.focus(); },
        appendTranscript(text) { textarea.value += text; publish(); },
        dispose() { disposed = true; textarea.removeEventListener("input", publish); slider.removeEventListener("input", onSlide); },
      };
    },
    mountAnswered(container, props) {
      const doc = container.ownerDocument;
      const answer = props.answer;
      const paragraph = doc.createElement("div");
      paragraph.setAttribute("data-testid", "feynman-explanation-answered");
      paragraph.className = ANSWERED_TEXT;
      const explanation = answer && typeof answer.explanation === "string" ? answer.explanation : "";
      paragraph.textContent = `“${explanation}”`;
      container.append(paragraph);

      const confidence = answer && typeof answer.confidence === "number" && CONFIDENCE_STOPS.includes(answer.confidence)
        ? answer.confidence : CONFIDENCE_STOPS[DEFAULT_CONFIDENCE_INDEX];
      const row = doc.createElement("div");
      row.className = ANSWERED_ROW;
      row.setAttribute("data-testid", "answered-confidence");
      const rail = doc.createElement("div");
      rail.className = STATIC_RAIL;
      paintRail(rail, confidence);
      const valueLabel = doc.createElement("span");
      valueLabel.className = `${CONFIDENCE_VALUE} text-muted-foreground`;
      valueLabel.textContent = `${confidence}%`;
      row.append(rail, valueLabel);
      container.append(row);
    },
  });
}
