# Initial rule evidence

Last reviewed: 2026-07-23

## Purpose and evidence standard

This note records the public evidence used to interpret the first five
DrawbackEngine rules. It distinguishes an attributable description from a
complete executable specification. A short English sentence can establish the
core rule without resolving implementation details such as castling,
en-passant, promotion, or what happens when the drawback removes every
otherwise legal move.

The strongest source found is a comment by the creator of Drawback Chess.
The remaining definitions come from a Chess.com community glossary compiled by
a player who says they discovered the drawbacks. That glossary is useful and
internally consistent, but it is not an official specification. The live
Drawback Chess site exposes a “Drawback Glossary” entry in its interface, but
undiscovered entries are gated by player progress and its public landing page
does not print the definitions. Accordingly, no rule in this note has enough
public evidence to be marked `verified`.

## Sources

1. **Creator announcement and discussion:** Adam Yedidia, “Try out
   drawbackchess.com!”, Reddit r/chess, 2024-02-15.
   <https://www.reddit.com/r/chess/comments/1arrw0d/try_out_drawbackchesscom/>
   The original poster identifies himself as the site's maker. In a reply about
   Lame Duck, he explicitly glosses it as “you can't move your king.”
2. **Community catalog:** Truc1231, reply #5 in “all drawbacks,” Chess.com
   forum, 2024-06-18.
   <https://www.chess.com/forum/view/general/all-drawbacks>
   Relevant entries appear as follows: Vegan at page lines 389–391, Truant at
   408–410, Lame Duck at 416–418, Spice of Life at 481–483, and Checkers at
   610–611 in the currently rendered page. The author introduces the list as
   drawbacks they “discovered,” rather than as an official rules document.
3. **Official product landing page:** “Drawback Chess.”
   <https://www.drawbackchess.com/>
   The interface identifies itself as Drawback Chess and links a Drawback
   Glossary, but the public landing-page response contains no rule text.

Quoted fragments in the rule sections below are kept short because the purpose
is source identification, not reproduction of the community catalog.

## Recommended shared semantics

Unless stronger rule-specific evidence is later found, use these explicit
engine conventions:

- “Move” means an otherwise legal standard-chess move generated before the
  drawback filter is applied.
- “Capture” includes an otherwise legal en-passant capture and a capturing
  promotion. Whether a move is a capture is determined by chess semantics, not
  merely whether the destination square was occupied.
- “In a row” compares the affected player's consecutive turns; the opponent's
  intervening move does not reset the history.
- Castling is represented as a king move with a secondary rook relocation.
- A promoting move is a pawn move for the purpose of classifying the move that
  was made. The resulting board piece has the promoted type on later turns.
- A drawback filter does not make an otherwise illegal chess move legal.
- If filtering leaves no move, the game-session policy must handle that result
  explicitly. None of the located definitions says whether it is a drawback
  loss, checkmate/stalemate under ordinary rules, or some other result.

These are DrawbackEngine conventions, not claims about undocumented behavior
on the original site.

## Rule findings

### Vegan

- **Attributable core definition:** the community catalog says, “You can’t
  capture knights.”
- **Defensible executable interpretation:** remove every ordinary legal move
  whose captured piece is an opposing knight. Restrict the captured target, not
  the type of the moving piece. Non-capturing knight moves and captures made by
  knights remain permitted.
- **Edge implications:** a promotion that captures a knight is forbidden.
  En-passant cannot normally capture a knight and is unaffected. Castling is
  non-capturing and is unaffected.
- **Ambiguities:** no located source discusses variant positions in which a
  knight is treated as a royal piece, transformed movement, or interactions
  with other drawbacks.
- **Recommended status:** `implemented-unverified`. The core wording is clear,
  but only a player-compiled source was found and no edge behavior is sourced.

### Lame Duck

- **Attributable core definition:** both the creator's Reddit reply and the
  community catalog say the player cannot move their king.
- **Defensible executable interpretation:** remove every ordinary legal move
  whose primary mover is the affected player's king.
- **Edge implications:** castling is forbidden because it is a king move.
  Captures by the king are forbidden. A rook moved as the secondary effect of
  castling does not make castling permissible.
- **Ambiguities:** neither source specifies the result when check can only be
  answered by a king move, nor whether the original variant permits king
  capture or nonstandard check semantics. DrawbackEngine should retain
  standard-chess legality and apply the filter afterward, then use its explicit
  no-drawback-legal-move policy.
- **Recommended status:** `implemented-unverified`. Creator attribution makes
  the core definition unusually strong, but the executable edge cases and loss
  semantics remain undocumented.

### Checkers

- **Attributable core definition:** the community catalog says, “You must
  capture if able.”
- **Defensible executable interpretation:** generate all ordinary legal moves.
  If at least one is a capture, retain all and only captures; otherwise retain
  all ordinary legal moves. The rule does not choose among multiple captures.
- **Edge implications:** legal en-passant captures and capturing promotions
  activate the rule. King captures count if they are ordinary legal moves.
  Pseudo-legal captures that leave the mover's king in check do not activate
  it.
- **Ambiguities:** “able” could theoretically mean pseudo-legal rather than
  legal, but that would conflict with the architecture's ordinary-legal-first
  sequence and could force an illegal move. The source does not discuss this
  distinction or what happens if another rule blocks every capture.
- **Recommended status:** `implemented-unverified`. The natural single-rule
  interpretation is clear, but the only located definition is community
  supplied and special captures are not expressly documented.

### Truant

- **Attributable core definition:** the community catalog says, “You can’t move
  the same piece twice in a row.”
- **Defensible executable interpretation:** remember the identity of the
  primary piece moved on the affected player's previous turn and forbid that
  same surviving piece from being the primary mover on the next turn. Piece
  identity must not be inferred from piece type alone.
- **Edge implications:** moving one knight and then the other is permitted.
  A pawn that promotes remains the same physical piece for identity tracking,
  so the newly promoted piece cannot move on the player's immediately following
  turn. Castling records the king as the primary mover, not the rook.
- **Ambiguities:** the source does not define persistent piece identity,
  promotion, castling's secondary rook movement, position setup, or whether a
  forced repeat causes an immediate loss. Tracking by origin/destination alone
  is unsafe because another piece can later occupy the square.
- **Recommended status:** `implemented-unverified`.

### Spice of Life

- **Attributable core definition:** the community catalog says, “You can’t move
  the same piece type twice in a row.”
- **Defensible executable interpretation:** remember the type of the primary
  mover on the affected player's previous turn and forbid ordinary legal moves
  by that type on the next turn. Compare the mover's type before the move.
- **Edge implications:** after any knight move, neither knight may move on the
  player's next turn. A promoting move counts as a pawn move; on later turns the
  promoted piece has its promoted type. Castling counts as a king move.
- **Ambiguities:** the source does not say whether promotion should instead be
  classified by the resulting piece, whether castling also counts as a rook
  move, or how transformed pieces interact with the rule. It also does not
  specify the result when every otherwise legal move has the prohibited type.
- **Recommended status:** `implemented-unverified`.

## Verification gaps and promotion criteria

Before changing any of these rules to `verified`, obtain an official glossary
export, creator-authored rule text, or reproducible original-site fixtures that
settle the relevant semantics. Then add the verification-policy test matrix:
positive and negative moves, edge positions, promotion, castling, en-passant,
start-of-turn/no-legal-move behavior where relevant, and at least one normal
replay fixture.

In particular, empirical replay work should target:

1. whether Lame Duck forbids castling and how an unavoidable king move ends;
2. whether Checkers recognizes en-passant and capturing promotion as triggers;
3. how Truant identifies a promoted pawn and castling's rook;
4. whether Spice of Life classifies promotion by pre-move or post-move type;
5. the common outcome when any drawback filter produces an empty move set.
