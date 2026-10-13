import { recordFallbacks, type Scenario } from "../src/harness.js";

/**
 * Chess for an adult beginner: rules and patterns (knowledge), puzzles and game reviews (game). Reviews need a UCI
 * engine the learner installs; without the game engine, every check becomes a tactics quiz.
 */
export const chess: Scenario = {
  id: "chess",
  skill: "chess",
  notes: "Knows how the pieces move. Loses most online games quickly. Wants to reach 1200 online.",
  expect: { engines: ["game", "knowledge"], main: "game", fallback: "knowledge", physical: false, supervisedOnly: [] },
  build: (draft) => {
    const backRank = { position: "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1", best: "Rd8#", prompt: "White to move. Find mate in one." };
    const scholars = { position: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 2 3", best: "Qxf7#", prompt: "White to move. Find mate in one." };
    const fork = { position: "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1", best: "Nc7+", prompt: "White to move. Win the rook." };
    return {
      skill: "chess",
      name: "Chess",
      noun: "chess",
      source: "generated",
      physical: false,
      engines: ["game", "knowledge", "self-report"],
      fallbacks: recordFallbacks(draft, { game: "knowledge" }),
      why: [
        { id: "win", label: "Win more games" },
        { id: "kids", label: "Play with my kids" },
        { id: "think", label: "Sharpen my thinking" },
        { id: "club", label: "Join a club" }
      ],
      pictures: [
        { id: "rating", label: "Reaching 1200 online", why: ["win", "club"], ladderStep: 5, milestone: "Games with at most two blunders", proof: "An engine review: two blunders or fewer", focus: { Fundamentals: 25, Tactics: 50, Strategy: 25 } },
        { id: "kids", label: "Teaching my kids", why: ["kids", "think"], ladderStep: 2, milestone: "Every checkmate pattern for beginners", proof: "Mate-in-one puzzles, 8 of 10", focus: { Fundamentals: 50, Tactics: 35, Strategy: 15 } },
        { id: "tactics", label: "Spotting tactics fast", why: ["think", "win"], ladderStep: 3, milestone: "Forks and pins on sight", proof: "Tactics puzzles, 8 of 10", focus: { Fundamentals: 20, Tactics: 65, Strategy: 15 } }
      ],
      probes: [
        { id: "rating", type: "single", question: "Do you have an online rating?", options: [{ value: 0, label: "No, I just know the moves" }, { value: 800, label: "Under 900" }, { value: 1000, label: "900 to 1100" }, { value: 1200, label: "Over 1100" }] },
        { id: "tactics", type: "quiz", question: "Solve a few positions.", spec: "tactics-set" }
      ],
      placement: [
        { when: "!fresh && rating >= 1000 && quiz.correct >= 3", step: 3, evidence: "Rated near 1000 and solves tactics" },
        { when: "rating >= 800 || quiz.correct >= 2", step: 1, evidence: "Plays online already" }
      ],
      ladder: [
        { id: "start", label: "Knows how the pieces move", hours: [0, 0] },
        { id: "rules", label: "Every rule, castling and en passant", hours: [1, 3], nodes: ["rules"],
          proof: { engine: "knowledge", spec: "rules-quiz", label: "Rules quiz, 90% right", criteria: [{ id: "acc", label: "90% right", check: "accuracy >= 0.9" }] } },
        { id: "mates", label: "Basic checkmate patterns", hours: [4, 8], nodes: ["mates"],
          proof: { engine: "game", spec: "mate-puzzles", label: "Ten mate-in-one puzzles, eight solved", criteria: [{ id: "solved", label: "Eight of ten", check: "puzzles_solved >= 8" }], fallback: "knowledge", fallback_spec: "tactics-set" } },
        { id: "tactics", label: "Forks, pins and skewers", hours: [8, 20], nodes: ["forks", "pins"],
          proof: { engine: "game", spec: "tactic-puzzles", label: "Ten tactics puzzles, eight solved", criteria: [{ id: "solved", label: "Eight of ten", check: "puzzles_solved >= 8" }], fallback: "knowledge", fallback_spec: "tactics-set" } },
        { id: "openings", label: "Opening principles", hours: [4, 8], nodes: ["openings"],
          proof: { engine: "knowledge", spec: "opening-quiz", label: "Opening principles quiz, 80% right", criteria: [{ id: "acc", label: "80% right", check: "accuracy >= 0.8" }] } },
        { id: "games", label: "Games with few blunders", hours: [20, 50], nodes: ["blunder-check"],
          proof: { engine: "game", spec: "game-review", label: "One rapid game reviewed: two blunders or fewer", criteria: [{ id: "blunders", label: "Two blunders or fewer", check: "blunders <= 2" }], fallback: "knowledge", fallback_spec: "tactics-set" } }
      ],
      nodes: [
        { id: "rules", name: "All the rules", lesson: "rules-lesson", drills: ["rules-drill"], review: { prompt: "Can you castle out of check?", kind: "choice", options: ["No", "Yes"], answer: 0 }, focus: "Fundamentals" },
        { id: "mates", name: "Checkmate patterns", requires: ["rules"], lesson: "mates-lesson", drills: ["mate-drill"], mistakes: ["missed-mate"], review: { prompt: "Name the mate with a rook on the last rank.", kind: "recall", answer: "Back-rank mate" }, focus: "Tactics" },
        { id: "forks", name: "Forks", requires: ["mates"], lesson: "tactics-lesson", drills: ["fork-drill"], review: { prompt: "Which piece forks best?", kind: "choice", options: ["Knight", "Pawn"], answer: 0 }, focus: "Tactics" },
        { id: "pins", name: "Pins", requires: ["mates"], lesson: "tactics-lesson", drills: ["pin-drill"], review: { prompt: "A pinned piece can't move without exposing...", kind: "choice", options: ["A bigger piece", "A pawn"], answer: 0 }, focus: "Tactics" },
        { id: "openings", name: "Opening principles", requires: ["rules"], lesson: "openings-lesson", drills: ["opening-drill"], review: { prompt: "Name two opening principles.", kind: "recall" }, focus: "Strategy" },
        { id: "blunder-check", name: "Blunder check", requires: ["forks", "pins", "openings"], lesson: "blunder-lesson", drills: ["blunder-drill"], mistakes: ["hanging-piece"], review: { prompt: "What do you check before every move?", kind: "choice", options: ["Checks, captures, threats", "The clock only"], answer: 0 }, focus: "Strategy" }
      ],
      lessons: [
        { id: "rules-lesson", title: "The rules", nodes: ["rules"], cards: [
          { type: "predict", text: "Can a king castle through an attacked square?", options: ["No", "Yes"], answer: 0 },
          { type: "diagram", text: "Castling: king two squares, rook jumps over.", figure: { kind: "graph", nodes: [{ id: "k", label: "Ke1 to g1" }, { id: "r", label: "Rh1 to f1" }], edges: [["k", "r"]] } }
        ] },
        { id: "mates-lesson", title: "Checkmate patterns", nodes: ["mates"], cards: [
          { type: "predict", text: "Black's king is boxed in by its own pawns. What's the danger?", options: ["Back-rank mate", "Stalemate"], answer: 0 },
          { type: "diagram", text: "Rook to the 8th rank: no escape squares.", figure: { kind: "figure", points: { king: [80, 10], rook: [40, 10], p1: [70, 25], p2: [80, 25], p3: [90, 25] }, segments: [["rook", "king"]], marks: [{ at: "king", label: "mate", role: "attention" }, { at: "rook", label: "Rd8", role: "good" }] } }
        ] },
        { id: "tactics-lesson", title: "Forks and pins", nodes: ["forks", "pins"], cards: [
          { type: "predict", text: "A knight attacks king and rook at once. What wins?", options: ["The rook, after the king moves", "Nothing"], answer: 0 },
          { type: "demo", text: "Nc7+ forks the king and the rook.", figure: { kind: "figure", points: { knight: [40, 70], c7: [30, 25], king: [55, 10], rook: [5, 10] }, segments: [["knight", "c7"], ["c7", "king"], ["c7", "rook"]], marks: [{ at: "c7", label: "fork", role: "good" }] }, playback: "steps" }
        ] },
        { id: "openings-lesson", title: "Opening principles", nodes: ["openings"], cards: [
          { type: "predict", text: "Moving the queen out early is usually...", options: ["Risky", "Strong"], answer: 0 },
          { type: "diagram", text: "Center, develop, castle, connect rooks.", figure: { kind: "graph", nodes: [{ id: "c", label: "Center pawns" }, { id: "d", label: "Develop knights, bishops" }, { id: "k", label: "Castle" }, { id: "r", label: "Connect rooks" }], edges: [["c", "d"], ["d", "k"], ["k", "r"]] } }
        ] },
        { id: "blunder-lesson", title: "The blunder check", nodes: ["blunder-check"], cards: [
          { type: "predict", text: "Most beginner games are lost by...", options: ["Leaving pieces undefended", "Bad openings"], answer: 0 },
          { type: "diagram", text: "Before each move: checks, captures, threats.", figure: { kind: "graph", nodes: [{ id: "c", label: "Checks?" }, { id: "x", label: "Captures?" }, { id: "t", label: "Threats?" }, { id: "m", label: "Move" }], edges: [["c", "x"], ["x", "t"], ["t", "m"]] } }
        ] }
      ],
      drills: [
        { id: "rules-drill", type: "choice", title: "Rules check", prompt: "Pick the legal move.", nodes: ["rules"], spec: "rules-quiz", minutes: 3, intensity: 1, focus: "Fundamentals" },
        { id: "mate-drill", type: "choice", title: "Mate in one", prompt: "Find the mating move.", nodes: ["mates"], spec: "tactics-set", difficulty: { param: "hints", levels: ["piece shown", "no hint"] }, minutes: 5, intensity: 1, focus: "Tactics", fixes: ["missed-mate"] },
        { id: "fork-drill", type: "choice", title: "Find the fork", prompt: "Pick the move that attacks two pieces.", nodes: ["forks"], spec: "tactics-set", minutes: 5, intensity: 1, focus: "Tactics" },
        { id: "pin-drill", type: "hotspot", title: "Spot the pin", prompt: "Tap the pinned piece.", nodes: ["pins"], spec: "pin-quiz", minutes: 4, intensity: 1, focus: "Tactics" },
        { id: "opening-drill", type: "order", title: "Opening plan", prompt: "Put the opening steps in order.", nodes: ["openings"], spec: "opening-quiz", minutes: 3, intensity: 1, focus: "Strategy" },
        { id: "blunder-drill", type: "choice", title: "What's hanging?", prompt: "Which piece can be taken for free?", nodes: ["blunder-check"], spec: "tactics-set", minutes: 5, intensity: 1, focus: "Strategy", fixes: ["hanging-piece"] }
      ],
      specs: {
        "mate-puzzles": { kind: "game", game: "chess", side: "white", engine: "none", fallback_items: [backRank, scholars], pass: "puzzles_solved >= 8" },
        "tactic-puzzles": { kind: "game", game: "chess", side: "white", engine: "none", fallback_items: [fork, backRank], pass: "puzzles_solved >= 8" },
        "game-review": { kind: "game", game: "chess", side: "both", engine: "uci", depth: 14, fallback_items: [backRank, scholars, fork], pass: "blunders <= 2 && agreement >= 0.5" },
        "tactics-set": {
          kind: "items",
          stop_after_wrong: 2,
          items: [
            { type: "choice", id: "t1", prompt: `${backRank.position}. White to move: mate in one?`, options: ["Rd8#", "Rd7", "g4"], answer: 0, difficulty: 1, nodes: ["mates"] },
            { type: "choice", id: "t2", prompt: `${scholars.position}. White to move: mate in one?`, options: ["Qxf7#", "Bxf7+", "Qf5"], answer: 0, difficulty: 2, nodes: ["mates"] },
            { type: "choice", id: "t3", prompt: `${fork.position}. White to move: win the rook.`, options: ["Nc7+", "Nd6+", "Kd2"], answer: 0, difficulty: 3, nodes: ["forks"] },
            { type: "choice", id: "t4", prompt: "Your knight on f3 is attacked by a pawn and defended once. Is it safe to ignore?", options: ["No, a pawn takes it for free", "Yes, it's defended"], answer: 0, difficulty: 3, nodes: ["blunder-check"] }
          ],
          pass: "accuracy >= 0.75"
        },
        "rules-quiz": {
          kind: "items",
          items: [
            { type: "choice", id: "r1", prompt: "Can you castle while in check?", options: ["No", "Yes"], answer: 0, difficulty: 1, nodes: ["rules"] },
            { type: "choice", id: "r2", prompt: "A pawn reaches the last rank. It becomes...", options: ["Any piece but a king", "Only a queen"], answer: 0, difficulty: 2, nodes: ["rules"] },
            { type: "choice", id: "r3", prompt: "En passant is only possible...", options: ["Right after the two-square pawn move", "Any time later"], answer: 0, difficulty: 3, nodes: ["rules"] }
          ],
          pass: "accuracy >= 0.9"
        },
        "pin-quiz": { kind: "items", items: [{ type: "hotspot", id: "pin1", prompt: "Tap the piece that can't move without exposing the king.", figure: "pin-board", region: { x: 0.44, y: 0.62, r: 0.06 }, difficulty: 2, nodes: ["pins"] }] },
        "opening-quiz": {
          kind: "items",
          items: [
            { type: "order", id: "o1", prompt: "Order these opening goals.", items: ["Center pawns", "Develop knights and bishops", "Castle", "Connect the rooks"], difficulty: 2, nodes: ["openings"] },
            { type: "choice", id: "o2", prompt: "Early queen moves are usually...", options: ["Risky: she gets chased", "Best"], answer: 0, difficulty: 2, nodes: ["openings"] }
          ],
          pass: "accuracy >= 0.8"
        }
      },
      mistakes: [
        { id: "missed-mate", name: "Missed mate", nodes: ["mates"], engine: "game", detector: { metric: "puzzles_solved", when: "puzzles_solved < puzzles_total * 0.6" }, severity: 2, explain: { lesson: "mates-lesson", card: 1 }, fix_drill: "mate-drill", headline: "Mate in one went unseen" },
        { id: "hanging-piece", name: "Hanging pieces", nodes: ["blunder-check"], engine: "game", detector: { metric: "blunders", when: "blunders > 2" }, severity: 3, explain: { lesson: "blunder-lesson", card: 1 }, fix_drill: "blunder-drill", headline: "Pieces left undefended" }
      ],
      access: ["A computer or phone", "An online chess account"],
      focus: { Fundamentals: 25, Tactics: 50, Strategy: 25 },
      key_metrics: [
        { id: "puzzles", label: "Puzzles solved", engine: "game", metric: "puzzles_solved", better: "higher", format: "count" },
        { id: "blunders", label: "Blunders per game", engine: "game", metric: "blunders", better: "lower", format: "count" },
        { id: "quiz", label: "Tactics quiz", engine: "knowledge", metric: "accuracy", unit: "%", better: "higher", format: "percent" }
      ],
      copy: { placeholder: "chess, go, checkers", blurb: "Rules, mates, tactics, fewer blunders" },
      notes: "Engines: game (chess rules) for puzzles and game reviews, knowledge for rules and tactics quizzes. Game reviews need a UCI engine the learner installs as a separate program (Stockfish is GPL, so it is never bundled); puzzles work without one. Without the game engine, every game proof falls back to the tactics quiz. Hours are estimates from general adult beginner progress, shown as ranges."
    };
  }
};
