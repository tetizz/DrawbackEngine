import type { ExternalConstraintDrawbackRule } from "../external-constraints.js";
import type { DrawbackRule } from "../types.js";
import { barbarianRageRule } from "./barbarian-rage.js";
import { attackObservedRules } from "./attack-observed-rules.js";
import { battleFatigueRule } from "./battle-fatigue.js";
import { boardRelativeRules } from "./board-relative-rules.js";
import { bridgeOverTroubledWaterRule } from "./bridge-over-troubled-water.js";
import { cessRule } from "./cess.js";
import { checkersRule } from "./checkers.js";
import { communityRules } from "./community-rules.js";
import { communityRulesTwo } from "./community-rules-two.js";
import { conscientiousObjectorsRule } from "./conscientious-objectors.js";
import { evenKeeledRule } from "./even-keeled.js";
import { exactParameterizedRules } from "./exact-parameterized-rules.js";
import { expeditionRule } from "./expedition.js";
import { expandedRules } from "./expanded-rules.js";
import { eyeForAnEyeRule } from "./eye-for-an-eye.js";
import { falseProphetsRule } from "./false-prophets.js";
import { finalBoardRules } from "./final-board-rules.js";
import { finalTacticalRules } from "./final-tactical-rules.js";
import { forwardMarchRule } from "./forward-march.js";
import { gamblerRule } from "./gambler.js";
import { geometricObservedRules } from "./geometric-observed-rules.js";
import { horseTranquilizerRule } from "./horse-tranquilizer.js";
import { historyFilterRules } from "./history-filter-rules.js";
import { justPassingThroughRule } from "./just-passing-through.js";
import { lameDuckRule } from "./lame-duck.js";
import { lossRules } from "./loss-rules.js";
import { nextStatefulRules } from "./next-stateful-rules.js";
import { oddballRule } from "./oddball.js";
import { observedRulesThree } from "./observed-rules-three.js";
import { observedRulesEight } from "./observed-rules-eight.js";
import { pacmanRule } from "./pacman.js";
import { quitHorsingAroundRule } from "./quit-horsing-around.js";
import { remorsefulRule } from "./remorseful.js";
import { responseHistoryRules } from "./response-history-rules.js";
import { reconnaissanceRule } from "./reconnaissance.js";
import { rerandomizedRules } from "./rerandomized-rules.js";
import { remainingResponseRules } from "./remaining-response-rules.js";
import { remainingStatefulRules } from "./remaining-stateful-rules.js";
import { spiceOfLifeRule } from "./spice-of-life.js";
import { trophyWifeRule } from "./trophy-wife.js";
import { truantRule } from "./truant.js";
import { trueGentlemanRule } from "./true-gentleman.js";
import { untitledDuckDrawbackRule } from "./untitled-duck-drawback.js";
import { veganRule } from "./vegan.js";
import {
  handAndGigabrainRule,
  ichtyophobeRule,
} from "./evaluator-backed-rules.js";

export type ExecutableDrawbackRule = DrawbackRule<unknown, unknown>;
export type ExternalExecutableDrawbackRule =
  ExternalConstraintDrawbackRule<unknown, unknown>;
export type PreparedExecutableDrawbackRule =
  | ExecutableDrawbackRule
  | ExternalExecutableDrawbackRule;

function eraseRule<State, Parameters>(
  rule: DrawbackRule<State, Parameters>,
): ExecutableDrawbackRule {
  // Runtime dispatch preserves the paired state and parameters inside
  // GameSession. Erasure is confined to heterogeneous catalog selection.
  return rule;
}

export const executableRules: readonly ExecutableDrawbackRule[] = Object.freeze([
  eraseRule(veganRule),
  eraseRule(trueGentlemanRule),
  eraseRule(falseProphetsRule),
  eraseRule(trophyWifeRule),
  eraseRule(lameDuckRule),
  eraseRule(cessRule),
  eraseRule(forwardMarchRule),
  eraseRule(checkersRule),
  eraseRule(pacmanRule),
  eraseRule(oddballRule),
  eraseRule(evenKeeledRule),
  eraseRule(truantRule),
  eraseRule(spiceOfLifeRule),
  eraseRule(quitHorsingAroundRule),
  eraseRule(remorsefulRule),
  eraseRule(battleFatigueRule),
  eraseRule(eyeForAnEyeRule),
  eraseRule(barbarianRageRule),
  eraseRule(conscientiousObjectorsRule),
  eraseRule(horseTranquilizerRule),
  eraseRule(untitledDuckDrawbackRule),
  eraseRule(justPassingThroughRule),
  eraseRule(gamblerRule),
  ...expandedRules.map(eraseRule),
  ...communityRules.map(eraseRule),
  ...communityRulesTwo.map(eraseRule),
  ...lossRules.map(eraseRule),
  ...observedRulesThree.map(eraseRule),
  ...boardRelativeRules.map(eraseRule),
  ...historyFilterRules.map(eraseRule),
  ...exactParameterizedRules.map(eraseRule),
  ...geometricObservedRules.map(eraseRule),
  ...responseHistoryRules.map(eraseRule),
  ...nextStatefulRules.map(eraseRule),
  ...attackObservedRules.map(eraseRule),
  ...remainingResponseRules.map(eraseRule),
  ...remainingStatefulRules.map(eraseRule),
  ...observedRulesEight.map(eraseRule),
  ...rerandomizedRules.map(eraseRule),
  eraseRule(expeditionRule),
  ...finalBoardRules.map(eraseRule),
  ...finalTacticalRules.map(eraseRule),
  eraseRule(bridgeOverTroubledWaterRule),
  eraseRule(reconnaissanceRule),
]);

const rulesById = new Map(executableRules.map((rule) => [rule.id, rule]));

function eraseExternalRule<State, Parameters>(
  rule: ExternalConstraintDrawbackRule<State, Parameters>,
): ExternalExecutableDrawbackRule {
  return rule;
}

export const externalConstraintRules: readonly ExternalExecutableDrawbackRule[] =
  Object.freeze([
    eraseExternalRule(handAndGigabrainRule),
    eraseExternalRule(ichtyophobeRule),
  ]);

export const preparedExecutableRules: readonly PreparedExecutableDrawbackRule[] =
  Object.freeze([...executableRules, ...externalConstraintRules]);

const preparedRulesById = new Map(
  preparedExecutableRules.map((rule) => [rule.id, rule]),
);

if (rulesById.size !== executableRules.length) {
  throw new Error("Executable drawback rule IDs must be unique.");
}
if (preparedRulesById.size !== preparedExecutableRules.length) {
  throw new Error("Prepared executable drawback rule IDs must be unique.");
}

export function resolveExecutableRule(id: string): ExecutableDrawbackRule {
  const rule = rulesById.get(id);
  if (rule === undefined) {
    throw new RangeError(`Unknown executable drawback rule: ${id}.`);
  }
  return rule;
}

export function resolvePreparedExecutableRule(
  id: string,
): PreparedExecutableDrawbackRule {
  const rule = preparedRulesById.get(id);
  if (rule === undefined) {
    throw new RangeError(`Unknown prepared executable drawback rule: ${id}.`);
  }
  return rule;
}
