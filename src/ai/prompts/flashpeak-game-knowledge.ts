/**
 * Flash Peak TMS - Authoritative Flash Peak Game Knowledge Base
 *
 * Sourced directly from game asset bundles and decompiled engine assemblies
 * in D:\Projects\FlashPeak (FootballPlayerMainTable, FootballPlayerAbilityTable,
 * FootballPlayerAttributeTable, PlayerBeShoulderBargeTransition, and ProjectCR.Runtime.dll).
 *
 * Injected into Omak Peak trusted context so the AI possesses authoritative,
 * exhaustive gameplay knowledge (characters, skills, attributes, physics,
 * combat formulas, and tactical matchup counters).
 */

export interface CharacterKnowledge {
  id: number;
  name: string;
  localized_name: string;
  role: 'ST' | 'CM' | 'CB' | 'WF' | 'GK';
  power: number;
  speed: number;
  stamina: number;
  shoot: number;
  pass: number;
  dribble: number;
  defense: number;
  small_skill: {
    name: string;
    cost_type: 'Stamina' | 'None';
    cost_val: number;
    description: string;
  };
  ultimate_skill: {
    name: string;
    cost_energy: number;
    range_or_duration: string;
    description: string;
  };
  key_passives: string;
  playstyle_summary: string;
}

export interface FlashPeakGameKnowledge {
  game_overview: {
    format: string;
    match_duration_sec: number;
    pitch_dimensions: string;
    rules: string[];
  };
  combat_and_collision_rules: {
    shoulder_barge_formula: string;
    double_teaming_penalty: string;
    energy_and_stamina_rules: string;
    goalkeeper_rules: string;
  };
  characters: CharacterKnowledge[];
  tactical_matchup_playbook: Record<string, string>;
}

export const FLASH_PEAK_GAME_KNOWLEDGE: FlashPeakGameKnowledge = {
  game_overview: {
    format: '4v4 Street / Arcade Football (Outfield 3v3 + 1 AI/Manual GK)',
    match_duration_sec: 300,
    pitch_dimensions: '66.0m (lebar) x 103.0m (panjang) x 20.0m (tinggi)',
    rules: [
      'Tanpa offside — rotasi, overlap, dan cherry-picking sepenuhnya legal.',
      'Durasi 5 menit (300 detik) continuous play.',
      'Mercy rule aktif bila selisih skor mencapai 3 gol di babak tertentu.',
      'Skor imbang saat waktu habis memicu Golden Goal (sudden death).',
    ],
  },
  combat_and_collision_rules: {
    shoulder_barge_formula:
      'Shoulder Barge dihitung dari Delta Power = Power Penyerang - Power Bertahan. Jika Delta Power > 25 (misal Andrew Power 87 menabrak penyerang ringan seperti Kelly Power 58 atau Orion Power 67), 80% memicu CATASTROPHIC KNOCKDOWN (terbanting jatuh ke rumput) dan 100% bola lepas! Jika -1 <= Delta Power <= 10 (seimbang), target 60% berhasil melindungi bola.',
    double_teaming_penalty:
      'Ketika pembawa bola ditempel/dikepung oleh 2 lawan (overlap), kecepatan lari turun drastis menjadi 90% (debuff OverlapPlayerHasBallRun/Sprint = 0.90), dan memicu benturan bahu berulang tiap 0.5 detik. Menahan bola sendirian saat dikepung 2 bek hampir pasti berakhir kehilangan bola.',
    energy_and_stamina_rules:
      'Energi Ulti pulih pasif 3.0/detik + bonus aksi (Bek dapat +20 Energi saat tekel sukses, Penyerang dapat +20 saat loose shoot). Stamina (600-1200) pulih 320-450/detik; lari tanpa bola gratis 0 stamina, tapi sprint dribble menguras 80 stamina/detik. Habis stamina memicu status LowStamina (sprint terkunci hingga 400 stamina terisi kembali).',
    goalkeeper_rules:
      'Kiper di kotak penalti memiliki status Invincible saat memegang bola (maks 3.0 detik). Operan balik (back-pass) dari rekan setim hanya bisa ditahan kiper selama 0.3 detik (anti-stall). Kiper keluar kotak penalti kehilangan hak sarung tangan.',
  },
  characters: [
    {
      id: 1003,
      name: 'Andrew',
      localized_name: '安德鲁',
      role: 'CB',
      power: 87,
      speed: 76,
      stamina: 84,
      shoot: 59,
      pass: 72,
      dribble: 61,
      defense: 82,
      small_skill: {
        name: 'Shoulder Barge',
        cost_type: 'Stamina',
        cost_val: 400,
        description: 'Benturan bahu jarak dekat (2.0m) dengan kekuatan tertinggi di game (87 Power). Memicu 80% Knockdown instan pada penyerang ringan.',
      },
      ultimate_skill: {
        name: 'Anchor Sweep / Super Tackle',
        cost_energy: 420,
        range_or_duration: '18.0 meter',
        description: 'Meluncur tekel sejauh 18 meter! Kontak dengan pembawa bola memicu ControlBallImmediately (bola otomatis lengket di kaki Andrew, tak terbantahkan) + lawan jatuh terkapar.',
      },
      key_passives: 'Intimidation Aura (-10 Speed & Shot ke lawan terdekat), Tackle Auto-Turn.',
      playstyle_summary: 'Bek perusak (Enforcer). Rajanya tekel jarak jauh dan body check brutal. Sangat mematikan untuk menghentikan serangan balik cepat.',
    },
    {
      id: 1009,
      name: 'Ford',
      localized_name: '福特',
      role: 'CB',
      power: 79,
      speed: 80,
      stamina: 78,
      shoot: 58,
      pass: 69,
      dribble: 58,
      defense: 84,
      small_skill: {
        name: 'Shoulder Barge',
        cost_type: 'Stamina',
        cost_val: 400,
        description: 'Body check kokoh (79 Power) jarak 2.0m, mengunci laju penyerang yang mencoba menerobos.',
      },
      ultimate_skill: {
        name: 'Iron Wall / Super Block',
        cost_energy: 380,
        range_or_duration: 'Durasi 4.0 detik',
        description: 'Memasang barikade pertahanan mutlak (Buff 1009020). Bola tembakan/umpan yang mengarah ke jalurnya seketika dihentikan mati (StopFreeMoveBall) dan disapu bersih ke depan.',
      },
      key_passives: 'Goal Iron Gate, Tackle Master, Jockey Speed 87.',
      playstyle_summary: 'Bek dinding kokoh (Wall Blocker). Menutup semua sudut shooting dan passing lawan. Duet paling ditakuti bersama Andrew.',
    },
    {
      id: 1001,
      name: 'Orion',
      localized_name: '奥利恩',
      role: 'ST',
      power: 67,
      speed: 70,
      stamina: 70,
      shoot: 81,
      pass: 67,
      dribble: 74,
      defense: 55,
      small_skill: {
        name: 'Orion Pull',
        cost_type: 'Stamina',
        cost_val: 320,
        description: 'Teknik drag-back khas untuk mengecoh tekel geser bek dan membatalkan animasi tendangan.',
      },
      ultimate_skill: {
        name: 'Skyfall Kick / Bicycle Kick',
        cost_energy: 530,
        range_or_duration: 'Aerial Volley',
        description: 'Tendangan salto spektakuler. Bola mendapat Buff kebal tekel (5.0s) & kebal intersep (1.63s). Arah tembakan pojok bisa diarahkan manual via swipe.',
      },
      key_passives: 'Box Predator Super Armor (2.0s di kotak penalti), Low Bullet Pass.',
      playstyle_summary: 'Target man mematikan di kotak penalti. Spesialis umpan lambung dan eksekusi salto yang tak bisa dihentikan di udara.',
    },
    {
      id: 1002,
      name: 'Hayato',
      localized_name: '夜神隼',
      role: 'CM',
      power: 72,
      speed: 71,
      stamina: 74,
      shoot: 70,
      pass: 77,
      dribble: 81,
      defense: 63,
      small_skill: {
        name: 'Hayato Pull',
        cost_type: 'Stamina',
        cost_val: 160,
        description: 'Drag-back gesit berbiaya rendah untuk menggocek lawan dalam ruang sempit.',
      },
      ultimate_skill: {
        name: 'Flash Step / Super Dribble',
        cost_energy: 320,
        range_or_duration: 'Radius 8.0m, kerucut 120 derajat',
        description: 'Gerakan dribble kilat berantai yang dapat melewati hingga 3 pemain lawan berturut-turut tanpa bisa direbut dari depan.',
      },
      key_passives: 'Dribble Super Armor (0.37s kebal stagger), Attack Boost.',
      playstyle_summary: 'Playmaker penggiring bola licin. Sangat efektif membongkar garis tengah dan memecah formasi bertahan lawan.',
    },
    {
      id: 1004,
      name: 'Kelly',
      localized_name: '凯莉',
      role: 'WF',
      power: 58,
      speed: 80,
      stamina: 66,
      shoot: 72,
      pass: 76,
      dribble: 78,
      defense: 54,
      small_skill: {
        name: 'Push Ball',
        cost_type: 'Stamina',
        cost_val: 150,
        description: 'Dorongan bola ke depan disertai akselerasi sprint eksplosif meninggalkan penjagaan bek.',
      },
      ultimate_skill: {
        name: 'Ultra Velocity / Wall Dash',
        cost_energy: 440,
        range_or_duration: 'Lompat 15m, elevasi 1.8m, ekstensi 8m',
        description: 'Lompat dan berlari di dinding stadion! Sepenuhnya kebal terhadap tekel rumput dan langsung diakhiri dengan tendangan voli menyilang ke gawang.',
      },
      key_passives: 'Final Form (+6% Speed & +3 Semua Stat selama 30 detik), Sprint tertinggi di game (87).',
      playstyle_summary: 'Sayap pelari cepat (Speed Demon). Mengandalkan kecepatan tepi lapangan dan trik dinding yang mustahil dijangkau tekel biasa.',
    },
    {
      id: 1006,
      name: 'Shirou',
      localized_name: '士郎',
      role: 'ST',
      power: 71,
      speed: 75,
      stamina: 71,
      shoot: 73,
      pass: 76,
      dribble: 79,
      defense: 56,
      small_skill: {
        name: 'Rainbow Flick',
        cost_type: 'Stamina',
        cost_val: 175,
        description: 'Mencungkil bola melewati kepala bek yang sedang meluncur tekel.',
      },
      ultimate_skill: {
        name: 'Dual Impact / Dual Shoot',
        cost_energy: 390,
        range_or_duration: 'Aura 10 detik',
        description: 'Tembakan kombinasi kembar dengan efek ledakan AoE Knockdown / Hit-Fly yang melempar jatuh siapa pun pemain di jalur lintasannya.',
      },
      key_passives: 'Shot Power Boost, Box Predator Super Armor, Curve tinggi (81).',
      playstyle_summary: 'Striker serba bisa dengan tendangan melengkung akurat dan tembakan ulti yang mendisrupsi pertahanan.',
    },
    {
      id: 1007,
      name: 'Rafael',
      localized_name: '拉斐尔',
      role: 'ST',
      power: 75,
      speed: 66,
      stamina: 72,
      shoot: 82,
      pass: 77,
      dribble: 69,
      defense: 49,
      small_skill: {
        name: 'Cut Turn',
        cost_type: 'Stamina',
        cost_val: 250,
        description: 'Pembalikan badan tajam menggunakan tumit untuk membuka ruang tembak seketika.',
      },
      ultimate_skill: {
        name: 'Super Fake Shoot',
        cost_energy: 460,
        range_or_duration: 'Durasi 10 detik',
        description: 'Melakukan 2 kali gerakan tipuan tembakan berturut-turut dengan Super Armor; membuat bek lawan oleng/stagger lalu melepas tembakan gledek (+20 Energi pada loose shot).',
      },
      key_passives: 'Finishing mematikan (85), Shot Power (85), Dribble Combo boost.',
      playstyle_summary: 'Sniper & master tipuan. Spesialis menghukum bek yang terburu-buru melakukan diving tackle.',
    },
    {
      id: 1008,
      name: 'Moco',
      localized_name: '莫科',
      role: 'CM',
      power: 67,
      speed: 76,
      stamina: 72,
      shoot: 67,
      pass: 78,
      dribble: 77,
      defense: 61,
      small_skill: {
        name: 'One-Two Pass',
        cost_type: 'Stamina',
        cost_val: 100,
        description: 'Umpan satu-dua instan (radius scan 25-50m) yang membutakan fokus kamera lawan selama 2 detik.',
      },
      ultimate_skill: {
        name: 'Hacker Mark / Precision Protocol',
        cost_energy: 380,
        range_or_duration: 'Durasi 20 detik',
        description: 'Mengaktifkan radar presisi global ke seluruh tim; operan menjadi auto-target akurat melintasi seluruh penjuru lapangan.',
      },
      key_passives: 'Penetrating Pass, Long Range Cannon (+8 Shot Power 3.0s), Akurasi umpan pendek tertinggi (85).',
      playstyle_summary: 'Jenderal lapangan tengah (Tactical Maestro). Mengatur ritme permainan dan membagi bola dengan akurasi radar tanpa cela.',
    },
    {
      id: 1010,
      name: 'Homer',
      localized_name: '赫马',
      role: 'CM',
      power: 72,
      speed: 70,
      stamina: 75,
      shoot: 73,
      pass: 84,
      dribble: 74,
      defense: 60,
      small_skill: {
        name: 'Elastico',
        cost_type: 'Stamina',
        cost_val: 160,
        description: 'Gerakan tipuan elastico yang memberikan efek counter-stun bila ditekel lawan saat dieksekusi.',
      },
      ultimate_skill: {
        name: 'Full Vision',
        cost_energy: 280,
        range_or_duration: 'Durasi 60 detik (Cost terendah)',
        description: 'Sudut pandang taktis luas; bola tembakan/lemparan berubah menjadi proyektil homing yang membelok mencari target dengan radius kunci 16.0 meter.',
      },
      key_passives: 'Lob Pass tertinggi (85), Curve 81, Counter-attack boost.',
      playstyle_summary: 'Playmaker umpan lambung dan proyektil berpandu. Ultinya paling murah dan cepat terisi kembali.',
    },
    {
      id: 1011,
      name: 'Oscar',
      localized_name: '奥斯卡',
      role: 'ST',
      power: 78,
      speed: 75,
      stamina: 77,
      shoot: 73,
      pass: 71,
      dribble: 75,
      defense: 58,
      small_skill: {
        name: 'Two Point Sprint',
        cost_type: 'Stamina',
        cost_val: 300,
        description: 'Sprint terjang fisik yang mendorong mundur lawan di depannya.',
      },
      ultimate_skill: {
        name: 'Savage Dash',
        cost_energy: 320,
        range_or_duration: 'Durasi 5.3 detik',
        description: 'Lari terjang tak terbendung yang menabrak dan menjatuhkan semua pemain di jalurnya; kecepatan tembakan bertambah seiring durasi lari.',
      },
      key_passives: 'In-box Scramble +6, Tight Angle Shot Boost, Fisik kuat (78 Power).',
      playstyle_summary: 'Striker badak perusak pertahanan. Menerobos garis belakang lawan dengan kekuatan fisik murni.',
    },
    {
      id: 1012,
      name: 'Steffie',
      localized_name: '史黛菲',
      role: 'CB',
      power: 75,
      speed: 81,
      stamina: 78,
      shoot: 55,
      pass: 78,
      dribble: 59,
      defense: 79,
      small_skill: {
        name: 'Double Tackle',
        cost_type: 'Stamina',
        cost_val: 320,
        description: 'Dua tekel luncur berantai tanpa jeda pemulihan di tanah; jika tekel pertama luput, tekel kedua langsung menyambar.',
      },
      ultimate_skill: {
        name: 'Doodle Storm',
        cost_energy: 360,
        range_or_duration: 'Durasi 10 detik',
        description: 'Memberi boost kecepatan tim selama 3 detik + mengaktifkan fitur Dual Slide (tekel ganda) untuk seluruh rekan setim selama 10 detik!',
      },
      key_passives: 'Coordinated Defense, Jockey Speed 87, Scramble 86, Bek tercepat.',
      playstyle_summary: 'Bek penyapu modern berkecepatan tinggi. Ahli menutup celah dan memberikan buff bertahan kolektif bagi tim.',
    },
    {
      id: 1013,
      name: 'Tatsuya',
      localized_name: '达也',
      role: 'WF',
      power: 59,
      speed: 81,
      stamina: 71,
      shoot: 67,
      pass: 70,
      dribble: 74,
      defense: 71,
      small_skill: {
        name: 'Dash',
        cost_type: 'None',
        cost_val: 0,
        description: 'Dash cepat GRATIS (0 Stamina, 0 Energy, CD 5.5 detik) untuk perpindahan posisi kilat.',
      },
      ultimate_skill: {
        name: 'Shadow Shuttle / Super Dash',
        cost_energy: 390,
        range_or_duration: 'Multi-dash beruntun',
        description: 'Manuver zig-zag beruntun dengan potongan sudut instan; mendapat bonus +1 dash tambahan bila dieksekusi di sektor sayap.',
      },
      key_passives: 'Lightning Raid, Adaptability, Stat bertahan seimbang untuk winger (DEF 71).',
      playstyle_summary: 'Sayap lincah counter-attack. Sangat mobile berkat dash tanpa biaya stamina.',
    },
    {
      id: 1005,
      name: 'Maxim',
      localized_name: '马克西姆',
      role: 'GK',
      power: 100,
      speed: 80,
      stamina: 81,
      shoot: 80,
      pass: 87,
      dribble: 75,
      defense: 75,
      small_skill: {
        name: 'Smother Tackle / Dive Saves',
        cost_type: 'None',
        cost_val: 0,
        description: 'Repertoar penyelamatan komprehensif: tangkapan bola bawah/atas, tepisan sudut 45/67 derajat, dan tekel pengaman bola lepas.',
      },
      ultimate_skill: {
        name: 'Goal Clearance / Distribution',
        cost_energy: 0,
        range_or_duration: 'Kotak Penalti',
        description: 'Pembersihan bola instan dengan operan atau tendangan jauh akurat (100 Strength & 87 Pass).',
      },
      key_passives: 'Invincible di kotak penalti maks 3.0s, Clearance 90.',
      playstyle_summary: 'Kiper tangguh pengawal mistar gawang.',
    },
  ],
  tactical_matchup_playbook: {
    'dikepung_andrew_dan_ford':
      'Skenario: Paling berbahaya di Flash Peak! Andrew punya Shoulder Barge (87 Power, 80% Knockdown) & Super Tackle 18m, sedangkan Ford punya Super Block (bola langsung mati). Strategi:\n1. JANGAN mendribble atau menahan bola — status overlap membuat lari melambat ke 90% dan memicu tabrakan bahu tiap 0.5 detik.\n2. Lakukan operan kilat 1-2 sentuhan (One-Two) ke ruang kosong SEBELUM jarak mendekat < 2 meter.\n3. Karena 2 bek lawan menempel pada 1 pemain, artinya ada 1 atau 2 rekan setimmu yang BEBAS tanpa kawalan (keunggulan jumlah di area lain).\n4. Gunakan umpan silang jauh (diagonal/lob pass) ke sayap kosong (Kelly/Tatsuya) atau cari posisi tembak di blindspot Ford.',
    'counter_orion':
      'Orion mematikan lewat Bicycle Kick (kebal tekel & intersep saat di udara). Cara counter: Matikan suplayer bola — potong umpan lambung sebelum masuk kotak penalti. Jika bola sudah melambung ke Orion, jangan buang stamina meluncur tekel karena dia kebal; sebaliknya posisikan bek (Ford/Andrew) tepat di garis gawang untuk memblokir arah tembakan setelah bola turun.',
    'counter_hayato':
      'Hayato punya Super Dribble dengan kerucut 120 derajat sejauh 8 meter yang melewati pemain depan. Cara counter: Jaga jarak jockey (Defend stance > 2m) dan jangan buru-buru sliding tackle dari depan. Biarkan dia menyelesaikan dash-nya, lalu sergap menggunakan Shoulder Barge dari arah samping/flank, atau pasang Super Block Ford tepat di jalurnya.',
    'counter_kelly':
      'Kelly mengandalkan Wall Dash 15m di dinding stadion yang kebal tekel rumput. Cara counter: Jangan ikut mengejar ke pinggir dinding (itu perangkap). Tetap kawal area tengah dan tiang jauh gawang. Tunggu Kelly mendarat dari dinding, lalu hantam dengan tekel Andrew saat animasi pendaratannya selesai.',
    'counter_rafael':
      'Rafael punya Super Fake Shoot dengan Super Armor yang membuat bek oleng jika buru-buru tekel. Cara counter: Tetap sabar dalam posisi jockey stance (Defend button) tanpa menekan tekel saat dia melakukan 2 tipuan pertama. Tekel baru dilepaskan saat animasi tendangan aslinya dimulai.',
  },
};
