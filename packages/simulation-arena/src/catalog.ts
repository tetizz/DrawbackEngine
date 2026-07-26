import {
  executableRules,
  resolveExecutableRule,
  type ExecutableDrawbackRule,
} from "@drawbackengine/drawback-engine";
import { Mulberry32 } from "@drawbackengine/shared";
import {
  greedyMaterialAgent,
  mediumHumanLikeAgent,
  strongHumanLikeAgent,
  weakHumanLikeAgent,
} from "./agents.js";
import { randomLegalAgent, simulateGame, type SimulationAgent, type SimulationResult } from "./simulation.js";

export const EXECUTABLE_RULE_IDS = [
  "vegan",
  "true-gentleman",
  "trophy-wife",
  "lame-duck",
  "cess",
  "forward-march",
  "checkers",
  "pacman",
  "oddball",
  "even-keeled",
  "truant",
  "spice-of-life",
  "quit-horsing-around",
  "remorseful",
  "battle-fatigue",
  "eye-for-an-eye",
  "barbarian-rage",
  "conscientious-objectors",
  "horse-tranquilizer",
  "untitled-duck-drawback",
  "just-passing-through",
  "gambler",
  "number-of-the-beast",
  "shadow-queen",
  "entrenched",
  "no-shuffling",
  "stop-stalling",
  "greedy",
  "professional-courtesy",
  "snipers",
  "stay-at-home-mom",
  "elephants-fear-mice",
  "far-sighted",
  "whites-of-their-eyes",
  "champing-at-the-bit",
  "scent-of-blood",
  "indecisive",
  "control-center",
  "out-of-breath",
  "queen-bee",
  "alternator",
  "hopscotch",
  "bottled-lighting",
  "chivalry",
  "covering-fire",
  "escort-mission",
  "evil-twin",
  "exclusivity-clause",
  "leaps-and-bounds",
  "left-for-dead",
  "outflanked",
  "punching-down",
  "simplifier",
  "bipartisanship",
  "false-prophets",
  "abstinence",
  "always-check-it-might-be-mate",
  "boastful",
  "closed-book",
  "hold-them-back",
  "homeland-security",
  "ivory-tower",
  "king-of-the-hill",
  "modest",
  "simp",
  "tower-defense",
  "warlord",
  "lucky",
  "eisoptrophobia",
  "gloomstalker",
  "noblesse-oblige",
  "bongcloud",
  "eat-your-vegetables",
  "horse-eats-first",
  "messy-divorce",
  "body-snatcher",
  "castle-doctrine",
  "my-kingdom-for-a-horse",
  "octomom",
  "pawn-battle",
  "edgelord",
  "botez-gambit",
  "cheerleaders",
  "noble-steed",
  "pack-mentality",
  "separation-anxiety",
  "separation-of-church-and-state",
  "sibling-rivalry",
  "social-distancing",
  "spread-out",
  "torchlight",
  "royal-berth",
  "peons-first",
  "power-cells",
  "leading-the-charge",
  "scouting-ahead",
  "diplomatic-immunity",
  "flatterer",
  "hipster",
  "hedonic-treadmill",
  "ladies-first",
  "centralized-command",
  "royal-jubilee",
  "monkey-see",
  "haunted",
  "scorched-earth",
  "turn-the-other-cheek",
  "velociraptor",
  "windup-toys",
  "doctor-octopus",
  "cowering-in-fear",
  "crenellations",
  "theocracy",
  "active-volcano",
  "comfort-zone",
  "crossing-the-rubicon",
  "true-love",
  "lethal-attraction",
  "thunderdome",
  "irresistible",
  "prima-donna",
  "inside-the-lines",
  "boxing-with-shadow",
  "cowardly",
  "going-the-distance",
  "left-to-right",
  "relay-race",
  "religious-dispute",
  "simon-says",
  "superstitious",
  "torpedos",
  "stir-crazy",
  "bloodthirsty",
  "fixation",
  "leveling-up",
  "quicksand",
  "absolution",
  "moving-day",
  "siege",
  "deer-in-the-headlights",
  "jumpy",
  "medusa",
  "stand-your-ground",
  "unrequited-love",
  "helicopter-parent",
  "paranoid",
  "rook-buddies",
  "atomic-bomb",
  "get-down-mr-president",
  "guerilla-tactics",
  "prince-charming",
  "savior-complex",
  "shellshocked",
  "skittish",
  "sleepy-king",
  "three-check",
  "friendly-fire",
  "protected-pawns",
  "rook-on-the-seventh",
  "rising-water",
  "queen-disguise",
  "now-kiss",
  "bishop-fan-club",
  "rook-fan-club",
  "respectful",
  "shapeshifter",
  "fischer-random",
  "unspooling",
  "blinded-by-the-sun",
  "colorblind",
  "hand-and-brainless",
  "obsession",
  "winds-of-fate",
  "expedition",
  "reflective",
  "eye-of-sauron",
  "drag",
  "ooh-shiny",
  "bridge-over-troubled-water",
  "reconnaissance",
] as const;

export type ExecutableRuleId = (typeof EXECUTABLE_RULE_IDS)[number];

export const CATALOG_AGENT_IDS = [
  "random-legal",
  "greedy-material",
  "human-like-weak",
  "human-like-medium",
  "human-like-strong",
] as const;

export type CatalogAgentId = (typeof CATALOG_AGENT_IDS)[number];
export type AgentStyle = "random" | "material" | "human-like";

export interface AgentProfile {
  readonly id: CatalogAgentId;
  readonly style: AgentStyle;
  readonly strength: number;
}

export interface CatalogSelectionOptions {
  readonly ruleIds?: readonly ExecutableRuleId[];
  readonly agentIds?: readonly CatalogAgentId[];
  readonly maxPlies?: number;
}

export interface CatalogGameSpec {
  readonly whiteRuleId: ExecutableRuleId;
  readonly blackRuleId: ExecutableRuleId;
  readonly whiteAgent: AgentProfile;
  readonly blackAgent: AgentProfile;
}

if (
  executableRules.length !== EXECUTABLE_RULE_IDS.length ||
  new Set(EXECUTABLE_RULE_IDS).size !== EXECUTABLE_RULE_IDS.length ||
  EXECUTABLE_RULE_IDS.some(
    (id) => !executableRules.some((rule) => rule.id === id),
  ) ||
  executableRules.some(
    (rule) => !EXECUTABLE_RULE_IDS.includes(
      rule.id as ExecutableRuleId,
    ),
  )
) {
  throw new Error("Simulation rule IDs are out of sync with the executable catalog.");
}

const AGENT_PROFILES: Readonly<
  Record<CatalogAgentId, AgentProfile & { readonly agent: SimulationAgent }>
> = {
  "random-legal": {
    id: "random-legal",
    style: "random",
    strength: 100,
    agent: randomLegalAgent,
  },
  "greedy-material": {
    id: "greedy-material",
    style: "material",
    strength: 600,
    agent: greedyMaterialAgent,
  },
  "human-like-weak": {
    id: "human-like-weak",
    style: "human-like",
    strength: 800,
    agent: weakHumanLikeAgent,
  },
  "human-like-medium": {
    id: "human-like-medium",
    style: "human-like",
    strength: 1400,
    agent: mediumHumanLikeAgent,
  },
  "human-like-strong": {
    id: "human-like-strong",
    style: "human-like",
    strength: 2000,
    agent: strongHumanLikeAgent,
  },
};

function choices<T>(
  configured: readonly T[] | undefined,
  defaults: readonly T[],
  label: string,
): readonly T[] {
  const selected = configured ?? defaults;
  if (selected.length === 0) {
    throw new RangeError(`${label} selection catalog cannot be empty.`);
  }
  return selected;
}

function pick<T>(values: readonly T[], rng: Mulberry32): T {
  const selected = values[rng.integer(values.length)];
  if (selected === undefined) {
    throw new Error("Catalog selection invariant failed.");
  }
  return selected;
}

function publicProfile(id: CatalogAgentId): AgentProfile {
  const profile = AGENT_PROFILES[id];
  return { id: profile.id, style: profile.style, strength: profile.strength };
}

export function deriveCatalogGameSpec(
  gameSeed: number,
  options: CatalogSelectionOptions = {},
): CatalogGameSpec {
  const rng = new Mulberry32(gameSeed ^ 0xc0de_cafe);
  const rules = choices(options.ruleIds, EXECUTABLE_RULE_IDS, "rule");
  const agents = choices(options.agentIds, CATALOG_AGENT_IDS, "agent");
  const whiteRuleId = pick(rules, rng);
  const blackRuleId = pick(rules, rng);
  const whiteAgentId = pick(agents, rng);
  const blackAgentId = pick(agents, rng);
  return {
    whiteRuleId,
    blackRuleId,
    whiteAgent: publicProfile(whiteAgentId),
    blackAgent: publicProfile(blackAgentId),
  };
}

export function simulateCatalogGame(
  gameSeed: number,
  options: CatalogSelectionOptions = {},
): SimulationResult {
  const spec = deriveCatalogGameSpec(gameSeed, options);
  return simulateGame({
    seed: gameSeed,
    rules: {
      white: resolveCatalogRule(spec.whiteRuleId),
      black: resolveCatalogRule(spec.blackRuleId),
    },
    whiteAgent: AGENT_PROFILES[spec.whiteAgent.id].agent,
    blackAgent: AGENT_PROFILES[spec.blackAgent.id].agent,
    ...(options.maxPlies === undefined ? {} : { maxPlies: options.maxPlies }),
  });
}

export function resolveCatalogRule(id: ExecutableRuleId): ExecutableDrawbackRule {
  return resolveExecutableRule(id);
}

export function resolveCatalogAgent(id: CatalogAgentId): SimulationAgent {
  return AGENT_PROFILES[id].agent;
}
