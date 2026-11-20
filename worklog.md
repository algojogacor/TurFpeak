# Worklog — Flash Peak TMS (TurFpeak)

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

# Worklog — Flash Peak TMS (TurFpeak)

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

# Worklog — Flash Peak TMS (TurFpeak)

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

# Worklog — Flash Peak TMS (TurFpeak)

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

# Worklog — Flash Peak TMS (TurFpeak)

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




