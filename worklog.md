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




