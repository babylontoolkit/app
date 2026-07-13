/**
 * Admin credit adjustment for LOCAL DEVELOPMENT (SPEC §4.6, spec/billing.md).
 *
 *   pnpm credits 25000                     # top up the local developer
 *   pnpm credits -500 "clawback: test"     # negative works too
 *   pnpm credits                           # no args: just print the ledger
 *
 * Why a script and not "edit the .jsonl":
 *
 * The balance is DERIVED — it is the `balanceAfter` of the last row, not a counter. Hand-editing the
 * file means computing that yourself, and getting it wrong silently corrupts every balance after it
 * with nothing to tell you. This reads the last row and does the arithmetic.
 *
 * This only exists because local mode keeps the ledger on disk. In production the ledger is Postgres:
 * `credit_ledger` has NO insert policy, UPDATE/DELETE are refused by a trigger, and `balance_after` is
 * computed by `append_ledger_entry()` under a per-user advisory lock. You cannot hand-append a row
 * there, by design — that path needs the admin endpoint, not this file.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Matches `LOCAL_USER.id` in app/lib/.server/supabase/auth.ts. */
const LOCAL_USER_ID = '00000000-0000-4000-8000-000000000001';
const LEDGER = path.join(process.cwd(), '.data', 'ledger', `${LOCAL_USER_ID}.jsonl`);

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run against a production build. Use the admin endpoint.');
  process.exit(1);
}

if (!fs.existsSync(LEDGER)) {
  console.error(`No local ledger at ${LEDGER}\nStart the app and sign in once — the signup grant creates it.`);
  process.exit(1);
}

const rows = fs
  .readFileSync(LEDGER, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const show = () => {
  for (const r of rows) {
    const delta = r.delta > 0 ? `+${r.delta}` : `${r.delta}`;

    console.log(
      `${r.createdAt.slice(0, 19).replace('T', ' ')}  ${String(r.reason).padEnd(11)} ${delta.padStart(8)}  ->  ${String(r.balanceAfter).padStart(7)}   ${r.note ?? ''}`,
    );
  }
  console.log(`\nBalance: ${rows.at(-1)?.balanceAfter ?? 0}`);
};

const amount = Number(process.argv[2]);

if (!process.argv[2]) {
  show();
  process.exit(0);
}

if (!Number.isFinite(amount) || amount === 0) {
  console.error(`"${process.argv[2]}" is not a usable amount. Example: pnpm credits 25000`);
  process.exit(1);
}

const note = process.argv[3] ?? 'Admin adjustment — local development';
const last = rows.at(-1);
const now = new Date();

/*
 * `adjustment` is one of only two reasons allowed to drive the balance negative (the other is
 * `generation`, which may overdraw because §4.2.1 forbids killing an in-flight build for balance).
 * Using it — rather than forging a `grant` or a `purchase` — keeps the history honest about the fact
 * that an operator reached in and moved the number.
 */
const entry = {
  userId: LOCAL_USER_ID,
  delta: amount,
  reason: 'adjustment',
  note,
  id: `led_${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 10)}`,
  balanceAfter: (last?.balanceAfter ?? 0) + amount,
  createdAt: now.toISOString(),
};

fs.appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`);
rows.push(entry);

console.log(`Appended: adjustment ${amount > 0 ? `+${amount}` : amount} — "${note}"\n`);
show();
