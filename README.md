# wa-gateway

Satu-satunya pemilik koneksi WhatsApp (Baileys) di VM. Tipis: hanya transport
dan routing — tanpa business logic. Bot Prime (Omak) dan Flash Peak TMS
menempel sebagai consumer via Unix domain socket (NDJSON).

## Prinsip
- Satu koneksi Baileys, satu auth_state (milik gateway, file-based).
- Routing dua aturan: grup turnamen (`WA_FLASHPEAK_GROUP_JID`) + DM organizer
  → flashpeak; semua lainnya → bot-prime. Tanpa parsing command apa pun.
- Consumer down → pesan di-drop dengan log (tidak queue); reconnect = hello.
- Gateway restart → consumer auto-reconnect (backoff 200ms→2s).
- Stateful minimum: tidak menyimpan riwayat pesan; buffer socket dibatasi
  (256 baris high-water → putus, consumer reconnect).

## Protokol (NDJSON, satu JSON per baris)
- gateway→consumer: `hello_ack`, `status`, `msg` (id/ts/from/sender/isGroup/
  fromMe/text/quoted/raw), `ack`, `media_ack`, `pong`
- consumer→gateway: `hello` {consumer}, `send` {rid,to,text,typingMs,quoted,
  mentions}, `media` {rid,msg}, `ping`

## ENV
| Variabel | Default | Arti |
|---|---|---|
| `WA_SOCKET_PATH` | `/run/wa-gateway.sock` | path Unix socket |
| `WA_AUTH_DIR` | `./auth_state` | direktori auth (milik gateway) |
| `WA_FLASHPEAK_GROUP_JID` | — | grup turnamen → flashpeak |
| `WA_ORGANIZER_JID` | — | DM organizer → flashpeak |
| `WA_PAIRING_NUMBER` | — | minta pairing code saat pairing pertama |
| `WA_LOG_LEVEL` | `info` | pino level |

## PM2
`ecosystem.config.cjs` — fork mode ×1, `max_memory_restart` 160M (gateway)
dan 200M (kedua consumer). Jangan cluster mode: Baileys di level gateway.

## Run
```bash
npm ci && npm run build
pm2 start ecosystem.config.cjs   # atau pm2 start dist/index.js --name wa-gateway
```
Pairing pertama: set `WA_PAIRING_NUMBER` (tanpa +), log `pairing code issued`
— masukkan di WhatsApp → Perangkat Tertaut.

## Test
`npm test` — protokol NDJSON (parse/buffer/partial-write), routing (grup
turnamen, organizer DM, device-suffix), handshake duplicate rejection.
