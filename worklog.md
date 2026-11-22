# Worklog — Flash Peak TMS (TurFpeak)

## [2026-11-22] Sesi: AI-Native Feature Expansion + Hardening + Long-Term Maintainability (Task: flash-peak-tms-ai-native-expansion-v1, Branch: feat/ai-native-expansion-v1)

### Konteks Sesi
Penyempurnaan menyeluruh proyek Flash Peak TMS (TurFpeak) sesuai brief Arya 22 Nov 2026: hardening, audit fresh-eyes, fitur AI-native baru (!ai/Omak Peak, AI agent admin-eksekusi, !qna/!saveqna, engagement/trivia), dokumentasi sync, maintainability jangka panjang. Branch `feat/ai-native-expansion-v1` dibuat dari master HEAD `86b0c7f` (paling maju — semua 8 PR sebelumnya sudah merged; tidak ada PR terbuka; tidak ada review comment yang belum ditindaklanjuti).

### Pemetaan Awal (verifikasi langsung dari repo + VM)
- Clone repo, cek semua branch (8 branch selain master, semuanya 0 commit ahead of master — fully merged). `gh pr list --state=all`: 8 PR, semua merged.
- Baseline: `tsc --noEmit` 0 error; `vitest run` 258/258 PASS (20 file).
- VM (`forfh`, `20.214.143.187`, user `azureuser`, project `/home/azureuser/flashpeak-tms`) di HEAD master yang sama (tidak ada drift produksi). Tournament `Gojiha Cup S1` status `DRAW_READY` (paused by Arya pasca-draw). 16 tim, 4 grup, 24 fixture, 0 match dimainkan, 0 series, 0 report_versions, 3 audit_events (2 draw + 1 manual roster correction).
- **Temuan utang teknis #1**: `worklog.md` korupsi duplikasi berlapis — file 1206 baris berisi 5 salinan file lama ter-append berulang (header `# Worklog` muncul 5x). Total sesi unik hanya 18, 4 di antaranya HANYA ada di salinan lama. FIXED: dedupe preserving semua 18 sesi unik (1072 baris final).
- **Temuan #2**: `inbound_messages` hanya capture pesan evidence/koreksi (bukan semua chat grup). Akibatnya `!saveqna` (butuh last-10 group messages) tidak akan jalan tanpa perluasan capture. FIXED: broad capture semua TEXT message di central group (idempotent via provider_message_key UNIQUE; IMAGE messages untouched — evidence path intact).
- **Temuan #3**: AGENT.md / AGENTS.md / GEMINI.md adalah 3 copy identik (md5 sama). Dibiarkan (tidak mengganggu; dokumentasi internal).
- **Observasi**: Arya sudah publik memperkenalkan "Omak Peak" sebagai asisten bot di pesan sambutan grup (2026-11-21 08:25 WIB) — jadi persona `!ai`/Omak Peak sudah dijanjikan ke peserta; fitur ini realisasi-nya.

### Utang Lama Diselesaikan
1. **worklog.md korupsi duplikasi** — FIXED (lihat di atas).
2. **Audit log WA terbatas** — FIXED via broad text capture (AI-NATIVE-001 di `src/index.ts`).
3. Tidak ada PR terbuka / review comment yang belum ditindaklanjuti — verified.

### Fitur Baru Diimplementasikan (D-037..D-040)

**1. `!ai` Omak Peak (D-037)** — `src/application/omak-peak.ts` + `src/ai/prompts/omak-peak.ts` + `omak-peak-context.ts`
- Read-only AI chat, ANY role, open-scope (turnamen/Flash Peak/casual).
- Persona "Omak Peak": santai, percaya diri, sesekali nyentil dari sisi konteks Flash Peak; bukan generic-AI tone.
- Rolling-window rate limit 2/user/60s (`RollingRateLimiter` class, in-memory, per-sender).
- Context builder: active tournament, fixtures, standings, teams+delegates (contacts shareable per D-037), qna, rules summary — semua read-only.
- AI-unavailable graceful fallback; rate-limit message dengan retry-after hint.
- First-use/no-arg: intro message (no state write — read-only invariant preserved).

**2. Organizer AI Agent (D-038)** — `src/application/agent-planner.ts` + `agent-actions.ts`
- `!agent <instruction>`: AI menyusun rencana dari CLOSED action catalog (reopen_report, override_lock, forfeit_winner, reschedule_fixture, cancel_fixture, set_tournament_status, record_ko_game_score, announce). AI NEVER produces free-form SQL/code.
- `!agentconfirm <code>`: atomic claim PENDING→EXECUTING; transactional execute (libSQL `db.transaction('write')`); semua aksi all-or-nothing; rollback pada kegagalan.
- **Idempotency (non-negotiable)**: double-confirm EXPLICITLY rejected dengan prior outcome + timestamp (tidak silently ignored). Atomic claim via `UPDATE status='EXECUTING' WHERE plan_code=? AND status='PENDING' AND expires_at > now` — affected rows = 0 means lost the race.
- Plan TTL 10 menit; expired/cancelled/cross-organizer semua ditolak eksplisit.
- Audit trail: `audit_events` per execution (AI_AGENT_PLAN_EXECUTED / AI_AGENT_PLAN_FAILED) dengan before/after JSON + instruction + plan_code.
- Crash recovery: `recoverInterruptedPlans()` di `FlashPeakApp.start()` mark stale EXECUTING (>5 min) sebagai FAILED.
- `set_tournament_status` action menggantikan manual SQL UPDATE yang Arya lakukan di VM pasca-draw (worklog 2026-11-21).
- Test idempotency + transactional rollback + cross-organizer reject + crash recovery: `tests/unit/ai_native.test.ts` (29 tests).

**3. `!qna` / `!saveqna` (D-039)** — `src/application/qna.ts`
- `!qna` (ANY): list living FAQ.
- `!saveqna [n]` (ORGANIZER): AI ekstrak Q&A dari last-N (default 10, max 50) group messages. AI decides mana Q&A valid vs obrolan (no rigid heuristic). Dedup via AI marking + UNIQUE(question, answer) constraint. Rate guard 30s cooldown.
- Bergantung pada broad text capture (AI-NATIVE-001).

**4. Engagement & Hiburan (D-040)** — `src/application/engagement.ts` + `trivia.ts`
- `EngagementService.buildHypeRecap(facts)`: 2-4 kalimat hype setelah KO series selesai. Facts dari DB (skor, margin, round); AI format presentation only; never invents in-match events. Wired di `handleKoGameEvidenceMessage` (detached follow-up, non-blocking).
- `EngagementService.buildChampionCelebration(facts)`: pesan juara saat Grand Final selesai. Wired di tempat yang sama.
- `!trivia`: random verified Flash Peak fact dari curated JSON DB (`src/data/flashpeak-trivia.json`, researched via web at dev time). Runtime AI only rephrases; never invents.
- `!quiz`: quiz question + delayed answer reveal (15s).
- `!pantun`: AI-generated pantun (no factual claims; safe to invent).
- Group-stage report-lock hype: designed tapi belum di-wire ke approval flow (documented as follow-up — wiring ke flow yang well-tested riskier; service siap).

### Foundation Changes
- **Migration 004** (`migrations/004_ai_native_features.sql`): `ai_action_plans` (plan_code UNIQUE, status CHECK PENDING/EXECUTING/EXECUTED/EXPIRED/CANCELLED/FAILED) + `qna_entries` (UNIQUE question+answer). `provider_usage` CHECK expanded via table rebuild (rename-copy-drop) untuk task_type baru.
- **AITaskType** (`src/shared/types/index.ts`): +CHAT_OMAK_PEAK, PLAN_AGENT, EXTRACT_QNA, FORMAT_HYPE, GENERATE_PANTUN, REPHRASE_TRIVIA.
- **Broad text capture** (`src/index.ts` AI-NATIVE-001): semua TEXT message di central group di-capture ke `inbound_messages` (idempotent; IMAGE untouched).
- **AI-native command registration** (`src/application/ai-native-commands.ts`): module terpisah agar `tournament-commands.ts` (3729 baris) tidak tambah besar. Modularisasi precedent dilanjutkan.
- **Flash Peak trivia DB** (`src/data/flashpeak-trivia.json`): 21 fakta + 10 quiz, terverifikasi via web research (Google Play com.moco.crgame, flashpeak.net, Threads/@apixelart, duniagames.co.id). Fakta: developer Moco Studios/Garena, 4v4 arcade, 5-min match, third-person single-character, no offside, Free Fire crossover characters (Shirou/Homer/Alvaro/Kelly/Hayato/Moco), 7 ranked tiers, dll.

### Bukti & Verifikasi Empiris
- `npx tsc --noEmit`: **0 error** (clean).
- `npx vitest run`: **287/287 PASS** (21 file; 258 lama + 29 baru di `tests/unit/ai_native.test.ts`; 0 regresi).
- Migration 004 apply test: fresh `:memory:` DB via `runMigrations` → tables `ai_action_plans`, `qna_entries`, `provider_usage` ada; CHECK constraint include `EXECUTING` + `CHAT_OMAK_PEAK`.
- Test spesifik idempotency: double-confirm rejected dengan "SUDAH DIEKSEKUSI" + "idempotency"; expired plan rejected; cancelled plan rejected; cross-organizer rejected; transactional rollback (2-action plan dengan action ke-2 invalid → tournament status TIDAK berubah, plan FAILED, audit_event AI_AGENT_PLAN_FAILED tercatat); crash recovery (stale EXECUTING >5min → FAILED dengan "Interrupted" reason).
- Test rate limiter: 2 uses dalam 60s allowed, 3rd rejected dengan retryAfterMs 30-45s; rolling window (oldest expires → 3rd allowed); per-sender独立.
- Test catalog preview: reopen_report rejects unknown fixture / non-COMPLETED status; forfeit_winner rejects winning_team_id not in fixture; catalog.toPromptJson lists all 8 action_ids.
- Test qna: listEntries empty-state + with entries; extractAndSave graceful when no messages; rate-guard 30s.
- Test trivia: loads curated DB; randomFact returns content; randomQuiz returns Q+A.

### Audit Fresh-Eyes (REPORTED, tidak difix kecuali in-scope)
1. **[LOW] Approval flow tidak transactional** (`src/reports/approval.ts:180-260`): insert approval + check 3-approval + LOCK transition adalah separate `db.execute`, tidak wrapped dalam transaction. Crash di antara bisa meninggalkan version dengan 3 approval tapi status PENDING_APPROVAL. Tidak difix (flow well-tested; WhatsApp messages sequential; practical impact near-zero; changing risks regression).
2. **[LOW] Numeric-index column access fragility** (widespread `rows[0][0]`): works (libsql rows array-like) tapi fragile kalau SELECT column order berubah. Tidak difix (cosmetic; menyentuh banyak file).
3. **[RECOMMENDATION] AI-first nickname-to-roster matching**: tiered deterministic matcher (`src/reports/validation.ts`, added 2026-11-21) working dengan zero false positives. Enhancement: pass roster di MAIN_MATCH_PROMPT trusted context, AI propose matched_player_id, deterministic matcher sebagai authoritative fallback. Tidak diimplement di PR ini (changing extraction schema/prompt warrants separate review; current state solid). Design sketch di PR description.
4. **[RECOMMENDATION] Modularisasi `tournament-commands.ts` (3729 baris)**: AI-native commands sudah dipisah ke `ai-native-commands.ts`. Full decomposition (standings-awards, schedule, draw, teams, roster, roomcard, wo, knockout, rules) recommended sebagai PR terpisah (pure code-motion, behavior-preserving).

### Audit Log WA (Task #3 — report only)
Scan `logs/bot-out.log` (14344 lines, covering 2026-11-20 to 2026-11-21) + `inbound_messages` (27 rows) di VM. Central tournament group: `120363412423738009@g.us`. Arya LID: `165210883154071@lid`.
- **Tidak ada pertanyaan peserta yang kelewat** dalam window yang ter-log. Arya sangat responsif (typikal <30s).
- Contoh Q&A terverifikasi terjawab: "besok main harus bgt jam 8?" → "nggak bang" + "jadi dimulai dari 20.00 besok sampai 19.59 lusa"; "Sehari 1 ronde?" → "sehari 1 ronde"; "Ngitungnya manual apa pake bot?" → "bot" + explanation; "GK ku 2 bisa ga?" → "masukin ke cadangan"; "Cadangan ku penuh 3" → "sesuaiin itu bg"; "klao jam 7?" → "tergantung perjanjian sama lawannya".
- Catatan: bot sudah restart 47x, jadi history log terbatas (~1.9MB). Pesan TEXT sebelum broad-capture fix tidak persistent di DB (hanya di stdout log). Setelah deploy PR ini, future messages akan persistent → audit capability lebih baik ke depan.

### Dokumentasi Diupdate
- `DECISIONS.md`: +D-037 (Omak Peak), D-038 (Agent), D-039 (QnA), D-040 (Engagement) — confirmed per task brief 2026-11-22.
- `README.md`: section "AI-native expansion" baru.
- `DATA_MODEL.md`: `ai_action_plans`, `qna_entries`, `provider_usage` CHECK expansion.
- `PROMPT_CATALOG.md`: §12 — 6 prompt baru (omak_peak_chat_v1, agent_planner_v1, qna_extractor_v1, engagement_formatter_v1, pantun_generator_v1, trivia_rephrase_v1).
- `WORKFLOWS.md`: §13 — flows untuk !ai, !agent/confirm/cancel, !qna/!saveqna, engagement hooks.
- `MANIFEST.json`: version 0.2.0-draft, changelog, research sources updated (Flash Peak game sources).
- `worklog.md`: entry sesi ini + dedup fix.

### File yang Berubah
- New: `migrations/004_ai_native_features.sql`, `src/application/{omak-peak,agent-actions,agent-planner,ai-native-commands,qna,engagement,trivia}.ts`, `src/ai/prompts/{omak-peak,omak-peak-context}.ts`, `src/data/flashpeak-trivia.json`, `tests/unit/ai_native.test.ts`.
- Modified: `src/index.ts` (broad capture + AI-native wiring + engagement hooks + agent recovery), `src/shared/types/index.ts` (AITaskType expansion), `worklog.md` (dedup + this entry), `flash-peak-tms/{DECISIONS,README,DATA_MODEL,PROMPT_CATALOG,WORKFLOWS}.md`, `flash-peak-tms/MANIFEST.json`.

### Hal yang Dipertimbangkan tapi Sengaja Tidak Diubah
- Approval flow transactionality (LOW risk, well-tested; separate PR).
- tournament-commands.ts modularization (separate PR, pure code-motion).
- AI-first nickname matching (separate review; current tiered matcher solid).
- AGENT.md/AGENTS.md/GEMINI.md triplicate (cosmetic; tidak mengganggu).

## [2026-11-21] Sesi Fitur: Implementasi Tiered Player-to-Roster Matcher (Task: flash-peak-tms-tiered-roster-matcher-v1)

### Konteks Sesi
Pengujian screenshot pertandingan tim Agility Starlight mengungkap bahwa pemain yang terdaftar dengan variasi karakter Unicode / titik pemisah (seperti `AGIㆍIshikawa` vs `AGI • Ishikawa`, atau `AGIㆍL∆RZZ☢️` vs `AGI • LΛRZZ ☣`) gagal dicocokkan oleh kode validator backend (`src/reports/validation.ts`) meskipun AI Vision berhasil membaca teks screenshot dengan sempurna. Investigasi pada seluruh 16 tim di database (`local.sqlite`) menemukan bahwa kesamaan clan tag (seperti `AVO`, `7SB_`, `TZ`, `AGI`) membuat pemain dalam tim yang sama memiliki kemiripan bawaan hingga 66.7% - 80% (misal `TZ Kuroko` vs `TZ Kurona` 80%). Oleh karena itu, penggunaan threshold similarity tunggal yang rendah (misal 60%) berisiko tinggi menyebabkan salah identifikasi / tertukarnya pemain. Dibutuhkan sistem pencocokan bertingkat (*Tiered Matching*) yang tangguh terhadap variasi dekoratif dan typo OCR minor dengan jaminan zero false positives.

### Langkah & Perubahan yang Dieksekusi
1. **Peningkatan Mesin Pencocokan Roster (`src/reports/validation.ts`)**:
   - Menambahkan fungsi `cleanSearchKey(nick: string)`: menormalkan string ke NFKD, huruf kecil, dan membuang semua karakter non-alfanumerik (`[^a-z0-9]`).
   - Menambahkan fungsi `computeSimilarity(str1: string, str2: string)` berbasis Levenshtein distance dari `fastest-levenshtein`.
   - Mengimplementasikan `matchPlayerToRoster(raw: RawPlayerMatchStat, roster: Player[])`:
     - **Tier 1 (Exact Raw Match)**: `raw.nickname_raw === p.nickname_raw`.
     - **Tier 2 (NFC Normalized Match)**: `normalize(raw) === normalize(p)`.
     - **Tier 3 (Clean Alphanumeric Key Match)**: mencocokkan `cleanSearchKey` dari input terhadap `cleanSearchKey(p.nickname_raw)` atau `p.nickname_search_key`. Ini secara otomatis mengatasi perbedaan titik pemisah (`•` vs `ㆍ`), spasi, simbol clan tag (`|`, `〆`, `☣`, `☢️`), dan variasi alfabet dekoratif (`∆` vs `Λ`) dengan skor 100% cocok.
     - **Tier 4 (Safe Fuzzy Match)**: Ambang batas minimum similarity `>= 0.75` **DAN** wajib memiliki selisih skor (*safety margin gap*) `>= 0.15` di atas kandidat runner-up dalam tim. Jika selisih terlalu tipis / ambigu (misal typo di antara dua pemain mirip), sistem menolak tebakan (*returns null*) dan mewajibkan konfirmasi manual.
2. **Sinkronisasi Pemetaan Goalkeeper Saves (`src/application/evidence-batch-processor.ts`)**:
   - Memperbarui fungsi `resolvePlayerSaves` agar juga memeriksa kesamaan `cleanSearchKey`, sehingga saves dari screenshot detail kiper tetap terpetakan dengan benar meski ada perbedaan simbol dekoratif di summary screen.
3. **Penambahan Test Suite Permanen (`tests/unit/reports.test.ts`)**:
   - Menambahkan describe block `Tiered Player-to-Roster Matcher (Zero False Positives & OCR Resilient)` yang menguji:
     - Exact raw dan NFC matching.
     - Stylized OCR variations (`AGI • Ishikawa` ➔ `AGIㆍIshikawa`, `AGI • ZKII☣` ➔ `AGIㆍZKII☣`, `AGI • LΛRZZ ☣` ➔ `AGIㆍL∆RZZ☢️`).
     - Safe fuzzy match untuk typo minor 1 karakter.
     - Penolakan input ambigu dengan safety gap < 15% (kasus `TZ Kuroko` vs `TZ Kurona`).
     - Penolakan tegas pemain tak terdaftar (`AGI • DIKZ`).

### Bukti & Verifikasi Empiris
- **Unit & Integration Tests**:
  - `npx vitest run tests/unit/reports.test.ts`: **25 tests passed (100%)**.
  - `npm run build` (`tsc`): **Clean compile tanpa error (Exit code 0)**.
- **Validasi terhadap Screenshot Agility Starlight**:
  - `AGI • LΛRZZ ☣` ➔ Cocok ke Slot 1 (`AGIㆍL∆RZZ☢️`) via Tier 3.
  - `AGI • Ishikawa` ➔ Cocok ke Slot 3 (`AGIㆍIshikawa`) via Tier 3.
  - `AGI • ZKII☣` ➔ Cocok ke Slot 2 (`AGIㆍZKII☣`) via Tier 3.
  - `AGI • DIKZ` ➔ Ditolak (Pemain Tidak Terdaftar, skor tertinggi di tim hanya 57.1%).

---


## [2026-11-21] Sesi Operasional VM: Pause Turnamen ke DRAW_READY Pasca-Draw (Task: flash-peak-tms-pause-draw-ready-v1)

### Konteks Sesi
Pengundian grup (`!draw`) untuk turnamen `Gojiha Cup S1` telah sukses dilaksanakan oleh Arya. Sesuai aturan sistem, command `!draw` mentransisikan status turnamen menjadi `ACTIVE`. Namun Arya menghendaki pertandingan baru dimulai besok dan tidak ingin cutoff harian 19:59 WIB mengevaluasi Double Walkover (D-031) pada sisa malam ini atau sebelum turnamen resmi dimulai besok.

### Langkah & Perubahan yang Dieksekusi
1. **Pengecekan Status Turnamen & Data Pasca-Draw di VM**:
   - Status sebelum perubahan: `ACTIVE` (ID: `14ec8b3d-e3b1-41d6-8af2-1b23734d3ff3`, 16 tim terbagi ke Grup A-D, 24 fixtures fase grup terbentuk).
2. **Eksekusi Transisi Status**:
   - Menjalankan update status database di VM (`forfh`):
     `UPDATE tournaments SET status = 'DRAW_READY', updated_at = <now_iso> WHERE id = '14ec8b3d-e3b1-41d6-8af2-1b23734d3ff3'`
   - Status baru: `DRAW_READY`.
3. **Verifikasi Efek Operasional**:
   - `MatchdayService` hanya memproses turnamen dengan `status = 'ACTIVE'`, sehingga:
     - Cutoff 19:59 WIB harian menjadi no-op.
     - Pengingat otomatis (17:00 dan 18:59 WIB) tidak akan tertrigger.
   - Seluruh data grup, 24 fixtures, klasemen, tim, dan delegasi tetap utuh dan aman.

### Bukti & Verifikasi Empiris
- **Status Sebelum**: `Status: ACTIVE`
- **Status Sesudah**: `Status: DRAW_READY` (diperbarui di `local.sqlite` pada `2026-11-21T14:25:55Z`).

---


## [2026-11-21] Sesi Follow-up 3: Fix Blocker & Quick-Wins dari Second-Opinion Review PR #8 (Task: flash-peak-tms-followup-roundcode-blocker-v1, Branch: audit/verify-fix-v1)

### Konteks Sesi
Second-opinion review independen atas PR #8 (`PR8_second_opinion_review.md`) menemukan 1 blocker + 2 quick-win sebelum merge. Ketiganya difix di branch yang sama, regression penuh per commit, tidak merge/push (keputusan merge tetap milik Arya). Catatan konteks dari Arya: untuk turnamen ukuran Gojiha (16 tim: 4 grup isi 4 → 8 kualifikasi → QF 4 fixture → SF 2 → Final 1) blocker ini TIDAK kena karena jumlah fixture tiap ronde selalu unik; blocker relevan di turnamen besar (≥6 grup / ≥24 tim, possible karena `!addteam` tanpa cap). Tetap wajib difix sebelum merge agar tidak meledak diam-diam di turnamen besar nanti.

### Item 1 — blocker-roundcode FIXED: label ronde dari histori ronde di DB, bukan jumlah fixture
- **Root cause (dibaca ulang sebelum fix):** `generateKnockoutFixtures` menurunkan `round_code` dari JUMLAH MATCH ronde itu (`fixtures.ts` lama: 1→FINAL, 2→SEMI_FINAL, 4→QUARTER_FINAL, selain itu→ROUND_OF_16 default). Dua ronde berbeda bisa kebetulan punya jumlah fixture yang sama-sama "non-standar" (mis. 6 grup → 12 kualifikasi → 6 fixture, lalu 6 pemenang → 3 fixture — keduanya jatuh ke default ROUND_OF_16). Karena `!startknockout` mengumpulkan pemenang via `WHERE round_code = <label terakhir>`, label ganda membuat pemenang ronde LAMA ikut ter-draw ulang — tim yang sudah tersingkir hidup lagi dan turnamen tidak pernah konvergen (terkonfirmasi reviewer via dry-run end-to-end).
- **Fix:** fungsi baru `deriveKnockoutRoundCode(db, tournamentId, matchCount)` di `src/competition/fixtures.ts`:
  1. Baca SEMUA label ronde knockout yang sudah tercatat di DB turnamen ini.
  2. Pilih label "natural" sesuai jumlah match (1→FINAL, 2→SEMI_FINAL, 4→QUARTER_FINAL, 8→ROUND_OF_16, 16→ROUND_OF_32) — supaya turnamen ukuran normal labelnya persis seperti dulu.
  3. Ronde 1-match SELALU FINAL (ronde setelahnya mengakhiri turnamen — by definition).
  4. Bila label natural sudah dipakai, maju sepanjang progresi (ROUND_OF_32→ROUND_OF_16→QUARTER_FINAL→SEMI_FINAL→FINAL) ke label yang belum dipakai. Khusus jumlah match non-standar (natural=null, mis. pool ganjil 3 fixture): scan dimulai SETELAH label terdalam yang sudah dipakai, sehingga label selalu MENYEMPIT (ronde setelah ROUND_OF_16 jadi QUARTER_FINAL, tidak pernah mundur ke ROUND_OF_32).
  5. Bila seluruh progresi habis (bracket ekstrem / pool ganjil beruntun), fallback ke label generik unik `KNOCKOUT_ROUND_<n>` — label tidak pernah bisa duplikat.
- **Fix pendukung (efek samping blocker yang sama):** `getActiveTournamentCurrentRound` di `matchday-service.ts` dulu mengurutkan ronde knockout secara LEKSIKALIS (`round_code ASC` → FINAL < QUARTER_FINAL < ROUND_OF_16 secara alfabetis — salah). Kini diurutkan menurut RANK progresi (R32→R16→QF→SF→FINAL), label di luar progresi (fallback `KNOCKOUT_ROUND_n`) diurutkan by first-seen `created_at` — berlaku untuk `allRounds` dan deteksi "ronde aktif" (ronde belum-selesai paling awal).
- **Dry-run reproduksi skenario PERSIS reviewer** (`verify-artifacts/check_roundcode_fix.mts`, semua via `!startknockout` + CommandRouter sungguhan):
  - PART 1 — 6 grup / 24 tim / 12 kualifikasi (skenario reviewer): label `ROUND_OF_32 → ROUND_OF_16 → QUARTER_FINAL → FINAL`, SEMUA label unik, TIDAK ADA tim tersingkir yang hidup lagi (diperiksa lintas ronde: tim yang kalah di ronde N tidak pernah muncul di ronde >N), turnamen KONVERGEN sampai FINAL. (Sebelum fix: ronde 2 & 3 sama-sama ROUND_OF_16, tim T5/T9/T11 yang sudah tersingkir ikut di-draw lagi, turnamen berputar selamanya.)
  - PART 2 — regression ukuran Gojiha (16 tim, 8 kualifikasi): label `QUARTER_FINAL → SEMI_FINAL → FINAL` — **identik perilaku lama**, tidak ada perubahan yang terlihat delegasi.
  - PART 2b — regression 16 kualifikasi: `ROUND_OF_16 → QUARTER_FINAL → SEMI_FINAL → FINAL` — identik perilaku lama.
  - PART 3 — progresi habis (8 ronde beruntun): fallback `KNOCKOUT_ROUND_6/7/8` — semua unik, tanpa kolisi.
  - Skenario reviewer lain (`review_roundcode_collision`): ronde 2 kini berlabel `QUARTER_FINAL` (dulu ROUND_OF_16 ganda); peserta ronde 2 = survivor ronde 1 semata.
- **Test permanen baru** (`tests/unit/competition.test.ts`, describe `REVIEW-FIX blocker-roundcode`): (a) ronde lebar 8 fixture ROUND_OF_16 disusul pool ganjil 7 survivor (3 fixture) → label QUARTER_FINAL (menyempit, unik, bukan ROUND_OF_32) + anti-self-match; (b) ronde 1-match SELALU FINAL + BO5 meski label lebih awal sudah terpakai.

### Item 2 — quickwin-shuffle-validation FIXED: validasi draw berdasarkan multiset team_id
- **Root cause:** validasi lama `new Set(drawn).size !== drawn.length` membandingkan IDENTITAS OBJEK — shuffle curang yang return objek BARU dengan `team_id` tertukar/terduplikasi lolos validasi dan bisa menghasilkan self-match X vs X (serangan persis reviewer, tadinya "DITERIMA (bug!)").
- **Fix:** hasil draw divalidasi berdasarkan multiset `team_id` — array `team_id` hasil shuffle harus PERSIS sama (sorted) dengan pool pra-draw; tambah/kurang/gandakan/mutasi team_id semuanya ditolak dengan error yang sama.
- **Bukti** (`verify-artifacts/check_quickwins_fix.mts` PART A): serangan reviewer (mutasi team_id antar objek) kini **DITOLAK**; duplikat elemen & elemen hilang tetap ditolak; shuffle sah (reverse, return-same-reference) tetap diterima tanpa self-match. Test permanen baru juga ditambahkan di `tests/unit/competition.test.ts` (describe `REVIEW-FIX quickwin-shuffle-validation`).

### Item 3 — quickwin-group-null-message FIXED: pesan knockout tanpa "(Grup null)", regulasi D-032
- **Root cause:** `formatMatchdayStatus` (!matchday) dan reminder H-3/H-1 (matchday-service.ts) men-draft `(Grup ${pf.groupCode})` untuk semua fixture — fixture knockout punya `groupCode` null → "(Grup null)" terlihat peserta; dan selalu menyebut D-031 (double walkover babak grup) meski yang pending fixture knockout (regulasinya D-032 double-loss + bye).
- **Fix:** label per-stage — fixture knockout ditampilkan `(Knockout)`, fixture grup tetap `(Grup X)`; regulasi dikutip per-stage: D-031 hanya bila ada fixture grup pending, D-032 (KALAH GANDA + bye otomatis) bila ada fixture knockout pending. Pengumuman cutoff (yang sudah benar sejak T17) tidak diubah.
- **Bukti** (`check_quickwins_fix.mts` PART B): B1 ronde SEMI_FINAL KO pending → "(Knockout)" + D-032, tanpa "(Grup null)", tanpa D-031; B2 regression ronde grup MD1 → "(Grup A)" + D-031 persis wording lama, tanpa "(Knockout)"/D-032.

### Regression Gate (dijalankan setelah SEMUA fix)
- `npx tsc --noEmit`: clean (0 error).
- `npx vitest run`: **253/253 PASS** (20 file; 250 test lama + 3 test permanen baru).
- Seluruh 24 skrip `verify-artifacts/check_*.mts` + 2 dry-run audit lama: semua exit 0, termasuk `check_t2_fix` (T2-FIX VERIFIED), `check_bracket_redraw` + `check_bracket_redraw_e2e` (BRACKET-REDRAW VERIFIED), `check_t17_fix` (T17-FIX VERIFIED), dan semua check T1–T18 lainnya — tidak ada regresi perilaku lama.
- ESLint `src`: 7 warning / 0 error — seluruhnya pre-existing (identik sebelum & sesudah perubahan; diverifikasi via stash).
- Skrip dry-run reviewer asli direplay: `review_roundcode_collision` (24-tim R16 + double-loss) dan `review_6group_happy` (24-tim happy path) — keduanya kini menunjukkan label unik & konvergen tanpa tim hidup lagi. (Heuristik "FAIL" di output script lama itu basi — script itu mem-filter fixture by `round_code='ROUND_OF_16'` yang setelah fix tidak lagi jadi label ronde 2; verdict sesungguhnya di `check_roundcode_fix.mts` yang menjalankan rantai penuh.)

### Scope Sesi Ini
- File produksi berubah: `src/competition/fixtures.ts` (deriveKnockoutRoundCode + validasi shuffle), `src/application/matchday-service.ts` (label "(Knockout)"/D-031/D-032 + ordering ronde), `tests/unit/competition.test.ts` (+3 test permanen).
- Check scripts baru: `verify-artifacts/check_roundcode_fix.mts`, `verify-artifacts/check_quickwins_fix.mts`.
- Tidak ada perubahan skema/migrasi; tidak merge/push ke master.


## [2026-11-21] Sesi Follow-up 2: Keputusan Bug Baru #1 & #2 (Task: flash-peak-tms-followup-resolveidentity-fix-v1, Branch: audit/verify-fix-v1)

### Konteks Sesi
Lanjutan dari HEAD `f8287bf`. Arya memutuskan dua bug baru yang sebelumnya dilaporkan terbuka: (1) `bindDelegateToTeam` auto-VERIFIED → DITUTUP sebagai by design; (2) `resolveIdentity` 1-arg di report-correction-coordinator → PERLU DIFIX (samakan dengan router). Branch sama, regression penuh per commit, tidak merge/push.

### Item 1 — Bug baru #1 (bindDelegateToTeam auto-VERIFIED) CLOSED (by design, no fix)
Keputusan Arya 21 Nov 2026: grup WhatsApp turnamen bersifat tertutup (Arya sendiri yang memasukkan tim yang benar-benar ikut), sehingga skenario "orang asing/orang salah tim kirim format roster duluan untuk merebut status VERIFIED" secara praktis tidak akan terjadi. Perilaku "siapa cepat dia dapat" diterima sebagai aturan main yang disengaja, konsisten dengan keputusan T10. Tanpa perubahan kode.

### Item 2 — Bug baru #2 (resolveIdentity 1-arg di coordinator) FIXED — commit `50f6ab9`
**Verifikasi SEBELUM fix (sesuai prinsip):**
- Signature: `resolveIdentity(rawAddress, _sourceChatId?)` — argumen kedua **tidak dipakai sama sekali** di body (prefix underscore, nol referensi). Lookup murni by raw_address/normalized → delegate → team (T14: dibatasi turnamen ACTIVE).
- Dry-run `check_resolveidentity_1arg.mts` Part A: 1-arg vs 2-arg **identik** di semua skenario (identitas LID alias per-chat, primary phone, sender tak dikenal). Dugaan awal task ("2-arg mempersempit lookup ke alias per-chat") **TIDAK TERKONFIRMASI** — perbedaannya lebih dangkal dari dugaan, bukan lebih dalam.
- Vonis: inkonsistensi 1-arg vs 2-arg = **latent inconsistency** murni. Hari ini no-op; begitu `_sourceChatId` diimplementasikan (narrowing/audit), koordinator akan diam-diam berperilaku beda dari router untuk kasus yang sama.
- Part B (dampak nyata yang terbukti): bila resolve gagal (UNREGISTERED), koordinator fallback `sender_normalized_address` sebagai `sender_id` — non-UUID, dijamin UNAUTHORIZED di `verifyCorrectionAuthority`. Ini terjadi karena identitas memang tidak terdaftar, BUKAN karena kurang argumen ke-2 — di luar cakupan fix ini, dicatat sebagai catatan saja.

**Fix (sesuai keputusan Arya):** pemanggilan di `report-correction-coordinator.ts` kini meneruskan `message.chat_id` sebagai argumen kedua — persis seperti router. Signature & behavior `resolveIdentity` tidak diubah. Tidak ada perubahan behavior yang diharapkan; fix bersifat konsistensi call-site + future-proof.

**Regression:** tsc clean; vitest 250/250 PASS; `check_resolveidentity_fix.mts` VERIFIED (spy membuktikan koordinator kini memanggil `resolveIdentity(sender_raw_address, chat_id)`); check T6 lama tetap VERIFIED.

### Scope Sesi Ini
- File produksi berubah: `src/application/report-correction-coordinator.ts` (1 pemanggilan). Tanpa perubahan untuk item 1.
- Check scripts baru: `check_resolveidentity_1arg.mts` (verifikasi vonis), `check_resolveidentity_fix.mts` (bukti fix via spy).


## [2026-11-21] Sesi Follow-up: Keputusan Kebijakan T10/T17 + Re-draw Bracket Knockout (Task: flash-peak-tms-followup-policy-and-redraw-v1, Branch: audit/verify-fix-v1)

### Konteks Sesi
Lanjutan task verifikasi & perbaikan audit T1–T18 (HEAD awal `d9349e3`, belum merge). Arya memutuskan: (1) T10 ditutup sebagai by-design, (2) T17 harus difix — cutoff 19:59 WIB wajib berlaku di fase knockout, (3) pairing bracket ronde knockout 2+ di-DRAW ULANG setiap ronde (keputusan desain baru). Semua kerja di branch yang sama, regression penuh per commit, tidak merge/push.

### Item 1 — T10 CLOSED (by design, no fix) — commit `1254f8e`
- Dry-run `verify-artifacts/check_t10_behavior.mts` membuktikan behavior auto-bind `!roster` PERSIS seperti deskripsi keputusan Arya: pengirim pertama format roster valid untuk tim tanpa delegasi langsung ter-bind (turnamen ACTIVE, tanpa gate tambahan, tanpa konfirmasi organizer; tim jadi VERIFIED via bindDelegateToTeam); orang kedua untuk tim yang sama DITOLAK auth check; format tidak valid tidak memicu bind. Tidak ada perbedaan dari deskripsi → tidak ada temuan baru. Tanpa perubahan kode.
- Catatan: `bindDelegateToTeam` yang men-set `registration_status='VERIFIED'` tanpa syarat tetap terbuka sebagai new-bug #1 yang sudah dilaporkan sebelumnya (tidak berubah statusnya).

### Item 2 — T17 FIXED — commit `a512ad6`
- Root cause (dari verifikasi task sebelumnya): `getRoundFixturesWithDelegates` (matchday-service.ts) INNER JOIN `groups`, sehingga fixture KNOCKOUT (group_id NULL) tersaring diam-diam dan `processDailyCutoff` tidak pernah menjaringnya.
- Fix: JOIN groups → LEFT JOIN; `MatchdayFixtureItem` menambah field `stage` dan `groupId/groupCode` jadi nullable; `processDailyCutoff` dispatch per stage — fixture GROUP → `handleGroupDoubleWalkover` (D-031, 0 poin + recompute standings, tidak berubah), fixture KNOCKOUT → `handleKnockoutDoubleRoomCardFailure` (D-032 double-loss: series COMPLETED tanpa pemenang, fixture WALKOVER) — sinyal yang persis dipakai `!startknockout` untuk memberi bye ke pasangan bracket, dan penanganan pool ganjil T2 sudah mengakomodasi hasilnya. Pengumuman cutoff memisahkan regulasi D-031 (grup) dan D-032 (knockout + info bye).
- Regression: tsc clean, vitest 248/248 PASS, `check_t17_fix.mts` VERIFIED (semi KO unplayed → WALKOVER + series COMPLETED no winner + audit KNOCKOUT_DOUBLE_LOSS_RECORDED + notice bye; fixture completed tak tersentuh; regresi ronde grup: DOUBLE_ABSENT tetap jalan).

### Item 3 — bracket-redraw (keputusan desain Arya) — commits `4b960ad` + `b2a0c43`
**Verifikasi dugaan new-bug #3 (SEBELUM redesign, sesuai prinsip):**
- `check_bye_index_bug.mts`: skenario QF penuh (4 fixture, 1 double-loss) — urutan hasil query `ORDER BY created_at ASC` SAMA dengan urutan insertion bracket; bye jatuh ke pemenang fixture bersebelahan (= model pairing-slot yang diniatkan kode).
- `check_bye_index_bug2.mts`: 30 DB in-memory segar — ordering equal-created_at konsisten = insertion/rowid order, 0 mismatch.
- **Vonis: TIDAK TERKONFIRMASI secara dinamis** di environment ini; namun asumsi "ordering equal keys == insertion order" tidak kontraktual dan bisa berbeda antar engine/plan — risiko struktural terdokumentasi, dan redesign draw ulang menghapus asumsi itu sepenuhnya (tidak ada lagi kode yang memetakan posisi bracket dari index fixture ronde sebelumnya).

**Implementasi re-draw:**
- `generateKnockoutFixtures` menerima `options.shuffle` (injectable untuk determinisme test). Bila disuplai: pool genap diacak dulu lalu dipasangkan sekuensial; shuffle divalidasi (jumlah & elemen sama, tanpa duplikat) — shuffle yang curang ditolak dengan error. TANPA shuffle (ronde pertama dari kualifikasi grup): seeding klasik juara-grup vs runner-up grup bersebelahan tetap (FR-COMP-011 tidak berubah).
- `!startknockout` (ronde 2+) mempassing `cryptoFisherYates` — primitif yang sama dengan !draw babak grup. Guard anti-self-match tetap; bye pool-ganjil T2 tetap (qualifier terakhir); jalur single-survivor → juara otomatis TIDAK diubah.
- Audit event `KNOCKOUT_ROUND_GENERATED` kini mencatat `drawMethod: 'RE-DRAW (cryptoFisherYates)'`, pasangan hasil draw (`drawnPairings`), dan `byeTeamId`; pengumuman grup menyatakan pasangan ditentukan lewat "DRAW ULANG".

### Bukti & Verifikasi Empiris
- Per commit: `npx tsc --noEmit` clean + `npx vitest run` hijau (248/248 untuk T10/T17/verify; **250/250** setelah 2 test permanen baru masuk di `b2a0c43`).
- Test permanen baru (tests/unit/competition.test.ts): (a) ronde 2+ berpasangan sesuai shuffle injectable (bukan pseudo-rank split lama) + anti-self-match + shuffle curang ditolak; (b) pool ganjil 3 → 1 fixture FINAL + bye qualifier terakhir.
- Dry-run: `check_t10_behavior.mts`, `check_t17_fix.mts`, `check_bye_index_bug.mts`, `check_bye_index_bug2.mts`, `check_bracket_redraw.mts` (QF klasik → SF re-draw sesuai shuffle → FINAL+bye pool ganjil), `check_bracket_redraw_e2e.mts` (rantai penuh `!startknockout` via CommandRouter: SF → FINAL → series COMPLETED; skenario QF double-loss → 3 survivor unik → FINAL + bye + notice DRAW ULANG) — semua VERIFIED.
- Temuan menarik dari E2E: 8 tim QF + satu double-loss menghasilkan 3 survivor unik (penerima bye = pemenang fixture partner yang memang sudah seed) → 1 FINAL + 1 bye — konsisten semantik T2, bukan bug.
- Scope: 4 commit baru di atas `d9349e3` (`1254f8e`, `a512ad6`, `4b960ad`, `b2a0c43`); file produksi berubah: `src/application/matchday-service.ts`, `src/application/tournament-commands.ts`, `src/competition/fixtures.ts`, `tests/unit/competition.test.ts`. Tidak merge/push (menunggu review Arya).


## [2026-11-21] Sesi Verifikasi & Perbaikan Temuan Audit Independen T1–T18 (Task: flash-peak-tms-verify-and-fix-audit-v1, Branch: audit/verify-fix-v1)

### Konteks Sesi
Audit independen fresh-session (Laporan_Audit_FlashPeak_TMS.pdf, 29 asersi dry-run, master @03f8860, 21 Nov 2026) melaporkan 18 temuan (T1–T18). Sesuai instruksi tugas: SETIAP temuan diverifikasi ulang dulu terhadap kode master @03f8860 (clone baru, read-only) SEBELUM perbaikan apa pun. Hasil verifikasi: **18/18 TERKONFIRMASI** (2 dengan koreksi mekanisme: T7 race hanya mungkin antar-event upsert terpisah karena handler memproses pesan secara berurutan; T17 no-op terjadi karena INNER JOIN groups menyaring fixture knockout secara diam-diam, bukan crash). Tidak ada temuan yang tidak terkonfirmasi. Laporan lengkap per temuan (status + bukti file:baris + hasil dry-run): `verify-artifacts/VERIFICATION_REPORT.md`.

### Perubahan Konkret (15 fix, satu commit per temuan di branch `audit/verify-fix-v1`)
1. **T1+T7+T11** (`15802c3`): `applyKoGameEvidence` — hapus Guard 3 (duplikat berbasis pasangan skor lintas-slot; pasangan skor bukan identitas game — BO3 sah bisa punya dua game 2-0, guard membekukan series di 1-0). Deteksi duplikat kini slot-scoped dan seluruh derive-slot + cek duplikat + apply berjalan dalam SATU transaksi write (mengserialisasi dua foto konkuren, T7). Status jurnal `NEEDS_REVIEW` yang tidak pernah di-set dihapus dari tipe/status/outcome (T11).
2. **T2** (`98a3564`): `generateKnockoutFixtures` — jumlah survivor ganjil (mis. 3 pasca bye double-loss D-032) tidak lagi throw "Jumlah juara grup harus sama..."; qualifier TERAKHIR menerima bye, pool genap dipasangkan; bye dikembalikan via `byeTeamId` dan diumumkan `!startknockout`.
3. **T3** (`759a85f`): `getOrganizerIdentities` — setiap identitas phone diperluas dengan varian `<digits>@s.whatsapp.net` (dan sebaliknya), sehingga deployment yang hanya set `WA_ORGANIZER_PHONE` tidak lagi menolak suara approval ORGANIZER (`!approve` memakai JID normalized sebagai approverId).
4. **T4** (`664a33b` + `fedef9c`): `resolveFixtureForMessage` — ketiga query kini memfilter `f.stage = 'GROUP'`; foto polos tanpa caption `!kogame` tidak lagi bocor membuat draf BO1 paralel untuk series BO3/BO5. Test integrasi FR-FAIL yang premisnya memakai fixture KNOCKOUT via jalur BO1 diganti fixture GROUP (intent test dipertahankan).
5. **T5** (`03104d1`): `recordSeriesGameResult` menerima `allow_completed_series` (default false); hanya `!kores` yang menyetelnya — re-record game di series COMPLETED kini benar-benar berfungsi (decrement + recompute) sesuai janji dokumentasi. Pipeline foto tetap menolak series COMPLETED.
6. **T6** (`d5af62b`): flag `is_organizer` diteruskan dari `CommandRouter.isSenderOrganizer` di `handleInboundMessage` → `handleCorrection` → `handleReportCorrection` → `applyReportCorrection`; koreksi NL organizer tidak lagi ditolak "Unauthorized sender".
7. **T8** (`3d76d7d`): blok 1.5 `handleInboundMessage` — konfirmasi plain-text ('ok'/'ya'/...) dan koreksi draf manual report kini di-gate `isSenderOrganizer`; anggota grup biasa tidak bisa lagi "menembakkan" draf organizer (`confirmPending` memang memakai `is_organizer: true` hardcoded).
8. **T9** (`b57bc95`): intersepsi `!kogame` hanya berlaku bila ada foto; teks `!kogame <fixture_id>` (status lookup yang terdokumentasi di cara-penggunaan.md) kini sampai ke handler router yang memang mengimplementasikannya.
9. **T12** (`6c275b9`): `isOrganizerAuthorized` di manual.ts — pola `startsWith('org_')`/`includes('organizer')` dihapus (pola yang sama yang FIX2-APR-003 bersihkan dari approval.ts); tersisa flag eksplisit + konstanta 'ORGANIZER'.
10. **T13** (`4b9b84f`): `handleInboundMessage` menolak pesan dari grup selain grup resmi SEBELUM jalur KO-pipeline/NL-intent/koreksi/bukti berjalan (FR-ID-005); DM organizer & bootstrap `!setgroup` tidak terpengaruh.
11. **T14** (`375544d`): lookup tim di `resolveIdentity` kini mengurutkan berdasar status turnamen (ACTIVE dulu, lalu status berjalan, COMPLETED/ARCHIVED terakhir, terbaru dulu) — delegasi lintas turnamen tidak lagi resolve ke tim turnamen lama.
12. **T15** (`54dd175`): `deriveKnockoutQualifiers` memanggil `recalculateAndPersistGroupStandings` (mesin yang sama dengan `!standings`) per grup, bukan SQL duplikat points/GD/GF — kualifikasi knockout kini identik dengan klasemen yang ditampilkan (tie H2H tuntas); seri PENUH di batas kualifikasi tetap throw untuk keputusan manual.
13. **T16** (`d1b50ef`): `handleManualReport` menolak fixture `stage = 'KNOCKOUT'` dengan arahan ke `!kores` (draf BO1 paralel untuk series BO3/BO5 tidak lagi mungkin via tangan organizer).
14. **T18** (`2853a51`): alias typo `!mulainokout` diganti `!mulaiknockout` (ejaan benar).
15. **Docs** (`298415a`): cara-penggunaan.md bagian "Kalau Ada Masalah di Knockout" disesuaikan dengan semantik baru (slot-based; janji re-record series selesai kini benar; janji NEEDS_REVIEW dihapus).

### DITUNDA (butuh keputusan organizer Arya — TIDAK difix buta)
- **T10** (delegasi tim tanpa delegate dapat direbut via `!roster` auto-bind): fitur self-registration yang disengaja; fix butuh kebijakan (batasi hanya saat status REGISTRATION/ONBOARDING vs wajib konfirmasi organizer untuk tim buatan panitia). Status: REPORTED / PENDING_APPROVAL.
- **T17** (cutoff 19:59 no-op pada ronde knockout): `getRoundFixturesWithDelegates` INNER JOIN groups sehingga fixture KO (group_id NULL) tak pernah diproses; fix butuh kebijakan D-031 vs D-032 (deadline KO: double-WO? reschedule wajib? reminder saja?). Status: REPORTED / PENDING_APPROVAL.

### Bug Baru di Luar Daftar Temuan (REPORTED, TIDAK difix — sesuai prinsip lapor dulu)
1. `bindDelegateToTeam` men-set `registration_status='VERIFIED'` tanpa syarat (`resolver.ts:346`) — tim yang belum onboarding langsung VERIFIED; terkait T10 tapi dampak lebih luas.
2. `report-correction-coordinator.ts:89` memakai `resolveIdentity` versi 1-arg (mengabaikan alias per-chat) — inkonsisten dengan router yang memakai 2-arg; delegasi multi-alias bisa gagal resolve di jalur koreksi.
3. Dugaan salah pasangan bye di `!startknockout`: partner bye dihitung dari INDEX array fixture (`tournament-commands.ts:2923-2924`), padahal pasangan bracket tidak dijamin bersebelahan index setelah `ORDER BY created_at` — bye bisa diberikan ke tim yang bukan pasangan double-loss. Perlu verifikasi lanjutan sebelum fix.

### Bukti & Verifikasi Empiris
- **Baseline sebelum verifikasi**: `npx tsc --noEmit` clean; `npx vitest run` **248/248 PASS** (20 file) @03f8860.
- **Verifikasi temuan (sebelum fix)**: `npx tsx verify-artifacts/dryrun_verify_tms_audit.ts` (7 asersi) + `npx tsx verify-artifacts/dryrun_verify_tms_audit2.ts` (6 asersi) — 13/13 PASS (PASS = temuan audit ter-reproduksi). Temuan lain diverifikasi via trace kode (T4, T9, T13, T14, T18).
- **Regression per fix** (jalankan SETIAP commit fix): `npx tsc --noEmit` clean + `npx vitest run` **248/248 PASS** + targeted check `npx tsx verify-artifacts/check_t<N>_fix.mts` → semua **VERIFIED**:
  ```text
  T1-FIX VERIFIED   (game2 2-0 legiter GAME_APPLIED→SERIES_COMPLETE 2-0; tied-slot resend DUPLICATE; late photo IGNORED)
  T2-FIX VERIFIED   (3 survivor→1 fixture+bye; 5→2+bye; 4→2 tanpa bye; 2→FINAL)
  T3-FIX VERIFIED   (phone-only config: identities=[digits, digits@s.whatsapp.net], approverAllowed=true; jid-config regresi OK)
  T4-FIX VERIFIED   (foto polos saat KO resolve null; caption grup tetap resolve)
  T5-FIX VERIFIED   (!kores re-record COMPLETED→IN_PROGRESS 1-1; foto lanjut SERIES_COMPLETE 2-1; series utuh tetap IGNORED)
  T6-FIX VERIFIED   (organizer lolos gate otoritas; stranger tetap Unauthorized)
  T8-FIX VERIFIED   (member 'ok' diblok; organizer lolos gate)
  T9-FIX VERIFIED   (teks !kogame <id>→status handler; teks !kogame→help; foto+caption tetep ke pipeline KO)
  T12-FIX VERIFIED  (org_/organizer diblok; flag eksplisit & ORGANIZER lolos)
  T13-FIX VERIFIED  (grup asing NL/foto ignored; grup resmi & DM organizer tetap diproses)
  T14-FIX VERIFIED  (delegasi 2 turnamen→tim ACTIVE; delegasi 1 tim tetap benar)
  T15-FIX VERIFIED  (seri penuh termasuk H2H→throw; rank-2 kualifikasi == rank-2 engine)
  T16-FIX VERIFIED  (fixture KNOCKOUT ditolak + arahan !kores; fixture GROUP tetap sukses)
  ```
- **Final sweep**: seluruh 13 skrip check dijalankan ulang sekaligus setelah semua fix — 13/13 VERIFIED; `tsc` clean; `vitest` 248/248 PASS di HEAD branch (`298415a`).
- **Scope disiplin**: tidak ada merge/push ke master (sesuai instruksi menunggu review Arya); semua kerja di branch `audit/verify-fix-v1`; file produksi yang berubah: `src/application/ko-evidence-pipeline.ts`, `src/application/tournament-commands.ts`, `src/application/fixture-resolver.ts`, `src/application/report-correction-coordinator.ts`, `src/competition/fixtures.ts`, `src/competition/series.ts`, `src/identity/resolver.ts`, `src/reports/approval.ts` (tidak berubah — fix T3 di router), `src/whatsapp/router.ts`, `src/reports/manual.ts`, `src/index.ts`, `tests/integration/full_flow.test.ts`, `cara-penggunaan.md`.


## [2026-11-21] Sesi Pull PR #7 & Redeploy VM: AI Resilience Notifications & Retry Queue (Task: flash-peak-tms-merge-pr7-redeploy-v1)

### Konteks Sesi
Mengeksekusi sinkronisasi pasca-merge PR #7 (`feat(ai): failure-cause-differentiated notifications + automatic retry queue (all-providers-failed)`) dari GitHub ke branch `master` lokal dan melakukan re-deployment ke VM (`forfh`). PR #7 mengimplementasikan:
1. Notifikasi kegagalan dibedakan per penyebab (failover transparan, retry in progress, terminal failure manual verification, unreadable screenshot).
2. Intake acknowledgment segera saat screenshot diterima ("📸 Screenshot diterima...").
3. Automatic retry queue untuk `AllProvidersFailedError` menggunakan reuse mekanisme debounce/lease yang ada + migrasi `003_ai_retry_queue.sql`.

### Langkah & Perubahan yang Dieksekusi
1. **Pull ke Repositori Lokal**:
   - `git fetch origin` & `git pull origin master` (Fast-forward `e5630aa..9e2175e`).
   - Kompilasi lokal `npm run build` (`tsc`) sukses tanpa error.
2. **Re-deployment ke VM (`forfh`)**:
   - Melakukan SSH ke VM `forfh` (`forfh-korea-vm`, `/home/azureuser/flashpeak-tms`).
   - Eksekusi `git pull origin master` (Fast-forward `e5630aa..9e2175e`).
   - Eksekusi `npm run build` di VM: clean, 0 error.
   - Eksekusi migrasi database: `npx tsx src/db/migrate.ts` mengaplikasikan `003_ai_retry_queue.sql` ke `local.sqlite`.
   - Restart service PM2: `pm2 restart flashpeak-bot --update-env && pm2 save`.
3. **Verifikasi Runtime Pasca-Deploy**:
   - Status PM2 `flashpeak-bot`: `online` (PID 3015536, 0 restart loops).
   - Log PM2 mengonfirmasi migrasi skema up to date, Multi-Provider Router aktif dengan 6 provider, dan Baileys sukses tersambung ke WhatsApp.

### Bukti & Verifikasi Empiris
- **Commit HEAD Master**: `9e2175e` (Merge pull request #7 from algojogacor/feat/ai-resilience-retry-queue).
- **Migration Output VM**:
  ```text
  ✅ Migrations completed successfully:
     Applied: 003_ai_retry_queue.sql
     Skipped: 001_initial.sql, 002_ko_game_evidence.sql
  ```
- **PM2 Process Status VM**:
  - `flashpeak-bot` (PID 3015536): `online`, memory ~128.7MB, uptime active.
- **Log Startup VM (`logs/bot-out.log`)**:
  ```text
  [DB] Connecting to database (file:local.sqlite)...
  [DB] Database schema is up to date.
  [AI] Initialized Multi-Provider Router with 6 provider(s): GROQ, DEEPSEEK, GEMINI, NVIDIA_NIM, COHERE, MISTRAL
  [WA] Initializing Baileys WhatsApp client (auth dir: ./auth_state)...
  [WA] Organizer identity configured (phone: set, jid: set).
  [WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP!
  [WA] Akun Bot JID: 6288242980462:2@s.whatsapp.net
  [WA] Bot siap memproses turnamen.
  ```
- **Unit & Integration Suite Lokal**: **20 file / 248/248 PASS** (16 test baru di `tests/integration/ai_resilience.test.ts`).

---


## [2026-11-20] Sesi Merge PR #5 & Redeploy VM: Fix 4 Audit Findings + Dynamic Group Sizing (Task: flash-peak-tms-merge-pr5-redeploy-v1)

### Konteks Sesi
Mengeksekusi merge Pull Request #5 (`fix(audit): resolve 4 audit findings + dynamic group sizing (FIX2)`) ke branch `master` dan melakukan re-deployment ke VM (`forfh`). PR ini menuntaskan 4 temuan audit (termasuk 1 bug kritis foreign key pada upload foto knockout `!kogame`) dan menambahkan fitur target ukuran grup dinamis `!draw size=4|5`.

### Langkah & Perubahan yang Dieksekusi
1. **Review & Merge PR #5**:
   - Analisis menyeluruh terhadap 4 perbaikan (FIX2-KO-003, FIX2-KO-004, FIX2-APR-003, FIX2-KO-005) dan fitur `FIX2-COMP-DYN`.
   - Eksekusi merge via GitHub CLI: `gh pr merge 5 --merge --delete-branch` (commit merge `250813b`).
   - Fast-forward sinkronisasi branch `master` lokal.
2. **Penyempurnaan Dokumentasi (`cara-penggunaan.md`)**:
   - Menambahkan petunjuk penggunaan `!draw size=4` / `!draw size=5` pada bagian panduan pengundian dan tabel cheatsheet.
3. **Re-deployment ke VM (`forfh`)**:
   - `git pull origin master` di `/home/azureuser/flashpeak-tms`.
   - `npm run build` (`tsc`) untuk memperbarui bundel kompilasi `dist/`.
   - `pm2 restart flashpeak-bot` dan `pm2 save`.
4. **Verifikasi Runtime Pasca-Deploy**:
   - Status PM2 `flashpeak-bot`: `online`, 0 crash/restart loop.
   - Startup log mengonfirmasi Baileys terhubung sukses kembali ke WhatsApp.

### Bukti & Verifikasi Empiris
- **Commit HEAD Master**: `250813b` + commit docs ini.
- **Unit & Integration Suite**: **19 file / 232/232 PASS** (+8 test regresi baru).
- **TypeScript Compilation**: **0 error**.
- **Log Startup VM**:
  - `[DB] Connecting to database (file:local.sqlite)...`
  - `[DB] Database schema is up to date.`
  - `[AI] Initialized Multi-Provider Router with 6 provider(s): GROQ, DEEPSEEK, GEMINI, NVIDIA_NIM, COHERE, MISTRAL`
  - `[WA] Organizer identity configured (phone: set, jid: set).`
  - `[WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP! Akun Bot JID: 6288242980462:2@s.whatsapp.net`
  - `[WA] Bot siap memproses turnamen.`

---


## [2026-11-20] Sesi Pendaftaran LID Organizer Arya (Task: flash-peak-tms-register-organizer-lid-v1)

### Konteks Sesi
Dari hasil pengetesan command `!id` oleh Arya di grup target (`120363412423738009@g.us`), terkonfirmasi bahwa WhatsApp Arya mengirimkan pesan menggunakan Privacy ID / LID: `165210883154071@lid`. Sesi ini mendaftarkan LID tersebut ke dalam konfigurasi `WA_ORGANIZER_JID` di `.env` VM agar Arya langsung diakui sebagai Organizer dengan hak akses penuh (bisa menjalankan `!setgroup`, `!createtournament`, dll).

### Langkah & Perubahan yang Dieksekusi
1. **Backup Snapshot `.env`**:
   - Dibuat snapshot backup: `/home/azureuser/flashpeak-tms/.env.backup-lid-20261120_103550`.
2. **Koreksi Variabel `WA_ORGANIZER_JID`**:
   - `WA_ORGANIZER_JID=165210883154071@lid,6289505630895@s.whatsapp.net`
   - `WA_ORGANIZER_PHONE=6289505630895`
   - Konfigurasi mendukung multi-target comma-separated sesuai implementasi router (`organizerList.some(...)`), sehingga baik interaksi via LID maupun Phone JID keduanya valid sebagai Organizer.
3. **Restart & Verifikasi Runtime PM2**:
   - Menjalankan `pm2 restart flashpeak-bot --update-env && pm2 save`.
   - Proses baru aktif (PID 2984818), status `online`, 0 errors.
   - Startup log mengonfirmasi Baileys terhubung kembali (`[WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP! Akun Bot JID: 6288242980462:2@s.whatsapp.net`).

---


## [2026-11-20] Sesi Fitur: Command !id & !myid untuk Pengecekan Identitas & Grup (Task: flash-peak-tms-command-id-v1)

### Konteks Sesi
Menambahkan perintah bawaan `!id` (dan alias `!myid`) pada CommandRouter WhatsApp agar pengguna (khususnya Arya sebagai Organizer) dapat memeriksa identitas asli pengirim (`sender_raw_address`, LID vs Phone JID), hak akses/role di sistem (apakah dikenali sebagai Organizer), serta ID chat/grup saat ini dan statusnya (resmi/belum). Perintah ini penting karena WhatsApp/Baileys dapat mengirimkan alamat dalam format `@lid` (Privacy ID) yang berbeda dari nomor telepon biasa.

### Langkah & Perubahan Kode
1. **Ekstensi Tipe `CommandDefinition` (`src/whatsapp/types.ts`)**:
   - Menambahkan flag opsional `allowOutsideCentralGroup?: boolean` agar perintah diagnostik seperti `!id` dapat dijalankan di grup mana pun (bahkan sebelum grup tersebut ditetapkan sebagai grup resmi via `!setgroup`).
2. **Implementasi Router Scope Guard & Handler `!id` (`src/whatsapp/router.ts`)**:
   - Menyesuaikan group scope guard: `if (isGroup && !isCentralGroup && !definition.allowOutsideCentralGroup)` sehingga perintah dengan flag ini tidak ditolak dengan pesan `UNAUTHORIZED_GROUP`.
   - Mengimplementasikan handler `!id` dan mendaftarkan `!id` serta `!myid` dengan `requiredRole: 'ANY'`, `allowedInDm: true`, `allowedInGroup: true`, dan `allowOutsideCentralGroup: true`.
   - Handler merender informasi:
     - User JID (`sender_raw_address`)
     - Tipe alamat (LID vs Phone JID)
     - Role pengguna di sistem (`ORGANIZER`, `DELEGATE`, atau `UNKNOWN`)
     - Status hak akses Organizer (apakah cocok dengan konfigurasi env)
     - ID chat/grup saat ini (`chat_id`)
     - Status grup resmi (apakah grup ini grup resmi, atau belum ada yang ditetapkan)
     - Petunjuk konfigurasi jika ID pengguna berupa `@lid` dan belum cocok dengan `WA_ORGANIZER_JID`.
3. **Dokumentasi Pengguna (`cara-penggunaan.md`)**:
   - Menambahkan `!id` / `!myid` pada tabel cheat sheet perintah.
4. **Pengujian & Verifikasi**:
   - Menambahkan test case baru di `tests/unit/whatsapp.test.ts` (menguji di central group, unauthorized group, dan alias `!myid`).
   - Mendaftarkan `id` dan `myid` di `audit-artifacts/audit_command_router_wiring.ts`.

### Bukti & Verifikasi Empiris
- **Unit Suite (`vitest run`)**: **18 file / 224/224 PASS** (bertambah 1 test).
- **TypeScript Typecheck (`tsc`)**: **0 error**.
- **Audit Wiring Suite (`audit_command_router_wiring.ts`)**: **38/38 commands SUCCESS**.

---


## [2026-11-20] Sesi Hotfix Konfigurasi: Nomor Organizer Arya (Task: flash-peak-tms-fix-organizer-number-v1)

### Konteks Sesi
Mengoreksi konfigurasi identitas nomor WhatsApp organizer turnamen pada file `.env` di VM deployment (`/home/azureuser/flashpeak-tms/.env`). Pada sesi deployment sebelumnya nomor diisi nilai dari service lain (`628999021644`). Sesi ini memperbaikinya ke nomor resmi yang sebenarnya dipakai Arya sebagai organizer turnamen (`6289505630895`).

### Langkah & Perubahan yang Dieksekusi
1. **Backup Snapshot `.env` Sebelum Modifikasi**:
   - Dibuat snapshot baru: `/home/azureuser/flashpeak-tms/.env.backup-hotfix-20261120_102035`.
2. **Koreksi Variabel Lingkungan di `.env`**:
   - `WA_ORGANIZER_PHONE=6289505630895`
   - `WA_ORGANIZER_JID=6289505630895@s.whatsapp.net`
3. **Database Tidak Disentuh**:
   - Sesuai instruksi, database `local.sqlite` tetap dibiarkan bersih dari sesi reset sebelumnya (0 baris di seluruh tabel turnamen).
4. **Restart Service PM2**:
   - Menjalankan `pm2 restart flashpeak-bot --update-env` dan `pm2 save`.
   - Proses `flashpeak-bot` baru (PID 2982781) berjalan online, memuat environment baru.
5. **Verifikasi Log**:
   - `logs/bot-out.log`: Terverifikasi `[WA] Organizer identity configured (phone: set, jid: set).` dan `[WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP! Akun Bot JID: 6288242980462:2@s.whatsapp.net`.

### Bukti & Verifikasi Empiris
- **Isi `.env` Terverifikasi**:
  ```text
  WA_ORGANIZER_PHONE=6289505630895
  WA_ORGANIZER_JID=6289505630895@s.whatsapp.net
  ```
- **PM2 Status**: `flashpeak-bot` (PID 2982781), status `online`, 0 crash/restart loop.
- **Log Verifikasi**:
  ```text
  2026-11-20T10:20:52: [WA] Organizer identity configured (phone: set, jid: set).
  2026-11-20T10:20:53: [WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP!
  2026-11-20T10:20:53: [WA] Akun Bot JID: 6288242980462:2@s.whatsapp.net
  2026-11-20T10:20:53: [WA] Bot siap memproses turnamen.
  ```

---


## [2026-11-20] Sesi Deployment & Reset Data Turnamen di VM (Task: flash-peak-tms-deploy-update-vm-v1)

### Konteks Sesi
Memperbarui deployment Flash Peak TMS (TurFpeak) yang sedang berjalan di VM (`forfh-korea-vm`, user `azureuser`) agar memakai kode terbaru dari `master` (commit `6cb8836`, memuat 4 PR besar: audit findings fix, interactive knockout evidence pipeline v2, approval-reset fix, preexisting TS bugfixes, dan panduan penggunaan). Sekaligus melakukan reset total data turnamen lama di database VM agar bersih dan siap digunakan Arya untuk turnamen baru via `!setgroup`.

### Langkah & Perubahan yang Dieksekusi
1. **Pemeriksaan Awal & Identifikasi Service**:
   - Ditemukan deployment berjalan di `/home/azureuser/flashpeak-tms`.
   - Service PM2 aktif: `flashpeak-bot` (id 9, fork mode, entry `dist/cli/start.js`, `--max-old-space-size=160`) dan `flashpeak-media` (id 8, port 4189, online).
   - Commit sebelum update dicatat sebagai titik rollback: `46ed1db` (`feat(roster): enforce Format 5+3 with automatic rejection for excess players`).

2. **Backup Snapshot Database & Sesi WhatsApp**:
   - `local.sqlite` disalin ke `local.sqlite.backup-pre-deploy-20261120_100254` (464K).
   - `auth_state` (kredensial WhatsApp session Baileys) dibackup ke `auth_state.backup-pre-deploy-20261120_100254`.
   - File `.env` dibackup ke `.env.backup-20261120_100504`.

3. **Update Kode & Build**:
   - Eksekusi `git fetch origin master && git pull origin master` di VM; berhasil fast-forward `46ed1db..6cb8836`.
   - Menjalankan `npm install` (semua 283 dependencies up-to-date).
   - Menjalankan `npm run build` (`tsc`) untuk memperbarui bundel kompilasi `dist/` (`dist/cli/start.js` terupdate).

4. **Reset Data Turnamen & Migrasi Database**:
   - `flashpeak-bot` dihentikan sementara via `pm2 stop flashpeak-bot` untuk melepas file lock SQLite (`SQLITE_BUSY`).
   - Menjalankan migrasi `npm run migrate`: berhasil menerapkan migrasi baru `002_ko_game_evidence.sql` (tabel per-game evidence jurnal knockout).
   - Menjalankan utility bawaan `npm run reset-data` (`src/cli/reset_data.ts`): membersihkan seluruh tabel turnamen (`approvals`, `corrections`, `player_game_stats`, `goalkeeper_reports`, `report_media`, `report_versions`, `report_sessions`, `media_assets`, `inbound_messages`, `standings`, `games`, `series`, `fixtures`, `group_members`, `groups`, `group_draws`, `players`, `teams`, `whatsapp_identities`, `delegates`, `tournaments`, `audit_events`).
   - Verifikasi hitungan baris di seluruh 26 tabel: seluruh tabel data turnamen bernilai **0 baris**, tabel meta `_migrations` bernilai **2** (001 dan 002). Skema tabel tetap utuh sempurna.

5. **Penyesuaian Environment Variables (`.env`)**:
   - `WA_CENTRAL_GROUP_JID=` di-reset kosong agar bot siap menerima penetapan grup baru via `!setgroup`.
   - Dikonfigurasi identitas organizer Arya (`WA_ORGANIZER_PHONE=628999021644` dan `WA_ORGANIZER_JID=628999021644@s.whatsapp.net`) untuk memenuhi proteksi FIX2-RBAC-001 (mencegah startup abort).
   - Memastikan `FLASHPEAK_MEDIA_SECRET` valid dan terhubung dengan `flashpeak-media` service.

6. **Restart & Verifikasi Runtime PM2**:
   - Menjalankan `pm2 start flashpeak-bot` dan `pm2 save`.
   - Status PM2: `flashpeak-bot` (pid 2980988) status **online**, 0 restarts pasca-start.
   - Log startup membuktikan bot sukses terhubung kembali ke WhatsApp (`[WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP! Akun Bot JID: 6288242980462:2@s.whatsapp.net`) dan siap memproses turnamen baru.

### Bukti & Verifikasi Empiris
- **Commit HEAD VM**: `6cb8836` (`git log -n 1 --oneline`).
- **Verifikasi Tabel Database (`local.sqlite`)**:
  - `_migrations`: 2
  - `tournaments`: 0
  - `teams`: 0
  - `delegates`: 0
  - `whatsapp_identities`: 0
  - `players`: 0
  - `fixtures`: 0
  - `games`: 0
  - `series`: 0
  - `ko_game_evidence`: 0
  - `inbound_messages`: 0
  - `media_assets`: 0
  - `report_sessions`: 0
  - `report_versions`: 0
  - `approvals`: 0
  - `standings`: 0
  - `audit_events`: 0
- **Log Startup**:
  - `[DB] Database schema is up to date.`
  - `[AI] Initialized Multi-Provider Router with 6 provider(s): GROQ, DEEPSEEK, GEMINI, NVIDIA_NIM, COHERE, MISTRAL`
  - `[WA] Organizer identity configured (phone: set, jid: set).`
  - `[WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP! Akun Bot JID: 6288242980462:2@s.whatsapp.net`
  - `[WA] Bot siap memproses turnamen.`

---


## [2026-11-20] Sesi Merge Koordinasi 4 PR ke master (Task: flash-peak-tms-analyze-and-merge-prs-v1)

### Konteks Sesi
Sesi ini menganalisis 4 PR terbuka (PR #1–#4) untuk menentukan urutan merge yang aman, mendeteksi konflik, lalu mengeksekusi merge bertahap dengan test ulang di master setelah tiap tahap. Seluruh analisa dilakukan secara lokal (clone + fetch semua head branch) SEBELUM tombol merge pertama ditekan, termasuk simulasi merge penuh (dry-run) dengan test + typecheck di tiap tahap.

### Fakta kunci dari analisa lokal
- **PR #4 ⊇ PR #2**: branch PR #4 dibuat DI ATAS head PR #2 (`bf1d98a`, terverifikasi `git merge-base --is-ancestor`) + 1 commit docs murni (`cara-penggunaan.md` + worklog). Dokumentasinya sudah akurat terhadap command final PR #2; `!help` tidak perlu sinkron kode karena outputnya dirender dinamis dari command registry.
- **PR #1**: 4 file artifact read-only baru (`second-opinion-audit-artifacts/`), nol perubahan kode produksi, tidak overlap dengan PR lain. Diputuskan MERGE (bukan close) sebagai referensi historis — laporan temuan tidak ter-superseded oleh fix, dan `dryrun_e2e.ts`-nya dipakai PR #2 sebagai verifikasi lintas-branch.
- **PR #2 ∩ PR #3**: 4 file sama, tapi hunk disjoint (PR #2: baris 24–89/2244–2532/2675+; PR #3: 2581–2601 + router 114–175) → auto-merge bersih.
- **Konflik git yang nyata hanya `worklog.md`** (gaya prepend, semua sesi menambah entri di atas) → di-resolve dengan union blok sesi (script `scripts/resolve_worklog.py` di luar repo, di sesi agent): zero konten hilang, urut terbaru-dulu.
- **Konflik semantik lintas-PR (tak terdeteksi git/vitest)**: 2 script dry-run buatan PR #2 (`audit_sync_central_group.ts` Scenario 4; `dryrun_knockout_stage.ts`) membangun `NormalizedMessage` dengan field legacy `sender_id`; setelah PR #3 menghapus fallback `|| sender_id` (BUGFIX-TS-002), `sender_raw_address` jadi undefined → crash `.split()` di `isSenderOrganizer`. Terdeteksi HANYA lewat dry-run sweep (15/17 gagal 2). Fix: alignment mekanis ke kontrak tipe — persis gaya yang PR #3 sendiri pakai untuk kasus yang sama pada 2 dry-run lama.

### Urutan merge yang dieksekusi + hasil test di master setelah tiap tahap
| Tahap | PR | Merge SHA | tsc master | vitest master |
|---|---|---|---|---|
| 0 | (baseline master `16c97bb`) | — | 5 error (2 bug TS pre-existing) | 223/223 |
| 1 | PR #1 audit artifacts | `dcf12ba` | 5 error (identik; bukan regresi) | 223/223 |
| 2 | PR #2 9 findings + KO pipeline | `2de0417` | 5 error (identik; bukan regresi) | 223/223 |
| 3 | PR #3 2 bug TS (branch di-update dulu: merge master + union worklog → push `4d7c781`) | `47531a6` | **0 error** | 223/223 |
| 4 | PR #4 cara-penggunaan (branch di-update dulu: merge master, auto-clean → push `12d046e`) | `fd5c2e0` | **0 error** | 223/223 |
| 5 | Commit alignment 2 dry-run + entri worklog ini | (commit ini) | **0 error** | 223/223 + dry-run 17/17 |

Alasan urutan: (1) PR #1 zero-risk masuk duluan supaya laporan audit hidup di master sebagai referensi sebelum fix-nya masuk; (2) PR #2 sebagai PR fungsional inti; (3) PR #3 setelah PR #2 — hunks disjoint dan fix-nya sekaligus membersihkan warisan `sender_id` yang dibawa PR #2; (4) PR #4 terakhir — tinggal menambah commit docs karena basisnya sudah ada di master.

### Verifikasi final di HEAD master
- `npx tsc --noEmit`: **0 error**.
- `npm test`: **18 file / 223/223 PASS**.
- Sweep 17 dry-run (12 audit lama + `dryrun_knockout_stage` + `dryrun_fix2_items` + `dryrun_ko_pipeline_v2` + `dryrun_fix_preexisting_ts_bugs` + `dryrun_e2e` second-opinion): **17/17 PASS** (sebelum alignment: 15/17).

### Catatan
- Token GHP dipakai via file chmod-600 di luar repo (tidak pernah di-commit, tidak pernah ditampilkan ulang). Token pernah tercantum sebagai teks di chat — owner disarankan revoke/rotate setelah sesi ini.


## [2026-11-20] Sesi Dokumentasi: Panduan Penggunaan Bot untuk Organizer & Delegasi (Task: flash-peak-tms-cara-penggunaan-doc-v1, Branch: docs/cara-penggunaan)

### Konteks Sesi
Sesuai task `flash-peak-tms-cara-penggunaan-doc-v1` (mode DOCUMENTATION, read-only terhadap logic), dokumen teknis yang ada (AGENT.md, FRD.md, COMPETITION_RULES.md) memang ditulis untuk developer/AI agent — belum ada panduan untuk pengguna akam: organizer (Arya & tim) dan delegasi tim yang sehari-hari memakai bot di grup WhatsApp. Sesi ini membuat **`cara-penggunaan.md`** di root repo sebagai tutorial step-by-step bahasa sehari-hari. Tidak ada perubahan logic/behavior kode apa pun.

Basis penulisan: branch `fix/second-opinion-findings` (`bf1d98a`) — kode terbaru yang memuat pipeline knockout interaktif PR #2 (`!startknockout`/`!kogame`/`!kores`, jalur foto per-game) yang belum ada di master `16c97bb`. Dokumen disusun dari pembacaan KODE langsung, bukan dari dokumentasi lama.

### Metode: Verifikasi ke Kode, Bukan ke Dokumentasi Lama
Seluruh isi dokumen diverifikasi terhadap perilaku kode nyata saat penulisan:
- Registry command (`registerCommand` di `src/whatsapp/router.ts` dan `src/application/tournament-commands.ts`): 44 command terdaftar (42 di tournament-commands + `!ping`/`!help`/`!setgroup` di router) — nama, `requiredRole`, DM/group, deskripsi, pesan usage & balasan tiap handler dibaca satu per satu.
- Jalur non-command yang didokumentasikan: foto bukti babak grup (evidence capture + debounce ~5 detik di `src/index.ts`), caption `!kogame` (pipeline KO per-game di `handleKoGameEvidenceMessage`), koreksi natural-language (kata kunci "koreksi/salah di/seharusnya/bukan" saat membalas draf), pertanyaan bebas berawalan `!` (WO intent, klasemen, jadwal, aturan, roster).
- Format pesan balasan bot dicuplik dari `src/whatsapp/formatters.ts` & pesan handler asli supaya contoh di dokumen mirip screenshot WhatsApp sungguhan.

### Dua Ketidakakuratan Awal Ditemukan Saat Verifikasi (dan dikoreksi sebelum commit)
1. Awalnya saya menulis "delegasi menolak draf dengan `!reject`" — salah. `!reject`/`!tolak`/`!batal` adalah registry `requiredRole: ORGANIZER` (handler `cancelHandler` untuk klaim WO pending / draf manual), BUKAN jalur tolak draf laporan 3-pihak. Jalur delegasi yang benar: tidak approve + balas draf dengan koreksi natural-language (`src/index.ts` isCorrectionCandidate). Bagian "Kalau Ada yang Tidak Setuju" ditulis ulang sesuai mekanisme itu.
2. Awalnya saya menulis "`!standings` menampilkan klasemen (semua grup)" — tidak tepat: handler memakai default `ctx.args[0]?.toUpperCase() || 'A'` (tanpa argumen = grup A saja). Dokumen diperbaiksi: harus menyebut huruf grup.

### Catatan !help (permintaan sinkronisasi task)
`!help` TIDAK perlu diperbarui kode-nya: implementasinya **dinamis** — handler merender daftar dari registry command terdaftar (`this.commands.entries()`) memakai `description:` tiap command, dengan penyaringan role (ORGANIZER-only disembunyikan dari non-organizer, DELEGATE-only disembunyikan dari UNKNOWN). Artinya setiap command baru termasuk pipeline knockout PR #2 otomatis muncul di `!help` tanpa perubahan. Deskripsi registry yang ada sudah akurat dan berbahasa pengguna. Konsistensi antara `!help` dan dokumen dijaga dengan: (a) dokumen menuliskan semua nama command persis seperti registry, (b) cheat sheet di akhir dokumen mencantumkan persis command yang akan dilihat pengguna di `!help`. Tidak ada perubahan kode pada `!help` — sesuai mode DOCUMENTATION (read-only terhadap logic).

### Deliverable
- **`cara-penggunaan.md`** (root repo, ~600 baris): tutorial mengikuti urutan alamiah turnamen — Gambaran besar (peta 4 fase + tabel beda babak grup vs knockout) → 1. Persiapan & Pendaftaran (createtournament, setgroup, addteam, onboarding, roster 5+3) → 2. Undian & Jadwal (draw, jadwal, standings, matchday/19:59 WIB) → 3. Melapor Hasil Babak Grup (alur foto→draf→approval 3 pihak, contoh percakapan utuh) → 4. Kalau Ada Masalah (claimwo, roomcard ok/ganti/tolak/habis + beda grup vs KO, salah kirim foto/AI gagal, manualreport, reopen/override) → 5. Babak Knockout & Grand Final (startknockout, konsep series BO3/BO5 + "kirim foto per game", !kogame lengkap dengan contoh balasan bot game-per-game, replay game seri, bye otomatis double-loss, kores) → 6. Kalau Turnamen Selesai (awards, pertanyaan bebas, jejak audit) → Cheat sheet cepat.
- Setiap command diformat konsisten: Siapa (role), Kapan (skenario), apa yang diketik (contoh konkret), apa yang terjadi setelahnya (cuplikan balasan bot nyata). Bahasa Indonesia sehari-hari, tanpa jargon teknis (tidak ada kata handler/pipeline/RBAC di isi dokumen).

### Status PR
Commit di branch `docs/cara-penggunaan` (dari `fix/second-opinion-findings`), PR terbuka ke master, tidak di-merge — menunggu review Arya.


## [2026-11-20] Sesi Lanjutan PR #2: Pipeline Knockout Interaktif + Approval Reset + Revisi Aturan Double-Loss (Task: flash-peak-tms-knockout-pipeline-and-override-v2)

### Konteks Sesi
Sesi ini MELANJUTKAN branch `fix/second-opinion-findings` (PR #2, masih terbuka, belum di-merge) — bukan branch/PR baru. Tiga bagian yang sebelumnya belum dikerjakan: (1) **revisi pendekatan evidence knockout** dari reuse pipeline BO1 babak grup (versi awal `!kores` pada FIX2-KO-001) menjadi **pipeline interaktif per-game** yang terpisah, karena format BO3/BO5 secara struktural beda (satu seri = beberapa game, bukan satu hasil); (2) **perbaikan bug approval-reset** yang dilaporkan sendiri pada sesi PR #2 (saat itu baru REPORTED, kini di-fix); (3) **revisi aturan bisnis dari Arya** (bukan bug fix) untuk kasus kedua tim tidak hadir di Knockout: dari wajib reschedule menjadi **double loss + bye otomatis**.

---

### [BAGIAN 2 — FIX2-KO-002] Pipeline Evidence Knockout Interaktif Per-Game
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `migrations/002_ko_game_evidence.sql` (tabel jurnal bukti per-game, baru)
  - `src/application/ko-evidence-pipeline.ts` (state machine seri per-game, baru)
  - `src/index.ts` (`handleKoGameEvidenceMessage` + dispatch pre-router + transisi turnamen COMPLETED)
  - `src/application/tournament-commands.ts` (command `!kogame` delegate; `!kores` direvisi menjadi jalur koreksi organizer)
- **Rencana & Masalah**: Versi awal `!kores` memakai organizer manual-report ala BO1 — tidak interaktif per-game, tidak menangani input delegasi yang berantakan. Arya minta alur: delegasi kirim foto per game → bot ekstraksi → balas hasil game + skor seri → minta game berikutnya atau umumkan pemenang.
- **Desain yang diambil (dicatat agar bisa dibaca ulang)**:
  1. **Nomor game TIDAK PERNAH dipercaya dari input delegasi** (caption/urutan foto). Slot selalu di-derive dari state DB: `deriveOpenGameSlot` mengembalikan slot game pertama yang belum punya hasil decisive, atau slot tied-pending-replay. Satu prinsip ini yang membuat foto terbalik, sekaligus, atau duplikat semuanya konvergen ke state seri yang benar.
  2. **Generic best-of-N**: threshold dari kolom `series.target_wins`; tidak ada branch khusus BO3/BO5 — BO5 Final hanya beda data (target 3), terbukti dry-run G.
  3. **Game seri → slot tetap menunggu replay** (D-028): foto decisive berikutnya mengisi slot yang sama (reuse `recordSeriesGameResult`), tidak konsumsi slot baru.
  4. **Foto setelah seri selesai** → jurnal `IGNORED` + pesan eksplisit "diabaikan, tidak dihitung resmi" — tidak pernah diproses sebagai hasil resmi.
  5. **Duplikat**: pasangan skor identik dengan slot decided → idempotent (pesan "duplikat hasil game ke-N, tidak dihitung sebagai game baru"), win tidak terhitung dua kali. Catatan penting: pair **mirror** (mis. 0-2 vs tercatat 2-0) TIDAK dianggap duplikat karena ekstraksi sudah terorientasi ke team_a/team_b fixture — mirror adalah skor berbeda yang sah mengisi slot berikutnya. (Guard mirror sempat salah ditulis saat iterasi pertama dan langsung menandai game-2 sah sebagai konflik; ditemukan via probe dry-run, diperbaiki.)
  6. **Konflik tak-ter-reconcile**: tidak ada jalur otomatis yang menimpa hasil decided — kasus semacam itu diekscalasi ke jalur koreksi organizer `!kores` (BAGIAN 3). Guard NEEDS_REVIEW tetap ada di skema jurnal untuk kebutuhan masa depan.
  7. **State persisten**: skor per-game di `games` (series_id terisi), agregat di `series`; jejak audit tiap foto di `ko_game_evidence` (status APPLIED/SUPERSEDED/IGNORED/NEEDS_REVIEW + note).
  8. **RBAC**: hanya delegasi terverifikasi (atau organizer) yang bisa submit foto; resolusi fixture: caption eksplisit → fixture KO aktif tim pengirim → fixture KO aktif tunggal turnamen.
  9. **GK rule per-game**: pipeline memakai extractor skor generik; kuota screenshot kiper (BO3=2/BO5=3 per pemenang) tetap berlaku pada jalur bukti kiper yang sudah ada dan tidak diduplikasi di sini.
  10. Transisi turnamen `COMPLETED` saat Grand Final selesai via foto juga kini terjadi di pipeline (bukan hanya di `!kores`).
- **Perubahan Kode**: seperti daftar file di atas; `handleInboundMessage` menangkap caption `!kogame` sebelum router/BO1-debounce agar foto KO tidak pernah masuk pipeline BO1.
- **Bukti & Verifikasi** (`npx tsx audit-artifacts/dryrun_ko_pipeline_v2.ts` — **59/59 PASS**):
  - A. Ideal berurutan BO3 2-0: series selesai di foto kedua, TIDAK diminta game 3 (early stop); DB 2-0 COMPLETED; 2 evidence APPLIED. (PASS)
  - B. BO3 1-1: bot minta foto game 3; game 3 penentuan menyelesaikan series 1-2, winner benar. (PASS)
  - C. Semua foto sekaligus di awal (+1 ekstra): foto ekstra diabaikan dengan pesan eksplisit; jurnal 2 APPLIED + 1 IGNORED; seri tetap 2-0. (PASS)
  - D. Foto terbalik: slot 1 terisi foto pertama yang sampai, slot 2 foto berikutnya; seri 1-1 tetap benar. (PASS)
  - E. Duplikat: skor identik → idempotent (win tidak dobel); skor beda mengisi slot berikutnya; foto pasca-selesai diabaikan. (PASS)
  - F. Game seri 1-1 → wajib replay slot sama; replay decisive 2-1 menuntaskan slot; hanya 1 row game (tidak konsumsi slot baru). (PASS)
  - G. BO5 Final: threshold 3 — 2 win belum selesai, win ke-3 menuntaskan; turnamen COMPLETED; pesan juara. (PASS)
  - H. E2E penuh: standings final → !startknockout → bracket → foto per game → FINAL dari pemenang SF → juara → turnamen COMPLETED. (PASS)

---

### [BAGIAN 3 — FIX2-APR-002] Approval Reset Saat Organizer Reopen (bug yang sebelumnya dilaporkan)
- **Status**: Selesai & Terverifikasi (bug #2 dari sesi PR #2 kini di-fix)
- **Modul/File Terkait**: `src/reports/approval.ts` (`organizerReopenReport`), `audit-artifacts/dryrun_ko_pipeline_v2.ts` (bagian P3), `audit-artifacts/dryrun_fix2_items.ts` (diperbarui)
- **Rencana & Masalah**: `organizerReopenReport` tidak menghapus approval lama — satu vote baru setelah reopen langsung melengkapi konsensus lama dan laporan ter-LOCK lagi tanpa divalidasi ulang (melanggar semangat FR-APR-003 untuk kasus reopen).
- **Perubahan Kode**: `organizerReopenReport` kini `DELETE FROM approvals WHERE report_version_id = ?` (jumlah ter-reset dicatat di audit event `before_json.approvals_reset`). Jalur koreksi `!kores` (organizer) dapat dipakai menyelesaikan kasus ambigu yang dieskalasi pipeline BAGIAN 2.
- **Bukti & Verifikasi** (dry-run P3, 8/8 PASS): lock 3 pihak → approval pasca-LOCK ditolak → `!reopen` → approval lama ter-reset (0 baris) → 1 vote baru diterima TIDAK mengunci (1/3) → 2 vote masih belum LOCK → 3 vote baru diperlukan untuk LOCK ulang → audit event mencatat `approvals_reset=3`.

---

### [BAGIAN 4 — FIX2-RULE-004] Revisi Aturan Kedua Tim Tidak Hadir di Knockout (REVISI ATURAN BISNIS DARI ARYA — bukan bug fix)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - Dokumentasi: `flash-peak-tms/COMPETITION_RULES.md` §6, `flash-peak-tms/DECISIONS.md` (D-032 + O-009), `flash-peak-tms/FRD.md` FR-FIX-006, `flash-peak-tms/README.md`, `flash-peak-tms/TESTING.md`, `docs/ARCHITECTURE_DECISIONS.md` (D-032)
  - Kode: `src/competition/walkover.ts` (`handleKnockoutDoubleRoomCardFailure` → double loss), `src/application/tournament-commands.ts` (pesan `!roomcard habis` + generator ronde berikutnya mendeteksi bye/juara-by-default), `src/competition/fixtures.ts` (guard anti self-match)
  - Test: `tests/unit/competition.test.ts` (test D-032 ditulis ulang ke aturan baru)
- **Aturan lama → baru**: Kedua tim KO tanpa room card: ~~WAJIB RESCHEDULE~~ → **KEDUA tim dinyatakan KALAH (double loss)**; fixture di-resolve (WALKOVER tanpa winner, series ditutup tanpa winner); tim yang seharusnya bertemu pemenangnya di ronde berikutnya **otomatis lolos (bye)**. Nomor keputusan D-032 dipertahankan dengan catatan revisi per 20 Nov 2026 di semua dokumen yang mencatat tanggal.
- **Perubahan Kode**:
  1. `handleKnockoutDoubleRoomCardFailure`: fixture → WALKOVER; game double-loss (is_walkover=1, tanpa winner); series COMPLETED tanpa winner; audit event `KNOCKOUT_DOUBLE_LOSS_RECORDED`.
  2. `!roomcard <id> habis` untuk KO: pesan baru menyatakan KALAH GANDA + konsekuensi bye ronde berikutnya.
  3. Generator ronde berikutnya (`!startknockout`): pemenang series + penerima bye (pasangan fixture double-loss) jadi seed ronde berikutnya; bye ditampilkan eksplisit di pesan WhatsApp (BYE OTOMATIS: <tim> lolos tanpa bertanding — pasangannya <A> vs <B> KALAH GANDA).
  4. **Edge case ditemukan & ditangani saat dry-run**: 2 SF dengan satu double-loss menyisakan 1 tim unik — generator lama akan membentuk FINAL "tim vs dirinya sendiri" (W3 vs W3). Kini: seed di-dedup; jika ≤1 tim unik tersisa → tim tersebut **dimahkotai JUARA langsung** (`KNOCKOUT_CHAMPION_BY_DEFAULT` audit event, turnamen COMPLETED, pesan juara + bye notice); jika 0 tersisa → info "panitia menetapkan juara manual". Guard anti self-match juga ditambahkan di `generateKnockoutFixtures`.
- **Bukti & Verifikasi**: dry-run P4 (10/10 PASS): pesan KALAH GANDA + bye eksplisit; fixture WALKOVER tanpa winner; series ditutup tanpa winner; TIDAK ada FINAL self-match; penerima bye dimahkotai juara langsung; audit event tercatat. Unit test `competition.test.ts` (D-032 revised) PASS dalam full suite 223/223.

---

### Catatan Tambahan
1. `audit_roomcard_commands.ts` Test 6, `dryrun_knockout_stage.ts` (post-final guard), `dryrun_fix2_items.ts` (bagian APR), dan `tests/migration.test.ts` (jumlah migrasi) di-update karena meng-asersi perilaku lama yang memang diubah oleh task ini (double-loss, approval-reset, migrasi kedua). Semua perubahan asersi disertai alasan di dalam file.
2. Bug #1 dari sesi PR #2 (5 error TS pre-existing master: `PendingWoClaim.id` + `sender_id` di 4 lokasi) tetap TIDAK diperbaiki (status REPORTED/PENDING_APPROVAL sesuai aturan sesi) — typecheck post-sesi tetap hanya berisi 5 error yang sama (bukan regresi).

---

### Ringkasan Akhir & Regression Gate Check (lanjutan branch fix/second-opinion-findings / PR #2)

**Full Vitest Suite**: 18 file / **223/223 PASS** (test D-032 & migration di-update mengikuti semantik baru).

**Dry-run audit-artifacts (15/15 PASS)**:

| # | Skrip | Status |
|---|-------|--------|
| 1–12 | 12 audit lama (command wiring, migration failure, e2e flow, gemini key, GK pipeline, RBAC WO, roomcard [Test 6 di-update ke double-loss], roster pipe, round-robin, media secret, sync central group, trusted context) | **12/12 PASS** |
| 13 | `dryrun_knockout_stage.ts` (PR #2; asersi post-final di-update) | **21/21 PASS** |
| 14 | `dryrun_fix2_items.ts` (PR #2; bagian APR di-update ke approval-reset baru) | **30/30 PASS** |
| 15 | `dryrun_ko_pipeline_v2.ts` (baru: bagian 2/3/4) | **59/59 PASS** |

**Dry-run second-opinion lintas-branch**: 34/34 PASS. **Typecheck**: hanya 5 error pre-existing master (identik baseline; bukan regresi — lihat catatan #2).


## [2026-11-20] Sesi Perbaikan Temuan Second-Opinion Audit (Task: flash-peak-tms-fix-second-opinion-findings-v1)

### Konteks Sesi
Sesi ini adalah tindak lanjut dari laporan second-opinion audit independen `flash-peak-tms-second-opinion-audit-v1` (19 November 2026, commit audit `16c97bb`). Audit tersebut mengonfirmasi jalur utama babak grup mature (34/34 dry-run PASS, 223/223 test PASS) namun menemukan 9 celah di luar jalur utama: fase knockout tanpa pintu masuk runtime (High), fallback nomor organizer hardcoded (High), organizer terkunci dari laporan LOCKED (High), recovery lease debounce pasif (Medium), WO claim NL oleh pengirim UNKNOWN (Medium), auto-adopt grup resmi diam-diam (Medium), lookup fixture prefix LIKE ambigu (Low–Medium), SQL IN non-parameterized (Low), dan dead code `recordGenuineDraw` (Low). Seluruh perbaikan dikerjakan pada branch `fix/second-opinion-findings` satu per satu sesuai prioritas, tetap dalam arsitektur modular `src/application/` / `src/competition/` / `src/whatsapp/` / `src/ingestion/`, tanpa mengubah skema migrasi. Semua perubahan dikirim via Pull Request ke `master` (tidak merge sendiri).

**Keputusan desain knockout yang diambil (dilaporkan untuk review Arya):**
1. **Trigger knockout manual oleh organizer via `!startknockout`** (bukan otomatis saat babak grup selesai) — konsisten dengan pola command organizer lain (`!draw` juga manual) dan prinsip "organizer is the final tournament authority" (COMPETITION_RULES §4). Kandidat alternatif (auto-generate saat semua fixture grup COMPLETED oleh matchday cutoff) tidak diambil agar tidak ada transisi fase tanpa kesempatan organizer memeriksa klasemen akhir.
2. **`!startknockout` juga berfungsi sebagai generator ronde knockout BERIKUTNYA** ketika semua series ronde aktif telah selesai (SF → FINAL), dengan pemenang series di-seed ulang ke `generateKnockoutFixtures` memakai aturan pairing anti-rematch grup yang sama.
3. **Pelaporan hasil game knockout via `!kores <fixture_id> <game_no> <skor_a>-<skor_b>`** (ORGANIZER-only, tercatat di games/series) — memakai jalur domain `recordSeriesGameResult` yang sudah teruji; bukti screenshot tetap mengalir lewat pipeline bukti biasa (FR-GK-008: BO3 winner 2 screenshot, BO5 3 screenshot). Kandidat alternatif (pipeline AI penuh per-game knockout) tidak diambil agar tidak menduplikasi logic approval grup; integrasi AI penuh per game knockout bisa jadi PR lanjutan.
4. **Batas ambiguitas klasemen**: `deriveKnockoutQualifiers` menolak start knockout bila peringkat 1–2 sebuah grup masih seri penuh (poin, SD, GF) — organizer harus menyelesaikan dulu (misal pertandingan tambahan/keputusan manual), sesuai FR-CALC-002 tie-breaker berjenjang.
5. **FIX2-GROUP-001**: `!setgroup` adalah satu-satunya cara eksplisit pindah grup resmi; pengecualian SATU-satunya untuk auto-adopt adalah bootstrap pertama saat **belum ada grup resmi yang terkonfigurasi sama sekali** (first-run), agar bot dapat dipasang tanpa env group.
6. **FIX2-DEADCODE-001**: `recordGenuineDraw` dihapus karena redundant dengan jalur resmi standings (`onReportLocked` → `games.is_draw=1` → `computeGroupStandings` beri 1 poin sesuai FR-CALC-001, terverifikasi dry-run audit pertama); signature-nya juga cacat (parameter `score` tunggal tidak bisa mewakili seri 2-2 vs 1-1). Test yang mengasertasinya ditulis ulang untuk memverifikasi jalur resmi.

---

### [FIX2-KO-001] Pintu Masuk Runtime Fase Knockout (Prioritas 1 — High)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `src/competition/fixtures.ts` (fungsi domain baru `deriveKnockoutQualifiers`)
  - `src/application/tournament-commands.ts` (command `!startknockout`/`!mulainokout`, `!kores`)
  - `src/application/matchday-service.ts` (dukungan stage KNOCKOUT + label ronde knockout)
  - `src/whatsapp/formatters.ts` (`formatKnockoutBracketAnnouncement`, `formatSeriesGameReportMessage`, `formatKnockoutNextRoundMessage`)
  - `audit-artifacts/dryrun_knockout_stage.ts` (dry-run baru)
- **Rencana & Masalah**: `generateKnockoutFixtures` dan `recordSeriesGameResult` lengkap sebagai domain logic dan lulus unit test, tetapi tidak ada command/handler/cron runtime mana pun yang memanggilnya — turnamen macet total setelah babak grup. `matchday-service` juga hanya mengelola `stage='GROUP'`.
- **Perubahan Kode**:
  1. `deriveKnockoutQualifiers(db, tournamentId)`: derivasi kualifikasi knockout dari klasemen final tersimpan (top 2 tiap grup, O-004/FR-COMP-011), dengan guard anti-ambiguitas seri penuh peringkat 1–2.
  2. Command organizer `!startknockout` (alias `!mulainokout`): guard seluruh fixture grup selesai; guard knockout belum ada; guard duplikasi (bila series masih berjalan → info + daftar series aktif); jalur kedua bila semua series ronde selesai → generate ronde berikutnya dari pemenang series (pairing anti same-group-rematch reuse); audit event `KNOCKOUT_STAGE_STARTED` / `KNOCKOUT_ROUND_GENERATED`; broadcast bracket via formatter WhatsApp.
  3. Command organizer `!kores <fixture_id> <game_no> <skor_a>-<skor_b>`: validasi input, resolve series by fixture (exact match), panggil `recordSeriesGameResult` (termasuk jalur game seri → wajib replay slot sama, D-028); saat Grand Final (BO5) selesai → `tournaments.status='COMPLETED'` + pesan juara.
  4. `getActiveTournamentCurrentRound` memperhitungkan stage KNOCKOUT (ronde aktif = ronde grup belum selesai dulu, lalu knockout); `formatRoundLabel` memberi label babak knockout (SEMI FINAL, FINAL, dsb) tanpa salah-format "Ronde".
- **Bukti & Verifikasi** (`npx tsx audit-artifacts/dryrun_knockout_stage.ts` → **21/21 PASS**):
  - Guard: `!startknockout` ditolak saat masih ada fixture grup belum selesai (pesan berisi jumlah). (PASS)
  - Generasi pertama: 2 fixture SEMI_FINAL BO3 target-2 dari 2 grup, tanpa same-group rematch, audit event tercatat. (PASS)
  - Idempotensi: `!startknockout` kedua saat series aktif → info + daftar series, tanpa duplikasi fixture. (PASS)
  - `!kores`: game seri 1-1 → tidak menambah win series (wajib replay); replay 2-1 + game 2 0-2 → series 1-1; game 3 2-0 → BO3 selesai 2-1, series COMPLETED, fixture COMPLETED. (PASS)
  - Ronde berikutnya: kedua SF selesai → `!startknockout` membentuk GRAND FINAL BO5 target-3 + audit event ronde. (PASS)
  - Grand Final 3 kemenangan → turnamen COMPLETED; `!startknockout` selanjutnya menolak dengan pesan turnamen tuntas. (PASS)
  - `!matchday` menampilkan label ronde knockout aktif (SEMI FINAL). (PASS)

---

### [FIX2-RBAC-001] Hapus Fallback Organizer Hardcoded + Abort Startup (Prioritas 1 — High)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**: `src/cli/start.ts`, `.env.example`, `audit-artifacts/dryrun_fix2_items.ts`
- **Rencana & Masalah**: `process.env.WA_ORGANIZER_PHONE || '6281234567890'` di CLI memberi hak ORGANIZER penuh ke pemilik nomor contoh bila env lupa diset; `.env.example` juga memuat nilai contoh yang tampak seperti nilai nyata.
- **Perubahan Kode**:
  1. Startup kini membaca `WA_ORGANIZER_PHONE`/`WA_ORGANIZER_JID`, normalisasi digit, dan **abort dengan pesan deskriptif** bila keduanya kosong (selaras pola abort migrasi gagal / media secret hilang).
  2. `createApp` menerima nilai yang sudah tervalidasi (tidak ada fallback default).
  3. `.env.example`: entri organizer dikomentari + catatan wajib diset manual; nilai contoh nomor asli dihapus.
- **Bukti & Verifikasi** (`dryrun_fix2_items.ts` bagian RBAC — 4/4 PASS): fallback `'6281234567890'` tidak lagi ada di `start.ts`; pesan abort "Organizer identity missing" ada; `.env.example` bersih dari nomor tampak-nyata; subproses dengan env organizer kosong exit non-zero dengan pesan abort.

---

### [FIX2-APR-001] Command Organizer Reopen/Override Laporan LOCKED (Prioritas 1 — High)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**: `src/application/tournament-commands.ts` (command `!reopen`, `!override`), `audit-artifacts/dryrun_fix2_items.ts`
- **Rencana & Masalah**: `organizerOverrideLock`/`organizerReopenReport` ada di `src/reports/approval.ts` (FR-APR-004) tapi tidak pernah dipanggil runtime — organizer terkunci dari laporan LOCKED yang salah, kontradiksi dengan pesan error submitReportApproval sendiri.
- **Perubahan Kode**:
  1. Command `!reopen <report_version_id|fixture_id> <alasan>` (ORGANIZER-only): resolve version id (fallback fixture → versi terbaru), validasi status LOCKED, panggil `organizerReopenReport` (status → NEEDS_CORRECTION, audit event).
  2. Command `!override <report_version_id|fixture_id> <alasan>` (ORGANIZER-only): panggil `organizerOverrideLock` (lock paksa + `onReportLocked` writeback statistik + audit event).
  3. Alasan wajib (audit trail); pesan balasan menjelaskan status baru dan langkah berikutnya (koreksi / persetujuan ulang FR-APR-003).
- **Bukti & Verifikasi** (`dryrun_fix2_items.ts` bagian APR — 10/10 PASS): baseline lock konsensus 3 pihak; approval pada LOCKED ditolak; `!reopen` membuka ke NEEDS_CORRECTION; jalur approval/koreksi hidup kembali (vote diterima, konsensus re-lock); `!override` mengunci paksa versi terbuka; kedua audit event tercatat; non-organizer ditolak RBAC.

---

### [FIX2-LEASE-001] recoverOrphanedLeases Saat app.start() (Prioritas 2 — Medium)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**: `src/index.ts` (`start()`), `src/ingestion/debounce.ts` (`recoverOrphanedLeases`), `tests/unit/debounce.test.ts`, `audit-artifacts/dryrun_fix2_items.ts`
- **Rencana & Masalah**: `recoverOrphanedLeases` tidak pernah dipanggil; "restart-safe" hanya lewat expiry lease pasif (~30 detik). Ditemukan pula bug desain lama: fungsi hanya merecover lease yang SUDAH expired — padahal saat boot worker lama sudah pasti mati, sehingga lease yang masih hidup tidak dipulihkan sampai 30 detik.
- **Perubahan Kode**:
  1. `app.start()` kini memanggil `recoverOrphanedLeases` (async, log jumlah recovered) sebelum poll loop.
  2. `recoverOrphanedLeases` diubah merecover SEMUA sesi `status='PROCESSING'` (lease hidup ataupun tidak) — worker lama tidak ada lagi saat boot by definition; `claimDebounceBatch` tetap jadi safety net expiry saat runtime.
  3. Unit test restart-safety ditulis ulang mengikuti semantik baru (recover di t+20s walau lease nominally alive; langsung bisa di-claim worker baru).
- **Bukti & Verifikasi** (`dryrun_fix2_items.ts` bagian LEASE — PASS): sesi PROCESSING dengan lease masih hidup (expiry 25 detik di masa depan) berubah COLLECTING dalam <2 detik setelah `app.start()`, tanpa menunggu expiry. Unit suite: 223/223 PASS.

---

### [FIX2-WO-002] Tolak WO Claim NL dari Pengirim Non-Delegasi Tim Pelapor (Prioritas 2 — Medium)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**: `src/application/wo-claim-session.ts` (`resolveFixtureForWoClaim` fallback by team-name), `audit-artifacts/dryrun_fix2_items.ts`
- **Rencana & Masalah**: Fallback resolusi fixture by team-name mention tidak memverifikasi pengirim = delegasi tim reporting — user mana pun bisa staging klaim WO atas nama tim lain.
- **Perubahan Kode**: Fallback #4 kini (a) menolak pengirim tanpa delegasi terverifikasi dengan pesan penjelasan, dan (b) memverifikasi `reportingDelegateId === delegate tim reporting` sebelum staging; gate kedua `!ok` organizer tetap utuh.
- **Bukti & Verifikasi** (`dryrun_fix2_items.ts` bagian WO — 4/4 PASS): UNKNOWN sender → ditolak; delegasi sah tim pelapor → klaim staged; `!ok` organizer tetap mengesahkan (fixture WALKOVER 3-0).

---

### [FIX2-GROUP-001] Hapus Auto-Adopt Grup Resmi dari Command Admin (Prioritas 2 — Medium)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**: `src/whatsapp/router.ts` (group scope validation), `audit-artifacts/audit_sync_central_group.ts` (scenario di-update), `audit-artifacts/dryrun_fix2_items.ts`
- **Rencana & Masalah**: Organizer menjalankan command admin (`!createtournament` dll.) di grup lain otomatis menjadikan grup itu grup resmi baru tanpa konfirmasi — risiko salah kirim command di grup personal.
- **Perubahan Kode**: Auto-adopt hanya tersisa untuk (1) `!setgroup` eksplisit dan (2) bootstrap pertama saat belum ada grup resmi terkonfigurasi. Command admin lain di grup non-resmi ditolak dengan pesan yang mengarahkan ke `!setgroup`; pesan untuk non-organizer tidak berubah.
- **Bukti & Verifikasi** (`dryrun_fix2_items.ts` bagian GROUP — 3/3 PASS; `audit_sync_central_group.ts` scenario 3/4 baru — PASS): `!createtournament` di grup asing ditolak; central group tidak berubah; `!setgroup` tetap bisa pindah secara eksplisit.

---

### [FIX2-LOOKUP-001] Exact Match Fixture ID di !roomcard/!claimwo (Prioritas 3 — Low)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**: `src/application/tournament-commands.ts`, `audit-artifacts/dryrun_fix2_items.ts`
- **Rencana & Masalah**: `WHERE f.id = ? OR f.id LIKE ? || '%'` membuat input pendek ambigu (cocok ke beberapa fixture sekaligus, `LIMIT 1` pilih arbitrary); pesan bantuan memakai contoh `!roomcard 1 ok` yang mendorong kebiasaan prefix.
- **Perubahan Kode**: Lookup diubah exact-match penuh di kedua command; pesan error & contoh diperbarui mengarahkan penggunaan ID fixture lengkap (via `!schedule`).
- **Bukti & Verifikasi** (`dryrun_fix2_items.ts` bagian LOOKUP — 4/4 PASS): dua fixture dengan ID saling prefix (`fix-lookup` vs `fix-lookup-1`) diresolve tepat ke fixture yang dimaksud (ROUND_2); update status host menulis ke fixture yang tepat; input pendek non-exact ditolak dengan pesan jelas; string LIKE prefix hilang dari SQL.

---

### [FIX2-SQL-001] Parameterize IN (...) di claimDebounceBatch (Prioritas 3 — Low)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**: `src/ingestion/debounce.ts`, `audit-artifacts/dryrun_fix2_items.ts`
- **Rencana & Masalah**: `IN (${messageIds})` menggabungkan ID langsung ke string SQL — melanggar pola parameterized file lain.
- **Perubahan Kode**: Placeholder `?` array sesuai pola `player_game_stats` di `stats.ts`.
- **Bukti & Verifikasi**: `dryrun_fix2_items.ts` bagian SQL — 2/2 PASS (string concat hilang, placeholder ada); full suite 223/223 PASS (jalur debounce batch dieksekusi dry-run e2e lintas-artifact juga lolos).

---

### [FIX2-DEADCODE-001] Hapus recordGenuineDraw (Prioritas 3 — Low)
- **Status**: Selesai & Terverifikasi (keputusan: HAPUS)
- **Modul/File Terkait**: `src/competition/walkover.ts`, `tests/unit/competition.test.ts`, `audit-artifacts/dryrun_fix2_items.ts`
- **Rencana & Masalah**: `recordGenuineDraw` dead code — hasil seri resmi sudah berjalan lewat `onReportLocked` → `games.is_draw=1` → `computeGroupStandings` (1 poin, FR-CALC-001) yang terverifikasi dry-run; signature fungsi juga cacat (`score` tunggal untuk kedua sisi, tak bisa merepresentasikan 2-2 vs 1-1).
- **Perubahan Kode**: Fungsi dihapus; unit test "double WO 0 poin ≠ seri sah 1 poin" ditulis ulang memverifikasi jalur resmi standings (game is_draw → computeGroupStandings → 1 poin) vs double walkover (0 poin).
- **Bukti & Verifikasi**: `dryrun_fix2_items.ts` bagian DEADCODE — 2/2 PASS; `tests/unit/competition.test.ts` 23/23 PASS dalam full suite 223/223.

---

### Bug Baru Ditemukan (Dilaporkan, TIDAK Diperbaiki Sendiri — Status: REPORTED / PENDING_APPROVAL)
1. **5 error TypeScript pre-existing di `master`** (`tsc --noEmit` di commit `16c97bb` tanpa perubahan saya): `PendingWoClaim` membutuhkan field `id` yang tidak diisi di `tournament-commands.ts:2584` (jalur `!claimwo` delegate) dan `NormalizedMessage` tidak punya properti `sender_id` yang dipakai di `wo-claim-session.ts`/`router.ts`/`tournament-commands.ts` (4 lokasi). Suite test tidak meng-cover path ini sehingga tetap 223/223 PASS — runtime bisa `undefined.split` pada jalur tertentu. Direkomendasikan perbaikan terpisah (tambahkan `id: randomUUID()` pada staging `!claimwo`; ganti `sender_id` → `sender_raw_address`).
2. **Approvals tidak di-reset saat reopen**: `organizerReopenReport` mengubah status versi namun **tidak menghapus baris approvals lama** — vote pertama setelah reopen langsung melengkapi konsensus 3 pihak (vote TEAM_A tunggal → LOCKED lagi). Ini melanggar semangat FR-APR-003 ("any new version creates a fresh version with 0 approvals") untuk kasus reopen-versi-sama. Dry-run saya mendokumentasikan perilaku ini sebagai baseline; perbaikan (DELETE approvals saat reopen) sebaiknya diputuskan Arya karena berdampak pada UX koreksi pasca-reopen.

---

### Ringkasan Akhir & Regression Gate Check (branch fix/second-opinion-findings)

**Full Vitest Suite**: 18 file / **223/223 PASS** (durasi ~12s; test restart-lease & genuine-draw ditulis ulang mengikuti semantik baru FIX2-LEASE-001 / FIX2-DEADCODE-001).

**Dry-run audit-artifacts (14/14 PASS)**:

| # | Skrip | Status |
|---|-------|--------|
| 1–12 | `audit_command_router_wiring`, `audit_db_migration_failure`, `audit_end_to_end_tournament_flow`, `audit_gemini_key_validation`, `audit_goalkeeper_and_batch_pipeline`, `audit_rbac_wo_claim`, `audit_roomcard_commands`, `audit_roster_pipe_and_table`, `audit_round_robin_5teams`, `audit_sec_media_secret`, `audit_sync_central_group` (scenario 3 di-update per FIX2-GROUP-001), `audit_trusted_context` | **12/12 PASS** |
| 13 | `dryrun_knockout_stage.ts` (baru, FIX2-KO-001) | **21/21 PASS** |
| 14 | `dryrun_fix2_items.ts` (baru, 8 temuan lain) | **30/30 PASS** |

**Dry-run second-opinion lintas-branch** (`second-opinion-audit-artifacts/dryrun_e2e.ts` dari branch `audit/second-opinion-v1`, dijalankan terhadap kode hasil fix): **34/34 PASS**.


## [2026-11-20] Sesi Independen: Fix 2 Bug TypeScript Pre-Existing dari master (Task: flash-peak-tms-fix-preexisting-ts-bugs-v1, Branch: fix/preexisting-ts-bugs → PR baru)

### Konteks Sesi
Sesi ini memperbaiki **2 bug TypeScript pre-existing di master** yang saya temukan dan laporkan sendiri saat typecheck di sesi PR #2 (branch fix/second-opinion-findings), namun saat itu sengaja TIDAK diperbaiki karena di luar scope task (sesuai aturan kerja: dilaporkan dulu, status REPORTED). Keduanya sudah ada SEBELUM PR #2 dan bukan regresi darinya. Sesi ini mengerjakan fix-nya sebagai task tersendiri di **branch baru `fix/preexisting-ts-bugs` dari master terkini `16c97bb`** (independen dari PR #2 yang masih berjalan; tanpa merge).

Saat typecheck di master murni awal sesi, kedua bug terkonfirmasi persis seperti laporan sebelumnya (5 baris error): 1× `PendingWoClaim.id` + 4× `sender_id`.

---

### [BUGFIX-TS-001] PendingWoClaim.id tidak terisi di jalur !claimwo
- **Status**: Selesai & Terverifikasi
- **File**: `src/application/tournament-commands.ts` (handler `!claimwo`, konstruksi `PendingWoClaim`)
- **Akar masalah** (dianalisis dulu sebelum fix): interface `PendingWoClaim` (src/application/wo-claim-session.ts) mensyaratkan field `id: string`, dan jalur natural-language WO-claim di `src/index.ts` SUDAH mengisinya dengan `id: randomUUID()` — tapi handler command `!claimwo` di tournament-commands.ts lupa mengisi field itu. Sesi WO di-keying per `chatId` (bukan per id) sehingga `id` saat ini tidak pernah *dibaca* oleh wo-claim-session (stagePendingClaim/getPending/confirmPending/rejectPending semua pakai chatId) — namun kontrak tipe terlanggar dan jika ada referensi `claim.id` di masa depan (mis. untuk audit/korelasi) akan mendapat `undefined` di jalur `!claimwo` saja, tidak di jalur NL. Perbedaan perilaku antar-dua jalur input yang sama fungsi inilah risiko laten yang sebenarnya.
- **Fix**: generate `id: randomUUID()` di titik konstruksi claim di handler `!claimwo` — konsisten persis dengan jalur NL yang sudah benar (`randomUUID` sudah di-import). Tidak ada tempat lain yang perlu diubah karena tidak ada konsumen id saat ini; kedua jalur kini menghasilkan claim dengan id identik dalam format dan semantik.
- **Bukti & Verifikasi** (`npx tsx audit-artifacts/dryrun_fix_preexisting_ts_bugs.ts` — T1, 8/8 PASS): delegasi `!claimwo` → pending claim tersedia di sesi; **`pending.id` string non-kosong dengan format UUID valid** (sebelum fix: undefined); `reportedByAddress` = sender_raw_address delegasi; organizer `!ok` → klaim disahkan, WO 3-0 tercatat di `games` (is_walkover=1); pending ter-clear. End-to-end jalur `!claimwo` utuh tanpa regresi (dry-run lama `audit_rbac_wo_claim.ts` juga tetap PASS).

---

### [BUGFIX-TS-002] Properti sender_id dipakai di 4 lokasi padahal tidak ada di NormalizedMessage
- **Status**: Selesai & Terverifikasi
- **File**: `src/application/tournament-commands.ts` (1 lokasi: reportedByAddress di `!claimwo`), `src/whatsapp/router.ts` (3 lokasi: `isSenderOrganizer` ×2, `handleMessage` delegate resolution)
- **Akar masalah** (dianalisis dulu sebelum fix): keempat lokasi memakai pola fallback `message.sender_raw_address || message.sender_id`, tapi `sender_id` **tidak pernah ada** di tipe `NormalizedMessage` — field yang tersedia adalah `sender_raw_address` (required, `string`), `sender_normalized_address`, `participant`, dll. Ini field warisan dari pra-refactor normalisasi pesan (sisa nama lama). Analisis normalizer (src/whatsapp/normalizer.ts): `sender_raw_address = msg.key.participant || msg.key.remoteJid || ''` dan pesan tanpa `remoteJid` langsung di-drop (`return null`) — jadi **setiap NormalizedMessage yang ada di runtime pasti punya sender_raw_address non-kosong** (minimum remoteJid). Kesimpulan akar masalah: **bukan** tipe yang kurang field (menambah `sender_id` ke tipe hanya agar tsc diam adalah salah kaprah — tidak ada produser yang mengisi field itu); akar masalahnya adalah 4 referensi ke field yang tidak pernah ada → fallback mati yang tampaknya aman di typecheck lama.
- **Fix**: hapus fallback `|| message.sender_id` di keempat lokasi; nilai yang dipakai kini murni `sender_raw_address` yang required dan dijamin non-kosong. Perilaku runtime tidak berubah untuk pesan hasil normalizer (nilai `undefined || x` tidak pernah tercapai); yang berubah hanya hilangnya referensi property ilegal.
- **Temuan turunan penting selama verifikasi**: 2 dry-run lama (`audit_sync_central_group.ts`, `audit_roomcard_commands.ts`) ternyata membangun `NormalizedMessage` buatan dengan field ilegal `sender_id`/`sender_phone` **tanpa** `sender_raw_address` — selama ini jalurnya "bekerja" justru karena fallback `|| sender_id` menutup `undefined`. Setelah fallback dihapus, kecurangan itu tersingkap dan dry-run crash di `isSenderOrganizer`. Dry-run lama inilah bukti nyata kenapa pemakaian field yang tidak ada di tipe itu berbahaya. Keduanya diperbaiki dengan membangun pesan **sesuai kontrak tipe** (`sender_raw_address` + `sender_normalized_address`), bukan dengan menghidupkan kembali field ilegal.
- **Bukti & Verifikasi** (`dryrun_fix_preexisting_ts_bugs.ts` — T2, 8/8 PASS): (A) `isSenderOrganizer` mengenali organizer via JID dari `sender_raw_address`, menolak non-organizer; (B) jalur fallback nomor telepon (`rawDigits` — lokasi fix kedua di router) mengenali organizer via organizerPhone tanpa kecocokan JID; (C) command dari delegasi non-organizer terproses via `handleMessage` → `resolveIdentity(sender_raw_address)` VERIFIED (nilai valid, bukan undefined); (D) jalur `!claimwo` (lokasi ke-4) aman dengan `reportedByAddress` terisi valid. Keempat lokasi terbukti menerima nilai valid saat runtime — bukan sekadar typecheck lolos.
- **Regression penuh sesi ini**: `tsc --noEmit` **0 error** (sebelumnya 5 — target task tercapai); full vitest suite **223/223 PASS** (18 file); sweep 13 dry-run audit-artifacts **13/13 PASS** (termasuk `audit_rbac_wo_claim.ts`, `audit_roomcard_commands.ts`, `audit_sync_central_group.ts` yang menjangkau jalur-jalur terdampak, dan dry-run baru `dryrun_fix_preexisting_ts_bugs.ts`).

---

### Catatan Tambahan
1. Branch `fix/preexisting-ts-bugs` dibuat **dari master terkini** (bukan dari branch PR #2) karena task ini independen; PR baru dibuka ke master dan **tidak di-merge** — menunggu review Arya, konsisten dengan proses sebelumnya.
2. PR #2 (`fix/second-opinion-findings`) tidak disentuh sama sekali di sesi ini; kedua bug fix ini akan berujung konflik minimal dengan PR #2 karena perubahan di area yang sama (`tournament-commands.ts` `!claimwo`) bersifat tambahan baris `id: randomUUID()` dan penghapusan fallback — mudah di-resolve saat merge.


## [2026-11-20] Sesi Perbaikan Temuan Audit Independen (Task: flash-peak-tms-fix-audit-findings-v1)

### Konteks Sesi
Sesi ini dilakukan sebagai tindak lanjut langsung dari laporan audit independen `flash-peak-tms-full-wiring-audit-v1` (19 November 2026). Audit tersebut memverifikasi kondisi aktual kode setelah modularisasi `src/index.ts` ke `src/application/` dan mengidentifikasi celah kritis pada pipeline bukti kiper (screenshot diabaikan, ekstraktor kiper tidak terpanggil, resolver identitas kiper dead code), kegagalan broadcast otomatis matchday saat central group didaftarkan dinamis, fallback hardcoded HMAC secret di media service, logika room card fallback yang terisolasi dari router, serta beberapa ketidaksesuaian RBAC dan context AI.

Semua perbaikan pada sesi ini dikerjakan secara berurutan sesuai prioritas (Critical $\rightarrow$ High $\rightarrow$ Medium $\rightarrow$ Low) dengan tetap menjaga arsitektur modular `src/application/` tanpa menarik logika kembali ke `src/index.ts`.

---

### [FIX-GK-001 & FIX-GK-002] Integrasi Goalkeeper Detail Extractor & Validasi Kuota Screenshot BO3/BO5
- **Prioritas**: Critical (Prioritas 1)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `src/application/evidence-batch-processor.ts`
  - `src/index.ts`
  - `audit-artifacts/audit_goalkeeper_and_batch_pipeline.ts`
- **Rencana & Masalah**:
  - Pada `evidence-batch-processor.ts`, aset bertipe `INDIVIDUAL_PLAYER_DETAIL` dikumpulkan ke `gkDetailAssets` namun diabaikan sama sekali (tidak ada pemanggilan extractor). Nilai `goalkeeper_saves` pada `team_a_players`/`team_b_players` di-hardcode ke `null`.
  - Fungsi `resolveGoalkeeperIdentity` dari `src/ai/extractors/gk-identity.ts` tidak pernah dipanggil di jalur pemrosesan batch.
  - Tidak ada validasi jumlah screenshot kiper untuk format knockout series (BO3 minimal 2 screenshot kemenangan, BO5 minimal 3 screenshot kemenangan).
- **Perubahan Kode**:
  1. Menambahkan `gkExtractor?: GoalkeeperDetailExtractor` ke interface `EvidenceBatchProcessorDeps` pada `src/application/evidence-batch-processor.ts`.
  2. Meneruskan `gkExtractor: this.gkExtractor` saat memanggil `processClaimedBatch` di `src/index.ts`.
  3. Mengumpulkan caption dari media individual player detail untuk disambungkan ke resolver identitas.
  4. Memeriksa format seri (`BO3` / `BO5` / Group). Menghitung `expectedGkCount` (BO3: 2, BO5: 3, Grup: 1, atau 0 jika imbang). Jika jumlah screenshot kiper dari tim submitting kurang dari kuota, memvalidasi dan menandai status laporan menjadi `NEEDS_CORRECTION` dengan pesan peringatan informatif di template WhatsApp.
  5. Memanggil `deps.gkExtractor.extract()` untuk setiap aset `INDIVIDUAL_PLAYER_DETAIL`, lalu memanggil `resolveGoalkeeperIdentity()` mencocokkan caption/nama kiper ke roster aktif tim yang submit.
  6. Memetakan hasil ekstraksi saves (`gkSavesByNickname`) ke pemain terkait di `rawPlayersForA` dan `rawPlayersForB`, mengeliminasi hardcode `null`.
- **Bukti & Verifikasi**:
  - Menjalankan `npx tsx audit-artifacts/audit_goalkeeper_and_batch_pipeline.ts`:
    - Scenario 1 (BO3 dengan 2 screenshot kiper): status `DRAFT_CREATED`, `gkExtractor` dipanggil 2x, `goalkeeper_saves` = 7. (PASS)
    - Scenario 2 (BO3 dengan 1 screenshot kiper): status `NEEDS_CORRECTION`, peringatan kuota kiper muncul di ringkasan pesan WA. (PASS)
    - Scenario 3 (BO3 dengan 3 screenshot kiper): status `DRAFT_CREATED`, saves terekstrak dengan catatan kelebihan screenshot. (PASS)
  - Menjalankan `npm test`: 223/223 test PASS.

---

### [FIX-SYNC-001] Sinkronisasi centralGroupJid Antara Router, MatchdayService, dan FlashPeakApp
- **Prioritas**: High (Prioritas 2)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `src/whatsapp/router.ts`
  - `src/application/matchday-service.ts`
  - `src/index.ts`
  - `audit-artifacts/audit_sync_central_group.ts`
- **Rencana & Masalah**:
  - Command `!setgroup` dan `!createtournament` meng-update `centralGroupJid` di router via `this.setCentralGroupJid(jid)`, tetapi tidak meng-update `this.centralGroupJid` milik `FlashPeakApp` dan tidak memanggil `this.matchdayService.setCentralGroupJid(jid)`.
  - Jika bot dijalankan tanpa env variable `WA_CENTRAL_GROUP_JID` (atau grup didaftarkan dinamis saat runtime), `matchdayService` tetap memegang `centralGroupJid = ""` sehingga broadcast jadwal matchday tidak dapat terkirim.
  - Selain itu, ditemukan bug edge-case di `router.ts`: `message.sender_raw_address.toLowerCase()` melempar `TypeError` jika `sender_raw_address` tidak terdefinisi.
- **Perubahan Kode**:
  1. Menambahkan listener callback `onCentralGroupJidChange` pada `CommandRouter` (`src/whatsapp/router.ts`) dan method `onGroupJidChanged(listener)`.
  2. Memastikan pemanggilan `this.setCentralGroupJid(normalizedChatId)` di router saat admin menjalankan command administratif atau pendaftaran grup baru (menggantikan assignment field direct).
  3. Memperbaiki null safety pada pengecekan `isSenderOrganizer` di `router.ts`.
  4. Menambahkan getter `getCentralGroupJid(): string` pada `MatchdayService`.
  5. Mengubah field `centralGroupJid` di `FlashPeakApp` agar mutable, mendaftarkan listener di constructor yang mensinkronkan `FlashPeakApp.centralGroupJid` dan `matchdayService.setCentralGroupJid(newJid)`, serta mengekspos helper method `setCentralGroupJid(jid)` dan `getCentralGroupJid()`.
- **Bukti & Verifikasi**:
  - Membuat dan menjalankan `audit-artifacts/audit_sync_central_group.ts`:
    - Scenario 1: Bot start dengan central group kosong $\rightarrow$ Organizer kirim `!setgroup` $\rightarrow$ ketiga komponen (`app`, `router`, `matchdayService`) sinkron ke group JID baru. (PASS)
    - Scenario 2: Pemanggilan programatik `app.setCentralGroupJid()` $\rightarrow$ ketiga komponen sinkron. (PASS)
    - Scenario 3: Organizer kirim `!createtournament` dari group baru $\rightarrow$ ketiga komponen otomatis ter-update ke group baru. (PASS)
  - Menjalankan `npm test`: 223/223 test PASS.

---

### [FIX-SEC-001B] Penghapusan Fallback Secret Hardcoded di flashpeak-media & Konfigurasi PM2 Ecosystem
- **Prioritas**: High (Prioritas 2)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `services/flashpeak-media/config.ts`
  - `services/flashpeak-media/server.ts`
  - `ecosystem.config.cjs`
  - `audit-artifacts/audit_sec_media_secret.ts`
- **Rencana & Masalah**:
  - Line 28 `services/flashpeak-media/config.ts` masih memiliki fallback secret HMAC ter-hardcode (`'e56ad9530df7d79427f1e39d089210eddf18c55d136ca4a3cec438eff86dc206'`) meskipun dokumentasi sebelumnya mengklaim sudah dihapus.
  - `ecosystem.config.cjs` tidak mendefinisikan `FLASHPEAK_MEDIA_SECRET` di blok env `flashpeak-media`, sehingga jika dideploy via PM2 berpotensi memakai secret default.
- **Perubahan Kode**:
  1. Menghapus fallback string hex hardcode pada `services/flashpeak-media/config.ts`. Mengubah `getDefaultConfig(overrides)` agar melempar error deskriptif jika `FLASHPEAK_MEDIA_SECRET` atau `MEDIA_SERVICE_HMAC_SECRET` tidak tersedia di environment.
  2. Memperbarui `createMediaServer` di `services/flashpeak-media/server.ts` agar melewatkan `customConfig` ke `getDefaultConfig(customConfig)` sebelum memvalidasi ketersediaan secret (sehingga unit test dengan mock config tetap berjalan mulus).
  3. Menambahkan mapping environment variable `FLASHPEAK_MEDIA_SECRET` dan `MEDIA_SERVICE_HMAC_SECRET` pada kedua app (`flashpeak-media` dan `flashpeak-bot`) di `ecosystem.config.cjs`.
  4. Melakukan audit grep menyeluruh terhadap string rahasia dan hex 32-64 karakter di seluruh codebase `src/` dan `services/`.
- **Bukti & Verifikasi**:
  - Membuat dan menjalankan `audit-artifacts/audit_sec_media_secret.ts`:
    - Static check: memastikan string hex rahasia tidak lagi berada di `config.ts`. (PASS)
    - Dynamic check: memastikan `getDefaultConfig()` melempar error saat secret tidak ada di env. (PASS)
    - Dynamic check: memastikan secret terbaca dengan benar dari `FLASHPEAK_MEDIA_SECRET` maupun `MEDIA_SERVICE_HMAC_SECRET`. (PASS)
  - Menjalankan `npm test`: 223/223 test PASS (termasuk 19/19 test suite media).

---

### [FIX-WO-001] Integrasi Logika Room Host Availability & Fallback ke Router Command (!roomcard)
- **Prioritas**: High (Prioritas 2)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `src/application/tournament-commands.ts`
  - `audit-artifacts/audit_roomcard_commands.ts`
- **Rencana & Masalah**:
  - Fungsi `evaluateRoomHostAvailability` di `src/competition/walkover.ts` sebelumnya tidak memiliki jalur pemanggilan dari WhatsApp command router.
  - Aturan FR-COMP-014, D-029, D-031, dan D-032 (tim kiri default $\rightarrow$ tim kanan ganti $\rightarrow$ tim kanan menolak jadi WO $\rightarrow$ kedua tim tidak punya kartu: grup 0 poin vs knockout wajib reschedule) tidak dapat diakses atau dipicu oleh user/panitia.
- **Perubahan Kode**:
  1. Mengimpor `evaluateRoomHostAvailability` ke `src/application/tournament-commands.ts`.
  2. Mengimplementasikan `roomCardHandler` dan mendaftarkan 3 command aliases: `!roomcard`, `!karturoom`, `!hostroom` dengan role `ANY` (dapat diakses organizer dan delegasi tim bertanding).
  3. Menyediakan navigasi status:
     - `!roomcard <fixture_id>`: Menampilkan status tuan rumah default (kiri), host aktif saat ini, dan panduan perintah.
     - `!roomcard <fixture_id> ok`: Tuan rumah terjadwal (kiri) memiliki room card dan siap menjadi host game.
     - `!roomcard <fixture_id> ganti`: Kiri tidak punya room card, lawan bersedia menggantikan sebagai host (status `OPPONENT_SUBSTITUTED`).
     - `!roomcard <fixture_id> tolak`: Kiri tidak punya room card, lawan menolak menggantikan $\rightarrow$ lawan menang WO 3-0.
     - `!roomcard <fixture_id> habis`: Kedua tim tidak memiliki room card. Pada Group Stage mencatat double walkover 0–0 (0 poin masing-masing tanpa statistik pemain per D-031) serta memperbarui klasemen grup; pada Knockout Stage menetapkan status wajib reschedule per D-032 (jadwal dikosongkan untuk penjadwalan ulang oleh panitia).
- **Bukti & Verifikasi**:
  - Membuat dan menjalankan `audit-artifacts/audit_roomcard_commands.ts`:
    - Test 1: Info display status room host. (PASS)
    - Test 2: Status `ok` $\rightarrow$ `DEFAULT_LEFT_SIDE`. (PASS)
    - Test 3: Status `ganti` $\rightarrow$ `OPPONENT_SUBSTITUTED`. (PASS)
    - Test 4: Status `tolak` $\rightarrow$ Single Forfeit (Singa FC menang WO 3-0). (PASS)
    - Test 5: Status `habis` di Group Stage $\rightarrow$ `GROUP_DOUBLE_WALKOVER_RECORDED` (0 poin masing-masing). (PASS)
    - Test 6: Status `habis` di Knockout Stage $\rightarrow$ `KNOCKOUT_RESCHEDULE_REQUIRED` (wajib reschedule, scheduled_at dibersihkan). (PASS)
  - Menjalankan `npm test`: 223/223 test PASS.

---

### [FIX-RBAC-001] Staging Klaim WO oleh Delegasi & Eksekusi Langsung oleh Panitia (!claimwo)
- **Prioritas**: Medium (Prioritas 3)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `src/application/tournament-commands.ts`
  - `src/whatsapp/router.ts`
  - `audit-artifacts/audit_rbac_wo_claim.ts`
- **Rencana & Masalah**:
  - Command `!claimwo`, `!klaimwo`, `!wo` sebelumnya di-lock hanya untuk panitia (`requiredRole: 'ORGANIZER'`).
  - Delegasi resmi tim tidak dapat mengajukan klaim WO melalui command, padahal rancangan FR-FIX-001 dan `wo_claim.ts` mendesain dua jalur: delegasi mengajukan klaim $\rightarrow$ status staged pending $\rightarrow$ panitia mengonfirmasi dengan `!ok` (atau `!batal`).
  - Selain itu, ditemukan bug pada context command: kode sebelumnya memeriksa `ctx.senderDelegate` yang tidak pernah ada di `CommandContext` (field sesungguhnya adalah `ctx.delegateId`).
- **Perubahan Kode**:
  1. Mengubah `requiredRole` untuk command `claimwo`, `klaimwo`, `wo` dari `'ORGANIZER'` menjadi `'ANY'`.
  2. Memperbaiki pengecekan delegasi dengan menggunakan `ctx.delegateId` pada `claimWoHandler` dan `roomCardHandler`.
  3. Mengimplementasikan dual-flow pada `claimWoHandler`:
     - **Jalur Delegasi**: Jika pengirim bukan panitia, sistem memverifikasi bahwa pengirim adalah delegasi resmi dari tim yang bertanding. Data klaim kemudian di-stage ke `deps.woClaimSession.stagePendingClaim(claim)` dengan TTL 15 menit. Bot memberikan respons bahwa klaim WO telah diajukan dan menunggu persetujuan panitia via `!ok` atau penolakan via `!batal`. Fixture tetap pada status `SCHEDULED` sampai panitia mengonfirmasi.
     - **Jalur Panitia (Organizer)**: Jika pengirim adalah panitia, klaim WO dieksekusi langsung secara administratif (`handleSingleForfeit`), fixture menjadi `WALKOVER`, skor resmi 3-0 dicatat, dan klasemen grup otomatis diperbarui.
  4. Memperbaiki null safety pada `message.sender_raw_address` di `src/whatsapp/router.ts` saat memanggil `isSenderOrganizer` dan `resolveIdentity`.
- **Bukti & Verifikasi**:
  - Membuat dan menjalankan `audit-artifacts/audit_rbac_wo_claim.ts`:
    - Test 1: User acak / tidak terdaftar mencoba `!claimwo` $\rightarrow$ ditolak izinnya. (PASS)
    - Test 2: Delegasi tim peserta mengajukan `!claimwo` $\rightarrow$ klaim tersimpan di `woClaimSession`, notifikasi konfirmasi panitia muncul, fixture tetap `SCHEDULED`. (PASS)
    - Test 3: Panitia membalas `!ok` $\rightarrow$ klaim disahkan, fixture berubah menjadi `WALKOVER`, skor 3-0, poin bertambah, `woClaimSession` dibersihkan. (PASS)
    - Test 4: Panitia langsung mengeksekusi `!claimwo` $\rightarrow$ langsung diterapkan tanpa staging. (PASS)
  - Menjalankan `audit-artifacts/audit_roomcard_commands.ts`: 6/6 test PASS.
  - Menjalankan `npm test`: 223/223 test PASS.

---

### [FIX-CTX-001] Propagasi Grounded trusted_context (Nama Tim & Roster) ke MatchSummaryExtractor
- **Prioritas**: Medium (Prioritas 3)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `src/application/evidence-batch-processor.ts`
  - `audit-artifacts/audit_trusted_context.ts`
- **Rencana & Masalah**:
  - Pada `evidence-batch-processor.ts`, `matchExtractor.extract()` dipanggil sebelum data fixture di-query dan tanpa parameter `trusted_context`.
  - Hal ini menyebabkan AI vision model mengekstrak nama tim dan pemain tanpa panduan konteks data yang sah dari database, sehingga meningkatkan risiko halusinasi OCR pada nama tim dan Unicode nickname pemain.
- **Perubahan Kode**:
  1. Menggeser pemanggilan query fixture (`fixtures`, `teams`, `games`) ke sebelum eksekusi `matchExtractor.extract()`.
  2. Menambahkan query daftar pemain aktif (`status = 'ACTIVE'`) dari kedua tim yang bertanding (`team_a_id` dan `team_b_id`) dari tabel `players`.
  3. Membentuk objek `trusted_context` yang mencakup:
     - `fixture_id`
     - `team_a_name`
     - `team_b_name`
     - `expected_roster`: array nickname pemain terdaftar beserta `team_id` terkait.
  4. Meneruskan `trusted_context` dan `correlation_id` (`session-${sessionId}`) ke options `matchExtractor.extract({ mime_type, base64 }, { trusted_context, correlation_id })`.
- **Bukti & Verifikasi**:
  - Membuat dan menjalankan `audit-artifacts/audit_trusted_context.ts`:
    - Memverifikasi objek `trusted_context` diterima oleh `matchExtractor.extract()`.
    - Memverifikasi nama kedua tim (`Elang Mas FC` & `Harimau Putih FC`) dan 10 pemain roster terisi lengkap.
    - Memverifikasi prompt yang dikirim ke AI router memuat JSON `trusted_context` sehingga grounding AI bekerja. (PASS)
  - Menjalankan `audit-artifacts/audit_goalkeeper_and_batch_pipeline.ts`: 3/3 scenario PASS.
  - Menjalankan `npm test`: 223/223 test PASS.

---

### [FIX-ROSTER-001] Pembersihan Tabel Markdown & Penanganan Kolom Pipe di parseRosterInput
- **Prioritas**: Medium (Prioritas 3)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `src/application/tournament-commands.ts`
  - `audit-artifacts/audit_roster_pipe_and_table.ts`
- **Rencana & Masalah**:
  - Pada pengujian `audit_roster_pipe_and_table.ts`, Test 3 (pendaftaran roster via format tabel markdown dengan pemisah pipe `|`) sebelumnya GAGAL pada parser deterministik.
  - Parser regex sederhana memperlakukan baris header tabel (`| No | Posisi | Nickname |`) dan baris pemisah (`|---|---|---|`) sebagai nama tim / nama pemain, serta menelan pipe pembatas kolom sehingga clan tag dengan pipe menjadi rusak.
- **Perubahan Kode**:
  1. Menambahkan deteksi dan parser tabel markdown khusus di awal `parseRosterInput` (`src/application/tournament-commands.ts`).
  2. Memisahkan baris teks sebelum tabel (untuk nama tim) dari baris tabel.
  3. Memfilter dan mengabaikan baris header tabel markdown (misal `No`, `Posisi`, `Nickname`, `Pemain`) dan separator baris (`|---|---|---|`).
  4. Untuk setiap baris data tabel markdown:
     - Menghapus pipe di awal dan akhir baris.
     - Membaca kolom sel: mengidentifikasi posisi (`GK`, `Inti`, `Cadangan`), mengabaikan kolom nomor urut baris (jika ada).
     - Menggabungkan kembali sisa sel dengan pipe (` | `) sehingga clan tag pemain yang menggunakan pipe (seperti `AVO | Zenyth`, `RRQ | Lemon`) tetap utuh tanpa terpecah.
- **Bukti & Verifikasi**:
  - Menjalankan ulang `audit-artifacts/audit_roster_pipe_and_table.ts`:
    - Test 1 (Single-line dengan pipe clan tag & section pipes): PASS.
    - Test 2 (Multiline dengan pipe clan tag): PASS.
    - Test 3 (Markdown table dengan pipe columns): PASS (`gkName`: `'AVO | Zenyth'`, 4 starters, 1 sub).
    - Test 4 (Pemeriksaan prompt AI): PASS.
  - Menjalankan `npm test`: 223/223 test PASS.

---

### [FIX-APIKEY-001] Perbaikan Pengecekan Validasi Gemini API Key di CLI Startup
- **Prioritas**: Low (Prioritas 4)
- **Status**: Selesai & Terverifikasi
- **Modul/File Terkait**:
  - `src/cli/start.ts`
  - `audit-artifacts/audit_gemini_key_validation.ts`
- **Rencana & Masalah**:
  - Pada `src/cli/start.ts` baris 139, kondisi validasi key Gemini: `if (geminiKey && geminiKey !== 'AIzaSy_placeholder_gemini_api_key' && !geminiKey.startsWith('AIzaSy_'))`.
  - Prefix resmi API key Google AI Studio (Gemini) adalah `AIzaSy`. Pengecekan `!geminiKey.startsWith('AIzaSy_')` menyebabkan key asli yang diawali `AIzaSy_` dianggap sebagai placeholder secara keliru sehingga inisialisasi Gemini adapter terabaikan dan fallback ke provider lain.
- **Perubahan Kode**:
  1. Mengubah kondisi pengecekan agar memeriksa placeholder secara spesifik: `geminiKey !== 'AIzaSy_placeholder_gemini_api_key' && !geminiKey.includes('placeholder')`.
- **Bukti & Verifikasi**:
  - Membuat dan menjalankan `audit-artifacts/audit_gemini_key_validation.ts`:
    - Menguji 6 variasi key (default placeholder, string placeholder sembarang, key dengan prefix `AIzaSy_`, key dengan prefix `AIzaSy`, string kosong, undefined).
    - Semua test case menghasilkan nilai evaluasi yang sesuai ekspektasi. (PASS)
  - Menjalankan `npm test`: 223/223 test PASS.

---

## Ringkasan Akhir & Regression Gate Check

Seluruh 12 skrip pengetesan independen pada direktori `audit-artifacts/` dan full unit/integration test suite (`npm test`) telah dijalankan ulang sebagai regression check menyeluruh setelah semua perbaikan selesai.

### Hasil Eksekusi Audit Artifacts (12/12 PASS):
| # | Skrip Audit | Area / Fitur Terkait | Status |
|---|-------------|----------------------|--------|
| 1 | `audit_command_router_wiring.ts` | Registrasi 36 command router & penolakan RBAC non-organizer | **PASS** |
| 2 | `audit_db_migration_failure.ts` | Abort startup & integritas atomik saat migrasi SQL korup | **PASS** |
| 3 | `audit_end_to_end_tournament_flow.ts` | Transisi state turnamen end-to-end (Draft $\rightarrow$ Draw $\rightarrow$ Fixture $\rightarrow$ Report $\rightarrow$ Standings $\rightarrow$ Awards) | **PASS** |
| 4 | `audit_gemini_key_validation.ts` | Validasi API key Gemini tanpa false rejection pada prefix `AIzaSy_` | **PASS** |
| 5 | `audit_goalkeeper_and_batch_pipeline.ts` | Ekstraksi saves kiper, resolver identitas nickname via caption, dan validasi kuota BO3/BO5 | **PASS** |
| 6 | `audit_rbac_wo_claim.ts` | Alur staging klaim WO oleh delegasi vs eksekusi administratif langsung oleh panitia | **PASS** |
| 7 | `audit_roomcard_commands.ts` | Command `!roomcard` untuk evaluasi host (default kiri, substitusi kanan, WO tolak, WO ganda grup 0 poin, wajib reschedule knockout) | **PASS** |
| 8 | `audit_roster_pipe_and_table.ts` | Parsing roster single-line, multiline, dan tabel markdown dengan karakter pipe clan tag | **PASS** |
| 9 | `audit_round_robin_5teams.ts` | Jadwal round-robin 5 tim menghasilkan tepat single round-robin (10 match, 4 match/tim) & keseimbangan host kiri/kanan | **PASS** |
| 10 | `audit_sec_media_secret.ts` | Eliminasi hardcode HMAC secret di `config.ts` dan error handling saat env rahasia tidak disetel | **PASS** |
| 11 | `audit_sync_central_group.ts` | Sinkronisasi dinamis `centralGroupJid` antara router, matchday service, dan app instance | **PASS** |
| 12 | `audit_trusted_context.ts` | Propagasi grounded `trusted_context` (nama tim dan daftar roster aktif) ke ekstraksi vision AI | **PASS** |

### Hasil Full Vitest Test Suite:
- **Test Files**: 18 passed (18)
- **Tests**: 223 passed (223)
- **Durasi**: ~7.8s
- **Regresi / Breaking Changes**: 0

---

## 2026-11-22 - Session: Best Goalkeeper Award Team Attribution (Decision D-036)

### Purpose
Mengalihkan atribusi penghargaan kiper terbaik (*Best Winning Goalkeeper*) pada pengumuman `!awards` agar secara resmi dianugerahkan kepada **Tim** (mewakili seluruh rotasi kiper di tim tersebut), bukan perseorangan kaku, dikarenakan game Flash Peak tidak memunculkan nickname/UID pada layar detail pertahanan kiper.

### Concrete Changes
1. **`src/whatsapp/formatters.ts`**:
   - Memperluas fungsi pembantu `formatAwardSection` dengan opsi `options?: { isTeamAward?: boolean; teamAwardNote?: string }`.
   - Mengalihkan output `bestWinningGoalkeeper` ke format Tim:
     - Mahkota (`👑`) diarahkan ke `Tim: *<teamName>*`.
     - Menyertakan catatan `🧤 Kiper Utama: *<nicknameRaw>*` dan total saves.
     - Menyertakan disclaimer: `_(Penghargaan kiper dianugerahkan kepada Tim mewakili seluruh rotasi kiper)_`.
     - Mendukung tampilan tie/seri tim bersama (`🤝 *Tim Pemenang Bersama*`).
2. **`tests/unit/formatters.test.ts`**:
   - Menambahkan asersi verifikasi output bahwa pengumuman `formatAwardsAnnouncement` memuat penobatan tim (`👑 Tim: *Team 1*`), kiper utama terdaftar, dan catatan representasi rotasi kiper.
3. **`flash-peak-tms/DECISIONS.md`**:
   - Menambahkan catatan resmi **Decision D-036: Best Goalkeeper Award Team Attribution** tertanggal 22 November 2026.

### Empirical Verification
- **Vitest**:
  ```bash
  npx vitest run tests/unit/formatters.test.ts tests/integration/full_flow.test.ts
  ```
  Output: `Test Files: 2 passed (2), Tests: 12 passed (12)`.
- **TypeScript Build**:
  ```bash
  npm run build
  ```
  Output: `tsc` exit code 0 tanpa error.
- **Full Test Suite**:
  ```bash
  npm test
  ```
  Output: `Test Files: 20 passed (20), Tests: 258 passed (258)`.

## 2026-11-22 - Session: Hotfix Deploy PR #9 — Runtime Data JSON Tidak Tersalin ke dist (Task: fix/build-copy-data)

### Latar & Gejala
- Deploy pertama PR #9 ke VM produksi (merge commit `0d6e9cd`, auto-deploy watcher) langsung crash-loop: `flashpeak-bot` `errored` dalam <10 dtk, auto-rollback mengembalikan `86b0c7f` (prod aman di kode lama).
- Log fatal berulang: `ENOENT: open '/home/azureuser/flashpeak-tms/dist/data/flashpeak-trivia.json'` dari `loadTrivia` (`src/application/trivia.ts:47`), dipanggil `registerAiNativeCommands` saat startup — deterministik tiap boot.

### Akar Masalah
- PM2 produksi menjalankan entry compiled `dist/cli/start.js` (definisi proses lama), bukan tsx/src seperti `ecosystem.config.cjs` terbaru. `tsc` tidak menyalin file non-TS (JSON) ke `dist`, padahal `TRIVIA_PATH` di-resolve relatif `__dirname` (`../data/`) → mode dist mencari `dist/data/` yang tidak pernah ada.
- Gap tidak tertangkap audit L2 karena seluruh verifikasi berjalan via vitest/tsx dari source tree (JSON hadir) — gap klasik test-env vs runtime-env.
- Catatan: migrations berjalan sebelum `createApp` (start.ts:67), sehingga migration 004 telah teraplikasi ke DB prod pada percobaan pertama (crash terjadi DI DALAM `createApp`); additive & idempoten — aman terhadap rollback kode.

### Fix
- `package.json` script `build`: `tsc` → `tsc && mkdir -p dist/data && cp src/data/*.json dist/data/` — artefak dist kini self-contained untuk data runtime.

### Empirical Verification
- Sandbox clean-build (`rm -rf dist && npm run build`): `dist/data/flashpeak-trivia.json` hadir (11.3 KB) + modul PR #9 (`agent-planner.js`, `qna.js`, dst.) ter-emit; `tsc` tetap 0 error.
- Redeploy VM dengan guard eksplisit `test -f dist/data/flashpeak-trivia.json` sebelum `pm2 restart` — hasil dicatat di komentar follow-up PR #9.






