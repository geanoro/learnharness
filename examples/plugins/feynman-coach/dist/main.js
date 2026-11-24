const CONFIDENCE_STOPS = [0, 30, 50, 70, 90, 100];
// Same six-stop ramp as the host's native quiz confidence rail
// (components/confidence-rail.tsx), reimplemented here because that
// component is core-internal and not part of the public plugin SDK.
const CONFIDENCE_COLORS = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e", "#10b981"];
const DEFAULT_CONFIDENCE_INDEX = 2;

function railBackground(value) {
  const color = CONFIDENCE_COLORS[CONFIDENCE_STOPS.indexOf(value)] ?? CONFIDENCE_COLORS[DEFAULT_CONFIDENCE_INDEX];
  return `linear-gradient(90deg, ${color} 0%, ${color} ${value}%, color-mix(in oklab, currentColor 14%, transparent) ${value}%, color-mix(in oklab, currentColor 14%, transparent) 100%)`;
}

function mountRail(doc, container, testid) {
  const rail = doc.createElement("div");
  rail.setAttribute("data-testid", testid);
  rail.style.height = "6px";
  rail.style.borderRadius = "999px";
  rail.style.width = "100%";
  container.append(rail);
  return { set(value) { rail.style.background = railBackground(value); } };
}

function mountPicker(doc, container, index, onPick) {
  const row = doc.createElement("div");
  row.style.display = "flex";
  row.style.justifyContent = "space-between";
  row.style.marginTop = "4px";
  const buttons = CONFIDENCE_STOPS.map((stop, i) => {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = `${stop}%`;
    button.setAttribute("data-testid", `feynman-confidence-${stop}`);
    button.style.fontSize = "11px";
    button.style.opacity = i === index ? "1" : "0.55";
    button.style.fontWeight = i === index ? "600" : "400";
    button.addEventListener("click", () => onPick(i));
    row.append(button);
    return button;
  });
  container.append(row);
  return { set(i) { buttons.forEach((b, idx) => { b.style.opacity = idx === i ? "1" : "0.55"; b.style.fontWeight = idx === i ? "600" : "400"; }); } };
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

      const textarea = doc.createElement("textarea");
      textarea.setAttribute("data-testid", "feynman-explanation-input");
      textarea.rows = 4;
      textarea.style.width = "100%";
      textarea.disabled = !props.active;
      textarea.value = typeof initial?.explanation === "string" ? initial.explanation : "";
      textarea.placeholder = props.input.payload && props.input.payload.mode === "short"
        ? "One sentence, in your own words, no terms the teacher used."
        : "3-5 lines, in your own words, as if to a friend — no terms the teacher used.";
      container.append(textarea);

      const railHost = doc.createElement("div");
      railHost.style.marginTop = "8px";
      container.append(railHost);
      const rail = mountRail(doc, railHost, "feynman-confidence-rail");
      rail.set(CONFIDENCE_STOPS[index]);
      const picker = mountPicker(doc, railHost, index, picked => { index = picked; rail.set(CONFIDENCE_STOPS[index]); picker.set(index); publish(); });
      picker.set(index);

      let disposed = false;
      const publish = () => {
        if (disposed) return;
        const explanation = textarea.value.trim();
        if (!explanation) { props.onChange({ status: "empty" }); return; }
        props.onChange({ status: "ready", value: { explanation: textarea.value, confidence: CONFIDENCE_STOPS[index] } });
      };
      textarea.addEventListener("input", publish);
      publish();

      return {
        update(next) {
          textarea.disabled = !next.active;
          const value = readValue(next.answer);
          if (value) {
            if (typeof value.explanation === "string" && value.explanation !== textarea.value) textarea.value = value.explanation;
            if (typeof value.confidence === "number" && CONFIDENCE_STOPS.includes(value.confidence) && CONFIDENCE_STOPS.indexOf(value.confidence) !== index) {
              index = CONFIDENCE_STOPS.indexOf(value.confidence);
              rail.set(CONFIDENCE_STOPS[index]);
              picker.set(index);
            }
          }
        },
        focus() { textarea.focus(); },
        appendTranscript(text) { textarea.value += text; publish(); },
        dispose() { disposed = true; textarea.removeEventListener("input", publish); },
      };
    },
    mountAnswered(container, props) {
      const doc = container.ownerDocument;
      const answer = props.answer;
      const paragraph = doc.createElement("p");
      paragraph.setAttribute("data-testid", "feynman-explanation-answered");
      paragraph.style.whiteSpace = "pre-wrap";
      paragraph.textContent = answer && typeof answer.explanation === "string" ? answer.explanation : "";
      container.append(paragraph);
      const confidence = answer && typeof answer.confidence === "number" && CONFIDENCE_STOPS.includes(answer.confidence)
        ? answer.confidence : CONFIDENCE_STOPS[DEFAULT_CONFIDENCE_INDEX];
      const railHost = doc.createElement("div");
      railHost.style.marginTop = "8px";
      container.append(railHost);
      mountRail(doc, railHost, "feynman-confidence-rail-static").set(confidence);
      const label = doc.createElement("div");
      label.setAttribute("data-testid", "feynman-confidence-value");
      label.textContent = `Confidence: ${confidence}%`;
      label.style.fontSize = "11px";
      label.style.opacity = "0.7";
      label.style.marginTop = "4px";
      container.append(label);
    },
  });
}
