import { createClient } from '@libsql/client';

async function main() {
  const dbUrl = process.env.TURSO_DATABASE_URL || 'file:local.sqlite';
  const db = createClient({ url: dbUrl });

  const t = await db.execute('SELECT id, name, status FROM tournaments ORDER BY created_at DESC LIMIT 1');
  console.log('Tournament:', t.rows[0]);

  const groups = await db.execute('SELECT id, group_code FROM groups');
  console.log('Groups:', groups.rows);

  const fixtures = await db.execute(`
    SELECT f.id, f.round_code, g.group_code, ta.team_name as team_a, tb.team_name as team_b, f.status
    FROM fixtures f
    LEFT JOIN groups g ON f.group_id = g.id
    LEFT JOIN teams ta ON f.team_a_id = ta.id
    LEFT JOIN teams tb ON f.team_b_id = tb.id
    ORDER BY g.group_code, f.round_code
  `);
  console.log(`Fixtures (${fixtures.rows.length}):`);
  for (const f of fixtures.rows) {
    console.log(` - [${f.group_code} | ${f.round_code}] ${f.team_a} vs ${f.team_b} (${f.status})`);
  }
}

main().catch(console.error);
