# Decision Register

**Version:** 0.1.0-draft  
**Purpose:** Separate organizer-confirmed decisions from proposed defaults and unresolved questions.

## A. Confirmed by organizer

| ID | Decision |
|---|---|
| D-001 | Product is an automated Flash Peak tournament management system using Baileys/WhatsApp. |
| D-002 | Marketing and external relations remain the organizer's responsibility. |
| D-003 | Registration data is prepared by organizer; delegates then interact with the bot to bind/confirm operational identity. |
| D-004 | One official delegate per team; multiple divisions each have their own delegate. |
| D-005 | Bot number and organizer's personal number are different. |
| D-006 | Central WhatsApp group is used for onboarding and match reports. |
| D-007 | `!onboarding` begins guided sequential onboarding. |
| D-008 | MVP supports traditional Group Stage and Knockout Stage; Swiss format is deferred. |
| D-009 | Group Stage allows draws. |
| D-010 | KO before final uses BO3; Grand Final uses BO5. |
| D-011 | BO3 means first to two game wins; BO5 first to three. |
| D-012 | Roster is five starters (one goalkeeper + four outfield) plus up to five substitutes. Five-player roster is allowed. |
| D-013 | Nicknames cannot be changed during tournament. |
| D-014 | Screenshot-based match reporting is desired. |
| D-015 | Goalkeeper detail screenshot is a separate individual-player screen. |
| D-016 | Goalkeeper avatar cue includes cap, goalkeeper gloves, and ball held in front of abdomen/chest. |
| D-017 | Goalkeeper saves are represented by the summary `DEFENSE` statistic. |
| D-018 | All required goalkeeper detail screenshots for a BO3/BO5 series are submitted after the series ends by the goalkeeper/delegate of the series-winning team. One image per game actually played. |
| D-019 | Goalkeeper award data is limited to winning matches; exact treatment of losses inside a winning series is clarified below as a provisional interpretation. |
| D-020 | Five-second sliding debounce; every new message resets the quiet window to five seconds. |
| D-021 | Use VM-based screenshot storage, reusing the Verax pattern. |
| D-022 | Use Turso for database. |
| D-023 | AI failure must be communicated; participant contacts organizer; manual fallback exists. |
| D-024 | Organizer wants PRD, FRD, AGENT.md, and supporting Markdown documentation for a swarm-mode coding agent. |
| D-025 | Baileys docs/repository must be researched and cloned into project root as a local reference if current docs are not present. |
| D-026 | Registration is open: any team that contacts the bot number is accepted. No cap on total team count. |
| D-027 | Group Stage groups are sized 5, with remainder groups sized 4 when team count is not divisible by 5 (e.g. 23 teams → 5+5+5+4+4). Every group — regardless of its size — qualifies exactly 2 teams to Knockout Stage. |
| D-028 | A tied individual Knockout game is replayed; the replay's score is added into the existing series score (e.g. series 2–1 tied again becomes 3–2), not recorded as a new standalone game outside the series. |
| D-029 | Room host within a series: default is the left-side team in the fixture, but this is a recommendation, not a strict requirement. If the designated host has no room card and the other team is willing to host instead, the match proceeds normally. If the other team is unwilling, that team is awarded the match automatically (opponent forfeits). |
| D-030 | Goalkeeper detail screenshot submission MUST include the nickname of the goalkeeper in the message text/caption (e.g. "FOTO 1 HX KINGrajj"), typed by the submitting delegate. The nickname need not match the roster exactly — fuzzy/approximate text matching against the submitting team's roster is sufficient, since only the goalkeeper/delegate of the series-winning team submits (see D-018). The caption is used only to disambiguate which goalkeeper within that team's roster the screenshot belongs to (relevant if a team has more than one registered goalkeeper); it is never used to determine which team won, since that is already fixed by submission policy. |
| D-031 | Both teams unable to provide a room card for a Group Stage fixture is treated as a double walkover: zero points each, no player statistics (same as "both teams fail to appear" in COMPETITION_RULES §6), NOT a 1–1 draw. The 1-point-each draw policy applies only to a fixture that was actually played in-game and genuinely tied. |
| D-032 | Both teams unable to provide a room card for a Knockout (BO3/BO5) fixture: the fixture MUST be rescheduled, since "no drawn series" applies in KO and there is no fair administrative score to assign. If rescheduling repeatedly fails for the same fixture, escalate to organizer for a manual ruling. |
| D-033 | Report session repeat-extension cap: a report session's expiry/escalation window (see O-012/FR-ING-008) may be extended a maximum of 3 times when new disputes/objections arrive within the current window. After the 3rd extension, the session closes under existing expiry policy regardless of new objections, and any further dispute goes to organizer review instead of auto-extending again. |
| D-034 | Left/right side assignment in Group Stage fixtures (which determines the default room-host recommendation, D-029/FR-FIX-005) must be balanced per team across its own group fixtures at fixture-generation time — no team should be stuck always-left (always expected to host) or always-right across the Group Stage. Standard round-robin scheduling (e.g. circle method) satisfies this by construction; a team's left-count and right-count across its own fixtures may differ by at most 1. See FR-COMP-013. |

## B. Proposed defaults — require organizer approval before publication

| ID | Proposed default | Why |
|---|---|---|
| P-001 | Group Stage one game per fixture | Simplifies first release; matches previous draft. |
| P-002 | Game duration eight minutes | Taken from reference rulebook; verify actual tournament preference. |
| P-003 | Kickoff 21:00 WIB | Reference rulebook. |
| P-004 | Confirmation deadline 20:00 WIB | Reference rulebook. |
| P-005 | Ten-minute grace period | Reference rulebook. |
| P-006 | Report within fifteen minutes | Operational suggestion. |
| P-007 | Group Stage win 3/draw 1/loss 0 | Conventional points model. |
| P-008 | Top two per group qualify | Conventional default, but bracket must be valid. |
| P-009 | Tiebreak order: points, GD, GF, head-to-head, playoff | Must be published before draw. |
| P-010 | Group Stage WO 3–0; KO forfeit series 0–2 or 0–3 | Adapted from reference rulebook; distinguish administrative series score from goals. |
| P-011 | `!manualreport` as admin command | Provisional command name. |
| P-012 | ~~Series host alternates~~ | **Superseded by O-007/D-029**: host is a left-side-default recommendation with opponent-substitution and forfeit-on-refusal, not an alternating rule. |
| P-013 | Report-session expiry/escalation | **Resolved by O-012/D-033**: base window configurable (10 min suggested), extendable on new disputes, capped at 3 extensions. |

## C. Goalkeeper policy — explicit interpretation to confirm

The organizer selected:
- Only the goalkeeper/delegate of the series-winning team submits goalkeeper detail screenshots after the series.
- If a BO3 requires three games, three goalkeeper detail screenshots are submitted.
- Goalkeeper award data is only for matches won.

Provisional consistent interpretation:
1. Winning-series team's goalkeeper submits one detail screenshot for every game played in that series.
2. All screenshots are retained and linked to their corresponding game.
3. If the series-winning team's goalkeeper lost an individual game within that series, that game's detail record is retained for evidence/series context but marked `award_eligible = false`.
4. Only games where that goalkeeper's team won are aggregated into goalkeeper award calculations.
5. This means the dataset is intentionally incomplete for opposing goalkeepers and is not a neutral all-player comparison. Use an award label such as `Best Winning Goalkeeper`, unless organizer chooses another approach.

This is a provisional interpretation to reconcile the two explicit rules. Do not silently change it.

## D. Open organizer decisions

All items below were open in v0.1.0-draft. Resolutions as of v0.1.1:

| ID | Question | Resolution |
|---|---|---|
| O-001 | Confirm that goalkeeper screenshot count is one per game played, including games lost by the eventual series winner, while award eligibility excludes those losses. | **Resolved — correction, not confirmation.** Screenshot count is one per game WON by the series-winning team's goalkeeper, not per game played. A BO3 2–1 submits 2 screenshots, not 3. A BO5 3–2 submits 3, not 5. Games lost within the series are not submitted at all (not "retained but ineligible" as the draft previously said). See D-018/D-019 and FR-GK-006/007 (corrected). |
| O-002 | Confirm Group Stage game duration and schedule defaults. | Game duration 8 minutes confirmed (was already the proposed default; now confirmed, not merely proposed). Kickoff/confirmation-deadline/grace-period defaults remain configurable proposed defaults pending organizer's per-season input — not blocking for MVP build. |
| O-003 | Number of groups / grouping policy per team count. | **Resolved.** See D-026/D-027: registration uncapped; groups sized 5 with remainder groups sized 4 (e.g. 23 → 5+5+5+4+4). |
| O-004 | Number qualifying from each group and bracket/bye handling. | **Resolved.** See D-027: exactly 2 per group qualify regardless of group size (5 or 4). |
| O-005 | KO draw/replay mechanism when an individual game is tied; check if in-game overtime/penalties exist. | **Resolved.** See D-028: tied game is replayed and its score is added into the existing series score, not recorded as a separate extra game. |
| O-006 | Confirm whether group stage is single round-robin and whether every team plays every other team once. | **Resolved.** Yes — single round-robin, every team in a group plays every other team in that group exactly once (4 games per team in a 5-team group, 3 games per team in a 4-team group). |
| O-007 | Confirm whether room host alternates in BO3/BO5. | **Resolved — replaced, not alternating.** See D-029: default host is the fixture's left-side team (recommendation, not strict); if unavailable and the other team agrees to host, match proceeds; if the other team refuses, that team wins by forfeit. |
| O-008 | Final tiebreak order and playoff rules. | Confirmed as already designed: BO5 Grand Final structurally prevents a drawn series ("first to three wins"); no further change needed. Group-stage tiebreak order (COMPETITION_RULES §3.2) stands as proposed, pending organizer sign-off before publication. |
| O-009 | Final WO score and double-forfeit consequences. | Group Stage double-WO (both teams absent, or both unable to provide room card per D-031) = 0 points each, no stats. KO double-forfeit-equivalent (room card unavailable both sides) = reschedule per D-032, not an administrative score. |
| O-010 | Exact provider accounts/quotas permitted under provider terms and models with image input. | **Resolved.** Use Groq, Gemini, and Ollama Cloud, all on free tier; requests are load-balanced/rotated across the three rather than fixed to one. Exact quotas/model IDs still require implementation-time verification against each provider's current terms (unchanged technical requirement). |
| O-011 | Exact media API endpoint/contract and current paths on Verax VM. Must be inspected live, not guessed. | **Resolved — design change, not just inspection.** Flash Peak tournament evidence MUST NOT be stored in the same Verax production storage/service instance. The Verax implementation (local reference: `D:\Projects\verax`) is studied only as an architectural pattern to replicate (folder layout, metadata-sidecar approach, public/private/quarantine separation). A separate storage instance/service is built for Flash Peak evidence. Reason: tournament screenshots must never be reachable through or commingled with editorial/redaksi media. See INFRASTRUCTURE.md §2–3 (revised). |
| O-012 | Report-session expiry duration and late-evidence policy. | **Resolved.** Base window remains configurable (10 minutes suggested as a starting point); a new objection/dispute arriving inside the current window extends it, capped at 3 extensions total (D-033). After the 3rd extension the session closes under expiry policy and further disputes go to organizer review. |
| O-013 | Award formulas, especially MVP/Best Defender/Best Winning Goalkeeper. | **Resolved — simplified.** No weighted formulas. Each award is a simple ranking by its one defining captured metric (e.g. Golden Boot = highest total goals, Top Assist = highest total assists), highest value wins, following existing tie-handling (co-winners on an exact tie, per prior ruling in a sibling project pattern — organizer may override per award). |
| O-014 | Confirm whether all three parties (Team A, Team B, organizer) approve every report version. This was part of prior design baseline. | **Resolved — confirmed as designed.** Yes, all three (Team A delegate, Team B delegate, organizer) must approve each report version. No change to FR-APR-001. |
| O-015 | Confirm minimum team count and bracket structure for tournaments with odd/unusual team counts. | **Resolved.** See D-026/D-027 — no minimum/cap on team count; uneven group sizes (5s and 4s) absorb any remainder, qualifiers per group stay fixed at 2 regardless of that group's size. |

## E. Change control

Any organizer decision that changes a confirmed item must:
- Update this register.
- Update PRD/FRD/rules/workflows/data model as needed.
- Include date and reason.
- Add or update tests.
- Avoid retroactively changing completed matches without an explicit ruling.
