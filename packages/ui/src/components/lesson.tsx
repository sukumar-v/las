import { useState } from "preact/hooks";
import type { Card as CardSpec } from "@las/schema";
import { Card, Eyebrow, Button } from "./primitives.js";
import { Choice, type ChoiceState } from "./answers.js";
import { Figure } from "../figures/figure.js";
import { Sim } from "./sim.js";
import { copy, type Voice } from "../copy.js";

export interface CardAnswer {
  picked?: number;
  revealed?: boolean;
  interacted?: boolean;
  side?: "left" | "right";
}

/** One teaching card. Each is 25 words or fewer by construction (the schema rejects more). */
export function LessonCard({ card, index, answer, onAnswer, voice }: { card: CardSpec; index: number; answer?: CardAnswer; onAnswer?: (a: CardAnswer) => void; voice?: Voice }) {
  const [local, setLocal] = useState<CardAnswer>({});
  const a = answer ?? local;
  const set = (n: CardAnswer) => {
    setLocal(n);
    onAnswer?.(n);
  };
  const type = <Eyebrow>{card.type}</Eyebrow>;
  switch (card.type) {
    case "predict": {
      const st: ChoiceState = { picked: a.picked, revealed: a.revealed };
      return (
        <Card label={`Card ${index + 1}: predict`}>
          {type}
          <Choice prompt={card.text} options={card.options} answer={card.answer} state={st} figures={card.figures} reveal={card.reveal} onPick={(i) => set({ picked: i, revealed: true })} />
          {card.figure && !card.figures ? <Figure figure={card.figure} /> : null}
        </Card>
      );
    }
    case "sim":
      return (
        <Card label={`Card ${index + 1}: sim`}>
          {type}
          <div class="las-prompt">{card.text}</div>
          <Sim spec={card.sim} onInteract={() => (a.interacted ? null : set({ interacted: true }))} />
          {card.sim.takeaway && a.interacted ? <p class="las-hint">{card.sim.takeaway}</p> : null}
        </Card>
      );
    case "mechanism":
      return (
        <Card label={`Card ${index + 1}: mechanism`}>
          {type}
          <div class="las-prompt">{card.text}</div>
          {card.figure ? <Figure figure={card.figure} /> : <Figure figure={{ kind: "mechanism", concept: card.concept }} />}
        </Card>
      );
    case "diagram":
      return (
        <Card label={`Card ${index + 1}: diagram`}>
          {type}
          <div class="las-prompt">{card.text}</div>
          <Figure figure={card.figure} />
        </Card>
      );
    case "demo":
      return (
        <Card label={`Card ${index + 1}: demo`}>
          {type}
          <div class="las-prompt">{card.text}</div>
          <Figure figure={card.figure} />
          <Button icon="play" onClick={() => set({ interacted: true })}>
            {card.playback === "steps" ? "Step" : "Play"}
          </Button>
        </Card>
      );
    case "compare":
      return (
        <Card label={`Card ${index + 1}: compare`}>
          {type}
          <div class="las-prompt">{card.text}</div>
          <div class="las-pair">
            <button type="button" class="las-opt" aria-pressed={a.side === "left" ? "true" : "false"} onClick={() => set({ side: "left", revealed: true })}>
              <Figure figure={card.left} />
              <small>{card.leftLabel ?? "A"}</small>
            </button>
            <button type="button" class="las-opt" aria-pressed={a.side === "right" ? "true" : "false"} onClick={() => set({ side: "right", revealed: true })}>
              <Figure figure={card.right} />
              <small>{card.rightLabel ?? "B"}</small>
            </button>
          </div>
          {a.revealed && card.answer ? <p class="las-hint">{a.side === card.answer ? copy(voice, "wellDone") : `It's ${card.answer === "left" ? card.leftLabel ?? "A" : card.rightLabel ?? "B"}.`}</p> : null}
        </Card>
      );
    case "try-it":
      return (
        <Card label={`Card ${index + 1}: try it`}>
          {type}
          <div class="las-prompt">{card.text}</div>
          {card.pattern ? <Figure figure={{ kind: "rhythm", pattern: card.pattern, subdivisions: Math.max(2, card.pattern.length), highlight: [] }} /> : null}
          {card.target ? <p class="las-sub">{card.target}</p> : null}
          <Button primary icon={card.action === "say-it" ? "mic" : card.action === "tap-rhythm" ? "music" : "play"} onClick={() => set({ interacted: true })}>
            {card.action === "say-it" ? "Say it" : card.action === "tap-rhythm" ? "Tap it" : card.action === "hold-pose" ? "Hold it" : card.action === "type-it" ? "Type it" : "Count"}
          </Button>
        </Card>
      );
  }
}

export function Lesson({ cards, answers, onAnswer, voice, title }: { cards: CardSpec[]; answers?: CardAnswer[]; onAnswer?: (i: number, a: CardAnswer) => void; voice?: Voice; title?: string }) {
  return (
    <div class="las-cards" aria-label={title}>
      {cards.map((c, i) => (
        <LessonCard key={i} card={c} index={i} answer={answers?.[i]} onAnswer={(a) => onAnswer?.(i, a)} voice={voice} />
      ))}
    </div>
  );
}
