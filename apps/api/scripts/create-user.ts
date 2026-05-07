/**
 * Create an admin user from the command line.
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/create-user.ts \
 *     --email admin@example.com --name "Site Admin" --password "..."
 *
 * Used by the install script (`infra/install.sh`) to bootstrap the
 * first admin during a fresh deploy. Also runnable manually for adding
 * later admins until a proper "manage users" UI exists.
 *
 * The user is created under the singleton `COMPANY_ID` and granted the
 * `admin` role.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { users } from '../src/db/schema/index.js';
import { hashPassword } from '../src/shared/auth/password.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

interface Args {
  email: string;
  name: string;
  password: string;
  roles: string[];
}

function parseArgs(argv: string[]): Args {
  let email: string | null = null;
  let name: string | null = null;
  let password: string | null = process.env.SMMTA_USER_PASSWORD ?? null;
  let roles: string[] = ['admin'];

  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--email' && value) { email = value; i++; continue; }
    if (flag === '--name' && value) { name = value; i++; continue; }
    if (flag === '--password' && value) { password = value; i++; continue; }
    if (flag === '--roles' && value) {
      roles = value.split(',').map((r) => r.trim()).filter((r) => r.length > 0);
      i++;
      continue;
    }
    if (flag === '--help' || flag === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  const missing: string[] = [];
  if (!email) missing.push('--email');
  if (!name) missing.push('--name');
  if (!password) missing.push('--password (or SMMTA_USER_PASSWORD env)');
  if (missing.length > 0) {
    console.error(`create-user: missing required argument(s): ${missing.join(', ')}`);
    printUsage();
    process.exit(2);
  }

  return { email: email!.trim().toLowerCase(), name: name!.trim(), password: password!, roles };
}

function printUsage(): void {
  console.error(
    [
      'Usage: tsx apps/api/scripts/create-user.ts \\',
      '         --email <email> --name "<full name>" \\',
      '         [--password <password> | $SMMTA_USER_PASSWORD] \\',
      '         [--roles admin,...]',
    ].join('\n'),
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const db = getDb();

  const existing = await db.query.users.findFirst({ where: eq(users.email, args.email) });
  if (existing) {
    console.error(`create-user: a user with email "${args.email}" already exists (id=${existing.id})`);
    process.exit(3);
  }

  const passwordHash = await hashPassword(args.password);
  const [row] = await db
    .insert(users)
    .values({
      companyId: getSingletonCompanyId(),
      email: args.email,
      name: args.name,
      passwordHash,
      roles: args.roles,
    })
    .returning({ id: users.id, email: users.email });

  if (!row) throw new Error('Failed to insert users row');

  console.log(`OK created user id=${row.id} email=${row.email} roles=${args.roles.join(',')}`);
}

main()
  .catch((err) => {
    console.error('create-user failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
  });
